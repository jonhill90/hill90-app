-- app#374 (found while auditing against #369's mcp_servers fix): workflows.
-- webhook_token was plaintext VARCHAR(64) — a real 32-byte random secret,
-- crypto.randomBytes(32).toString('hex') — and it is the ENTIRE authentication
-- for POST /workflows/webhook/:token, documented in that route's own header
-- as public, no auth. It was returned on every create/list/get/update
-- response and rendered in full into the DOM (a title attribute) on the
-- Workflows list page.
--
-- HASHED, NOT ENCRYPTED — deliberately a different pattern from #369/#372's
-- mcp_servers fix, because the use is different. connection_config is a
-- credential the API must later DECRYPT and use (e.g. to send to a
-- provider); webhook_token is only ever COMPARED for equality against an
-- incoming URL parameter. Hashing is both simpler and stronger for that use
-- — the plaintext need never be recoverable, only reproducible from the
-- token a caller presents. This mirrors agents.model_router_refresh_hash,
-- an already-established in-repo pattern for exactly this shape (a
-- high-entropy bearer secret, checked by equality, never read back).
--
-- UNSALTED SHA-256. Normally a sin for a password hash, deliberately not
-- one here: webhook_token is 256 bits of crypto.randomBytes, never
-- user-chosen, so a precomputed rainbow table is not a meaningful threat —
-- there is no dictionary of "likely" values to precompute against. The
-- threat this defends against is database read access, which a plain
-- digest defeats: an attacker with a copy of the row cannot recover a
-- token that triggers a real webhook.
--
-- ZERO ROWS, CONFIRMED ON PRODUCTION BEFORE THIS MIGRATION WAS WRITTEN
-- (`select count(*) filter (where trigger_type='webhook') as webhook_workflows,
--  count(*) as total from workflows` -> 0, 0) — no backfill, no dual-read
-- window, no rollback complexity. Worth recording explicitly: the migration
-- runner (migrate.ts) executes raw SQL inside a transaction and cannot
-- perform AES-256-GCM or SHA-256 itself — a populated column of this shape
-- would need an app-level backfill step outside what this file can do. Safe
-- here only because there is nothing to backfill.
ALTER TABLE workflows DROP COLUMN webhook_token;
ALTER TABLE workflows ADD COLUMN webhook_token_hash VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_webhook_token_hash
    ON workflows(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
