-- A session close the service GUESSED, marked as a guess (#213).
--
-- `agent_sessions` rows are opened by `POST /agents/:id/start` and closed by
-- `POST /agents/:id/stop`. Anything that stops an agent WITHOUT going through
-- that route — a killed container, a host reboot, an API restart, or the
-- reconciler demoting an agent whose container has vanished — leaves the row
-- open, and the uptime sum (`COALESCE(stopped_at, NOW()) - started_at`) then
-- accrues for ever. Wrong HIGH, unbounded, and in the flattering direction.
--
-- The reconciler can now close those rows, but it only knows the container is
-- GONE, never when it went. So the close is stamped as an estimate rather than
-- presented as the true stop time, and the stats endpoints report how much of a
-- total rests on one. A number that cannot say "part of this is a guess" is the
-- shape this issue is about; adding a guess without saying so would be the same
-- defect wearing a fix.
ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS stopped_at_estimated BOOLEAN NOT NULL DEFAULT FALSE;
