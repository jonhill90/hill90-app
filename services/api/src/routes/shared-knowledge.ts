/**
 * Shared knowledge proxy routes — user-facing CRUD for shared knowledge.
 *
 * Auth: requireAuth at mount (Keycloak JWT), requireRole('user') per-route.
 * Ownership: scopeToOwner for admin bypass vs user scoping.
 * Proxies to knowledge service /internal/admin/shared/* endpoints.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import * as skProxy from '../services/shared-knowledge-proxy';
import { parsePageParams, DEFAULT_PAGE } from '../helpers/page-params';

const router = Router();

// ---------------------------------------------------------------------------
// Knowledge Graph — visual graph of collections, sources, and agent entries
// ---------------------------------------------------------------------------

router.get('/graph', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { getPool } = await import('../db/pool');
    const pool = getPool();

    const page = parsePageParams(req);
    if ('error' in page) {
      res.status(400).json({ error: page.error });
      return;
    }
    const limit = page.limit ?? DEFAULT_PAGE;

    // Every list here is BOUNDED, and every stat below comes from COUNT(*)
    // rather than from the array's length (#215).
    //
    // Those two changes are one change. `collections.length` was correct only
    // because the query returned everything — a length that is correct only
    // because nothing is bounded is a defect waiting for someone to bound it.
    // Adding the LIMIT without replacing the stats would have silently capped
    // a figure rendered to a user at SharedKnowledgeClient.tsx:155, which is
    // exactly the regression this codebase already shipped once in #188.
    const [
      { rows: collections },
      { rows: sources },
      { rows: agentEntries },
      { rows: countRows },
    ] = await Promise.all([
      pool.query(
        `SELECT id, name, visibility FROM shared_collections ORDER BY name LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT ss.id, ss.title, ss.source_type, ss.collection_id,
                (SELECT count(*) FROM shared_chunks sc
                 JOIN shared_documents sd ON sc.document_id = sd.id
                 WHERE sd.source_id = ss.id) AS chunk_count
         FROM shared_sources ss WHERE ss.status = 'active' ORDER BY ss.title LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT agent_id, count(*) AS entry_count, max(updated_at) AS last_updated
         FROM knowledge_entries WHERE status = 'active'
         GROUP BY agent_id ORDER BY agent_id LIMIT $1`,
        [limit],
      ),
      // Each COUNT is over the same WHERE as the list it describes. The agent
      // figure is COUNT(DISTINCT agent_id) because its list is grouped — a
      // plain COUNT(*) there would count entries, not agents.
      pool.query(
        `SELECT
           (SELECT count(*) FROM shared_collections) AS collections,
           (SELECT count(*) FROM shared_sources WHERE status = 'active') AS sources,
           (SELECT count(DISTINCT agent_id) FROM knowledge_entries WHERE status = 'active')
             AS agents_with_knowledge`,
      ),
    ]);

    // Build graph
    const nodes: Array<{ id: string; type: string; label: string; meta?: Record<string, unknown> }> = [];
    const edges: Array<{ source: string; target: string; label?: string }> = [];

    // Add collection nodes
    const collectionIds = new Set<string>();
    for (const c of collections) {
      collectionIds.add(String(c.id));
      nodes.push({ id: `col-${c.id}`, type: 'collection', label: c.name, meta: { visibility: c.visibility } });
    }

    // Add source nodes + edges to collections
    //
    // The edge is emitted only when its collection node is present. Truncating
    // the collections but not the sources would otherwise produce edges
    // pointing at nodes that do not exist, which is worse than a smaller
    // graph: a renderer either drops them silently or lays out around a
    // phantom.
    let danglingEdges = 0;
    for (const s of sources) {
      nodes.push({ id: `src-${s.id}`, type: 'source', label: s.title, meta: { source_type: s.source_type, chunk_count: Number(s.chunk_count) } });
      if (collectionIds.has(String(s.collection_id))) {
        edges.push({ source: `col-${s.collection_id}`, target: `src-${s.id}`, label: 'contains' });
      } else {
        danglingEdges++;
      }
    }

    // Add agent nodes + edges
    for (const a of agentEntries) {
      nodes.push({ id: `agent-${a.agent_id}`, type: 'agent', label: a.agent_id, meta: { entry_count: Number(a.entry_count) } });
    }

    const total = {
      collections: Number(countRows[0].collections),
      sources: Number(countRows[0].sources),
      agents_with_knowledge: Number(countRows[0].agents_with_knowledge),
    };
    const shown = {
      collections: collections.length,
      sources: sources.length,
      agents_with_knowledge: agentEntries.length,
    };

    res.json({
      nodes,
      edges,
      // `stats` keeps its name and its meaning — the size of the corpus — and
      // is now measured rather than inferred from the page.
      stats: total,
      // What this response actually contains, so a partial graph can say so
      // instead of looking like a small corpus. Present even when nothing was
      // truncated, so its absence never has to be interpreted.
      shown,
      truncated:
        shown.collections < total.collections ||
        shown.sources < total.sources ||
        shown.agents_with_knowledge < total.agents_with_knowledge,
      dangling_edges_omitted: danglingEdges,
    });
  } catch (err) {
    console.error('[shared-knowledge] Graph error:', err);
    res.status(500).json({ error: 'Failed to build knowledge graph' });
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

router.get('/stats', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const since = req.query.since as string | undefined;
    const result = await skProxy.getStats(since);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

router.get('/collections', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const owner = scope.where === '1=1' ? undefined : (req as any).user.sub;
    const result = await skProxy.listCollections(owner);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] List collections error:', err);
    res.status(500).json({ error: 'Failed to list collections' });
  }
});

router.get('/collections/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const result = await skProxy.getCollection(req.params.id);
    if (result.status !== 200) {
      res.status(result.status).json(result.data);
      return;
    }

    // Verify ownership for non-admin users
    const scope = scopeToOwner(req);
    const collection = result.data as { created_by: string; visibility: string };
    if (scope.where !== '1=1') {
      const user = (req as any).user;
      if (collection.created_by !== user.sub && collection.visibility !== 'shared') {
        res.status(404).json({ error: 'Collection not found' });
        return;
      }
    }

    res.json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Get collection error:', err);
    res.status(500).json({ error: 'Failed to get collection' });
  }
});

router.post('/collections', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = await skProxy.createCollection({
      name: req.body.name,
      description: req.body.description || '',
      visibility: req.body.visibility || 'private',
      created_by: user.sub,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Create collection error:', err);
    res.status(500).json({ error: 'Failed to create collection' });
  }
});

router.put('/collections/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    // Verify ownership
    const existing = await skProxy.getCollection(req.params.id);
    if (existing.status !== 200) {
      res.status(existing.status).json(existing.data);
      return;
    }

    const scope = scopeToOwner(req);
    const collection = existing.data as { created_by: string };
    if (scope.where !== '1=1' && collection.created_by !== (req as any).user.sub) {
      res.status(403).json({ error: 'Not authorized to update this collection' });
      return;
    }

    const result = await skProxy.updateCollection(req.params.id, {
      name: req.body.name,
      description: req.body.description,
      visibility: req.body.visibility,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Update collection error:', err);
    res.status(500).json({ error: 'Failed to update collection' });
  }
});

router.delete('/collections/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    // Verify ownership
    const existing = await skProxy.getCollection(req.params.id);
    if (existing.status !== 200) {
      res.status(existing.status).json(existing.data);
      return;
    }

    const scope = scopeToOwner(req);
    const collection = existing.data as { created_by: string };
    if (scope.where !== '1=1' && collection.created_by !== (req as any).user.sub) {
      res.status(403).json({ error: 'Not authorized to delete this collection' });
      return;
    }

    const result = await skProxy.deleteCollection(req.params.id);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Delete collection error:', err);
    res.status(500).json({ error: 'Failed to delete collection' });
  }
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

router.get('/sources', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const collectionId = req.query.collection_id as string;
    if (!collectionId) {
      res.status(400).json({ error: 'collection_id query parameter is required' });
      return;
    }

    // Verify collection visibility
    const collection = await skProxy.getCollection(collectionId);
    if (collection.status !== 200) {
      res.status(collection.status).json(collection.data);
      return;
    }

    const scope = scopeToOwner(req);
    const col = collection.data as { created_by: string; visibility: string };
    if (scope.where !== '1=1' && col.created_by !== (req as any).user.sub && col.visibility !== 'shared') {
      res.status(404).json({ error: 'Collection not found' });
      return;
    }

    const result = await skProxy.listSources(collectionId);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] List sources error:', err);
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

router.get('/sources/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const result = await skProxy.getSource(req.params.id);
    if (result.status !== 200) {
      res.status(result.status).json(result.data);
      return;
    }

    // Verify access via parent collection visibility/ownership
    const src = result.data as { collection_id: string };
    const collection = await skProxy.getCollection(src.collection_id);
    if (collection.status !== 200) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }

    const scope = scopeToOwner(req);
    const col = collection.data as { created_by: string; visibility: string };
    if (scope.where !== '1=1' && col.created_by !== (req as any).user.sub && col.visibility !== 'shared') {
      res.status(404).json({ error: 'Source not found' });
      return;
    }

    res.json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Get source error:', err);
    res.status(500).json({ error: 'Failed to get source' });
  }
});

router.post('/sources', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Verify collection ownership
    const collection = await skProxy.getCollection(req.body.collection_id);
    if (collection.status !== 200) {
      res.status(collection.status).json(collection.data);
      return;
    }

    const scope = scopeToOwner(req);
    const col = collection.data as { created_by: string };
    if (scope.where !== '1=1' && col.created_by !== user.sub) {
      res.status(403).json({ error: 'Not authorized to add sources to this collection' });
      return;
    }

    const result = await skProxy.createSource({
      collection_id: req.body.collection_id,
      title: req.body.title,
      source_type: req.body.source_type,
      raw_content: req.body.raw_content,
      source_url: req.body.source_url,
      created_by: user.sub,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Create source error:', err);
    res.status(500).json({ error: 'Failed to create source' });
  }
});

router.delete('/sources/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    // Verify source ownership via collection
    const source = await skProxy.getSource(req.params.id);
    if (source.status !== 200) {
      res.status(source.status).json(source.data);
      return;
    }

    const src = source.data as { created_by: string };
    const scope = scopeToOwner(req);
    if (scope.where !== '1=1' && src.created_by !== (req as any).user.sub) {
      res.status(403).json({ error: 'Not authorized to delete this source' });
      return;
    }

    const result = await skProxy.deleteSource(req.params.id);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Delete source error:', err);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

router.get('/search', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: 'q query parameter is required' });
      return;
    }

    const user = (req as any).user;
    const scope = scopeToOwner(req);
    const owner = scope.where === '1=1' ? undefined : user.sub;

    const result = await skProxy.searchShared({
      q,
      collection_id: req.query.collection_id as string | undefined,
      owner,
      requester_id: user.sub,
      requester_type: 'user',
      limit: req.query.limit as string | undefined,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Search error:', err);
    res.status(500).json({ error: 'Failed to search shared knowledge' });
  }
});

export default router;
