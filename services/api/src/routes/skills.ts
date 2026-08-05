import { Router, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin, isElevatedScope } from '../helpers/elevated-scope';
import { auditLog } from '../helpers/audit';

const router = Router();

const VALID_SCOPES = ['container_local', 'host_docker', 'vps_system'] as const;

function defaultToolsConfigForScope(_scope: string) {
  return {
    shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
    filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data', '/home/agentuser'], denied_paths: [] },
    health: { enabled: true },
  };
}

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

// Helper: fetch tools for a set of skill IDs via skill_tools join
async function fetchToolsForSkills(skillIds: string[]): Promise<Record<string, any[]>> {
  if (skillIds.length === 0) return {};
  const { rows } = await getPool().query(
    `SELECT st.skill_id, t.id, t.name, t.description, t.install_method
     FROM skill_tools st
     JOIN tools t ON t.id = st.tool_id
     WHERE st.skill_id = ANY($1::uuid[])
     ORDER BY t.name ASC`,
    [skillIds]
  );
  const map: Record<string, any[]> = {};
  for (const row of rows) {
    if (!map[row.skill_id]) map[row.skill_id] = [];
    map[row.skill_id].push({ id: row.id, name: row.name, description: row.description, install_method: row.install_method });
  }
  return map;
}

// Helper: validate and insert skill_tools rows.
//
// Takes a `db` (a transaction client, never the pool directly) so its
// DELETE + INSERTs run on the SAME connection as the skills row write in
// its caller — see #424: this used to always call getPool().query()
// itself, a fresh possibly-different connection on every call, so it was
// never actually atomic with the row write around it despite running
// right after it in the same function. On POST /, a bad tool_id thrown
// here left the skills row already committed while the client was told
// creation failed — a phantom skill on refresh. On PUT /:id, a transient
// failure mid-loop (after the DELETE, partway through re-inserting) left
// only some of the intended tool associations, while the row's other
// fields committed fine.
async function setSkillTools(db: PoolClient, skillId: string, toolIds: string[]): Promise<void> {
  if (!toolIds || toolIds.length === 0) return;

  // Validate all tool_ids exist
  const { rows: existingTools } = await db.query(
    'SELECT id FROM tools WHERE id = ANY($1::uuid[])',
    [toolIds]
  );
  if (existingTools.length !== toolIds.length) {
    const found = new Set(existingTools.map((t: any) => t.id));
    const missing = toolIds.filter(id => !found.has(id));
    throw { validationError: true, message: `Tool(s) not found: ${missing.join(', ')}` };
  }

  // Delete existing and insert new
  await db.query('DELETE FROM skill_tools WHERE skill_id = $1', [skillId]);
  for (const toolId of toolIds) {
    await db.query(
      'INSERT INTO skill_tools (skill_id, tool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [skillId, toolId]
    );
  }
}

