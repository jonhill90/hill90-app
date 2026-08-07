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
    const page = parsePageParams(req);
    if ('error' in page) {
      res.status(400).json({ error: page.error });
      return;
    }

    // #300: PROXIED, not queried. This handler used to run four statements
    // through `getPool()` against `shared_collections`, `shared_sources` and
    // `knowledge_entries` — tables that live in the KNOWLEDGE service's
    // database and do not exist in this one. Measured: five such tables in
    // `hill90_akm`, zero in `hill90_api`. So the endpoint answered 500 on every
    // call, and the page rendered "Failed to load graph" — a visibly broken
    // feature rather than a silent one, and the only reason anyone could have
    // known.
    //
    // The bounded lists, the COUNT(*) totals and the dangling-edge rule moved
    // WITH the queries rather than being reimplemented here over paginated
    // responses: the count belongs next to the data it counts, and two copies
    // of that logic is how the twin defects in this repository start.
    //
    // Cross-service sibling-drift sweep (app#445 family): this route never
    // called scopeToOwner, unlike its own siblings below (/collections etc.)
    // — a plain `user`-role caller could see every other user's private
    // collection and source names via the graph. Scoped identically now.
    const scope = scopeToOwner(req);
    const owner = scope.where === '1=1' ? undefined : (req as any).user.sub;
    const { status, data } = await skProxy.getGraph(page.limit ?? DEFAULT_PAGE, owner);
    res.status(status).json(data);
  } catch (err: any) {
    console.error('[shared-knowledge] Graph error:', err);
    res.status(502).json({ error: 'Knowledge service unreachable' });
  }
});

router.get('/stats', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const since = req.query.since as string | undefined;
    // Same fix as /graph above — this route never called scopeToOwner either,
    // leaking every user's top_collections/top_sources names to any caller.
    const scope = scopeToOwner(req);
    const owner = scope.where === '1=1' ? undefined : (req as any).user.sub;
    const result = await skProxy.getStats(since, owner);
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
    // #180: forward the real total. Without it the UI counts what it was
    // handed, and a page of 200 renders as "200 sources" over a collection of
    // 300 — bounded, and silently so, which is the defect wearing a fix.
    if (result.total !== null) {
      res.setHeader('X-Total-Count', String(result.total));
    }
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

    // app#499: "we don't want that strange guid to represent users... we
    // want the names." The knowledge service has no Keycloak access and
    // deliberately shouldn't gain one just to resolve a display string —
    // but THIS request already carries the caller's own Keycloak token,
    // which the api verified moments ago in requireAuth, and that token's
    // payload IS this user's own name. Forwarded once, here, at the one
    // point this codebase can ever legitimately know it — nothing downstream
    // ever looks up anyone ELSE's identity. `name` (Keycloak's standard
    // first+last claim) is preferred over `preferred_username` (the login
    // handle) because a graph node is meant to read as a person, not an
    // account name; falls back to preferred_username when a directory entry
    // has no first/last name set, and to nothing (the pre-#499 raw-sub
    // rendering) when the token carries neither.
    const requesterDisplayName: string | undefined = user.name || user.preferred_username || undefined;

    const result = await skProxy.searchShared({
      q,
      collection_id: req.query.collection_id as string | undefined,
      owner,
      requester_id: user.sub,
      requester_type: 'user',
      requester_display_name: requesterDisplayName,
      limit: req.query.limit as string | undefined,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[shared-knowledge] Search error:', err);
    res.status(500).json({ error: 'Failed to search shared knowledge' });
  }
});

export default router;
