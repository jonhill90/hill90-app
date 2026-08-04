-- Name whether a document's chunks actually got embedded (#210).
--
-- Embedding is best-effort inside ingest: generate_embeddings() returns None
-- on any failure — AI service unreachable, non-200, timeout, no credentials —
-- and only logs a warning. The ingest then marked the job 'completed' and the
-- source 'active' with no field anywhere distinguishing a fully-embedded
-- source from one with zero embeddings.
--
-- That is a half-completed write reporting as done. The repo already answered
-- this question once, for knowledge_entries: a sync_status column that names
-- the incomplete state, plus a reconciler that converges it. This is the same
-- answer for shared knowledge.
--
-- Values:
--   embedded  every chunk has a vector
--   partial   some chunks have vectors, some do not
--   pending   none do, and it has not been retried
--   failed    a retry ran and did not fix it
--
-- Backfill of existing rows is deliberately 'pending' rather than 'embedded':
-- claiming coverage we have not verified would be the same defect this column
-- exists to remove. The recompute below corrects the ones we CAN prove.

ALTER TABLE shared_documents
    ADD COLUMN IF NOT EXISTS embedding_status VARCHAR(16) NOT NULL DEFAULT 'pending';

ALTER TABLE shared_documents
    DROP CONSTRAINT IF EXISTS shared_documents_embedding_status_check;

ALTER TABLE shared_documents
    ADD CONSTRAINT shared_documents_embedding_status_check
    CHECK (embedding_status IN ('embedded', 'partial', 'pending', 'failed'));

-- Set existing rows from what is actually in the table, rather than assuming.
UPDATE shared_documents d
SET embedding_status = sub.status
FROM (
    SELECT c.document_id,
           CASE
               WHEN COUNT(*) FILTER (WHERE c.embedding IS NOT NULL) = 0 THEN 'pending'
               WHEN COUNT(*) FILTER (WHERE c.embedding IS NULL) = 0 THEN 'embedded'
               ELSE 'partial'
           END AS status
    FROM shared_chunks c
    GROUP BY c.document_id
) sub
WHERE d.id = sub.document_id;

-- Finding the un-embedded corpus is the whole point of the backfill, and it
-- is a WHERE on a NULL column over every chunk.
CREATE INDEX IF NOT EXISTS idx_schk_embedding_null
    ON shared_chunks (document_id)
    WHERE embedding IS NULL;

CREATE INDEX IF NOT EXISTS idx_sd_embedding_status
    ON shared_documents (embedding_status)
    WHERE embedding_status <> 'embedded';
