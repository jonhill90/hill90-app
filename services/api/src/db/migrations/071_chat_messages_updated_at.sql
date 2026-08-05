-- Migration 071: Add updated_at to chat_messages (app#437 follow-up)
--
-- The stale-message sweeper (routes/chat.ts) can only tell a genuinely
-- stuck message from one still actively progressing by comparing against
-- the time of its LAST update, not its creation time. chat_messages had
-- no such column — created_at is fixed at insert and untouched by the
-- 'thinking' progress callback or the final complete/error one, so a
-- message legitimately receiving repeated thinking updates for longer
-- than the sweeper's threshold would be indistinguishable, by created_at
-- alone, from one that stalled the moment it was created.

ALTER TABLE chat_messages ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill: best available approximation for existing rows is their own
-- creation time, since no history of prior updates exists to recover.
UPDATE chat_messages SET updated_at = created_at;