// List all skills — all authenticated users see all skills
router.get('/', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM skills ORDER BY is_platform DESC, name ASC`
    );

    // Fetch tools for all skills
    const toolsMap = await fetchToolsForSkills(rows.map((r: any) => r.id));
    const result = rows.map((r: any) => ({ ...r, tools: toolsMap[r.id] || [] }));

    res.json(result);
  } catch (err) {
    console.error('[skills] List error:', err);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

// Skill-tool dependency graph
router.get('/graph', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const [skillResult, edgeResult] = await Promise.all([
      getPool().query(
        `SELECT s.id, s.name, s.scope, s.is_platform,
                COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name))
                  FILTER (WHERE t.id IS NOT NULL), '[]') AS tools
         FROM skills s
         LEFT JOIN skill_tools st ON st.skill_id = s.id
         LEFT JOIN tools t ON t.id = st.tool_id
         GROUP BY s.id
         ORDER BY s.name ASC`
      ),
      getPool().query(
        `SELECT st.skill_id AS source, st.tool_id AS target FROM skill_tools st`
      ),
    ]);

    const skillNodes = skillResult.rows.map((s: any) => ({
      id: s.id, name: s.name, type: 'skill' as const, scope: s.scope, is_platform: s.is_platform,
    }));

    const toolMap = new Map<string, string>();
    for (const row of skillResult.rows) {
      for (const t of row.tools) {
        if (t.id) toolMap.set(t.id, t.name);
      }
    }

    const toolNodes = Array.from(toolMap.entries()).map(([id, name]) => ({
      id, name, type: 'tool' as const,
    }));

    res.json({
      nodes: [...skillNodes, ...toolNodes],
      edges: edgeResult.rows.map((e: any) => ({ source: e.source, target: e.target })),
    });
  } catch (err) {
    console.error('[skills] Graph error:', err);
    res.status(500).json({ error: 'Failed to build skill graph' });
  }
});

// Get single skill
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM skills WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const toolsMap = await fetchToolsForSkills([rows[0].id]);
    res.json({ ...rows[0], tools: toolsMap[rows[0].id] || [] });
  } catch (err) {
    console.error('[skills] Get error:', err);
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

// Create skill — admin only
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description, tools_config, instructions_md, scope, tool_ids } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const resolvedConfig = (tools_config && typeof tools_config === 'object')
      ? tools_config
      : defaultToolsConfigForScope(scope || 'container_local');

    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    if (tool_ids !== undefined && (!Array.isArray(tool_ids) || !tool_ids.every((id: unknown) => typeof id === 'string'))) {
      res.status(400).json({ error: 'tool_ids must be an array of UUIDs' });
      return;
    }

    // The row write and its tool associations are one transaction (#424):
    // either both land or neither does, so a rejected create (a bad
    // tool_id) never leaves a phantom skill row behind.
    const skill = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform, created_by)
         VALUES ($1, $2, $3, $4, $5, false, NULL)
         RETURNING *`,
        [name, description || '', JSON.stringify(resolvedConfig), instructions_md || '', scope || 'container_local']
      );

      if (tool_ids && tool_ids.length > 0) {
        await setSkillTools(client, rows[0].id, tool_ids);
      }

      return rows[0];
    });

    const toolsMap = await fetchToolsForSkills([skill.id]);
    res.status(201).json({ ...skill, tools: toolsMap[skill.id] || [] });
  } catch (err: any) {
    if (err.validationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'A skill with this name already exists' });
      return;
    }
    console.error('[skills] Create error:', err);
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

