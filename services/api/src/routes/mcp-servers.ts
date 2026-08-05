/**
 * MCP Server management routes.
 *
 *   GET    /mcp-servers              — list MCP servers
 *   POST   /mcp-servers              — create MCP server
 *   GET    /mcp-servers/:id          — get MCP server
 *   PUT    /mcp-servers/:id          — update MCP server
 *   DELETE /mcp-servers/:id          — delete MCP server
 *   POST   /agents/:id/mcp-servers   — assign to agent (in agents.ts)
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { reportedStatus, isStatusVerified } from '../services/agent-status-verification';
import { isAdmin } from '../helpers/elevated-scope';
import { encryptProviderKey, decryptProviderKey } from '../services/provider-key-crypto';

const router = Router();

// app#369: connection_config can carry a credential — a command's --token
// arg, an env block — and used to be stored as plain JSONB, returned
// verbatim on every read. Same class of secret provider_connections already
// encrypts; reusing that exact helper and key rather than inventing a
// second scheme, per the standing instruction not to.
function getEncryptionKey(): string {
  const key = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (!key) throw new Error('PROVIDER_KEY_ENCRYPTION_KEY not configured');
  return key;
}

// WHOLE-BLOB, NOT PER-KEY. connection_config is heterogeneous by transport
// (stdio: command/args/env; sse/http: url), and the create form's own
// placeholder invites a credential directly into `args` as a plain string
// (`--token ghp_xxx`) or into `env`, not a single named "secret" field.
// Maintaining an allowlist of which keys are safe to leave in cleartext
// would have to track every future transport and is exactly the kind of
// assumption that goes stale silently. See migration 067 for the same
// reasoning against the schema change.
function encryptConfig(config: unknown): { encrypted: Buffer; nonce: Buffer } {
  return encryptProviderKey(JSON.stringify(config ?? {}), getEncryptionKey());
}

// Columns explicitly listed, never `SELECT *` — connection_config_encrypted
// and connection_config_nonce must never leave this file. Mirrors
// provider_connections, whose GET responses never include api_key_encrypted
// either.
const PUBLIC_COLUMNS = `id, name, description, transport, is_platform, created_by, created_at, updated_at`;

// ── List MCP servers ────────────────────────────────────────────────
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    // connection_config_encrypted/_nonce are selected here ONLY to compute
    // connection_display below — they are deleted from every row before
    // res.json, same guarantee PUBLIC_COLUMNS gives the rest of this file.
    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_COLUMNS}, connection_config_encrypted, connection_config_nonce,
              (SELECT count(*) FROM agent_mcp_servers ams WHERE ams.mcp_server_id = ms.id) AS agent_count
       FROM mcp_servers ms
       ${admin ? '' : 'WHERE ms.created_by = $1 OR ms.is_platform = true'}
       ORDER BY ms.name`,
      admin ? [] : [user.sub]
    );

    res.json(rows.map(withConnectionDisplay));
  } catch (err: any) {
    console.error('[mcp-servers] List error:', err);
    res.status(500).json({ error: 'Failed to list MCP servers' });
  }
});

// ── Create MCP server ───────────────────────────────────────────────
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, description, transport, connection_config, is_platform } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const validTransports = ['stdio', 'sse', 'http'];
    if (transport && !validTransports.includes(transport)) {
      res.status(400).json({ error: `transport must be one of: ${validTransports.join(', ')}` });
      return;
    }

    // Only admins can create platform MCP servers
    if (is_platform && !isAdmin(req)) {
      res.status(403).json({ error: 'Only admins can create platform MCP servers' });
      return;
    }

    const { encrypted, nonce } = encryptConfig(connection_config);

    const { rows } = await getPool().query(
      `INSERT INTO mcp_servers (name, description, transport, connection_config_encrypted, connection_config_nonce, is_platform, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        name,
        description || null,
        transport || 'stdio',
        encrypted,
        nonce,
        is_platform || false,
        user.sub,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    console.error('[mcp-servers] Create error:', err);
    res.status(500).json({ error: 'Failed to create MCP server' });
  }
});

// ── Get MCP server ──────────────────────────────────────────────────
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_COLUMNS}, connection_config_encrypted, connection_config_nonce,
              (SELECT count(*) FROM agent_mcp_servers ams WHERE ams.mcp_server_id = ms.id) AS agent_count
       FROM mcp_servers ms
       WHERE ms.id = $1 ${admin ? '' : 'AND (ms.created_by = $2 OR ms.is_platform = true)'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'MCP server not found' });
      return;
    }

    const row = withConnectionDisplay(rows[0]);

    // Include assigned agents
    const { rows: agents } = await getPool().query(
      `SELECT a.id, a.name, a.agent_id, a.status, ams.enabled, ams.added_at
       FROM agent_mcp_servers ams
       JOIN agents a ON ams.agent_id = a.id
       WHERE ams.mcp_server_id = $1
       ORDER BY ams.added_at`,
      [req.params.id]
    );

    // #262 asked for this to be DECIDED rather than left silent. Mapped, not
    // left as-is: it has no UI reader today, which makes it a latent trap
    // rather than a live defect — and an unmapped payload is exactly how this
    // family reached a third route after two rounds of fixing it. The cost of
    // mapping a payload nobody reads is nothing; the cost of the next reader
    // finding a raw status here is the whole of #238 again.
    res.json({
      ...row,
      agents: agents.map((a: any) => ({
        ...a,
        status: reportedStatus(a.agent_id, a.status),
        status_verified: isStatusVerified(a.agent_id),
      })),
    });
  } catch (err: any) {
    console.error('[mcp-servers] Get error:', err);
    res.status(500).json({ error: 'Failed to get MCP server' });
  }
});

// ── Update MCP server ───────────────────────────────────────────────
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { name, description, transport, connection_config } = req.body;

    // Only re-encrypt when a new config was actually sent — COALESCE keeps
    // the existing ciphertext otherwise, the same "not provided means
    // unchanged" contract every other field here already has. There is no
    // decrypt-then-compare shortcut: the caller must send the whole config
    // to change any part of it, exactly like provider_connections' api_key.
    let newEncrypted: Buffer | null = null;
    let newNonce: Buffer | null = null;
    if (connection_config !== undefined) {
      const enc = encryptConfig(connection_config);
      newEncrypted = enc.encrypted;
      newNonce = enc.nonce;
    }

    const { rows } = await getPool().query(
      `UPDATE mcp_servers SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        transport = COALESCE($3, transport),
        connection_config_encrypted = COALESCE($4, connection_config_encrypted),
        connection_config_nonce = COALESCE($5, connection_config_nonce),
        updated_at = NOW()
       WHERE id = $6 ${admin ? '' : 'AND created_by = $7'}
       RETURNING ${PUBLIC_COLUMNS}`,
      admin
        ? [name, description, transport, newEncrypted, newNonce, req.params.id]
        : [name, description, transport, newEncrypted, newNonce, req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'MCP server not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error('[mcp-servers] Update error:', err);
    res.status(500).json({ error: 'Failed to update MCP server' });
  }
});

// ── Delete MCP server ───────────────────────────────────────────────
router.delete('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rowCount } = await getPool().query(
      `DELETE FROM mcp_servers WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'MCP server not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[mcp-servers] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete MCP server' });
  }
});

// Exported so tests/services that legitimately need the plaintext (a future
// MCP gateway connecting to the actual server) can decrypt without
// duplicating the key/algorithm choice. Not used directly in any response —
// no route ever returns the plaintext.
export function decryptConnectionConfig(encrypted: Buffer, nonce: Buffer): unknown {
  return JSON.parse(decryptProviderKey(encrypted, nonce, getEncryptionKey()));
}

// The list/detail views need *something* to show — a credential-bearing
// field the UI cannot read at all is #354/#370's shape again, just moved
// server-side. This is structural stripping, not secret-pattern-matching:
// it never inspects a value to guess whether it "looks like" a token, it
// only ever keeps pieces of the shape that cannot themselves carry one.
//   stdio  — command verbatim (a binary name, e.g. "npx"), plus COUNTS of
//            args/env entries. A credential can land in args (a plain
//            string, "--token ghp_xxx") or env (arbitrary key-value), so
//            neither's VALUES are ever included — only how many there are.
//   sse/http — the URL's origin only (scheme+host+port via the URL parser),
//            never path or query, which is exactly where a token or
//            signed URL parameter would live. An unparseable URL yields no
//            origin at all rather than falling back to the raw string.
// Built from the DECRYPTED value, computed here, never from anything the
// client sends — the display can't be spoofed into showing something the
// stored config doesn't actually have.
export function buildConnectionDisplay(config: unknown): Record<string, unknown> {
  const cfg = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;

  if (Array.isArray(cfg.args) || typeof cfg.command === 'string' || cfg.env !== undefined) {
    const display: Record<string, unknown> = {};
    if (typeof cfg.command === 'string') display.command = cfg.command;
    if (Array.isArray(cfg.args)) display.args_count = cfg.args.length;
    if (cfg.env && typeof cfg.env === 'object') display.env_count = Object.keys(cfg.env).length;
    return display;
  }

  if (typeof cfg.url === 'string') {
    try {
      return { url_origin: new URL(cfg.url).origin };
    } catch {
      return {};
    }
  }

  return {};
}

// Decrypts a row's connection_config, replaces the encrypted columns with
// the derived connection_display, and returns a NEW object — the encrypted
// Buffers never survive into what gets passed to res.json.
function withConnectionDisplay(row: Record<string, unknown>): Record<string, unknown> {
  const { connection_config_encrypted, connection_config_nonce, ...rest } = row;
  const config = decryptConnectionConfig(
    connection_config_encrypted as Buffer,
    connection_config_nonce as Buffer
  );
  return { ...rest, connection_display: buildConnectionDisplay(config) };
}

export default router;
