/**
 * WebSocket terminal proxy — relays between browser and agentbox PTY.
 *
 * Path: /chat/threads/:threadId/terminal
 *
 * Auth: the caller offers its Keycloak JWT as a WebSocket SUBPROTOCOL,
 * `hill90.bearer.<token>`, alongside the plain `hill90.terminal.v1`. The Origin is
 * checked against an allowlist first. Then thread participation, then a WebSocket to
 * agentbox to relay.
 *
 * TWO DEFECTS WERE FIXED HERE ON 2026-07-31, and both are easy to reintroduce.
 *
 * 1. THERE WAS NO ORIGIN CHECK. WebSockets are not covered by the same-origin policy:
 *    the browser will happily open one cross-origin and attach the user's credential.
 *    So any page a signed-in user visited could open this socket and drive a shell
 *    inside their agent container. CORS does not help — it does not apply to the
 *    WebSocket handshake. Checking Origin at the handshake is the only defence.
 *
 * 2. THE TOKEN CAME FROM THE QUERY STRING. URLs are recorded in access logs, proxy
 *    logs and browser history, none of which are places a bearer credential may live,
 *    and this service wrote it into its own log line on every upgrade.
 *
 *    The browser's WebSocket API cannot set an Authorization header, so the token
 *    moved to `Sec-WebSocket-Protocol` — a request HEADER, which is not logged the way
 *    URLs are. The alternative, a short-lived single-use ticket minted over a normal
 *    authenticated request, was rejected for this codebase: it needs server-side
 *    ticket state, and with more than one api replica that state has to be shared or
 *    the ticket only works on the replica that issued it. The subprotocol needs no
 *    state at all.
 *
 *    The query-string path is GONE, not deprecated. Accepting both would leave the
 *    logging exposure exactly as it was.
 *
 * The selected subprotocol echoed back to the client is ALWAYS the plain version
 * string, never the bearer one — a response header is logged too.
 */

import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { getPool } from '../db/pool';

const CONTAINER_PREFIX = 'agentbox-';
const AGENTBOX_PORT = 8054;
const PING_INTERVAL_MS = 30_000; // 30s keep-alive ping

/** The subprotocol the client and server agree on, and which is echoed back. */
const PROTOCOL_VERSION = 'hill90.terminal.v1';
/** Prefix marking the subprotocol entry that carries the bearer token. */
const PROTOCOL_BEARER_PREFIX = 'hill90.bearer.';

/**
 * Exact-match origin allowlist from TERMINAL_ALLOWED_ORIGINS (comma-separated).
 *
 * Read per request, not once at module load, so a test or a restart-free config change
 * cannot leave a stale allowlist in place.
 *
 * Unset or empty means REFUSE EVERYTHING. This fails closed on purpose: the failure
 * mode of the alternative is a silently permissive terminal, which is the whole defect
 * being fixed. A misconfigured deployment loses terminals and says so in the log.
 */
function allowedOrigins(): string[] {
  return (process.env.TERMINAL_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Whether this Origin may open a terminal.
 *
 * Exact string comparison, deliberately. Substring or suffix matching would accept
 * `https://hill90.com.evil.example`, and comparing only the hostname would accept the
 * wrong scheme or port. An origin is scheme + host + port and all three matter.
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

/**
 * Pull the bearer token out of the offered subprotocols.
 *
 * Returns null when no entry carries one, which is treated as "unauthenticated" — the
 * query string is never consulted.
 */
function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(',')) {
    const entry = raw.trim();
    if (entry.startsWith(PROTOCOL_BEARER_PREFIX)) {
      const token = entry.slice(PROTOCOL_BEARER_PREFIX.length);
      if (token.length > 0) return token;
    }
  }
  return null;
}

/**
 * A URL safe to log: the path only.
 *
 * The query string is dropped rather than escaped. This log line used to print
 * `?token=<jwt>` on every upgrade, which put the credential in the service's own logs
 * — the same exposure as having it in the URL in the first place.
 */
