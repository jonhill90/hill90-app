"""Atomic file I/O and knowledge store operations."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import asyncpg
import structlog

from app.middleware.agent_auth import AgentClaims
from app.services.frontmatter import parse_frontmatter
from app.services.path_policy import validate_path

logger = structlog.get_logger()


def _resolve_file_path(data_dir: str, agent_id: str, path: str) -> Path:
    """Resolve an agent-relative path to an absolute file path."""
    return Path(data_dir) / "agents" / agent_id / path


def _resolve_shared_path(data_dir: str, path: str) -> Path:
    """Resolve a shared namespace path to an absolute file path."""
    return Path(data_dir) / "shared" / path


async def atomic_file_write(file_path: Path, content: str) -> None:
    """Write content atomically using tmp+fsync+rename."""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(file_path.parent), suffix=".tmp", prefix=".akm_"
    )
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp_path, str(file_path))
    except Exception:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


async def create_entry(
    pool: asyncpg.Pool,
    data_dir: str,
    claims: AgentClaims,
    path: str,
    content: str,
) -> dict[str, Any]:
    """Create a new knowledge entry (DB-first, then file write).

    Returns the created entry as a dict.
    """
    path = validate_path(path)
    meta, body = parse_frontmatter(content)
    content_hash = hashlib.sha256(content.encode()).hexdigest()

    # DB-first: insert with sync_status='pending'
    row = await pool.fetchrow(
        """INSERT INTO knowledge_entries
           (agent_id, path, title, entry_type, body, content_hash, tags, sync_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING id, agent_id, path, title, entry_type, content_hash, tags,
                     status, sync_status, created_at, updated_at""",
        claims.sub,
        path,
        meta["title"],
        meta["type"],
        content,
        content_hash,
        meta.get("tags", []),
    )

    entry = dict(row)

    # Attempt file write (non-blocking — reconciler catches failures)
    try:
        file_path = _resolve_file_path(data_dir, claims.sub, path)
        await atomic_file_write(file_path, content)
        await pool.execute(
            "UPDATE knowledge_entries SET sync_status = 'synced' WHERE id = $1",
            entry["id"],
        )
        entry["sync_status"] = "synced"
    except Exception:
        logger.warning(
            "file_write_failed_reconciler_will_retry",
            entry_id=str(entry["id"]),
            path=path,
            agent_id=claims.sub,
        )
        # entry["sync_status"] remains "pending" — accurate representation

    return entry


async def read_entry(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    path: str,
) -> dict[str, Any] | None:
    """Read a knowledge entry by path. Returns None if not found or not authorized."""
    path = validate_path(path)
    row = await pool.fetchrow(
        """SELECT id, agent_id, path, title, entry_type, body as content, content_hash,
                  tags, status, sync_status, created_at, updated_at
           FROM knowledge_entries
           WHERE agent_id = $1 AND path = $2 AND status = 'active'""",
        claims.sub,
        path,
    )
    if row is None:
        return None
    return dict(row)


async def read_entry_cross_agent(
    pool: asyncpg.Pool,
    requesting_agent: str,
    owner_agent: str,
    path: str,
) -> dict[str, Any] | None:
    """Attempt to read another agent's entry. Returns None — cross-agent reads are forbidden."""
    return None  # Explicitly forbidden


async def update_entry(
    pool: asyncpg.Pool,
    data_dir: str,
    claims: AgentClaims,
    path: str,
    content: str,
) -> dict[str, Any] | None:
    """Update an existing knowledge entry."""
    path = validate_path(path)
    meta, body = parse_frontmatter(content)
    content_hash = hashlib.sha256(content.encode()).hexdigest()

    row = await pool.fetchrow(
        """UPDATE knowledge_entries
           SET title = $3, entry_type = $4, body = $5, content_hash = $6,
               tags = $7, sync_status = 'pending', updated_at = NOW()
           WHERE agent_id = $1 AND path = $2 AND status = 'active'
           RETURNING id, agent_id, path, title, entry_type, content_hash, tags,
                     status, sync_status, created_at, updated_at""",
        claims.sub,
        path,
        meta["title"],
        meta["type"],
        content,
        content_hash,
        meta.get("tags", []),
    )

    if row is None:
        return None

    entry = dict(row)

    # Attempt file write
    try:
        file_path = _resolve_file_path(data_dir, claims.sub, path)
        await atomic_file_write(file_path, content)
        await pool.execute(
            "UPDATE knowledge_entries SET sync_status = 'synced' WHERE id = $1",
            entry["id"],
        )
        entry["sync_status"] = "synced"
    except Exception:
        logger.warning(
            "file_write_failed_reconciler_will_retry",
            entry_id=str(entry["id"]),
            path=path,
        )
        # entry["sync_status"] remains "pending" — accurate representation

    return entry


async def archive_entry(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    path: str,
) -> dict[str, Any] | None:
    """Soft-delete (archive) an entry."""
    path = validate_path(path)
    row = await pool.fetchrow(
        """UPDATE knowledge_entries
           SET status = 'archived', updated_at = NOW()
           WHERE agent_id = $1 AND path = $2 AND status = 'active'
           RETURNING id, path, status""",
        claims.sub,
        path,
    )
    if row is None:
        return None
    return {"archived": True, "id": row["id"], "path": row["path"]}


async def list_entries(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    entry_type: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """List one page of entries for the authenticated agent.

    Returns ``(rows, total)`` where ``total`` is a ``COUNT(*)`` over the same
    ``WHERE`` as the page — never ``len(rows)``. A total derived from the page
    is a number that agrees with itself and reports truncation as
    completeness, which is the defect this bound exists to prevent (#183).

    The ``id`` tiebreak is load-bearing: entries written in the same instant
    share an ``updated_at``, and paging over a non-unique sort key can hand
    one row to two pages and no page to another.
    """
    if entry_type:
        rows = await pool.fetch(
            """SELECT id, path, title, entry_type, tags, status, sync_status,
                      created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active' AND entry_type = $2
               ORDER BY updated_at DESC, id DESC
               LIMIT $3 OFFSET $4""",
            claims.sub,
            entry_type,
            limit,
            offset,
        )
        total = await pool.fetchval(
            """SELECT COUNT(*)
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active' AND entry_type = $2""",
            claims.sub,
            entry_type,
        )
    else:
        rows = await pool.fetch(
            """SELECT id, path, title, entry_type, tags, status, sync_status,
                      created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active'
               ORDER BY updated_at DESC, id DESC
               LIMIT $2 OFFSET $3""",
            claims.sub,
            limit,
            offset,
        )
        total = await pool.fetchval(
            """SELECT COUNT(*)
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active'""",
            claims.sub,
        )
    return [dict(r) for r in rows], total


SEARCH_PAGE_LIMIT = 20


async def search_entries(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    query: str,
) -> tuple[list[dict[str, Any]], int]:
    """Full-text search within the agent's namespace.

    Returns ``(rows, total_matches)`` — the page, and HOW MANY MATCHED.

    The second value is a ``COUNT(*)`` over the same predicate as the page,
    never ``len(rows)``. `internal_admin.py` was fixed this way in #209 and this
    twin two files away was not, in the same session that wrote the
    look-for-the-twin rule into CONTRIBUTING (#234). A total derived from the
    page it describes agrees with itself, which is precisely what makes the
    class invisible: twenty rows and the word twenty, and nothing to notice.
    """
    rows = await pool.fetch(
        """SELECT id, path, title, entry_type, tags,
                  ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS score,
                  ts_headline('english', body, websearch_to_tsquery('english', $2),
                              'StartSel=**, StopSel=**, MaxFragments=3, MaxWords=50') AS headline,
                  created_at, updated_at
           FROM knowledge_entries
           WHERE agent_id = $1
             AND status = 'active'
             AND search_vector @@ websearch_to_tsquery('english', $2)
           ORDER BY score DESC
           LIMIT $3""",
        claims.sub,
        query,
        SEARCH_PAGE_LIMIT,
    )
    total_matches = await pool.fetchval(
        """SELECT COUNT(*)
           FROM knowledge_entries
           WHERE agent_id = $1
             AND status = 'active'
             AND search_vector @@ websearch_to_tsquery('english', $2)""",
        claims.sub,
        query,
    )
    return [dict(r) for r in rows], int(total_matches or 0)


# ---------------------------------------------------------------------------
# Private-memory graph (app#501)
# ---------------------------------------------------------------------------
#
# A SECOND producer into the node-type contract services/ui's KnowledgeGraph.tsx
# already renders (docs/contracts/graph-node-types.json, app#380/#381) — that
# renderer takes nodes/edges and does not care which service or which Postgres
# database they came from. shared_store.py's GraphNodeType/GRAPH_NODE_TYPES
# stays exactly as it was; it declares what THAT function can emit, not the
# renderer's full vocabulary. This module declares its own, and the manifest
# is the union of both — see test_graph_node_type_contract.py for the updated
# assertion this split requires.
class EntryGraphNodeType:
    AGENT = "agent"
    ENTRY = "entry"


ENTRY_GRAPH_NODE_TYPES: frozenset[str] = frozenset({
    EntryGraphNodeType.AGENT, EntryGraphNodeType.ENTRY,
})


async def entries_graph(
    pool: asyncpg.Pool, limit: int, *, agent_ids: list[str] | None = None
) -> dict[str, Any]:
    """Nodes, edges and totals for the private-memory graph (app#501).

    OWNER/AUTHORITY, decided rather than assumed (app#501's own text asks for
    this explicitly): this table has no owner/created_by column at all —
    unlike shared_store.py's tables, ownership here is entirely indirect,
    via which Keycloak user's `agents` row a given `agent_id` belongs to.
    This function does not resolve that itself, and is not supposed to:
    `agent_ids`, when given, IS the caller's already-decided visibility —
    computed by the api's own `getAllowedAgentIds` (routes/knowledge.ts),
    the exact mechanism `routes/knowledge.ts`'s existing entries/search
    endpoints already use to answer "which agents can this caller see". This
    function trusts that list the same way `internal_admin.py`'s own header
    already states policy for this file's sibling endpoints: "The knowledge
    service trusts the API service to pass the correct agent_id filters."
    `agent_ids=None` means no filter — the ADMIN path, reached only when the
    api's own scoping resolved to "sees everything", never a default.

    A dedicated app#499 note: this graph is single-owner (or admin-only) by
    construction — no `user` node type, no requester identity anywhere in
    this query, so the sub-vs-name rendering problem #499 fixed for shared
    knowledge does not arise here at all.
    """
    agent_filter = "" if agent_ids is None else "AND agent_id = ANY($2::text[])"
    agent_params: tuple = (limit,) if agent_ids is None else (limit, agent_ids)

    agents = await pool.fetch(
        f"""SELECT agent_id, COUNT(*) AS entry_count, MAX(updated_at) AS last_updated
              FROM knowledge_entries
             WHERE status = 'active' {agent_filter}
          GROUP BY agent_id
          ORDER BY last_updated DESC
             LIMIT $1""",
        *agent_params,
    )
    entries = await pool.fetch(
        f"""SELECT id, agent_id, path, title, entry_type, tags, status,
                   created_at, updated_at
              FROM knowledge_entries
             WHERE status = 'active' {agent_filter}
          ORDER BY updated_at DESC, id DESC
             LIMIT $1""",
        *agent_params,
    )

    # knowledge_links (migration 002) exists for [[wikilink]] cross-referencing
    # but, as of this function, NOTHING WRITES TO IT — create_entry/update_entry
    # never populate it. This join is therefore correct and safe (it will
    # simply return zero rows against every real deployment today) but is not
    # yet provable against real production data, only against rows this PR's
    # own tests insert directly. Written now so the graph is ready the moment
    # a wikilink-parsing writer exists, rather than needing a second PR to
    # wire up structure that is otherwise already in the schema.
    #
    # A link only resolves WITHIN the same agent — target_path is unique per
    # agent_id (knowledge_entries' own UNIQUE (agent_id, path)), so matching
    # cross-agent would be matching on a coincidence, not a real reference.
    # Own filter/params rather than reusing agent_filter/agent_params: this
    # query has no LIMIT param, so reusing the ($1=limit, $2=agent_ids) pair
    # would pass an unused $1 while referencing a $2 the query never defines
    # relative to itself — a real asyncpg parameter-count mismatch, not a
    # style choice.
    links_filter = "" if agent_ids is None else "AND ke_source.agent_id = ANY($1::text[])"
    links_params: tuple = () if agent_ids is None else (agent_ids,)
    links = await pool.fetch(
        f"""SELECT kl.source_id, ke_target.id AS target_id
              FROM knowledge_links kl
              JOIN knowledge_entries ke_source ON ke_source.id = kl.source_id
         LEFT JOIN knowledge_entries ke_target
                ON ke_target.agent_id = ke_source.agent_id
               AND ke_target.path = kl.target_path
               AND ke_target.status = 'active'
             WHERE ke_source.status = 'active' {links_filter}""",
        *links_params,
    )

    totals_filter = "" if agent_ids is None else "AND agent_id = ANY($1::text[])"
    totals_params: tuple = () if agent_ids is None else (agent_ids,)
    totals = await pool.fetchrow(
        f"""SELECT
              (SELECT COUNT(DISTINCT agent_id) FROM knowledge_entries
                WHERE status = 'active' {totals_filter}) AS agents_with_entries,
              (SELECT COUNT(*) FROM knowledge_entries
                WHERE status = 'active' {totals_filter}) AS entries""",
        *totals_params,
    )

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    dangling_edges = 0

    agent_ids_shown = set()
    for a in agents:
        agent_ids_shown.add(a["agent_id"])
        nodes.append({
            "id": f"agent-{a['agent_id']}", "type": EntryGraphNodeType.AGENT,
            "label": a["agent_id"], "meta": {"entry_count": int(a["entry_count"])},
        })

    entry_ids_shown = set()
    for e in entries:
        entry_ids_shown.add(str(e["id"]))
        node_id = f"entry-{e['id']}"
        nodes.append({
            "id": node_id, "type": EntryGraphNodeType.ENTRY, "label": e["title"],
            "meta": {"entry_type": e["entry_type"], "tags": e["tags"], "status": e["status"]},
        })
        # Same dangling-edge accounting as shared_store.knowledge_graph: an
        # edge is only emitted when the OTHER end is actually on this page.
        # An agent whose own row was cut by the agents-page LIMIT still owns
        # this entry — the entry node stays, only the edge to the (missing)
        # agent node is withheld and counted.
        if e["agent_id"] in agent_ids_shown:
            edges.append({"source": f"agent-{e['agent_id']}", "target": node_id, "label": "contains"})
        else:
            dangling_edges += 1

    for link in links:
        source_id = str(link["source_id"])
        target_id = str(link["target_id"]) if link["target_id"] is not None else None
        # Three ways this can fail to resolve, all counted as dangling rather
        # than silently dropped: the source entry didn't make this page, the
        # link's target_path doesn't match any active entry at all (a
        # genuinely broken wikilink), or the target entry exists but didn't
        # make this page.
        if source_id in entry_ids_shown and target_id is not None and target_id in entry_ids_shown:
            edges.append({"source": f"entry-{source_id}", "target": f"entry-{target_id}", "label": "links"})
        else:
            dangling_edges += 1

    total = {"agents": int(totals["agents_with_entries"]), "entries": int(totals["entries"])}
    shown = {"agents": len(agents), "entries": len(entries)}

    return {
        "nodes": nodes,
        "edges": edges,
        "total": total,
        "shown": shown,
        "dangling_edges": dangling_edges,
        "truncated": any(shown[k] < total[k] for k in total),
    }
