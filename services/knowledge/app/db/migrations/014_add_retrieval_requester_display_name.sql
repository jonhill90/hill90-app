-- app#499: "we don't want that strange guid to represent users or agents.
-- we want the names." KnowledgeGraph.tsx renders a `user` node's label
-- verbatim -- which was the raw Keycloak `sub`, because that is literally
-- all `shared_retrievals.requester_id` ever stored.
--
-- The knowledge service has no access to Keycloak and deliberately should
-- not gain one just for a display string (a new coupling on every read path
-- for a cosmetic concern). The api DOES already see the caller's own name
-- on every request that can write a retrieval row -- the Keycloak token's
-- `name`/`preferred_username` claims -- so this is resolved AT WRITE TIME:
-- the api forwards the caller's own display name alongside `requester_id`
-- when it records a search, and it is stored durably here.
--
-- This only ever captures the CURRENT caller's own name, for their OWN row
-- -- there is no lookup of anyone else's identity anywhere in this change.
-- An agent's retrieval (requester_type='agent') never has a Keycloak token
-- to read a name from, so this column stays NULL for those rows, which is
-- correct: agent nodes render `agent_id`, a slug, and were never the GUID
-- problem this issue is about.
--
-- Nullable and unbacked by design: existing rows have no name to backfill
-- (the api never captured one before this), and the reader falls back to
-- the raw sub for any row where this is NULL -- same rendering as before
-- this migration, not a regression, just not yet improved for old data.

ALTER TABLE shared_retrievals
    ADD COLUMN IF NOT EXISTS requester_display_name VARCHAR(255) DEFAULT NULL;
