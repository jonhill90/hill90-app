-- Docker already knows when a container's most recent run ended; the
-- reconciler read `info.State.FinishedAt` on every inspect and discarded it,
-- then guessed NOW() for every session it closed (#213, #285).
--
-- Carried here in queryable form, on `agents` rather than `agent_sessions`,
-- because it is written at inspect time (per agent, per reconcile pass) and
-- read at sweep time (per stopped agent) — two different moments that need a
-- column to pass the value between them. `closeSessionsForStoppedAgents()`
-- uses it in place of NOW() when it is present, and leaves the close
-- estimated, exactly as before, when it is NULL — which is still true
-- whenever the container has been fully removed and Docker has nothing left
-- to ask.
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS container_finished_at TIMESTAMPTZ NULL;
