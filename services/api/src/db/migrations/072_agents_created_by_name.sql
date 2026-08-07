-- Migration 072: agents.created_by_name (app#499)
--
-- AgentDetailClient.tsx's "Created ... by" line is the same raw-Keycloak-sub
-- rendering #499 fixed in the shared-knowledge graph, in a different table:
-- `session.user?.sub === agent.created_by ? ... : agent.created_by?.slice(0, 8) + '…'`
-- — "you" for yourself, a truncated GUID for whoever else created the agent.
--
-- Same fix, same reasoning: resolved AT WRITE TIME, from the CALLER's own
-- Keycloak token, at the one moment this codebase can ever legitimately
-- know it — POST /agents already has `req.user` in hand. No lookup of
-- anyone else's identity is added anywhere by this column.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255) DEFAULT NULL;
