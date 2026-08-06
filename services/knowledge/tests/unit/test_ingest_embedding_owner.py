"""ingest_source must attribute the embedding spend it triggers to the real
user who triggered it.

THE GAP. `generate_embeddings` gained an `owner` kwarg specifically so spend
could be attributed instead of landing under a generic internal sentinel
(see app#548). `ingest_source` already has the real identity sitting
in scope — `created_by` — right where it calls `generate_embeddings`, and
was not passing it.

THE ASSERTION THAT MATTERS is what `generate_embeddings` was actually
called WITH, not that ingestion completed successfully — a call with no
owner also "succeeds" and would pass a test that only checked the outcome.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services import ingest


def _mock_pool():
    """ingest_source only ever passes `pool` through to shared_store calls
    that are mocked below — it never touches it directly."""
    return AsyncMock()


@pytest.mark.asyncio
async def test_ingest_source_attributes_embedding_spend_to_created_by():
    with (
        patch.object(ingest.shared_store, "create_source", AsyncMock(return_value={"id": "src-1"})),
        patch.object(ingest.shared_store, "create_ingest_job", AsyncMock(return_value={"id": "job-1"})),
        patch.object(ingest.shared_store, "update_ingest_job", AsyncMock()),
        patch.object(ingest.shared_store, "create_document", AsyncMock(return_value={"id": "doc-1", "title": "Doc", "chunk_count": 1})),
        patch.object(ingest.shared_store, "create_chunks", AsyncMock(return_value=(1, 1))),
        patch.object(ingest.shared_store, "embedding_status_for", lambda inserted, embedded: "embedded"),
        patch.object(ingest.shared_store, "set_document_embedding_status", AsyncMock()),
        patch.object(ingest.shared_store, "update_source_status", AsyncMock()),
        patch("app.services.embeddings.generate_embeddings", AsyncMock(return_value=[[0.1, 0.2]])) as mock_gen,
    ):
        await ingest.ingest_source(
            _mock_pool(),
            collection_id="col-1",
            title="Doc",
            source_type="text",
            raw_content="hello " * 50,
            created_by="user-99",
        )

    # THE ASSERTION THAT MATTERS: the real user identity reached the
    # embedding call, not merely that ingestion completed.
    mock_gen.assert_called_once()
    _, kwargs = mock_gen.call_args
    assert kwargs.get("owner") == "user-99"
