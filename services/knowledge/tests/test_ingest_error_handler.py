"""ingest_source's own failure handler — the code that only runs once
ingestion has already failed some other way.

THE DEFECT. `ingest_source`'s `except Exception as exc:` block calls
`shared_store.update_ingest_job(status="failed")` and
`shared_store.update_source_status(status="error")` UNGUARDED. If either of
those compensation writes itself raises — the same class of DB blip that
plausibly caused the ORIGINAL failure in the first place — the new exception
propagates out of `ingest_source` uncaught. The caller
(`routes/internal_admin_shared.py`'s `create_source`) only catches
`IngestError`, not a bare `Exception`, so this becomes an unhandled 500 with
the compensation-write's error, not the original ingest failure, and the
`ingest_jobs`/`shared_sources` rows are left in whatever pre-failure state
they were in — never marked `failed`/`error` — with no record of what
actually went wrong.

WHAT THIS TEST PROVES. That a failure while RECORDING a failure does not
destroy the original error, and does not leave the job/source unresolved.
It does not prove the compensation writes always succeed against a real
Postgres — that's `tests/integration/`'s job.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.ingest import ingest_source


class TestIngestErrorHandlerSurvivesItsOwnCompensationWriteFailing:
    @pytest.mark.asyncio
    async def test_a_failed_compensation_write_does_not_swallow_the_original_error(self):
        fake_source = {
            "id": "src-1", "collection_id": "col-1", "title": "T",
            "raw_content": "x", "source_type": "text",
        }
        fake_job = {"id": "job-1"}

        with (
            patch("app.services.ingest.shared_store.create_source", AsyncMock(return_value=fake_source)),
            patch("app.services.ingest.shared_store.create_ingest_job", AsyncMock(return_value=fake_job)),
            # First call marks the job 'running' (succeeds); the SECOND call is
            # the except block's own compensation write, marking it 'failed' —
            # THAT ONE fails here, simulating the same DB blip class that could
            # plausibly have caused the original failure below.
            patch(
                "app.services.ingest.shared_store.update_ingest_job",
                AsyncMock(side_effect=[None, RuntimeError("pool exhausted during compensation write")]),
            ),
            patch(
                "app.services.ingest.shared_store.update_source_status",
                AsyncMock(side_effect=RuntimeError("pool exhausted during compensation write")),
            ),
            # The ORIGINAL failure this whole handler exists to record.
            patch(
                "app.services.ingest.shared_store.create_document",
                AsyncMock(side_effect=RuntimeError("original failure: document insert failed")),
            ),
        ):
            result = await ingest_source(
                pool=object(),
                collection_id="col-1",
                title="T",
                source_type="text",
                raw_content="some real content that chunks cleanly",
                created_by="user-1",
            )

        # THE ASSERTION THAT MATTERS: ingest_source must still return the
        # ORIGINAL error, not raise (or return) whatever the compensation
        # write's own failure was.
        assert result["ingest_job"]["status"] == "failed"
        assert "original failure: document insert failed" in result["ingest_job"]["error_message"]
        assert result["source"]["status"] == "error"
