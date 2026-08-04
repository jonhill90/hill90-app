-- A session open the service could not measure exactly, marked as such (#285).
--
-- The mirror of 064's stopped_at_estimated, and NOT symmetric in cause. The
-- stop side's gap was unbounded — the reconciler discovers a dead container on
-- its own schedule, so a guessed close could overstate uptime by an entire
-- outage window. The start side's gap is bounded: `POST /agents/:id/start`
-- writes `started_at` after tool installation and a handful of other
-- in-request steps that all run synchronously after the container already
-- exists, so `NOW()` at INSERT time is off by however long that work took —
-- seconds, not hours, and never unbounded. Still not Docker-measured, which is
-- what this column is for.
ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS started_at_estimated BOOLEAN NOT NULL DEFAULT FALSE;
