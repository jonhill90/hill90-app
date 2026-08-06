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
import { pumpWithBackpressure, RELAY_DEFAULTS } from './relay-backpressure';
import { stillAuthorised } from '../helpers/participation-watch';

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
 * Close code for a session ended because a peer stopped reading and the relay
 * queue passed its hard cap. Distinct from 4001/4002: nothing is wrong with the
 * credential, so a client may reasonably reconnect — which is why the UI's
 * terminalClose.ts leaves this one on the auto-reconnect path.
 */
const CLOSE_RELAY_OVERFLOW = 4003;

/**
 * Close code for a session ended because the viewer was REMOVED from the thread
 * (issue #196). Distinct from 4001 and 4002 for the same reason those are
 * distinct from each other: 4001 means the credential was refused, 4002 means it
 * was good and ran out, 4004 means it is still valid and the access behind it is
 * gone. A client cannot act differently on conditions that arrive as one number.
 *
 * The ui MUST know this code. `terminalClose.ts` auto-reconnects on every code it
 * does not recognise, so an unknown 4004 would make a removed user's terminal
 * retry in a loop against an upgrade that now refuses it, and say nothing.
 */
const CLOSE_ACCESS_REVOKED = 4004;

/**
 * setTimeout stores its delay in a signed 32-bit int. A larger value overflows
 * and the timer fires IMMEDIATELY — which would turn a long-lived session into
 * one that dies at once. Anything beyond this is capped; the socket then simply
 * outlives the cap, which is the pre-existing behaviour, not a regression.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * How long shutdown waits for close frames to reach their peers (#318).
 *
 * NOT A GUESS AT WHAT A SOCKET NEEDS. `closeAllSessions` waits on the sockets
 * themselves, so the normal case resolves in milliseconds; this is a ceiling for a
 * peer that never answers, and it is anchored at both ends:
 *
 *   UPPER  no compose file sets `stop_grace_period`, so Docker's default 10s is the
 *          whole shutdown budget — shared with closePool() and the exit. Two seconds
 *          is a fifth of it, leaving eight for the rest.
 *   LOWER  a close frame is a 2-byte code plus a short reason: one write on an
 *          already-established connection. What it needs is an event-loop turn, which
 *          is the same requirement boot/fatal.ts records for stderr — `process.exit()`
 *          does not wait for a pending write. That is now the THIRD place in this
 *          codebase where that property decides a design, so treat it as a known
 *          property rather than rediscovering it a fourth time.
 *
 * Any value between roughly 250ms and 5s satisfies both bounds. 2s within that window
 * is arbitrary, and arbitrary is acceptable here BECAUSE the wait is event-driven: the
 * number is only reached by a socket that is already broken.
 */
const DRAIN_TIMEOUT_MS = 2_000;

/**
 * Where the proxy connects once a caller is allowed in.
 *
 * INJECTABLE BECAUSE NOTHING AFTER THE HANDSHAKE WAS TESTABLE WITHOUT IT (#313).
 * `resolveAgentWsUrl` builds `ws://agentbox-<agent_id>:8054/…` and `agent_id` is
 * validated at creation against `^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$`, so no database
 * value can point this at a test server. With the upstream unreachable,
 * `agentWs.on('error')` runs `cleanupAll()`, which clears the expiry timer and the
 * ping interval — so the credential deadline and the participation re-check were
 * cleared before they could ever fire, whenever the upstream was absent, which in a
 * test it always is. Not a race: the ordering the code guarantees.
 *
 * This is the THIRD instance of a pattern this codebase has already chosen twice —
 * `resolveAgentModels`'s `exec` parameter and `boot/fatal.ts`'s `Exit` hook. Same
 * shape, same reason, same default-to-production behaviour when omitted.
 */
/**
 * A shutdown handle for the sessions this proxy owns.
 *
 * `server.close()` stops the listener accepting new connections and does not touch
 * established ones — and an upgraded WebSocket is as established as it gets. Measured:
 * after `server.close()` a live terminal's client is still `readyState === OPEN`, and
 * `process.exit(0)` then severs it with no frame at all, so the client sees 1006
 * (#318). Nothing outside this module can reach `wss.clients`, so the handle must come
 * from here.
 */
export interface TerminalProxyHandle {
  /** Close every live session with `code`; resolves when they are gone or the drain elapses. */
  closeAllSessions: (code: number, reason: string, timeoutMs?: number) => Promise<number>;
}

export interface TerminalProxyOptions {
  resolveUpstream?: (threadId: string) => Promise<string | null>;
}

