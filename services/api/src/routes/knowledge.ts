/**
 * Knowledge proxy routes — read-only access to agent knowledge.
 *
 * Auth pattern matches /agents router:
 * - requireAuth at mount (Keycloak JWT validation in app.ts)
 * - requireRole('user') per-route
 * - scopeToOwner(req) for admin bypass vs user scoping
 *
 * Users see knowledge from their own agents. Admins see all agents' knowledge.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { getPool } from '../db/pool';
import * as akmProxy from '../services/akm-proxy';
import { parsePageParams, DEFAULT_PAGE } from '../helpers/page-params';

const router = Router();

/**
 * Given a request, return the list of agent_ids the user is allowed to see.
 * Admins: null (no filter — see all).
 * Users: list of agent_ids they created.
 */
async function getAllowedAgentIds(req: Request): Promise<string[] | null> {
  const scope = scopeToOwner(req);
  if (scope.where === '1=1') {
    return null; // admin — no filter
  }
  const { rows } = await getPool().query(
    `SELECT agent_id FROM agents WHERE ${scope.where}`,
    scope.params,
  );
  return rows.map((r: { agent_id: string }) => r.agent_id);
}

/**
 * Check if a specific agent_id is owned by the requesting user.
 */
async function isAgentOwned(req: Request, agentId: string): Promise<boolean> {
  const allowed = await getAllowedAgentIds(req);
  if (allowed === null) return true; // admin
  return allowed.includes(agentId);
}

// List agents with knowledge stats
router.get('/agents', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const result = await akmProxy.listAgents();
    if (result.status !== 200) {
      res.status(result.status).json(result.data);
      return;
    }

    // Filter to owned agents for non-admin users
    const allowed = await getAllowedAgentIds(req);
    let agents = result.data as Array<{ agent_id: string }>;
    if (allowed !== null) {
      agents = agents.filter(a => allowed.includes(a.agent_id));
    }

    res.json(agents);
  } catch (err) {
    console.error('[knowledge] List agents error:', err);
    res.status(500).json({ error: 'Failed to list knowledge agents' });
  }
});

// app#501: the private-memory graph — the same visualisation shared
// knowledge already has (KnowledgeGraph.tsx), over each agent's own
// non-shared memory (knowledge_entries) instead.
//
// AUTHORITY, decided rather than assumed (the issue's own explicit ask):
// "non-shared, but I can view" is two different capabilities — viewing
// YOUR OWN agents' memories needs no new privilege at all (getAllowedAgentIds
// already gates every other route in this file the identical way); viewing
// ANY OTHER user's private memories would be a genuinely new admin
// capability, not a side effect of the admin role already existing on this
// route. This ships owner-scoped: an admin sees every agent (scopeToOwner's
// existing '1=1' bypass, the same one every other route here already gets
// for free), a non-admin sees only their own — nobody gains new visibility
// into someone else's data that they did not already have via every other
// /knowledge/* route in this file.
router.get('/graph', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const page = parsePageParams(req);
    if ('error' in page) {
      res.status(400).json({ error: page.error });
      return;
    }

    const allowed = await getAllowedAgentIds(req);
    // A non-admin caller who owns zero agents must see an EMPTY graph, not
    // every agent's memories — and `allowed` here is `[]`, not `null`, so
    // this is not the admin path by accident. Short-circuited here rather
    // than forwarded as `agent_ids=` to the knowledge service: proxyGet
    // (akm-proxy.ts) strips empty-string param values before building the
    // query string, which would silently turn an explicit "see nothing"
    // into an unfiltered "see everything" the moment it crossed that
    // boundary — a real authorization bug, not a cosmetic one. Answering
    // directly here means that stripping behavior never gets a chance to
    // matter.
    if (allowed !== null && allowed.length === 0) {
      res.json({
        nodes: [], edges: [],
        total: { agents: 0, entries: 0 }, shown: { agents: 0, entries: 0 },
        dangling_edges: 0, truncated: false,
      });
      return;
    }

    const result = await akmProxy.getEntriesGraph(allowed, page.limit ?? DEFAULT_PAGE);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[knowledge] Graph error:', err);
    res.status(502).json({ error: 'Knowledge service unreachable' });
  }
});

