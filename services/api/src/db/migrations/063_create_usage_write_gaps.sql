-- Usage rows that were NEVER WRITTEN, recorded as a fact instead of as an absence.
--
-- Every `log_usage` call site in `services/ai` is wrapped in a handler that logs
-- and continues, which is the right call for the request — a metering failure
-- must not fail an inference the user is waiting on. The consequence is that
-- `model_usage` can be missing rows, and `COUNT(*)`/`SUM(...)` over what landed
-- cannot tell a request that was never recorded from one that cost nothing. The
-- symptom is a total that is smaller than the truth and looks like a quiet
-- period; nobody notices absent rows (#261).
--
-- This table does NOT recover the lost rows — their token counts and cost are
-- gone. It records that N of them were lost in a window, so a total can be
-- qualified rather than silently understated.
--
-- Written on the NEXT SUCCESSFUL usage write, not by a retry: the database was
-- unreachable at the moment of failure, so the gap converges into the record as
-- soon as it is reachable again.
CREATE TABLE IF NOT EXISTS usage_write_gaps (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    missed_count   INTEGER NOT NULL,
    first_failed_at TIMESTAMPTZ NOT NULL,
    last_failed_at  TIMESTAMPTZ NOT NULL,
    reason         TEXT,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The read is "did any writes fail in the window I am summing?", which is a
-- range over the failure timestamps rather than over recorded_at.
CREATE INDEX IF NOT EXISTS idx_usage_write_gaps_window
    ON usage_write_gaps (first_failed_at, last_failed_at);