function safePath(url: string | undefined): string {
  if (!url) return '<none>';
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?<redacted>`;
}

/**
 * Extract threadId from upgrade path: /chat/threads/:id/terminal
 */
function parseThreadId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/chat\/threads\/([^/]+)\/terminal/);
  return match ? match[1] : null;
}

/**
 * Resolve the agentbox WebSocket URL for a thread's running agent.
 */
async function resolveAgentWsUrl(threadId: string, workToken: string): Promise<string | null> {
  const pool = getPool();

  // Find running agent participant for this thread
  const { rows } = await pool.query(
    `SELECT a.agent_id, a.work_token
     FROM chat_participants cp
     JOIN agents a ON a.id::text = cp.participant_id
     WHERE cp.thread_id = $1
       AND cp.participant_type = 'agent'
       AND a.status = 'running'
     LIMIT 1`,
    [threadId]
  );

  if (rows.length === 0) return null;

  const agentSlug = rows[0].agent_id;
  const agentWorkToken = rows[0].work_token;

  return `ws://${CONTAINER_PREFIX}${agentSlug}:${AGENTBOX_PORT}/terminal/ws?token=${agentWorkToken}`;
}

/**
 * Check if user is a participant in the thread.
 */
async function isParticipant(threadId: string, userSub: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'human'
     LIMIT 1`,
    [threadId, userSub]
  );
  return rows.length > 0;
}

/**
 * Attach WebSocket terminal proxy to an HTTP server.
 *
 * Handles upgrade requests matching /chat/threads/:id/terminal.
 *
 * Auth is a Keycloak JWT carried in the `hill90.bearer.<token>` WebSocket
 * subprotocol. NOT the query string — that path was removed deliberately (see
 * the note above), because a URL reaches access logs, proxy logs and browser
 * history. This docstring said "or token query param" after the removal, which
 * is how a closed hole gets reopened by someone reading the comment instead of
 * the code.
 */
/**
 * Close code for a session cut short because its credential expired.
 *
 * NOT 4001: agentbox already closes with 4001 for "unauthorized"
 * (services/agentbox/app/ws_terminal.py), and a client cannot act differently on
 * two conditions that arrive as the same number. 4001 means the credential was
 * refused; 4002 means it was good and has run out.
 */
const CLOSE_CREDENTIAL_EXPIRED = 4002;

/**
 * setTimeout stores its delay in a signed 32-bit int. A larger value overflows
 * and the timer fires IMMEDIATELY — which would turn a long-lived session into
 * one that dies at once. Anything beyond this is capped; the socket then simply
 * outlives the cap, which is the pre-existing behaviour, not a regression.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function attachTerminalProxy(
  server: ReturnType<typeof import('http').createServer>,
  verifyToken: (token: string) => Promise<{ sub: string; roles?: string[]; exp: number } | null>,
): void {
  // Only ever select the plain version subprotocol. Returning the bearer entry would
  // echo the token back in the response's Sec-WebSocket-Protocol header.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL_VERSION) ? PROTOCOL_VERSION : false),
  });

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    console.log(`[terminal-proxy] Upgrade request: ${safePath(req.url)} from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);

    const threadId = parseThreadId(req.url);
    if (!threadId) {
      console.log('[terminal-proxy] No threadId in path, ignoring upgrade');
      // Not our path — let other handlers deal with it
      return;
    }

    try {
      // ORIGIN FIRST, before any credential is examined.
      //
      // Order matters beyond tidiness: answering 401-vs-403 based on token validity to
      // a caller that failed the origin check would tell an attacking page whether the
      // credential it captured is good. A refused origin learns only that it was
      // refused.
      const origin = req.headers.origin;
      if (!isOriginAllowed(origin)) {
        const configured = allowedOrigins().length;
        console.warn(
          `[terminal-proxy] REFUSED upgrade: origin ${origin ? `'${origin}'` : '<absent>'} not in allowlist ` +
          (configured === 0
            ? '(TERMINAL_ALLOWED_ORIGINS is unset or empty — this refuses every terminal by design; set it to the UI origin)'
            : `(${configured} origin(s) configured)`),
        );
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // The token comes from a header, never the query string. See the file header.
      const token = tokenFromProtocols(req.headers['sec-websocket-protocol'] as string | undefined)
        || (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : null);

      if (!token) {
        console.warn('[terminal-proxy] REFUSED upgrade: no token in Sec-WebSocket-Protocol or Authorization');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Verify Keycloak JWT
      const user = await verifyToken(token);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // The session may not outlive the credential that authorised it. Verified
      // once at the handshake and then never again, a terminal is a shell that
      // survives the token expiring, the user signing out, and their roles being
      // revoked — held open indefinitely by the keep-alive ping below.
      //
      // Fails closed on a missing or spent expiry. jwt.verify already rejects an
      // expired token upstream, so reaching here with one means the verifier does
      // not check it; refusing is the safe reading of that, not a duplicate.
      const expiresAtMs = typeof user.exp === 'number' ? user.exp * 1000 : NaN;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        console.warn('[terminal-proxy] REFUSED upgrade: credential absent or already expired');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check thread participation (admin bypass)
      const isAdmin = user.roles?.includes('admin');
      if (!isAdmin && !(await isParticipant(threadId, user.sub))) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // Resolve agentbox WebSocket URL
      const agentWsUrl = await resolveAgentWsUrl(threadId, '');
      console.log(`[terminal-proxy] Resolved agentbox URL for thread=${threadId}: ${agentWsUrl ? 'found' : 'not found'}`);
      if (!agentWsUrl) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Complete the upgrade
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        // Connect to agentbox
        const agentWs = new WebSocket(agentWsUrl);

        agentWs.on('open', () => {
          console.log(`[terminal-proxy] Connected to agentbox for thread=${threadId} url=${agentWsUrl}`);
        });

        agentWs.on('unexpected-response', (_req: any, res: any) => {
          console.error(`[terminal-proxy] Agentbox unexpected response: ${res.statusCode} for thread=${threadId}`);
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
        });

        // Keep-alive: ping both sides every 30s to prevent idle timeout
        // from Traefik, load balancers, or browser network stack
        const pingInterval = setInterval(() => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.ping();
          }
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.ping();
          }
        }, PING_INTERVAL_MS);

        // Ends the session when the credential does. Cleared in cleanupAll like
        // the ping — an armed timer holding a reference to a closed socket is
        // the leak class this repository has already paid for once.
        const expiryTimer = setTimeout(() => {
          console.log(`[terminal-proxy] Closing thread=${threadId}: credential expired`);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CLOSE_CREDENTIAL_EXPIRED, 'credential expired');
          }
          cleanupAll();
        }, Math.min(expiresAtMs - Date.now(), MAX_TIMEOUT_MS));

        function cleanupAll() {
          clearTimeout(expiryTimer);
          clearInterval(pingInterval);
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
          if (agentWs.readyState === WebSocket.OPEN) agentWs.close();
        }

        // Relay: agentbox → client
        agentWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });

        // Relay: client → agentbox
        clientWs.on('message', (data, isBinary) => {
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.send(data, { binary: isBinary });
          }
        });

        // Cleanup on either side close
        agentWs.on('close', cleanupAll);
        clientWs.on('close', cleanupAll);

        agentWs.on('error', (err) => {
          console.error(`[terminal-proxy] Agentbox WS error: ${err.message}`);
          cleanupAll();
        });
        clientWs.on('error', (err) => {
          console.error(`[terminal-proxy] Client WS error: ${err.message}`);
          cleanupAll();
        });
      });

    } catch (err) {
      console.error('[terminal-proxy] Upgrade error:', err);
      socket.destroy();
    }
  });
}