// List entries for an agent
router.get('/entries', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agent_id as string;
    if (!agentId) {
      res.status(400).json({ error: 'agent_id query parameter is required' });
      return;
    }

    if (!await isAgentOwned(req, agentId)) {
      res.status(403).json({ error: 'Not authorized to view this agent\'s knowledge' });
      return;
    }

    const type = req.query.type as string | undefined;
    const page = parsePageParams(req);
    if ('error' in page) {
      res.status(400).json({ error: page.error });
      return;
    }

    const result = await akmProxy.listEntries(agentId, type, page);

    // Forward the real total. Without this the UI has no way to know its list
    // was cut, and a short list that looks complete is the defect this whole
    // chain exists to remove (#180). The body stays a bare JSON array: the UI
    // does `Array.isArray(data) ? data : []`, so an object here empties the
    // page for any UI build older than this one.
    if (result.total !== null) {
      res.setHeader('X-Total-Count', String(result.total));
    }
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[knowledge] List entries error:', err);
    res.status(500).json({ error: 'Failed to list knowledge entries' });
  }
});

// Read a specific entry
router.get('/entries/:agentId/:path(*)', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const path = req.params.path || req.params[0];

    if (!await isAgentOwned(req, agentId)) {
      res.status(403).json({ error: 'Not authorized to view this agent\'s knowledge' });
      return;
    }

    const result = await akmProxy.readEntry(agentId, path);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[knowledge] Read entry error:', err);
    res.status(500).json({ error: 'Failed to read knowledge entry' });
  }
});

// Create entry
router.post('/entries', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { agent_id, path, content } = req.body;
    if (!agent_id || !path || !content) {
      res.status(400).json({ error: 'agent_id, path, and content are required' });
      return;
    }

    if (!await isAgentOwned(req, agent_id)) {
      res.status(403).json({ error: 'Not authorized to create entries for this agent' });
      return;
    }

    const result = await akmProxy.createEntry(agent_id, path, content);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[knowledge] Create entry error:', err);
    res.status(500).json({ error: 'Failed to create knowledge entry' });
  }
});

// Search entries
router.get('/search', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: 'q query parameter is required' });
      return;
    }

    const agentId = req.query.agent_id as string | undefined;

    // If agent_id specified, verify ownership
    if (agentId) {
      if (!await isAgentOwned(req, agentId)) {
        res.status(403).json({ error: 'Not authorized to search this agent\'s knowledge' });
        return;
      }
      const result = await akmProxy.searchEntries(q, agentId);
      res.status(result.status).json(result.data);
      return;
    }

    // No agent_id — admin searches all, user searches own agents only
    const allowed = await getAllowedAgentIds(req);
    if (allowed === null) {
      // Admin: search all
      const result = await akmProxy.searchEntries(q);
      res.status(result.status).json(result.data);
      return;
    }

    // User: search each owned agent and merge results.
    //
    // The merged total is the SUM OF EACH AGENT'S REAL TOTAL, not the size of the
    // merged array — and certainly not the size of the slice below. Each upstream
    // response is itself capped at 20, so summing `data.results.length` would cap
    // the merged figure at 20 per agent: a number that grows with agent count and
    // has nothing to do with how many entries matched.
    const allResults: Array<Record<string, unknown>> = [];
    let totalMatches = 0;
    for (const aid of allowed) {
      const result = await akmProxy.searchEntries(q, aid);
      if (result.status === 200) {
        const data = result.data as {
          results: Array<Record<string, unknown>>;
          total_matches?: number;
        };
        allResults.push(...data.results);
        // Fall back to the page length only if an older knowledge service is
        // deployed that does not send a total. That undercounts rather than
        // overcounts, and it is visible as `truncated` being wrong, not as a
        // number that silently looks fine.
        totalMatches += Number(data.total_matches ?? data.results.length);
      }
    }

    // Sort by score descending, limit to 20
    allResults.sort((a, b) => ((b.score as number) || 0) - ((a.score as number) || 0));
    const limited = allResults.slice(0, 20);

    res.json({
      query: q,
      results: limited,
      // How many rows are in THIS response.
      count: limited.length,
      // How many matched. Differs from `count` exactly when the page was cut.
      total_matches: totalMatches,
      truncated: totalMatches > limited.length,
      search_type: 'fts',
      score_type: 'ts_rank',
    });
  } catch (err) {
    console.error('[knowledge] Search error:', err);
    res.status(500).json({ error: 'Failed to search knowledge' });
  }
});

export default router;