// Update skill — admin only
router.put('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, scope FROM skills WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const { name, description, tools_config, instructions_md, scope, tool_ids } = req.body;

    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    if (tool_ids !== undefined && (!Array.isArray(tool_ids) || !tool_ids.every((id: unknown) => typeof id === 'string'))) {
      res.status(400).json({ error: 'tool_ids must be an array of UUIDs' });
      return;
    }

    // Scope-Change Safety Contract (D2, D3, D8):
    // No elevated scope transition while tools_config is live in a running container.
    //
    // Scoped deliberately to the SCOPE TRANSITION, not to every tools_config
    // write: a PUT that edits tools_config with oldScope === newScope on an
    // already-elevated, already-assigned skill skips this guard entirely.
    // Verified this is not a gap, not just assumed: a running agent's actual
    // capabilities come from agent.yml, generated once at POST
    // /agents/:id/start from the AGENT row's own tools_config snapshot
    // (agent-files.ts), and agentbox's AgentConfig.from_file() reads that
    // file exactly once at process start (server.py's __main__ block) —
    // no refresh loop ever re-reads it. A skill's tools_config only reaches
    // an agent's row via the resolve-on-save merge in POST/DELETE
    // /agents/:id/skills (assign/unassign), and assignment itself is
    // blocked with 409 while the agent is running. This PUT handler never
    // touches agents.tools_config for an already-assigned agent at all. So
    // an in-place skill edit cannot reach a running container through any
    // code path that exists — the contract's name is accurate as scoped.
    const oldScope = existing[0].scope;
    const newScope = scope || oldScope;
    if (oldScope !== newScope && (isElevatedScope(oldScope) || isElevatedScope(newScope))) {
      // Check for running agents assigned to this skill
      const { rows: runningAgents } = await getPool().query(
        `SELECT a.id, a.agent_id FROM agent_skills asks
         JOIN agents a ON a.id = asks.agent_id
         WHERE asks.skill_id = $1 AND a.status = 'running'`,
        [req.params.id]
      );
      if (runningAgents.length > 0) {
        const user = (req as any).user;
        auditLog('skill_scope_change_blocked', req.params.id, user.sub, 'human', {
          old_scope: oldScope, new_scope: newScope, reason: 'running_agents',
          running_agents: runningAgents.map((a: any) => a.agent_id),
        });
        res.status(409).json({
          error: 'Cannot change scope while running agents are assigned. Stop the agent(s) first.',
          running_agents: runningAgents.map((a: any) => ({ id: a.id, agent_id: a.agent_id })),
        });
        return;
      }

      // Escalation (to elevated) blocked when any agents assigned (D3)
      if (isElevatedScope(newScope)) {
        const { rows: countRows } = await getPool().query(
          `SELECT COUNT(*)::int AS count FROM agent_skills WHERE skill_id = $1`,
          [req.params.id]
        );
        if (countRows[0].count > 0) {
          const user = (req as any).user;
          auditLog('skill_scope_change_blocked', req.params.id, user.sub, 'human', {
            old_scope: oldScope, new_scope: newScope, reason: 'escalation_with_assignments',
            assigned_count: countRows[0].count,
          });
          res.status(409).json({
            error: 'Cannot escalate scope while agents are assigned. Remove assignments first.',
            assigned_count: countRows[0].count,
          });
          return;
        }
      }
    }

    // The row update and its tool-association resync are one transaction
    // (#424): either both land or neither does. Before this fix, a
    // transient failure partway through the resync loop (after the DELETE,
    // partway through re-inserting) left only some of the intended tool
    // associations while the row's other fields had already committed —
    // a reported 500 that had, in fact, partially succeeded and wiped
    // existing associations along the way.
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE skills SET
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          tools_config = COALESCE($3, tools_config),
          instructions_md = COALESCE($4, instructions_md),
          scope = COALESCE($5, scope),
          updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          name || null,
          description ?? null,
          tools_config ? JSON.stringify(tools_config) : null,
          instructions_md ?? null,
          scope || null,
          req.params.id,
        ]
      );

      if (tool_ids !== undefined) {
        await setSkillTools(client, rows[0].id, tool_ids);
      }

      return rows[0];
    });

    // Audit scope change if scope actually changed
    if (oldScope !== newScope) {
      const user = (req as any).user;
      auditLog('skill_scope_change', req.params.id, user.sub, 'human', { old_scope: oldScope, new_scope: newScope });
    }

    const toolsMap = await fetchToolsForSkills([row.id]);
    res.json({ ...row, tools: toolsMap[row.id] || [] });
  } catch (err: any) {
    if (err.validationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'A skill with this name already exists' });
      return;
    }
    console.error('[skills] Update error:', err);
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

// Delete skill — admin only, platform skills undeletable, assigned skills undeletable
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM skills WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot delete a platform skill' });
      return;
    }

    // Check for agents using this skill via agent_skills join table
    const { rows: assignments } = await getPool().query(
      `SELECT as2.agent_id, a.agent_id AS agent_slug
       FROM agent_skills as2
       JOIN agents a ON a.id = as2.agent_id
       WHERE as2.skill_id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (assignments.length > 0) {
      res.status(409).json({
        error: 'Cannot delete skill while agents are assigned to it',
        agent_id: assignments[0].agent_slug,
      });
      return;
    }

    // skill_tools rows cascade-delete via FK
    await getPool().query('DELETE FROM skills WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[skills] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

export default router;
