-- app#369: mcp_servers.connection_config stored MCP server credentials
-- (a command's --token args, an env block) in plain JSONB, at rest and on
-- every read — unlike provider_connections, which encrypts the identical
-- class of secret with AES-256-GCM before it ever reaches the database.
--
-- Fixed by applying that same, already-established pattern rather than
-- inventing a second one: the whole connection_config blob is now AES-256-GCM
-- ciphertext plus its nonce, matching provider_connections' api_key_encrypted
-- / api_key_nonce column shape exactly.
--
-- WHOLE-BLOB, NOT PER-KEY. connection_config is heterogeneous by transport —
-- stdio carries command/args/env, sse/http carries url — and the UI's own
-- form invites a credential directly into `args` (a plain string, e.g.
-- `--token ghp_xxx`) or `env` (arbitrary key-value), not a single named
-- "secret" field. An allowlist of "safe" cleartext keys would have to be
-- maintained as transports grow and would be exactly the kind of assumption
-- that goes stale silently. Zero rows exist, so there is no cost to choosing
-- the more conservative shape now instead of the cheaper-looking one.
--
-- mcp_servers has ZERO rows in production (confirmed before this migration
-- was written) — no ciphertext migration, no dual-read window, no rollback
-- complexity, and the empty table is why NOT NULL can be added directly
-- rather than backfilled.
ALTER TABLE mcp_servers DROP COLUMN connection_config;
ALTER TABLE mcp_servers ADD COLUMN connection_config_encrypted BYTEA NOT NULL;
ALTER TABLE mcp_servers ADD COLUMN connection_config_nonce BYTEA NOT NULL;