export function attachTerminalProxy(
  server: ReturnType<typeof import('http').createServer>,
  verifyToken: (token: string) => Promise<{ sub: string; roles?: string[]; exp: number } | null>,
  options: TerminalProxyOptions = {},
): TerminalProxyHandle {
  const resolveUpstream = options.resolveUpstream ?? ((threadId: string) => resolveAgentWsUrl(threadId, ''));
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
      const agentWsUrl = await resolveUpstream(threadId);
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
        // from Traefik, load balancers, or browser network stack.
        //
        // The participation re-check rides THIS tick rather than arming a second
        // timer (issue #196). Access was checked once before the upgrade, so
        // removing a participant left their terminal streaming until the token
        // expired — the system reported the removal succeeded while the thing it
        // was meant to stop carried on. Admins are exempt for the same reason they
        // bypass the check at connect.
        const pingInterval = setInterval(() => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.ping();
          }
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.ping();
          }

          if (isAdmin) return;
          void (async () => {
            const allowed = await stillAuthorised(
              () => isParticipant(threadId, user.sub),
              'terminal-proxy',
            );
            if (allowed) return;
            console.log(`[terminal-proxy] Closing thread=${threadId}: participation revoked`);
            // `void` above attaches no rejection handler, and this tick is
            // not dispatched by Express, so boot/async-errors.ts's patch
            // does not reach it — a throw here has nowhere to go but this
            // service's process-wide unhandledRejection backstop
            // (boot/fatal.ts), which exits the process. This interval runs
            // every 30s for the life of every open terminal session, so a
            // teardown failure on ONE session would otherwise cost the api
            // for everyone with a terminal open. Caught here so it costs
            // only this session.
            try {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(CLOSE_ACCESS_REVOKED, 'access revoked');
              }
              cleanupAll();
            } catch (err) {
              console.error(`[terminal-proxy] Cleanup after participation recheck failed for thread=${threadId}:`, err);
            }
          })();
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

        // Declared before cleanupAll so its teardown can reach them; assigned when
        // the pumps are created below.
        let stopAgentToClient: (() => void) | null = null;
        let stopClientToAgent: (() => void) | null = null;

        // Called from six places, most of them with no error handling of
        // their own: the two `.on('close', ...)` listeners just below and
        // the two `.on('error', ...)` handlers further down are plain
        // synchronous EventEmitter callbacks, where an uncaught throw is
        // Node's 'uncaughtException' — a DIFFERENT, and not covered, failure
        // mode from the 'unhandledRejection' the participation-recheck tick
        // above risks; this service's backstop (boot/fatal.ts) only
        // listens for the latter. One safe implementation here protects
        // every caller at once, rather than needing the same try/catch
        // typed out at each of the six call sites — the same reasoning
        // boot/async-errors.ts already applies at the Express boundary.
        function cleanupAll() {
          stopAgentToClient?.();
          stopClientToAgent?.();
          clearTimeout(expiryTimer);
          clearInterval(pingInterval);
          try {
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
          } catch (err) {
            console.error(`[terminal-proxy] Closing clientWs during cleanup failed for thread=${threadId}:`, err);
          }
          try {
            if (agentWs.readyState === WebSocket.OPEN) agentWs.close();
          } catch (err) {
            console.error(`[terminal-proxy] Closing agentWs during cleanup failed for thread=${threadId}:`, err);
          }
        }

        // Relay, both ways, with backpressure. `ws.send()` does not block: a peer
        // that stops reading used to accumulate the entire stream in this
        // process's memory, and app-api has no mem_limit (issue #144). Above the
        // high-water mark the SOURCE is paused so the stall reaches whoever is
        // producing; past the hard cap the peer is not slow but gone, and the
        // session ends rather than being held open at a cost to everyone else.
        const isOpen = (s: { readyState: number }) => s.readyState === WebSocket.OPEN;

        const endForOverflow = (direction: string) => (queued: number) => {
          console.error(
            `[terminal-proxy] Closing thread=${threadId}: ${direction} queue ${queued} bytes ` +
            `over the ${RELAY_DEFAULTS.hardCapBytes}-byte cap — peer is not reading`,
          );
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(CLOSE_RELAY_OVERFLOW, 'peer not reading: buffer limit exceeded');
          }
          cleanupAll();
        };

        stopAgentToClient = pumpWithBackpressure(
          agentWs as never, clientWs as never,
          { ...RELAY_DEFAULTS, isOpen, onOverflow: endForOverflow('agentbox to client') },
        );
        stopClientToAgent = pumpWithBackpressure(
          clientWs as never, agentWs as never,
          { ...RELAY_DEFAULTS, isOpen, onOverflow: endForOverflow('client to agentbox') },
        );

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

  return {
    async closeAllSessions(code: number, reason: string, timeoutMs = DRAIN_TIMEOUT_MS): Promise<number> {
      const live = [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN);
      if (live.length === 0) return 0;

      console.log(`[terminal-proxy] Closing ${live.length} live session(s): ${code} ${reason}`);

      // Wait for the closes; do not sleep for a guessed interval. Each socket resolves
      // as it goes, so the normal case costs milliseconds and the timeout is a ceiling
      // for a peer that never answers rather than a delay everyone pays.
      const drained = Promise.all(
        live.map((client) => new Promise<void>((resolve) => {
          client.once('close', () => resolve());
          client.close(code, reason);
        })),
      );

      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        drained,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      return live.length;
    },
  };
}
