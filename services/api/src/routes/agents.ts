import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getPool, withTransaction, Queryable } from '../db/pool';
import { armCredentialDeadline, endStreamForExpiredCredential } from '../helpers/stream-deadline';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { ELEVATED_SCOPES, isAdmin, getAgentElevatedScope, getAgentEffectiveScope } from '../helpers/elevated-scope';
import { auditLog } from '../helpers/audit';
import { writeAgentFiles, removeAgentFiles } from '../services/agent-files';
import { mergeToolsConfigs, DEFAULT_TOOLS_CONFIG } from '../services/merge-tools-config';
import { reportedStatus, isStatusVerified, markStatusVerified } from '../services/agent-status-verification';
import { ensureRequiredToolsInstalled, reconcileToolInstalls } from '../services/tool-installer';
import {
  createAndStartContainer,
  stopAndRemoveContainer,
  inspectContainer,
  getContainerStats,
  getContainerLogs,
  execInContainer,
  removeAgentVolumes,
  resolveAgentNetwork,
} from '../services/docker';
import { collectBounded, ReadTooLargeError, MAX_READ_BYTES } from '../helpers/bounded-read';
import { MAX_EVENT_TAIL } from '../helpers/event-log-limits';
import { encryptProviderKey, decryptProviderKey } from '../services/provider-key-crypto';

// app#374: agents.env_vars stored operator-supplied environment variables —
// including, per the UI's own AgentClaudeConfig.tsx form, a raw Anthropic
// API key — in plain JSONB, at rest and on every read. Same class of secret
// provider_connections already encrypts (AES-256-GCM via
// encryptProviderKey/decryptProviderKey) and mcp_servers.connection_config
// was fixed to encrypt in #372; this reuses that exact helper rather than
// inventing a second scheme. WHOLE-BLOB, NOT PER-KEY, for the same reason
// #372 gave for connection_config: env_vars is heterogeneous and has no
// named secret field — an allowlist of "safe" keys would go stale silently.
function getEnvVarsEncryptionKey(): string {
  const key = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (!key) throw new Error('PROVIDER_KEY_ENCRYPTION_KEY not configured');
  return key;
}

function encryptEnvVars(envVars: Record<string, string>): { encrypted: Buffer; nonce: Buffer } {
  return encryptProviderKey(JSON.stringify(envVars), getEnvVarsEncryptionKey());
}

// NULL columns (migration 069: nullable, unlike #372/#376's, since agents
// had a real row rather than zero) decode as "nothing encrypted yet", i.e.
// an empty object — not an error, and not a reason to fail a read.
function decryptEnvVars(encrypted: Buffer | null | undefined, nonce: Buffer | null | undefined): Record<string, string> {
  if (!encrypted || !nonce) return {};
  return JSON.parse(decryptProviderKey(encrypted, nonce, getEnvVarsEncryptionKey()));
}

// The non-secret summary a response may carry instead of the plaintext —
// key NAMES only, never values, mirroring mcp-servers.ts's
// connection_display for the same reason: an operator managing an agent's
// env vars needs to see WHICH are set to add or remove one, not their
// values redisplayed.
function envVarKeys(envVars: Record<string, string>): string[] {
  return Object.keys(envVars).sort();
}

/**
 * How often the SSE handler polls for new inference rows.
 *
 * Read PER REQUEST, deliberately. A module-level constant would force every test
 * in the process to share one cadence; read here, only the two tests that opt in
 * change anything, and every other test keeps production's 3000ms exactly. That
 * matters because this suite has an unexplained flake class and a global timing
 * change would put it beyond ruling out.
 *
 * 3000ms in production, and OVERRIDABLE because that number sets the floor on how
 * long a test takes. A test that must observe one poll cannot finish in under
 * 3s and lands near 4s, against jest's 5000ms default — about one second of
 * margin, which docs/decisions/api-suite-flakiness.md round four measured as the
 * reason TIMEOUT is in that suite's symptom set: "no carrier required, only a
 * delay of more than a second from any source".
 *
 * The tests set it small (jest.setup.js). Production leaves it unset and gets
 * 3000. Read once at import, so it is the process's setting, not a per-request
 * one.
 */
function inferencePollMs(): number {
  const raw = parseInt(process.env.INFERENCE_POLL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

import { createBoundedSseWriter, SSE_DEFAULTS } from '../services/sse-writer';
import {
  generateAgentAkmToken,
  getAkmEnvVars,
  isAkmConfigured,
} from '../services/akm-token';
import { revokeAgentAkmToken } from '../services/akm-revoke';
import { dispatchWebhooks } from '../services/webhook-dispatch';
import { notify } from '../services/notifications';
import {
  generateAgentModelRouterToken,
  getModelRouterEnvVars,
  isModelRouterConfigured,
} from '../services/model-router-token';
import { revokeAgentModelRouterToken } from '../services/model-router-revoke';
import { getS3Client } from '../services/s3';
import {
  processAvatar,
  agentAvatarKey,
  uploadAvatar as uploadAvatarToS3,
  deleteAvatar as deleteAvatarFromS3,
  getAvatarStream,
} from '../services/avatar';
import { rolesFrom } from '../middleware/keycloak-config';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const AGENT_AVATAR_BUCKET = 'agent-avatars';

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

function isAutoAgentModelsPolicy(description: string | null): boolean {
  return (description || '').startsWith('[auto-agent-models]');
}

async function validateModelNames(modelNames: string[], ownerSub: string): Promise<string | null> {
  for (const modelName of modelNames) {
    const { rows: userRows } = await getPool().query(
      `SELECT id FROM user_models WHERE name = $1 AND (created_by = $2 OR created_by IS NULL) AND is_active = true`,
      [modelName, ownerSub]
    );
    if (userRows.length > 0) continue;

    return `Model '${modelName}' not found in user models for agent owner`;
  }
  return null;
}

async function validatePolicyEligibility(
  policyId: string,
  agentOwnerSub: string
): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT allowed_models FROM model_policies WHERE id = $1`,
    [policyId]
  );
  if (rows.length === 0) return null;

  const allowedModels: string[] = rows[0].allowed_models || [];
  const inaccessible: string[] = [];
  for (const modelName of allowedModels) {
    const { rows: userRows } = await getPool().query(
      `SELECT id FROM user_models WHERE name = $1 AND (created_by = $2 OR created_by IS NULL) AND is_active = true`,
      [modelName, agentOwnerSub]
    );
    if (userRows.length === 0) {
      inaccessible.push(modelName);
    }
  }
  if (inaccessible.length > 0) {
    return `Policy contains models not accessible to agent owner: ${inaccessible.join(', ')}`;
  }
  return null;
}

async function upsertAutoAgentModelsPolicy(
  agentDbId: string,
  agentSlug: string,
  ownerSub: string,
  updatedBy: string,
  modelNames: string[],
  // #212: defaults to the pool for callers that are not in a transaction. A
  // helper that reached for getPool() unconditionally would commit its own
  // writes outside its caller's transaction, and the rollback would silently
  // stop covering them.
  exec: Queryable = getPool()
): Promise<string> {
  const name = `agent-models-${agentDbId}`;
  const description = `[auto-agent-models] ${agentSlug}`;
  const existing = await exec.query(
    `SELECT id FROM model_policies WHERE name = $1 AND created_by = $2`,
    [name, ownerSub]
  );
  if (existing.rows.length > 0) {
    await exec.query(
      `UPDATE model_policies
       SET description = $1,
           allowed_models = $2,
           model_aliases = $3,
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [description, JSON.stringify(modelNames), JSON.stringify({}), updatedBy, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const inserted = await exec.query(
    `INSERT INTO model_policies (name, description, allowed_models, model_aliases, updated_by, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, description, JSON.stringify(modelNames), JSON.stringify({}), updatedBy, ownerSub]
  );
  return inserted.rows[0].id;
}

async function resolveAgentModels(
  policyId: string | null,
  // Same parameter as upsertAutoAgentModelsPolicy above, for a DIFFERENT reason,
  // and the difference is worth knowing before anyone "simplifies" it away.
  //
  // That one WRITES: reaching for the pool would commit outside the caller's
  // transaction and the rollback would stop covering it. This one only READS, so
  // it cannot break a rollback. What it breaks is visibility — a pool connection
  // is a different session and cannot see the caller's uncommitted rows, so it
  // would return `[]` for a policy the transaction had just inserted, and the
  // caller would report an agent with no models rather than fail.
  //
  // That was not reachable when this parameter was added (#283): both in-transaction
  // callers were in the branch where model_policy_id came from the request and the
  // row therefore predates BEGIN. It becomes reachable the moment anyone reads back
  // a policy created inside the same transaction — which the branch directly above
  // each call site does create. One branch away, and silent when it arrives.
  exec: Queryable = getPool()
): Promise<string[]> {
  if (!policyId) return [];
  const { rows } = await exec.query(
    `SELECT allowed_models FROM model_policies WHERE id = $1`,
    [policyId]
  );
  return rows[0]?.allowed_models || [];
}

// ---------------------------------------------------------------------------
// Templates (static, no DB)
// ---------------------------------------------------------------------------

const AGENT_TEMPLATES = [
  {
    id: 'code-assistant',
    name: 'Code Assistant',
    agent_id: 'code-assistant',
    description: 'General-purpose coding agent. Reads, writes, and refactors code in a sandboxed workspace.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['node', 'npm', 'npx', 'git', 'python3', 'pip3'], denied_patterns: ['rm -rf /'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are a skilled software engineer. Write clean, well-tested code. Prefer simple solutions over clever ones.',
    rules_md: 'Always run tests before declaring a task complete. Never commit secrets or credentials.',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 200,
    skill_names: [],
    model_names: [],
  },
  {
    id: 'research-agent',
    name: 'Research Agent',
    agent_id: 'research-agent',
    description: 'Investigates topics, summarises findings, and produces structured reports with citations.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['curl', 'node', 'python3'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are a thorough researcher. Gather information from multiple sources, cross-reference claims, and present findings with clear citations.',
    rules_md: 'Always cite sources. Flag uncertain or contradictory information. Prefer primary sources over summaries.',
    cpus: '0.5',
    mem_limit: '512m',
    pids_limit: 100,
    skill_names: [],
    model_names: [],
  },
  {
    id: 'devops-bot',
    name: 'DevOps Bot',
    agent_id: 'devops-bot',
    description: 'Infrastructure automation agent for deployments, monitoring, and incident response.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['docker', 'git', 'curl', 'ssh', 'scp', 'bash', 'node', 'npm'], denied_patterns: ['rm -rf /'], max_timeout: 600 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are an experienced DevOps engineer. Prioritise reliability, observability, and minimal-downtime changes.',
    rules_md: 'Always verify health checks after deployments. Never bypass branch protections. Use rollback procedures when failures are detected.',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 200,
    skill_names: [],
    model_names: [],
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    agent_id: 'data-analyst',
    description: 'Analyses datasets, produces visualisations, and generates summary statistics.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['python3', 'pip3', 'node', 'npm'], denied_patterns: [], max_timeout: 600 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are a data analyst. Clean data methodically, choose appropriate visualisations, and explain statistical findings in plain language.',
    rules_md: 'Always validate data quality before analysis. Document assumptions and limitations. Use reproducible methods.',
    cpus: '1.0',
    mem_limit: '2g',
    pids_limit: 200,
    skill_names: [],
    model_names: [],
  },
];

router.get('/templates', requireRole('user'), (_req: Request, res: Response) => {
  res.json(AGENT_TEMPLATES);
});

// ---------------------------------------------------------------------------
// CRUD (user role)
// ---------------------------------------------------------------------------

// List agents
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.status, a.container_state, a.tools_config,
              a.cpus, a.mem_limit, a.pids_limit, a.model_policy_id, a.autonomy_level,
              a.avatar_key, a.tags,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models,
              a.created_at, a.updated_at, a.created_by,
              a.container_profile_id,
              cp.name AS cp_name, cp.docker_image AS cp_docker_image,
              COALESCE(
                json_agg(json_build_object('id', s.id, 'name', s.name, 'scope', s.scope))
                FILTER (WHERE s.id IS NOT NULL), '[]'
              ) AS skills
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       LEFT JOIN container_profiles cp ON cp.id = a.container_profile_id
       LEFT JOIN agent_skills asks ON asks.agent_id = a.id
       LEFT JOIN skills s ON s.id = asks.skill_id
       WHERE ${scope.where.replace(/created_by/g, 'a.created_by')}
       GROUP BY a.id, mp.allowed_models, cp.name, cp.docker_image
       ORDER BY a.created_at DESC`,
      scope.params
    );
    // Attach container_profile object and principal identity fields
    for (const row of rows) {
      // AI-115: Add principal identity fields
      row.principal_id = row.id;
      row.principal_type = row.principal_type || 'agent';

      row.hasAvatar = !!row.avatar_key;
      delete row.avatar_key;

      // #238: a status reconciliation could not check is reported as `unknown`,
      // not as the last value the database happens to hold. #239: and what the
      // reconciler last SAW travels with it, so `stopped` because the container
      // exited stays distinguishable from `stopped` because it is gone.
      row.status_verified = isStatusVerified(row.agent_id);
      row.status = reportedStatus(row.agent_id, row.status);
      if (!row.status_verified) row.container_state = null;

      row.container_profile = row.container_profile_id
        ? { id: row.container_profile_id, name: row.cp_name, docker_image: row.cp_docker_image }
        : null;
      delete row.cp_name;
      delete row.cp_docker_image;
    }
    res.json(rows);
  } catch (err) {
    console.error('[agents] List error:', err);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Create agent
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, model_names, skill_ids, container_profile_id, autonomy_level } = req.body;

    // Validate autonomy_level if provided
    if (autonomy_level !== undefined) {
      const validLevels = ['ask_before_acting', 'act_within_scope', 'full_autonomy'];
      if (!validLevels.includes(autonomy_level)) {
        res.status(400).json({ error: `autonomy_level must be one of: ${validLevels.join(', ')}` });
        return;
      }
    }

    // Reject legacy field
    if (req.body.tool_preset_id !== undefined) {
      res.status(400).json({ error: 'tool_preset_id is deprecated. Use skill_ids instead.' });
      return;
    }

    if (!agent_id || !name) {
      res.status(400).json({ error: 'agent_id and name are required' });
      return;
    }

    // Validate agent_id format (slug: lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(agent_id) && !/^[a-z0-9]$/.test(agent_id)) {
      res.status(400).json({ error: 'agent_id must be a lowercase slug (a-z, 0-9, hyphens, 1-63 chars)' });
      return;
    }

    // Validate skill_ids
    if (skill_ids !== undefined) {
      if (!Array.isArray(skill_ids)) {
        res.status(400).json({ error: 'skill_ids must be an array' });
        return;
      }
    }
    if (model_names !== undefined && !Array.isArray(model_names)) {
      res.status(400).json({ error: 'model_names must be an array' });
      return;
    }
    if (model_names !== undefined && model_policy_id !== undefined) {
      res.status(400).json({ error: 'Use either model_names or model_policy_id, not both' });
      return;
    }

    // Validate model_policy_id ownership + eligibility
    let validatedPolicyId: string | null = null;
    if (model_policy_id) {
      const { rows: policyRows } = await getPool().query(
        'SELECT id, created_by, allowed_models FROM model_policies WHERE id = $1',
        [model_policy_id]
      );
      if (policyRows.length === 0) {
        res.status(400).json({ error: 'Model policy not found' });
        return;
      }
      const policyOwner = policyRows[0].created_by;
      if (policyOwner !== null && policyOwner !== user.sub) {
        res.status(403).json({ error: "Cannot assign another user's policy" });
        return;
      }
      // AI-120: validate all models in policy are accessible to agent owner
      const eligibilityError = await validatePolicyEligibility(model_policy_id, user.sub);
      if (eligibilityError) {
        res.status(400).json({ error: eligibilityError });
        return;
      }
      validatedPolicyId = model_policy_id;
    }

    // Direct model assignment (preferred user-facing path)
    let normalizedModelNames: string[] | undefined = undefined;
    if (model_names !== undefined) {
      normalizedModelNames = [...new Set((model_names as string[]).filter(Boolean))];
      const modelError = await validateModelNames(normalizedModelNames, user.sub);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }
      // Policy id is derived after insert via auto policy upsert.
      validatedPolicyId = null;
    }

    // Validate container_profile_id if provided
    if (container_profile_id !== undefined && container_profile_id !== null) {
      const { rows: profileRows } = await getPool().query(
        'SELECT id FROM container_profiles WHERE id = $1',
        [container_profile_id]
      );
      if (profileRows.length === 0) {
        res.status(400).json({ error: 'Container profile not found' });
        return;
      }
    }

    // Resolve tools_config from explicit payload or assigned skills
    let resolvedToolsConfig = tools_config || DEFAULT_TOOLS_CONFIG;
    let validatedSkillIds: string[] = [];
    if (skill_ids && skill_ids.length > 0) {
      const { rows: skillRows } = await getPool().query(
        'SELECT id, tools_config, scope FROM skills WHERE id = ANY($1::uuid[])',
        [skill_ids]
      );
      if (skillRows.length !== skill_ids.length) {
        res.status(400).json({ error: 'One or more skills not found' });
        return;
      }
      if (skillRows.some((s: any) => ELEVATED_SCOPES.includes(s.scope)) && !isAdmin(req)) {
        const elevatedScope = skillRows.find((s: any) => ELEVATED_SCOPES.includes(s.scope))!.scope;
        auditLog('skill_assign_denied', agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'POST /agents' });
        res.status(403).json({ error: `Assigning ${elevatedScope} skills requires admin role` });
        return;
      }
      const configs = skillRows.map((r: any) => r.tools_config);
      resolvedToolsConfig = mergeToolsConfigs(configs);
      validatedSkillIds = skill_ids;
    }

    // #212: ONE transaction over the whole write sequence. These statements used
    // to run on the pool, each committing on its own, so a failure at the policy
    // upsert or a skill insert answered 500 with the agent row already saved —
    // the caller told the create failed while the agent sat in the list, and a
    // retry answering 409 told the same user it had already happened.
    //
    // This path is database-only — no container, no files, no tokens — which is
    // why it can be made GENUINELY atomic rather than merely self-cleaning. The
    // validation reads above stay outside: they are reads, and they return
    // before anything is written.
    const createdAgent = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::uuid, (SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL LIMIT 1)),
               $11, $12, $13)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
      [
        agent_id,
        name,
        description || '',
        JSON.stringify(resolvedToolsConfig),
        cpus || '1.0',
        mem_limit || '1g',
        pids_limit || 200,
        soul_md || '',
        rules_md || '',
        validatedPolicyId,
        container_profile_id || null,
        autonomy_level || 'act_within_scope',
        user.sub,
      ]
    );

    const agent = rows[0];

    if (normalizedModelNames !== undefined) {
      if (normalizedModelNames.length > 0) {
        const autoPolicyId = await upsertAutoAgentModelsPolicy(
          agent.id,
          agent.agent_id,
          user.sub,
          user.sub,
          normalizedModelNames,
          tx
        );
        await tx.query(
          `UPDATE agents SET model_policy_id = $1, updated_at = NOW() WHERE id = $2`,
          [autoPolicyId, agent.id]
        );
        agent.model_policy_id = autoPolicyId;
        agent.models = normalizedModelNames;
      } else {
        agent.models = [];
      }
    } else {
      agent.models = await resolveAgentModels(agent.model_policy_id, tx);
    }

    // Insert skill assignments into agent_skills
    for (const skillId of validatedSkillIds) {
      await tx.query(
        'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
        [agent.id, skillId, user.sub]
      );
    }

    // Fetch the skills array for response
    const { rows: skillRows2 } = await tx.query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [agent.id]
    );
    agent.skills = skillRows2;
    return agent;
    });

    res.status(201).json(createdAgent);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'An agent with this agent_id already exists' });
      return;
    }
    console.error('[agents] Create error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// Get agent detail
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.status, a.container_state, a.tools_config,
              cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
              model_policy_id, a.autonomy_level, a.avatar_key, a.tags,
              a.env_vars_encrypted, a.env_vars_nonce, a.container_profile_id,
              a.schedule_cron, a.schedule_enabled,
              cp.name AS cp_name, cp.docker_image AS cp_docker_image,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models,
              mp.name AS model_policy_name,
              error_message, a.created_at, a.updated_at, a.created_by
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       LEFT JOIN container_profiles cp ON cp.id = a.container_profile_id
       WHERE a.id = $${paramOffset} AND ${scope.where.replace(/created_by/g, 'a.created_by')}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    agent.hasAvatar = !!agent.avatar_key;
    delete agent.avatar_key;

    // app#374: the encrypted columns must never reach res.json — only the
    // key names, decrypted server-side, never the values.
    agent.env_var_keys = envVarKeys(decryptEnvVars(agent.env_vars_encrypted, agent.env_vars_nonce));
    delete agent.env_vars_encrypted;
    delete agent.env_vars_nonce;

    // #238/#239: see the list route.
    agent.status_verified = isStatusVerified(agent.agent_id);
    agent.status = reportedStatus(agent.agent_id, agent.status);
    if (!agent.status_verified) agent.container_state = null;

    // AI-115: Add principal identity fields
    agent.principal_id = agent.id;
    agent.principal_type = agent.principal_type || 'agent';

    agent.container_profile = agent.container_profile_id
      ? { id: agent.container_profile_id, name: agent.cp_name, docker_image: agent.cp_docker_image }
      : null;
    delete agent.cp_name;
    delete agent.cp_docker_image;

    // Fetch skills for this agent
    const { rows: skillRows } = await getPool().query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [agent.id]
    );
    agent.skills = skillRows;

    res.json(agent);
  } catch (err) {
    console.error('[agents] Get error:', err);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// Export agent config
router.get('/:id/export', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.tools_config,
              a.cpus, a.mem_limit, a.pids_limit, a.soul_md, a.rules_md,
              a.autonomy_level, a.container_profile_id,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       WHERE a.id = $${paramOffset} AND ${scope.where.replace(/created_by/g, 'a.created_by')}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    const { rows: skillRows } = await getPool().query(
      `SELECT s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [agent.id]
    );

    const exportData = {
      _version: 1,
      _exported_at: new Date().toISOString(),
      agent_id: agent.agent_id,
      name: agent.name,
      description: agent.description,
      tools_config: agent.tools_config,
      cpus: agent.cpus,
      mem_limit: agent.mem_limit,
      pids_limit: agent.pids_limit,
      soul_md: agent.soul_md,
      rules_md: agent.rules_md,
      autonomy_level: agent.autonomy_level,
      model_names: agent.models || [],
      skill_names: skillRows.map((s: any) => s.name),
      container_profile_id: agent.container_profile_id,
    };

    res.setHeader('Content-Disposition', `attachment; filename="${agent.agent_id}.json"`);
    res.json(exportData);
  } catch (err) {
    console.error('[agents] Export error:', err);
    res.status(500).json({ error: 'Failed to export agent' });
  }
});

// Import agent from exported config
router.post('/import', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const config = req.body;

    if (!config.agent_id || !config.name) {
      res.status(400).json({ error: 'Exported config must include agent_id and name' });
      return;
    }

    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(config.agent_id) && !/^[a-z0-9]$/.test(config.agent_id)) {
      res.status(400).json({ error: 'agent_id must be a lowercase slug (a-z, 0-9, hyphens, 1-63 chars)' });
      return;
    }

    const validLevels = ['ask_before_acting', 'act_within_scope', 'full_autonomy'];
    const autonomyLevel = config.autonomy_level && validLevels.includes(config.autonomy_level)
      ? config.autonomy_level
      : 'act_within_scope';

    // Resolve skill_ids from skill_names
    let validatedSkillIds: string[] = [];
    let resolvedToolsConfig = config.tools_config || DEFAULT_TOOLS_CONFIG;
    if (config.skill_names && Array.isArray(config.skill_names) && config.skill_names.length > 0) {
      const { rows: skillRows } = await getPool().query(
        'SELECT id, tools_config, scope FROM skills WHERE name = ANY($1::text[])',
        [config.skill_names]
      );
      if (skillRows.some((s: any) => ELEVATED_SCOPES.includes(s.scope)) && !isAdmin(req)) {
        res.status(403).json({ error: 'Importing agents with elevated-scope skills requires admin role' });
        return;
      }
      validatedSkillIds = skillRows.map((r: any) => r.id);
      if (skillRows.length > 0) {
        resolvedToolsConfig = mergeToolsConfigs(skillRows.map((r: any) => r.tools_config));
      }
    }

    // Validate model_names
    const modelNames: string[] = config.model_names && Array.isArray(config.model_names) ? config.model_names : [];
    if (modelNames.length > 0) {
      const modelError = await validateModelNames(modelNames, user.sub);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }
    }

    // Validate container_profile_id
    let profileId = null;
    if (config.container_profile_id) {
      const { rows: profileRows } = await getPool().query(
        'SELECT id FROM container_profiles WHERE id = $1',
        [config.container_profile_id]
      );
      if (profileRows.length > 0) {
        profileId = config.container_profile_id;
      }
    }

    // #212, the twin of the create path: same four statements, same defect, so
    // the same one transaction. A fix applied to one and not the other is the
    // drift behind #141, #153 and #182.
    const createdAgent = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               (SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL LIMIT 1),
               $10, $11, $12)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
      [
        config.agent_id,
        config.name,
        config.description || '',
        JSON.stringify(resolvedToolsConfig),
        config.cpus || '1.0',
        config.mem_limit || '1g',
        config.pids_limit || 200,
        config.soul_md || '',
        config.rules_md || '',
        profileId,
        autonomyLevel,
        user.sub,
      ]
    );

    const agent = rows[0];

    if (modelNames.length > 0) {
      const autoPolicyId = await upsertAutoAgentModelsPolicy(
        agent.id,
        agent.agent_id,
        user.sub,
        user.sub,
        modelNames,
        tx
      );
      await tx.query(
        `UPDATE agents SET model_policy_id = $1, updated_at = NOW() WHERE id = $2`,
        [autoPolicyId, agent.id]
      );
      agent.model_policy_id = autoPolicyId;
      agent.models = modelNames;
    } else {
      agent.models = await resolveAgentModels(agent.model_policy_id, tx);
    }

    for (const skillId of validatedSkillIds) {
      await tx.query(
        'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
        [agent.id, skillId, user.sub]
      );
    }

    const { rows: skillRows2 } = await tx.query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [agent.id]
    );
    agent.skills = skillRows2;
    return agent;
    });

    res.status(201).json(createdAgent);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'An agent with this agent_id already exists' });
      return;
    }
    console.error('[agents] Import error:', err);
    res.status(500).json({ error: 'Failed to import agent' });
  }
});

// Update agent
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;

    // Reject legacy field
    if (req.body.tool_preset_id !== undefined) {
      res.status(400).json({ error: 'tool_preset_id is deprecated. Use skill_ids instead.' });
      return;
    }

    // Check agent exists and is owned
    const { rows: existing } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (existing[0].status === 'running') {
      res.status(409).json({ error: 'Cannot update a running agent. Stop it first.' });
      return;
    }

    const user = (req as any).user;
    const { name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, model_names, skill_ids, container_profile_id, autonomy_level, tags, env_vars_set, env_vars_unset } = req.body;

    // app#374/#386 review: env_vars is a DELTA contract, not a whole-map
    // replace — env_vars_set (keys to add/update) and env_vars_unset (keys
    // to remove), never a full object the caller is expected to already
    // hold. The whole-map shape this replaced required the client to read
    // back the current plaintext to safely modify one key; once the value
    // is encrypted and withheld (a few lines below), that read-back is
    // impossible, and a client that could no longer see the old values but
    // still sent a "complete" replacement would silently delete every key
    // it didn't know about. A delta removes the read-modify-write race
    // entirely rather than requiring the client to get it right.
    if (env_vars_set !== undefined) {
      if (typeof env_vars_set !== 'object' || env_vars_set === null || Array.isArray(env_vars_set)) {
        res.status(400).json({ error: 'env_vars_set must be an object with string key-value pairs' });
        return;
      }
      for (const [k, v] of Object.entries(env_vars_set)) {
        if (typeof v !== 'string') {
          res.status(400).json({ error: `env_vars_set["${k}"] must be a string` });
          return;
        }
      }
    }
    if (env_vars_unset !== undefined) {
      if (!Array.isArray(env_vars_unset) || !env_vars_unset.every((k: unknown) => typeof k === 'string')) {
        res.status(400).json({ error: 'env_vars_unset must be an array of key names' });
        return;
      }
    }

    // Validate tags if provided
    if (tags !== undefined) {
      if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string')) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }
    }

    // Validate autonomy_level if provided
    if (autonomy_level !== undefined) {
      const validLevels = ['ask_before_acting', 'act_within_scope', 'full_autonomy'];
      if (!validLevels.includes(autonomy_level)) {
        res.status(400).json({ error: `autonomy_level must be one of: ${validLevels.join(', ')}` });
        return;
      }
    }

    // Validate skill_ids
    if (skill_ids !== undefined) {
      if (!Array.isArray(skill_ids)) {
        res.status(400).json({ error: 'skill_ids must be an array' });
        return;
      }
    }
    if (model_names !== undefined && !Array.isArray(model_names)) {
      res.status(400).json({ error: 'model_names must be an array' });
      return;
    }
    if (model_names !== undefined && model_policy_id !== undefined) {
      res.status(400).json({ error: 'Use either model_names or model_policy_id, not both' });
      return;
    }

    // model_policy_id assignment: all callers subject to ownership + eligibility check
    if (model_policy_id !== undefined) {
      // Validate FK if non-null
      if (model_policy_id !== null) {
        const { rows: policyRows } = await getPool().query(
          'SELECT id, created_by, allowed_models FROM model_policies WHERE id = $1',
          [model_policy_id]
        );
        if (policyRows.length === 0) {
          res.status(400).json({ error: 'Model policy not found' });
          return;
        }

        const policyOwner = policyRows[0].created_by;
        if (policyOwner !== null && policyOwner !== user.sub) {
          res.status(403).json({ error: "Cannot assign another user's policy" });
          return;
        }
        // AI-120: validate all models in policy are accessible to agent owner
        const eligibilityError = await validatePolicyEligibility(model_policy_id, existing[0].created_by);
        if (eligibilityError) {
          res.status(400).json({ error: eligibilityError });
          return;
        }
      }
    }

    // Validate container_profile_id if provided (non-null)
    if (container_profile_id !== undefined && container_profile_id !== null) {
      const { rows: cpRows } = await getPool().query(
        'SELECT id FROM container_profiles WHERE id = $1',
        [container_profile_id]
      );
      if (cpRows.length === 0) {
        res.status(400).json({ error: 'Container profile not found' });
        return;
      }
    }

    let resolvedModelPolicyId: string | null | undefined = undefined;
    if (model_names !== undefined) {
      const normalizedModelNames = [...new Set((model_names as string[]).filter(Boolean))];
      const modelError = await validateModelNames(normalizedModelNames, existing[0].created_by);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }

      if (normalizedModelNames.length === 0) {
        resolvedModelPolicyId = null;
      } else {
        let reusePolicyId: string | null = null;
        if (existing[0].model_policy_id) {
          const { rows: policyRows } = await getPool().query(
            `SELECT id, description FROM model_policies WHERE id = $1`,
            [existing[0].model_policy_id]
          );
          if (policyRows.length > 0 && isAutoAgentModelsPolicy(policyRows[0].description)) {
            reusePolicyId = policyRows[0].id;
          }
        }

        if (reusePolicyId) {
          await getPool().query(
            `UPDATE model_policies
             SET allowed_models = $1, model_aliases = $2, updated_by = $3, updated_at = NOW()
             WHERE id = $4`,
            [JSON.stringify(normalizedModelNames), JSON.stringify({}), user.sub, reusePolicyId]
          );
          resolvedModelPolicyId = reusePolicyId;
        } else {
          resolvedModelPolicyId = await upsertAutoAgentModelsPolicy(
            existing[0].id,
            existing[0].agent_id,
            existing[0].created_by,
            user.sub,
            normalizedModelNames
          );
        }
      }
    }

    // Resolve tools_config from explicit payload or assigned skills
    let resolvedToolsConfig = tools_config ? JSON.stringify(tools_config) : null;
    if (skill_ids !== undefined) {
      if (skill_ids.length > 0) {
        const { rows: skillRows } = await getPool().query(
          'SELECT id, tools_config, scope FROM skills WHERE id = ANY($1::uuid[])',
          [skill_ids]
        );
        if (skillRows.length !== skill_ids.length) {
          res.status(400).json({ error: 'One or more skills not found' });
          return;
        }
        if (skillRows.some((s: any) => ELEVATED_SCOPES.includes(s.scope)) && !isAdmin(req)) {
          const elevatedScope = skillRows.find((s: any) => ELEVATED_SCOPES.includes(s.scope))!.scope;
          auditLog('skill_assign_denied', existing[0].agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'PUT /agents/:id' });
          res.status(403).json({ error: `Assigning ${elevatedScope} skills requires admin role` });
          return;
        }
        const configs = skillRows.map((r: any) => r.tools_config);
        resolvedToolsConfig = JSON.stringify(mergeToolsConfigs(configs));
      }

      // Check for implicit elevated-skill removal (non-admin removing elevated skills via PUT)
      if (!isAdmin(req)) {
        const { rows: currentSkills } = await getPool().query(
          `SELECT asks.skill_id, s.scope FROM agent_skills asks
           JOIN skills s ON s.id = asks.skill_id
           WHERE asks.agent_id = $1`,
          [req.params.id]
        );
        const removedIds = currentSkills
          .filter((cs: any) => !skill_ids.includes(cs.skill_id))
          .filter((cs: any) => ELEVATED_SCOPES.includes(cs.scope));
        if (removedIds.length > 0) {
          auditLog('skill_remove_denied', existing[0].agent_id, user.sub, 'human', { skill_scope: removedIds[0].scope, endpoint: 'PUT /agents/:id' });
          res.status(403).json({ error: `Cannot remove ${removedIds[0].scope} skills without admin role` });
          return;
        }
      }
    }

    // Build SET clause: model_policy_id uses explicit flag to allow clearing to NULL
    const modelPolicyProvided = model_policy_id !== undefined || model_names !== undefined;
    const effectiveModelPolicyId = model_names !== undefined ? resolvedModelPolicyId : model_policy_id;
    const containerProfileProvided = container_profile_id !== undefined;

    // app#374/#386 review: DELTA applied server-side. The client can no
    // longer read back the existing values (never returned as plaintext —
    // see GET /:id above), so it never holds the full current set and
    // never needs to — env_vars_unset removes keys, env_vars_set adds or
    // updates keys, both applied on top of the decrypted current value.
    // unset runs before set, so set wins for any key named in both (a
    // client asking to both remove and set the same key in one call is a
    // contradictory request; "the thing you just set is still set" is the
    // less surprising resolution).
    let envVarsEncrypted: Buffer | null = null;
    let envVarsNonce: Buffer | null = null;
    let finalEnvVars: Record<string, string> = decryptEnvVars(existing[0].env_vars_encrypted, existing[0].env_vars_nonce);
    if (env_vars_set !== undefined || env_vars_unset !== undefined) {
      if (Array.isArray(env_vars_unset)) {
        for (const key of env_vars_unset) delete finalEnvVars[key];
      }
      if (env_vars_set !== undefined) {
        finalEnvVars = { ...finalEnvVars, ...env_vars_set };
      }
      const encrypted = encryptEnvVars(finalEnvVars);
      envVarsEncrypted = encrypted.encrypted;
      envVarsNonce = encrypted.nonce;
    }

    const { rows } = await getPool().query(
      `UPDATE agents SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        tools_config = COALESCE($3, tools_config),
        cpus = COALESCE($4, cpus),
        mem_limit = COALESCE($5, mem_limit),
        pids_limit = COALESCE($6, pids_limit),
        soul_md = COALESCE($7, soul_md),
        rules_md = COALESCE($8, rules_md),
        model_policy_id = CASE WHEN $9::boolean THEN $10::uuid ELSE model_policy_id END,
        container_profile_id = CASE WHEN $11::boolean THEN $12::uuid ELSE container_profile_id END,
        autonomy_level = COALESCE($13, autonomy_level),
        tags = COALESCE($14, tags),
        env_vars_encrypted = COALESCE($15, env_vars_encrypted),
        env_vars_nonce = COALESCE($16, env_vars_nonce),
        updated_at = NOW()
       WHERE id = $17
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, tags, error_message, created_at, updated_at, created_by`,
      [
        name || null,
        description ?? null,
        resolvedToolsConfig,
        cpus || null,
        mem_limit || null,
        pids_limit ?? null,
        soul_md ?? null,
        rules_md ?? null,
        modelPolicyProvided,
        modelPolicyProvided ? (effectiveModelPolicyId ?? null) : null,
        containerProfileProvided,
        containerProfileProvided ? (container_profile_id ?? null) : null,
        autonomy_level || null,
        tags !== undefined ? JSON.stringify(tags) : null,
        envVarsEncrypted,
        envVarsNonce,
        req.params.id,
      ]
    );

    const updatedAgent = rows[0];
    // app#374: never the plaintext, never the ciphertext — only the key
    // names, same as GET /:id. finalEnvVars already reflects the delta
    // above whether or not env_vars_set/env_vars_unset was provided.
    updatedAgent.env_var_keys = envVarKeys(finalEnvVars);

    // Update agent_skills if skill_ids provided
    if (skill_ids !== undefined) {
      // Clear existing assignments
      await getPool().query('DELETE FROM agent_skills WHERE agent_id = $1', [req.params.id]);
      // Insert new assignments
      for (const skillId of skill_ids) {
        await getPool().query(
          'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
          [req.params.id, skillId, user.sub]
        );
      }
    }

    // Fetch skills for response
    const { rows: agentSkills } = await getPool().query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [req.params.id]
    );
    updatedAgent.skills = agentSkills;
    updatedAgent.models = await resolveAgentModels(updatedAgent.model_policy_id);

    res.json(updatedAgent);
  } catch (err) {
    console.error('[agents] Update error:', err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// Delete agent (admin only)
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    // #340: this route deleted the row without ever attempting revocation,
    // so a running agent's AKM/model-router tokens stayed live until their
    // own `exp` for a container that no longer existed — worse than #245,
    // where a revoke was at least attempted. #245's fix (preserve the JTI
    // column when a revoke fails) does NOT transfer here: `DELETE FROM
    // agents` removes whatever the columns hold either way, so there is no
    // column left to preserve once this request returns. What DOES transfer
    // is attempting the revoke and telling the audit trail the truth —
    // token_revoked vs token_revoke_failed, naming jti/exp/agent — since the
    // audit stream doesn't depend on the row surviving. Whether a
    // revoke-failed token from this path is later counted or swept stays
    // #269's, same boundary as `/stop`.
    //
    // Non-blocking, on purpose: every other cleanup step in this route
    // (container stop just below, volume purge, avatar removal, config
    // files) was ALREADY best-effort before this fix — each already caught
    // its own errors and continued to the delete. The two revoke calls
    // follow that pre-existing convention rather than deciding anything
    // #269 hasn't: #269 is specifically about whether a failed revoke should
    // block `/stop`, a route that had no such non-blocking precedent before
    // #245/#269 raised the question. This route did.
    const deleteCorrelationId = (req as any).correlationId;
    if (agent.akm_jti && isAkmConfigured()) {
      try {
        await revokeAgentAkmToken(agent.agent_id, agent.akm_jti, agent.akm_exp ?? undefined);
        auditLog('token_revoked', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.akm_jti, reason: 'delete',
          owner_sub: agent.created_by, correlation_id: deleteCorrelationId,
        });
      } catch (err) {
        console.error(`[agents] AKM token revocation failed for ${agent.agent_id}:`, err);
        auditLog('token_revoke_failed', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.akm_jti, exp: agent.akm_exp, reason: 'delete',
          owner_sub: agent.created_by, correlation_id: deleteCorrelationId,
        });
      }
    }
    if (agent.model_router_jti && isModelRouterConfigured()) {
      try {
        await revokeAgentModelRouterToken(agent.agent_id, agent.model_router_jti, agent.model_router_exp ?? undefined);
        auditLog('token_revoked', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.model_router_jti, reason: 'delete',
          owner_sub: agent.created_by, correlation_id: deleteCorrelationId,
        });
      } catch (err) {
        console.error(`[agents] Model-router token revocation failed for ${agent.agent_id}:`, err);
        auditLog('token_revoke_failed', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.model_router_jti, exp: agent.model_router_exp, reason: 'delete',
          owner_sub: agent.created_by, correlation_id: deleteCorrelationId,
        });
      }
    }

    // Stop container if running
    if (agent.status === 'running') {
      try {
        await stopAndRemoveContainer(agent.agent_id);
      } catch (err) {
        console.error(`[agents] Failed to stop container for ${agent.agent_id}:`, err);
      }
    }

    // Purge volumes if requested
    if (req.query.purge === 'true') {
      await removeAgentVolumes(agent.agent_id);
      auditLog('purge_volumes', agent.agent_id, user.sub, 'human');
    }

    // Remove avatar from S3
    if (agent.avatar_key) {
      try {
        await deleteAvatarFromS3(getS3Client(), agent.avatar_key, AGENT_AVATAR_BUCKET);
      } catch (err) {
        console.error('[agents] Failed to delete avatar:', err);
      }
    }

    // Remove config files
    removeAgentFiles(agent.agent_id);

    // Delete from DB
    await getPool().query('DELETE FROM agents WHERE id = $1', [req.params.id]);

    auditLog('delete', agent.agent_id, user.sub, 'human');
    res.json({ deleted: true });
  } catch (err) {
    console.error('[agents] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});


// ---------------------------------------------------------------------------
// Avatar (user role)
// ---------------------------------------------------------------------------

router.post('/:id/avatar', requireRole('user'), avatarUpload.single('avatar'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT id, agent_id, avatar_key FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    if (!ALLOWED_MIMES.includes(file.mimetype)) { res.status(400).json({ error: 'Invalid file type' }); return; }
    const agent = rows[0];
    const processed = await processAvatar(file.buffer);
    const key = agentAvatarKey(agent.id);
    const s3 = getS3Client();
    const oldKey = agent.avatar_key;
    await uploadAvatarToS3(s3, key, processed, AGENT_AVATAR_BUCKET);
    await getPool().query('UPDATE agents SET avatar_key = $1, updated_at = NOW() WHERE id = $2', [key, agent.id]);
    if (oldKey) { try { await deleteAvatarFromS3(s3, oldKey, AGENT_AVATAR_BUCKET); } catch (e) { console.error('[agents] old avatar delete failed:', e); } }
    res.json({ message: 'Avatar uploaded' });
  } catch (err) { console.error('[agents] POST avatar error:', err); res.status(500).json({ error: 'Failed to upload avatar' }); }
});

router.get('/:id/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT avatar_key FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (!rows[0].avatar_key) { res.status(404).json({ error: 'No avatar found' }); return; }
    const s3 = getS3Client();
    const { stream, etag } = await getAvatarStream(s3, rows[0].avatar_key, AGENT_AVATAR_BUCKET);
    if (etag && req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-cache');
    if (etag) res.setHeader('ETag', etag);
    (stream as any).pipe(res);
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) { res.status(404).json({ error: 'No avatar found' }); return; }
    console.error('[agents] GET avatar error:', err); res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

router.delete('/:id/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT id, avatar_key FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (!rows[0].avatar_key) { res.status(404).json({ error: 'No avatar found' }); return; }
    const s3 = getS3Client();
    await deleteAvatarFromS3(s3, rows[0].avatar_key, AGENT_AVATAR_BUCKET);
    await getPool().query('UPDATE agents SET avatar_key = NULL, updated_at = NOW() WHERE id = $1', [rows[0].id]);
    res.json({ message: 'Avatar deleted' });
  } catch (err) { console.error('[agents] DELETE avatar error:', err); res.status(500).json({ error: 'Failed to delete avatar' }); }
});

// ---------------------------------------------------------------------------
// Lifecycle (admin role)
// ---------------------------------------------------------------------------

// Start agent
router.post('/:id/start', requireRole('admin'), async (req: Request, res: Response) => {
  let agentSlug = 'unknown';
  try {
    const user = (req as any).user;

    // Environment guard
    if (!process.env.AGENTBOX_CONFIG_HOST_PATH) {
      res.status(503).json({ error: 'AGENTBOX_CONFIG_HOST_PATH not configured' });
      return;
    }

    const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    agentSlug = agent.agent_id;
    const correlationId = (req as any).correlationId;

    // Fetch skill instructions at start time (fresh-at-start, not resolve-on-save)
    // Multi-skill: compose all skill instructions with per-skill headers, ordered by assigned_at
    let skillInstructions: string | undefined;
    const { rows: skillRows } = await getPool().query(
      `SELECT s.name, s.instructions_md FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1
       ORDER BY asks.assigned_at ASC`,
      [agent.id]
    );
    const instructionParts = skillRows
      .filter((r: any) => r.instructions_md)
      .map((r: any) => `## Skill: ${r.name}\n\n${r.instructions_md}`);
    if (instructionParts.length > 0) {
      skillInstructions = instructionParts.join('\n\n---\n\n');
    }

    // Write config files to disk
    writeAgentFiles(agent, skillInstructions);

    // AI-115: Owner role ceiling enforcement — re-derive at start time.
    // Placed after skill instructions query to preserve mock call order in tests.
    const elevatedScope = await getAgentElevatedScope(agent.id);
    if (elevatedScope) {
      const ownerRoles: string[] = user.sub === agent.created_by
        ? rolesFrom(user)
        : [];
      if (user.sub === agent.created_by && !ownerRoles.includes('admin')) {
        auditLog('principal_ceiling_denied', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id,
          owner_sub: agent.created_by,
          denied_scope: elevatedScope,
          correlation_id: correlationId,
        });
        res.status(403).json({
          error: 'Owner role ceiling exceeded',
          detail: `Agent has elevated scope '${elevatedScope}' but owner lacks admin role`,
        });
        return;
      }
    }

    // Generate AKM token if configured (AI-115: WorkloadClaims)
    let akmEnv: string[] = [];
    let akmJti: string | null = null;
    let akmExp: number | null = null;
    if (isAkmConfigured()) {
      try {
        const akmToken = await generateAgentAkmToken({
          agentSlug: agent.agent_id,
          agentUuid: agent.id,
          scopes: ['akm:read', 'akm:write'],
          owner: agent.created_by,
          correlationId,
        });
        akmEnv = getAkmEnvVars(akmToken);
        akmJti = akmToken.jti;
        akmExp = akmToken.expiresAt;
        auditLog('token_issued', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, principal_type: 'agent',
          jti: akmToken.jti, owner_sub: agent.created_by,
          scopes: ['akm:read', 'akm:write'], aud: 'hill90-akm',
          correlation_id: correlationId,
        });
      } catch (err) {
        console.error('[agents] AKM token generation failed (continuing without AKM):', err);
      }
    }

    // Generate model-router token if configured (AI-115: WorkloadClaims)
    let modelRouterEnv: string[] = [];
    let modelRouterJti: string | null = null;
    let modelRouterExp: number | null = null;
    let modelRouterRefreshSecret: string | null = null;
    if (isModelRouterConfigured()) {
      try {
        const mrToken = await generateAgentModelRouterToken({
          agentSlug: agent.agent_id,
          agentUuid: agent.id,
          owner: agent.created_by,
          scopes: [],
          correlationId,
        });
        modelRouterEnv = getModelRouterEnvVars(mrToken);
        modelRouterJti = mrToken.jti;
        modelRouterExp = mrToken.expiresAt;
        modelRouterRefreshSecret = mrToken.refreshSecret;
        auditLog('token_issued', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, principal_type: 'agent',
          jti: mrToken.jti, owner_sub: agent.created_by,
          scopes: [], aud: 'hill90-model-router',
          correlation_id: correlationId,
        });
      } catch (err) {
        console.error('[agents] Model-router token generation failed (continuing without model-router):', err);
      }
    }

    // Generate work token and chat callback env
    const workToken = crypto.randomUUID();
    const chatEnv: string[] = [];
    if (process.env.CHAT_CALLBACK_TOKEN) {
      chatEnv.push(`CHAT_CALLBACK_TOKEN=${process.env.CHAT_CALLBACK_TOKEN}`);
    }
    // Claude Code CLI credential handoff (AI-185)
    if (process.env.ANTHROPIC_API_KEY) {
      chatEnv.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }
    // Web search via Tavily (AI-254)
    if (process.env.TAVILY_API_KEY) {
      chatEnv.push(`TAVILY_API_KEY=${process.env.TAVILY_API_KEY}`);
    }

    // Resolve agent scope for network assignment
    const effectiveScope = await getAgentEffectiveScope(agent.id);
    const network = resolveAgentNetwork(effectiveScope);

    // Resolve container profile image + metadata
    let profileImage: string | undefined;
    let profileMetadata: Record<string, any> | undefined;
    if (agent.container_profile_id) {
      const { rows: profileRows } = await getPool().query(
        'SELECT docker_image, metadata FROM container_profiles WHERE id = $1',
        [agent.container_profile_id]
      );
      if (profileRows.length > 0) {
        profileImage = profileRows[0].docker_image;
        const meta = profileRows[0].metadata;
        if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
          profileMetadata = meta;
        }
      }
    }

    // Create and start container
    const containerId = await createAndStartContainer({
      agentId: agent.agent_id,
      hostConfigPath: process.env.AGENTBOX_CONFIG_HOST_PATH!,
      cpus: agent.cpus,
      memLimit: agent.mem_limit,
      pidsLimit: agent.pids_limit,
      env: [...akmEnv, ...modelRouterEnv, ...chatEnv, `WORK_TOKEN=${workToken}`, 'AGENT_USE_TERMINAL=1'],
      network,
      image: profileImage,
      metadata: profileMetadata,
    });

    // #285's second half. Read Docker's own State.StartedAt for started_at,
    // HERE — immediately after createAndStartContainer returns, before any
    // of Phase 6B or what follows — and NOWHERE ELSE. THE POSITION IS
    // LOAD-BEARING, not incidental:
    //
    // Containers here run RestartPolicy: unless-stopped (docker.ts), so the
    // daemon can restart one invisibly to this service at any LATER point.
    // Read StartedAt during ongoing reconciliation, or at any moment after
    // this one, and it describes the LATEST restart rather than this
    // session's start — that is exactly the hazard that scoped #326 (this
    // issue's first half) down to the stop side only, and it is why
    // inspectContainer's own reconciliation call site never reads this
    // field. AT THIS EXACT LINE, no time has passed for an internal restart
    // to occur — the container was created microseconds ago, by this
    // request, one statement up — so the value is unambiguously this
    // session's start. Moving this call further down the function (e.g. to
    // just before the session INSERT, after tool installation), or reusing
    // it for a container this request did not just create, reopens the
    // hazard #326 exists to avoid.
    //
    // Never fails the start: the agent already launched successfully, and a
    // metadata read going wrong must not be reported as a launch failure.
    // Falls back to NOW() at INSERT time — today's behaviour — and the row
    // says so via started_at_estimated, the same honesty the stop side
    // already has via stopped_at_estimated.
    let containerStartedAt: Date | null = null;
    try {
      const inspected = await inspectContainer(agent.agent_id);
      containerStartedAt = inspected?.startedAt ?? null;
    } catch (err) {
      console.error(`[agents] Could not read container start time for ${agent.agent_id}:`, err);
    }

    // Phase 6B: ensure required tools are installed for assigned skills.
    // Installation writes persistent status to agent_tool_installs.
    try {
      await ensureRequiredToolsInstalled(agent.id, agent.agent_id);
    } catch (installErr: any) {
      try {
        await stopAndRemoveContainer(agent.agent_id);
      } catch (cleanupErr) {
        console.error('[agents] Cleanup failed after tool install error:', cleanupErr);
      }
      throw new Error(`Tool installation failed: ${installErr?.message || installErr}`);
    }

    // Store AKM JTI + exp for revocation on stop
    if (akmJti) {
      await getPool().query(
        `UPDATE agents SET akm_jti = $1, akm_exp = $2, updated_at = NOW() WHERE id = $3`,
        [akmJti, akmExp, req.params.id]
      );
    }

    // Store model-router JTI + exp + refresh hash for revocation on stop and token refresh
    if (modelRouterJti) {
      const mrRefreshHash = modelRouterRefreshSecret
        ? crypto.createHash('sha256').update(modelRouterRefreshSecret).digest('hex')
        : null;
      await getPool().query(
        `UPDATE agents SET model_router_jti = $1, model_router_exp = $2, model_router_refresh_hash = $3, updated_at = NOW() WHERE id = $4`,
        [modelRouterJti, modelRouterExp, mrRefreshHash, req.params.id]
      );
    }

    // Update DB (store work_token for chat dispatch verification)
    await getPool().query(
      // container_finished_at = NULL: this session has no end yet, and a
      // stale exact stop time left by the PREVIOUS container must not read
      // back out of GET /agents/:id while this one is running (#285).
      `UPDATE agents SET status = 'running', container_id = $1, work_token = $2, error_message = NULL, container_state = 'running', container_finished_at = NULL, updated_at = NOW() WHERE id = $3`,
      [containerId, workToken, req.params.id]
    );

    // First-hand evidence: this request started the container. Without this an
    // agent started while reconciliation is failing would report `unknown`
    // until the next successful pass, which would be needlessly pessimistic.
    markStatusVerified(agent.agent_id);

    // Record status transition
    try {
      await getPool().query(
        `INSERT INTO agent_status_history (agent_id, old_status, new_status, changed_by) VALUES ($1, $2, 'running', $3)`,
        [agent.id, agent.status, user.sub]
      );
    } catch (err) {
      console.error(`[agents] Status history insert failed for ${agent.agent_id}:`, err);
    }

    // Track session for uptime progression. COALESCE + IS NULL mirrors
    // closeSessionsForStoppedAgents' own stop-side pattern exactly: the
    // measured value when the read above got one, NOW() when it did not,
    // and started_at_estimated records honestly which happened — the same
    // shape stopped_at_estimated already gives the close side (#285).
    try {
      await getPool().query(
        `INSERT INTO agent_sessions (agent_id, started_at, started_at_estimated)
         VALUES ($1, COALESCE($2, NOW()), $2 IS NULL)`,
        [agent.id, containerStartedAt]
      );
    } catch (err) {
      console.error(`[agents] Session tracking insert failed for ${agent.agent_id}:`, err);
    }

    auditLog('start', agent.agent_id, user.sub, 'human', {
      principal_id: agent.id, owner_sub: agent.created_by, correlation_id: correlationId,
      container_id: containerId, network, profile_image: profileImage || 'hill90/agentbox:latest',
      akm_jti: akmJti, model_router_jti: modelRouterJti,
    });
    dispatchWebhooks(agent.agent_id, agent.id, 'start', { container_id: containerId });
    notify(agent.created_by, `Agent "${agent.name || agent.agent_id}" started`, 'agent_start', { agent_id: agent.id, agent_slug: agent.agent_id });
    res.json({ status: 'running', container_id: containerId, principal_id: agent.id });
  } catch (err: any) {
    console.error('[agents] Start error:', err);

    // Update DB with error
    try {
      await getPool().query(
        `UPDATE agents SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [err.message, req.params.id]
      );
      await getPool().query(
        `INSERT INTO agent_status_history (agent_id, old_status, new_status, changed_by) VALUES ($1, $2, 'error', $3)`,
        [req.params.id, 'starting', (req as any).user?.sub]
      );
    } catch { /* best effort */ }

    dispatchWebhooks(agentSlug, req.params.id, 'error', { error: err.message });
    notify((req as any).user?.sub, `Agent "${agentSlug}" failed to start: ${err.message}`, 'agent_error', { agent_id: req.params.id, agent_slug: agentSlug });
    res.status(500).json({ error: 'Failed to start agent', detail: err.message });
  }
});

// Stop agent
router.post('/:id/stop', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    // #245/#269. The ORDERING here — revoke, then stopAndRemoveContainer —
    // is #269's to change, not this fix's: a failed revoke that blocked the
    // stop would leave a running container behind, and whether that trade
    // is worth making is a judgement about risk tolerance, Jon's to make,
    // not derivable from the code. THIS FIX DOES NOT TOUCH THAT SEQUENCE.
    //
    // What it does fix does not depend on the ordering either way: revocation
    // here is a JTI denylist, so a token can only be stopped by NAME, and the
    // final UPDATE below used to null akm_jti/model_router_jti unconditionally
    // — including when the try/catch just above had caught a failure. That
    // does not just delay the fix; it destroys the only handle the row held
    // on a still-live token, making it unrevocable FOREVER rather than merely
    // revocable-late. Whichever order Jon eventually picks, that would still
    // be true, which is why it does not wait on #269.
    //
    // So each revoke's success is tracked, and BOTH the final UPDATE and the
    // audit trail below act on it: a failed revoke keeps its JTI/exp columns
    // instead of nulling them, and reports token_revoke_failed — naming the
    // jti, its expiry and the agent — instead of claiming token_revoked for
    // a token that is still live. AKM and model-router are fixed together:
    // they are the same shaped block twice in this file, and fixing one
    // while leaving its parallel is the drift that survived four months in
    // #114 and cost #308.
    //
    // DELIBERATELY NOT DECIDED HERE, and left to #269: whether an orphaned
    // (revoke-failed) token should also be counted or swept. Nothing below
    // retries a failed revoke or records it anywhere but the audit stream.
    let akmRevokeFailed = false;
    if (agent.akm_jti && isAkmConfigured()) {
      try {
        await revokeAgentAkmToken(agent.agent_id, agent.akm_jti, agent.akm_exp ?? undefined);
      } catch (err) {
        akmRevokeFailed = true;
        console.error(`[agents] AKM token revocation failed for ${agent.agent_id}:`, err);
        // Continue with stop — container removal is more important
      }
    }

    let modelRouterRevokeFailed = false;
    if (agent.model_router_jti && isModelRouterConfigured()) {
      try {
        await revokeAgentModelRouterToken(agent.agent_id, agent.model_router_jti, agent.model_router_exp ?? undefined);
      } catch (err) {
        modelRouterRevokeFailed = true;
        console.error(`[agents] Model-router token revocation failed for ${agent.agent_id}:`, err);
        // Continue with stop — container removal is more important
      }
    }

    await stopAndRemoveContainer(agent.agent_id);

    // Mark any pending chat messages from this agent as error (stale cleanup).
    // Contract: chat-dispatch uses agent UUID (agents.id) as author_id, not the slug.
    // Bump seq so SSE cursor-based consumers pick up the status transition.
    try {
      const { rowCount } = await getPool().query(
        `UPDATE chat_messages
         SET status = 'error', error_message = 'Agent stopped',
             seq = nextval('chat_messages_seq')
         WHERE author_id = $1 AND author_type = 'agent' AND status = 'pending'`,
        [agent.id]
      );
      if (rowCount && rowCount > 0) {
        console.log(`[agents] Marked ${rowCount} pending chat message(s) as error for ${agent.agent_id}`);
      }
    } catch (err) {
      console.error(`[agents] Stale chat message cleanup failed for ${agent.agent_id}:`, err);
      // Continue with stop — clearing agent state is more important
    }

    // Close open session for uptime tracking
    try {
      await getPool().query(
        `UPDATE agent_sessions SET stopped_at = NOW()
         WHERE agent_id = $1 AND stopped_at IS NULL`,
        [agent.id]
      );
    } catch (err) {
      console.error(`[agents] Session tracking update failed for ${agent.agent_id}:`, err);
    }

    // #245: a revoke that failed above keeps its columns here — nulling them
    // would erase the only name a retry or an operator could revoke by.
    const stopUpdateSets = [
      `status = 'stopped'`, `container_id = NULL`, `work_token = NULL`,
      `error_message = NULL`, `container_state = 'absent'`, `updated_at = NOW()`,
    ];
    if (!akmRevokeFailed) {
      stopUpdateSets.push(`akm_jti = NULL`, `akm_exp = NULL`);
    }
    if (!modelRouterRevokeFailed) {
      stopUpdateSets.push(`model_router_jti = NULL`, `model_router_exp = NULL`, `model_router_refresh_hash = NULL`);
    }
    await getPool().query(
      `UPDATE agents SET ${stopUpdateSets.join(', ')} WHERE id = $1`,
      [req.params.id]
    );

    // Record status transition
    try {
      await getPool().query(
        `INSERT INTO agent_status_history (agent_id, old_status, new_status, changed_by) VALUES ($1, $2, 'stopped', $3)`,
        [agent.id, agent.status, user.sub]
      );
    } catch (err) {
      console.error(`[agents] Status history insert failed for ${agent.agent_id}:`, err);
    }

    const stopCorrelationId = (req as any).correlationId;
    // AI-115: token_revoked audit events. #245: the event now agrees with
    // what actually happened — token_revoke_failed, naming the jti and its
    // expiry, when the revoke above threw; token_revoked, as before, only
    // when it actually succeeded. The old code emitted token_revoked
    // unconditionally, so the one record an operator would consult
    // afterward said "revoked" for a token that was not — the same silence
    // with a reassuring word attached.
    if (agent.akm_jti) {
      if (akmRevokeFailed) {
        auditLog('token_revoke_failed', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.akm_jti, exp: agent.akm_exp, reason: 'stop',
          owner_sub: agent.created_by, correlation_id: stopCorrelationId,
        });
      } else {
        auditLog('token_revoked', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.akm_jti, reason: 'stop',
          owner_sub: agent.created_by, correlation_id: stopCorrelationId,
        });
      }
    }
    if (agent.model_router_jti) {
      if (modelRouterRevokeFailed) {
        auditLog('token_revoke_failed', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.model_router_jti, exp: agent.model_router_exp, reason: 'stop',
          owner_sub: agent.created_by, correlation_id: stopCorrelationId,
        });
      } else {
        auditLog('token_revoked', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, jti: agent.model_router_jti, reason: 'stop',
          owner_sub: agent.created_by, correlation_id: stopCorrelationId,
        });
      }
    }
    auditLog('stop', agent.agent_id, user.sub, 'human', {
      principal_id: agent.id, owner_sub: agent.created_by, correlation_id: stopCorrelationId,
    });
    dispatchWebhooks(agent.agent_id, agent.id, 'stop', {});
    notify(agent.created_by, `Agent "${agent.name || agent.agent_id}" stopped`, 'agent_stop', { agent_id: agent.id, agent_slug: agent.agent_id });
    res.json({ status: 'stopped' });
  } catch (err: any) {
    console.error('[agents] Stop error:', err);
    res.status(500).json({ error: 'Failed to stop agent', detail: err.message });
  }
});

// Get live container status
router.get('/:id/status', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT agent_id, status, container_id, error_message FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    let containerStatus = null;

    if (agent.container_id) {
      containerStatus = await inspectContainer(agent.agent_id);
    }

    res.json({
      db_status: agent.status,
      container: containerStatus,
      error_message: agent.error_message,
    });
  } catch (err) {
    console.error('[agents] Status error:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Get per-agent tool installation statuses
router.get('/:id/tool-installs', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { rows } = await getPool().query(
      `SELECT ati.tool_id, t.name AS tool_name, t.description AS tool_description,
              ati.status, ati.install_message, ati.installed_at, ati.updated_at
       FROM agent_tool_installs ati
       JOIN tools t ON t.id = ati.tool_id
       WHERE ati.agent_id = $1
       ORDER BY t.name ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[agents] Tool install status error:', err);
    res.status(500).json({ error: 'Failed to get tool install status' });
  }
});

// Reconcile tool installations for a running agent
router.post('/:id/reconcile-tools', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query('SELECT id, agent_id, status FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent must be running to reconcile tools. Use start instead.' });
      return;
    }

    const result = await reconcileToolInstalls(agent.id, agent.agent_id);
    auditLog('reconcile_tools', agent.agent_id, user.sub, 'human', result);
    res.json(result);
  } catch (err: any) {
    console.error('[agents] Reconcile tools error:', err);
    res.status(500).json({ error: 'Failed to reconcile tools', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Inference event helpers (model_usage → AgentEvent merge)
// ---------------------------------------------------------------------------

interface InferenceRow {
  id: string;
  agent_id: string;
  model_name: string;
  request_type: string;
  status: string;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null; // Postgres numeric serializes as string
  requested_model: string | null;
  provider_model_id: string | null;
  created_at: Date;
}

function mapInferenceToEvent(row: InferenceRow): Record<string, unknown> {
  const cost = Number(row.cost_usd ?? 0);
  return {
    id: `inference-${row.id}`,
    timestamp: row.created_at.toISOString(),
    type: row.status === 'success' ? 'inference_complete' : `inference_${row.status}`,
    tool: 'inference',
    input_summary: `${row.model_name} (${row.request_type})`,
    output_summary: `${row.input_tokens ?? 0}+${row.output_tokens ?? 0} tokens, $${cost.toFixed(4)}, ${row.latency_ms ?? 0}ms`,
    duration_ms: row.latency_ms ?? null,
    success: row.status === 'success',
    metadata: {
      model_name: row.model_name,
      requested_model: row.requested_model,
      provider_model_id: row.provider_model_id,
      request_type: row.request_type,
      status: row.status,
      input_tokens: row.input_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
      cost_usd: cost,
    },
  };
}

async function getRecentInference(
  agentId: string,
  limit: number,
  userSub: string,
  admin: boolean,
  cursor?: { createdAt: string; id: string },
): Promise<InferenceRow[]> {
  if (cursor) {
    // Incremental: rows after cursor, oldest-first
    const conditions = [`agent_id = $1`, `(created_at, id) > ($2, $3)`];
    const params: unknown[] = [agentId, cursor.createdAt, cursor.id];
    let paramIdx = 4;
    if (!admin) {
      conditions.push(`owner = $${paramIdx++}`);
      params.push(userSub);
    }
    params.push(limit);
    const { rows } = await getPool().query(
      `SELECT id, agent_id, model_name, request_type, status, latency_ms,
              input_tokens, output_tokens, cost_usd,
              requested_model, provider_model_id, created_at
       FROM model_usage
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC
       LIMIT $${paramIdx}`,
      params,
    );
    return rows;
  }

  // Backfill: N most recent rows (newest-first), reversed in caller for chronological emission
  const conditions = [`agent_id = $1`];
  const params: unknown[] = [agentId];
  let paramIdx = 2;
  if (!admin) {
    conditions.push(`owner = $${paramIdx++}`);
    params.push(userSub);
  }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT id, agent_id, model_name, request_type, status, latency_ms,
            input_tokens, output_tokens, cost_usd,
            requested_model, provider_model_id, created_at
     FROM model_usage
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${paramIdx}`,
    params,
  );
  return rows.reverse(); // Oldest first
}

// Get agent events (structured activity timeline)
router.get('/:id/events', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const roles: string[] = rolesFrom(user);
    const admin = roles.includes('admin');

    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT agent_id, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent is not running. Event history is not available for stopped agents.' });
      return;
    }

    // Ceiling, not just a floor. This value goes two places on one request:
    // `tail -n <n>` inside the agent container, whose output the one-shot path
    // buffers whole before Buffer.concat, and the LIMIT of the model_usage query
    // in getRecentInference. Unbounded, one signed-in user could ask for the
    // agent's entire log and inference history in a single response — and
    // app-api declares no mem_limit, so the ceiling was the VPS's memory, shared
    // with the platform. 5000 is the bound /events/export already applies to the
    // same parameter; the two must not disagree.
    const parsedTail = parseInt(req.query.tail as string);
    const tail = Number.isNaN(parsedTail) ? 100 : Math.max(0, Math.min(parsedTail, MAX_EVENT_TAIL));
    const follow = req.query.follow === 'true';

    if (follow) {
      // SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // This stream must not outlive the credential that authorised it. It is
      // authenticated once, here, and then held open indefinitely by the poll and
      // heartbeat below — so without a deadline it keeps delivering after the token
      // expires, after sign-out, and after roles are revoked. Same defect as the
      // terminal proxy (app#145), different transport.
      const clearDeadline = armCredentialDeadline(
        res as never,
        (req as any).user?.exp,
        () => endStreamForExpiredCredential(res as never, 'agents-events'),
      );
      req.on('close', () => clearDeadline?.());
      res.flushHeaders();

      // Phase 1: Initial inference backfill
      let cursorCreatedAt = new Date().toISOString();
      let cursorId = '';
      try {
        const backfillRows = await getRecentInference(agent.agent_id, tail, user.sub, admin);
        for (const row of backfillRows) {
          res.write(`data: ${JSON.stringify(mapInferenceToEvent(row))}\n\n`);
        }
        if (backfillRows.length > 0) {
          const last = backfillRows[backfillRows.length - 1];
          cursorCreatedAt = last.created_at.toISOString();
          cursorId = last.id;
        }
      } catch (err) {
        console.error('[agents] SSE inference backfill failed (continuing):', err);
      }

      // Phase 2: tail -f for container events
      //
      // OWNERSHIP IS REGISTERED BEFORE THE STREAM EXISTS, AND RE-CHECKED AFTER.
      // `execInContainer` is awaited below. A client that goes away DURING that
      // await — an ordinary page navigation — makes Node emit 'close' before any
      // handler capable of destroying the stream exists. 'close' is not replayed,
      // so a listener registered afterwards never fires: the `tail -f` then runs
      // in the container for the life of this process, read and discarded.
      //
      // TWO CONDITIONS, BOTH REQUIRED. Registering the cleanup first is necessary
      // but not sufficient, because when it runs the stream it must destroy has
      // not been created yet. So `closed` is re-checked AFTER the await and the
      // stream destroyed there. Neither half closes the hole alone.
      //
      // The sibling at chat.ts (threads/:id/stream) has had the first half since
      // its own leak; these three container-stream routes never got either.
      let closed = false;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let liveStream: { destroy?: () => void } | null = null;
      const clearPoll = () => {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      };
      const cleanup = () => {
        closed = true;
        clearPoll();
        liveStream?.destroy?.();
        liveStream = null;
      };
      req.on('close', cleanup);

      try {
        const stream = await execInContainer(agent.agent_id, [
          'tail', '-f', '-n', String(tail), '/var/log/agentbox/events.jsonl',
        ]);
        liveStream = stream as unknown as { destroy?: () => void };
        // The client left while the exec was in flight; cleanup has already run and
        // found nothing to destroy.
        if (closed) { liveStream.destroy?.(); return; }

        // Every SSE frame goes through this. res.write() returns false when the
        // socket is full and Node will happily buffer past that, without limit —
        // see sse-writer.ts. Backpressure pauses the container stream; the cap
        // ends a stream nobody is reading.
        const sse = createBoundedSseWriter(res as never, {
          hardCapBytes: SSE_DEFAULTS.hardCapBytes,
          onOverflow: (queued) => {
            console.error(
              `[agents] SSE aborted: ${queued} bytes queued for a client that is not reading`,
            );
            clearPoll();
            (stream as unknown as { destroy?: () => void }).destroy?.();
            res.write(
              `event: error\ndata: ${JSON.stringify({
                error: 'Client not reading',
                detail: 'The event stream was stopped because its buffer limit was exceeded.',
              })}\n\n`,
            );
            res.end();
          },
        });

        // Phase 3: inference poll
        const pollMs = inferencePollMs();
        pollInterval = setInterval(async () => {
          if (res.writableEnded || res.destroyed) return;
          try {
            const newRows = await getRecentInference(
              agent.agent_id, 50, user.sub, admin,
              { createdAt: cursorCreatedAt, id: cursorId },
            );
            for (const row of newRows) {
              if (res.writableEnded || res.destroyed) return;
              sse.write(`data: ${JSON.stringify(mapInferenceToEvent(row))}\n\n`);
            }
            if (newRows.length > 0) {
              const last = newRows[newRows.length - 1];
              cursorCreatedAt = last.created_at.toISOString();
              cursorId = last.id;
            }
          } catch (err) {
            console.error('[agents] SSE inference poll failed (continuing):', err);
          }
        }, pollMs);

        // The producer to slow down when the client falls behind. Without this the
        // writer can only refuse writes; with it, `tail -f` stops being read and
        // the stall reaches the agent instead of this process's memory.
        sse.setSource(stream as unknown as { pause(): void; resume(): void });

        let buffer = '';
        // Bytes held in the trailing INCOMPLETE line. On this path the hazard is
        // not the total — a follow stream is meant to run long — it is a line
        // that never ends, which `buffer` would grow to hold forever.
        let pendingBytes = 0;
        // Destroying a stream does not un-queue the 'data' events already
        // scheduled, so without this the abort path runs twice and emits a second
        // error frame for one abort.
        //
        // This comment used to end "and the second res.write() throws 'write after
        // end'". That is false, and it was measured rather than argued: on Node
        // v26.5.0 a `res.write()` after `res.end()`, and a `res.write()` after the
        // client has disconnected, both return false silently — no throw, no
        // 'error' event even with a listener attached, no uncaught exception. The
        // flag is still right; the reason given for it was not. A confidently wrong
        // comment is the same hazard as a check that cannot fire: it survives review
        // because it sounds like it was verified.
        let aborted = false;
        stream.on('data', (chunk: Buffer) => {
          if (aborted || res.writableEnded || res.destroyed) return;
          pendingBytes += chunk.length;
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // keep incomplete line in buffer
          if (lines.length > 0) {
            // Something was consumed, so only the leftover is still pending.
            pendingBytes = Buffer.byteLength(buffer);
          }
          if (pendingBytes > MAX_READ_BYTES) {
            // Explicit, not silent. A stream that simply stopped emitting would
            // be indistinguishable from an idle agent.
            aborted = true;
            console.error(`[agents] SSE aborted: unterminated line over ${MAX_READ_BYTES} bytes`);
            res.write(
              `event: error\ndata: ${JSON.stringify({
                error: 'Event log line too large',
                detail: `A single log line exceeded the ${MAX_READ_BYTES}-byte read limit; the stream was stopped.`,
              })}\n\n`,
            );
            clearPoll();
            (stream as unknown as { destroy?: () => void }).destroy?.();
            res.end();
            return;
          }
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Validate JSON — skip any non-JSON lines (e.g. tail errors)
            try { JSON.parse(trimmed); } catch { continue; }
            sse.write(`data: ${trimmed}\n\n`);
          }
        });

        stream.on('end', () => {
          clearPoll();
          if (buffer.trim()) {
            try { JSON.parse(buffer.trim()); res.write(`data: ${buffer.trim()}\n\n`); } catch { /* skip */ }
          }
          res.write('event: end\ndata: stream closed\n\n');
          res.end();
        });

        stream.on('error', (err: Error) => {
          clearPoll();
          res.write(`event: error\ndata: ${err.message}\n\n`);
          res.end();
        });

      } catch (err: any) {
        res.write(`event: error\ndata: ${err.message}\n\n`);
        res.end();
      }
      return;
    }

    // One-shot: return events as JSON array, merged with inference events
    try {
      const stream = await execInContainer(agent.agent_id, [
        'tail', '-n', String(tail), '/var/log/agentbox/events.jsonl',
      ]);

      let rawBuf: Buffer;
      try {
        // Bounded as it arrives. `tail -n` limits how many LINES are asked for;
        // nothing limits how long one line is, and the agent writes this file.
        rawBuf = await collectBounded(stream);
      } catch (err) {
        if (err instanceof ReadTooLargeError) {
          res.status(413).json({
            error: 'Event log too large',
            detail: `The agent's event log exceeds the ${MAX_READ_BYTES}-byte read limit. Lower ?tail= or export a narrower range.`,
          });
          return;
        }
        res.status(500).json({ error: 'Failed to read events', detail: (err as Error).message });
        return;
      }

      await (async () => {
        try {
          const raw = rawBuf.toString('utf-8');
          const containerEvents = raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
              try { return JSON.parse(line); } catch { return null; }
            })
            .filter(e => e !== null);

          // Merge inference events from DB
          let inferenceEvents: Record<string, unknown>[] = [];
          try {
            const inferenceRows = await getRecentInference(agent.agent_id, tail, user.sub, admin);
            inferenceEvents = inferenceRows.map(mapInferenceToEvent);
          } catch (err) {
            console.error('[agents] One-shot inference query failed (continuing):', err);
          }

          // Merge and sort by (timestamp, id)
          const merged = [...containerEvents, ...inferenceEvents].sort((a: any, b: any) => {
            const tsCmp = (a.timestamp || '').localeCompare(b.timestamp || '');
            if (tsCmp !== 0) return tsCmp;
            return (a.id || '').localeCompare(b.id || '');
          });

          res.json(merged);
        } catch (err: any) {
          console.error('[agents] One-shot merge failed:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to merge events', detail: err.message });
          }
        }
      })();
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to read events', detail: err.message });
    }
  } catch (err) {
    console.error('[agents] Events error:', err);
    res.status(500).json({ error: 'Failed to get events' });
  }
});


// Export agent events as CSV download
router.get('/:id/events/export', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const roles: string[] = rolesFrom(user);
    const admin = roles.includes('admin');

    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT agent_id, name, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent is not running. Event export is not available for stopped agents.' });
      return;
    }

    const parsedTail = parseInt(req.query.tail as string);
    const tail = Number.isNaN(parsedTail) ? 500 : Math.max(0, Math.min(parsedTail, MAX_EVENT_TAIL));

    // Collect container events
    let containerEvents: Record<string, unknown>[] = [];
    try {
      const stream = await execInContainer(agent.agent_id, [
        'tail', '-n', String(tail), '/var/log/agentbox/events.jsonl',
      ]);
      const raw = (await collectBounded(stream)).toString('utf-8');
      containerEvents = raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(e => e !== null);
    } catch (err) {
      if (err instanceof ReadTooLargeError) {
        // Must NOT fall through to the generic catch below. That one logs and
        // continues with an empty containerEvents, which would hand back a CSV
        // that looks complete and silently contains none of the agent's events.
        res.status(413).json({
          error: 'Event log too large',
          detail: `The agent's event log exceeds the ${MAX_READ_BYTES}-byte read limit. Lower ?tail= to export a narrower range.`,
        });
        return;
      }
      console.error('[agents] CSV export container events failed:', err);
    }

    // Collect inference events
    let inferenceEvents: Record<string, unknown>[] = [];
    try {
      const inferenceRows = await getRecentInference(agent.agent_id, tail, user.sub, admin);
      inferenceEvents = inferenceRows.map(mapInferenceToEvent);
    } catch (err) {
      console.error('[agents] CSV export inference query failed:', err);
    }

    // Merge and sort
    const merged = [...containerEvents, ...inferenceEvents].sort((a: any, b: any) => {
      const tsCmp = (a.timestamp || '').localeCompare(b.timestamp || '');
      if (tsCmp !== 0) return tsCmp;
      return (a.id || '').localeCompare(b.id || '');
    });

    // Build CSV
    const csvHeaders = ['timestamp', 'type', 'tool', 'success', 'duration_ms', 'input_summary', 'output_summary'];
    const escapeCsv = (val: unknown): string => {
      const s = val == null ? '' : String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const csvRows = merged.map((e: any) =>
      csvHeaders.map(h => escapeCsv(e[h])).join(',')
    );
    const csv = [csvHeaders.join(','), ...csvRows].join('\n');

    const safeName = (agent.name || agent.agent_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-events-${dateStr}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[agents] Events export error:', err);
    res.status(500).json({ error: 'Failed to export events' });
  }
});

// Filter log lines by search term and timestamp range.
function filterLogLines(lines: string[], search?: string, since?: string, until?: string): string[] {
  let filtered = lines;
  if (since || until) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const untilMs = until ? new Date(until).getTime() : Infinity;
    if (!isNaN(sinceMs) || !isNaN(untilMs)) {
      filtered = filtered.filter((line) => {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 10) return true;
        const ts = new Date(line.slice(0, spaceIdx)).getTime();
        if (isNaN(ts)) return true;
        return ts >= (isNaN(sinceMs) ? 0 : sinceMs) && ts <= (isNaN(untilMs) ? Infinity : untilMs);
      });
    }
  }
  if (search) {
    const term = search.toLowerCase();
    filtered = filtered.filter((line) => line.toLowerCase().includes(term));
  }
  return filtered;
}

// Get container logs
router.get('/:id/logs', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query('SELECT agent_id, status FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    // Clamped like its siblings. The read is already byte-capped by
    // collectBounded, so this bounds the ask rather than the damage — but an
    // unclamped literal here is how the drift starts.
    const tail = Math.min(parseInt(req.query.tail as string) || 200, MAX_EVENT_TAIL);
    const follow = req.query.follow === 'true';
    const search = (req.query.search as string) || undefined;
    const since = (req.query.since as string) || undefined;
    const until = (req.query.until as string) || undefined;

    if (follow) {
      // SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // This stream must not outlive the credential that authorised it. It is
      // authenticated once, here, and then held open indefinitely by the poll and
      // heartbeat below — so without a deadline it keeps delivering after the token
      // expires, after sign-out, and after roles are revoked. Same defect as the
      // terminal proxy (app#145), different transport.
      const clearDeadline = armCredentialDeadline(
        res as never,
        (req as any).user?.exp,
        () => endStreamForExpiredCredential(res as never, 'agents-logs'),
      );
      req.on('close', () => clearDeadline?.());
      res.flushHeaders();

      // Same two conditions as the events follow stream above: own the stream
      // before it exists, then re-check after the await. A 'close' arriving while
      // `getContainerLogs` is in flight is not replayed to a listener registered
      // afterwards, so without the second check this `follow: true` log stream
      // runs for the life of the process with nobody to stop it.
      let closed = false;
      let liveStream: { destroy?: () => void } | null = null;
      const cleanup = () => {
        closed = true;
        liveStream?.destroy?.();
        liveStream = null;
      };
      req.on('close', cleanup);

      try {
        const stream = await getContainerLogs(agent.agent_id, { tail, follow: true });
        liveStream = stream as unknown as { destroy?: () => void };
        if (closed) { liveStream.destroy?.(); return; }

        stream.on('data', (chunk: Buffer) => {
          // Docker stream has 8-byte header per frame; strip it
          const lines = stripDockerHeader(chunk);
          const filtered = filterLogLines(lines, search, since, until);
          for (const line of filtered) {
            res.write(`data: ${line}\n\n`);
          }
        });

        stream.on('end', () => {
          res.write('event: end\ndata: stream closed\n\n');
          res.end();
        });

        stream.on('error', (err: Error) => {
          res.write(`event: error\ndata: ${err.message}\n\n`);
          res.end();
        });

      } catch (err: any) {
        res.write(`event: error\ndata: ${err.message}\n\n`);
        res.end();
      }
      return;
    }

    // Non-streaming: return log text
    const stream = await getContainerLogs(agent.agent_id, { tail, follow: false });
    let logBuf: Buffer;
    try {
      logBuf = await collectBounded(stream);
    } catch (err) {
      if (err instanceof ReadTooLargeError) {
        res.status(413).json({
          error: 'Log too large',
          detail: `The container log exceeds the ${MAX_READ_BYTES}-byte read limit. Lower ?tail= or narrow the range.`,
        });
        return;
      }
      res.status(500).json({ error: 'Failed to read logs', detail: (err as Error).message });
      return;
    }
    const lines = stripDockerHeader(logBuf);
    const filtered = filterLogLines(lines, search, since, until);
    res.json({ logs: filtered.join('\n') });
  } catch (err) {
    console.error('[agents] Logs error:', err);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// ---------------------------------------------------------------------------
// Skill assignment (user role, RBAC on scope)
// ---------------------------------------------------------------------------

// Assign skill to agent
router.post('/:id/skills', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { skill_id } = req.body;

    if (!skill_id) {
      res.status(400).json({ error: 'skill_id is required' });
      return;
    }

    // Check agent exists and user has access
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (agentRows[0].status === 'running') {
      res.status(409).json({ error: 'Cannot modify skills on a running agent. Stop it first.' });
      return;
    }

    // Look up skill and check scope-based RBAC
    const { rows: skillRows } = await getPool().query(
      'SELECT id, scope, tools_config FROM skills WHERE id = $1',
      [skill_id]
    );
    if (skillRows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const skillScope = skillRows[0].scope;
    if (ELEVATED_SCOPES.includes(skillScope) && !isAdmin(req)) {
      auditLog('skill_assign_denied', req.params.id, user.sub, 'human', { skill_id, skill_scope: skillScope, endpoint: 'POST /agents/:id/skills' });
      res.status(403).json({ error: `Assigning ${skillScope} skills requires admin role` });
      return;
    }

    // Additive: INSERT only, catch PK violation as 409
    let assignmentRow;
    try {
      const { rows } = await getPool().query(
        `INSERT INTO agent_skills (agent_id, skill_id, assigned_by)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [req.params.id, skill_id, user.sub]
      );
      assignmentRow = rows[0];
    } catch (insertErr: any) {
      if (insertErr.code === '23505') {
        res.status(409).json({ error: 'Skill already assigned to this agent' });
        return;
      }
      throw insertErr;
    }

    // Resolve-on-save: merge tools_config from all skills for this agent
    const { rows: allSkillConfigs } = await getPool().query(
      `SELECT s.tools_config FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [req.params.id]
    );
    const allConfigs = allSkillConfigs.map((r: any) => r.tools_config);
    const mergedConfig = mergeToolsConfigs(allConfigs);
    await getPool().query(
      'UPDATE agents SET tools_config = $1 WHERE id = $2',
      [JSON.stringify(mergedConfig), req.params.id]
    );

    auditLog('skill_assign', req.params.id, user.sub, 'human', { skill_id, skill_scope: skillScope, endpoint: 'POST /agents/:id/skills' });
    res.status(201).json(assignmentRow);
  } catch (err: any) {
    console.error('[agents] Assign skill error:', err);
    res.status(500).json({ error: 'Failed to assign skill' });
  }
});

// Remove skill from agent
router.delete('/:id/skills/:skillId', requireRole('user'), async (req: Request, res: Response) => {
  try {
    // Check agent exists and user has access
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (agentRows[0].status === 'running') {
      res.status(409).json({ error: 'Cannot modify skills on a running agent. Stop it first.' });
      return;
    }

    // Look up skill to check scope-based RBAC
    const { rows: skillRows } = await getPool().query(
      'SELECT id, scope FROM skills WHERE id = $1',
      [req.params.skillId]
    );
    if (skillRows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const skillScope = skillRows[0].scope;
    if (ELEVATED_SCOPES.includes(skillScope) && !isAdmin(req)) {
      const user = (req as any).user;
      auditLog('skill_remove_denied', req.params.id, user.sub, 'human', { skill_id: req.params.skillId, skill_scope: skillScope, endpoint: 'DELETE /agents/:id/skills/:skillId' });
      res.status(403).json({ error: `Removing ${skillScope} skills requires admin role` });
      return;
    }

    const { rowCount } = await getPool().query(
      'DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2',
      [req.params.id, req.params.skillId]
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'Skill assignment not found' });
      return;
    }

    // Recompute tools_config from remaining skills
    const { rows: remainingConfigs } = await getPool().query(
      `SELECT s.tools_config FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [req.params.id]
    );
    const removeConfigs = remainingConfigs.map((r: any) => r.tools_config);
    const removeMerged = removeConfigs.length > 0
      ? mergeToolsConfigs(removeConfigs)
      : DEFAULT_TOOLS_CONFIG;
    await getPool().query(
      'UPDATE agents SET tools_config = $1 WHERE id = $2',
      [JSON.stringify(removeMerged), req.params.id]
    );

    const user = (req as any).user;
    auditLog('skill_remove', req.params.id, user.sub, 'human', { skill_id: req.params.skillId, skill_scope: skillScope, endpoint: 'DELETE /agents/:id/skills/:skillId' });
    res.json({ removed: true });
  } catch (err) {
    console.error('[agents] Remove skill error:', err);
    res.status(500).json({ error: 'Failed to remove skill' });
  }
});

function stripDockerHeader(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) {
      // Remaining data without header
      lines.push(buf.subarray(offset).toString('utf-8').trimEnd());
      break;
    }
    const size = buf.readUInt32BE(offset + 4);
    if (size === 0 || offset + 8 + size > buf.length) {
      lines.push(buf.subarray(offset + 8).toString('utf-8').trimEnd());
      break;
    }
    const line = buf.subarray(offset + 8, offset + 8 + size).toString('utf-8').trimEnd();
    if (line) lines.push(line);
    offset += 8 + size;
  }
  return lines;
}

// Agent progression — stats (computed from existing data)
router.get('/:id/stats', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const agent = rows[0];

    // Parallel queries for stats
    const [inferenceResult, chatResult, sessionResult, skillResult] = await Promise.all([
      getPool().query(
        `SELECT COUNT(*) AS total_inferences,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0) AS estimated_cost,
                COUNT(DISTINCT model_name) AS distinct_models
         FROM model_usage WHERE agent_id = $1`,
        [agent.agent_id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS total_messages
         FROM chat_messages WHERE author_id = $1 AND author_type = 'agent'`,
        [agent.id],
      ),
      getPool().query(
        // #213: the total, AND what it does not know. `total_uptime_seconds`
        // keeps its meaning; the two companions say how much of it rests on a
        // guess — either end, close OR open (#285's second half) — and how
        // many sessions are still accruing. Neither was expressible before,
        // so a figure that was wrong — in either direction — looked exactly
        // like a quiet agent. OR, not just stopped_at_estimated: a session
        // whose START was guessed is just as much a guess as one whose STOP
        // was, and counting only one half would make started_at_estimated a
        // column that is written and never read.
        `SELECT COALESCE(SUM(
           EXTRACT(EPOCH FROM (COALESCE(stopped_at, NOW()) - started_at))
         ), 0) AS total_uptime_seconds,
         COALESCE(SUM(
           CASE WHEN stopped_at_estimated OR started_at_estimated
                THEN EXTRACT(EPOCH FROM (COALESCE(stopped_at, NOW()) - started_at)) ELSE 0 END
         ), 0) AS estimated_uptime_seconds,
         COUNT(*) FILTER (WHERE stopped_at IS NULL) AS open_sessions
         FROM agent_sessions WHERE agent_id = $1`,
        [agent.id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS skill_count FROM agent_skills WHERE agent_id = $1`,
        [agent.id],
      ),
    ]);

    const inf = inferenceResult.rows[0];
    const chat = chatResult.rows[0];
    const sess = sessionResult.rows[0];
    const skill = skillResult.rows[0];

    // Knowledge entries via AKM proxy (best-effort).
    //
    // `total` (X-Total-Count), NOT `data.length`. The length was the true
    // count until #182 bounded the knowledge endpoint at 500, after which it
    // silently reported 500 for every agent above that (#188). We only need
    // the number, so ask for the smallest page that still carries the header.
    let knowledgeEntries = 0;
    try {
      const akmProxy = await import('../services/akm-proxy');
      const akmResult = await akmProxy.listEntries(agent.agent_id, undefined, { limit: 1 });
      if (akmResult.status === 200 && akmResult.total !== null) {
        knowledgeEntries = akmResult.total;
      }
    } catch { /* AKM unavailable */ }

    res.json({
      total_inferences: Number(inf.total_inferences),
      total_tokens: Number(inf.total_tokens),
      estimated_cost: Number(Number(inf.estimated_cost).toFixed(4)),
      distinct_models: Number(inf.distinct_models),
      knowledge_entries: knowledgeEntries,
      chat_messages: Number(chat.total_messages),
      total_uptime_seconds: Math.floor(Number(sess.total_uptime_seconds)),
      // #213: `uptime_complete` is false when any of the total rests on a
      // guessed close, or when a session is still open and therefore still
      // growing. False does not mean the number is wrong — it means the service
      // cannot say that it is right.
      uptime_estimated_seconds: Math.floor(Number(sess.estimated_uptime_seconds || 0)),
      open_sessions: Number(sess.open_sessions || 0),
      uptime_complete: Number(sess.estimated_uptime_seconds || 0) === 0
        && Number(sess.open_sessions || 0) === 0,
      skills_assigned: Number(skill.skill_count),
      first_started: agent.created_at,
    });
  } catch (err: any) {
    console.error('[agents] Stats error:', err);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Agent metrics — computed operational metrics
router.get('/:id/metrics', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const agent = rows[0];

    const [messagesResult, eventsResult, lastActiveResult] = await Promise.all([
      getPool().query(
        `SELECT COUNT(*) AS total_messages
         FROM chat_messages WHERE author_id = $1 AND author_type = 'agent'`,
        [agent.id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS total_events
         FROM model_usage WHERE agent_id = $1`,
        [agent.agent_id],
      ),
      getPool().query(
        // #286. THREE faults in one statement, none reachable by anyone because
        // nothing has ever called this endpoint:
        //   1. `created_at` — a column `agent_sessions` has never had;
        //   2. the outer `MAX(created_at)` then names a column the UNION stops
        //      producing once (1) is fixed, since a UNION takes its names from
        //      the FIRST branch — fixing one moves the error rather than
        //      removing it;
        //   3. `$1` was compared against `agent_sessions.agent_id` (uuid) AND
        //      `chat_messages.author_id` (varchar):
        //      `operator does not exist: character varying = uuid`.
        `SELECT MAX(ts) AS last_active FROM (
           SELECT started_at AS ts FROM agent_sessions WHERE agent_id = $1
           UNION ALL
           SELECT created_at AS ts FROM chat_messages WHERE author_id = $2 AND author_type = 'agent'
           UNION ALL
           SELECT created_at AS ts FROM model_usage WHERE agent_id = $3
         ) AS events`,
        [agent.id, agent.id, agent.agent_id],
      ),
    ]);

    res.json({
      total_messages: Number(messagesResult.rows[0].total_messages),
      total_events: Number(eventsResult.rows[0].total_events),
      last_active: lastActiveResult.rows[0].last_active || null,
    });
  } catch (err: any) {
    console.error('[agents] Metrics error:', err);
    res.status(500).json({ error: 'Failed to compute metrics' });
  }
});

// Agent progression — artifacts (computed on-demand from stats)
const ARTIFACT_CATALOG = [
  { id: 'first_light', name: 'First Light', icon: '⚡', description: 'Completed first model inference', check: (s: any) => s.total_inferences >= 1 },
  { id: 'thousand_calls', name: 'Thousand Calls', icon: '🔥', description: '1,000 inferences completed', check: (s: any) => s.total_inferences >= 1000 },
  { id: 'ten_thousand', name: 'Ten Thousand', icon: '💫', description: '10,000 inferences completed', check: (s: any) => s.total_inferences >= 10000 },
  { id: 'first_plan', name: 'First Plan', icon: '🏗', description: 'Created first plan document', check: (s: any) => s.plan_entries >= 1 },
  { id: 'decision_maker', name: 'Decision Maker', icon: '⚖️', description: 'Recorded first architecture decision', check: (s: any) => s.decision_entries >= 1 },
  { id: 'deep_research', name: 'Deep Research', icon: '🔬', description: 'Conducted first research investigation', check: (s: any) => s.research_entries >= 1 },
  { id: 'memory_keeper', name: 'Memory Keeper', icon: '🧠', description: 'Accumulated 100 knowledge entries', check: (s: any) => s.knowledge_entries >= 100 },
  { id: 'chat_veteran', name: 'Chat Veteran', icon: '💬', description: 'Sent 100 chat messages', check: (s: any) => s.chat_messages >= 100 },
  { id: 'polyglot', name: 'Polyglot', icon: '🌐', description: 'Used 2+ different models', check: (s: any) => s.distinct_models >= 2 },
  { id: 'week_runner', name: 'Week Runner', icon: '⏱', description: '7 days cumulative uptime', check: (s: any) => s.total_uptime_seconds >= 7 * 86400 },
  { id: 'month_runner', name: 'Month Runner', icon: '🏃', description: '30 days cumulative uptime', check: (s: any) => s.total_uptime_seconds >= 30 * 86400 },
];

router.get('/:id/artifacts', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const agent = rows[0];

    // Gather signal data
    const [infResult, chatResult, sessResult] = await Promise.all([
      getPool().query(
        // #286: was `COUNT(DISTINCT model)`. The column is `model_name`, so this
        // endpoint answered 500 on every call too — found by the same check,
        // never by anyone using it.
        `SELECT COUNT(*) AS total_inferences, COUNT(DISTINCT model_name) AS distinct_models
         FROM model_usage WHERE agent_id = $1`,
        [agent.agent_id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS total_messages
         FROM chat_messages WHERE author_id = $1 AND author_type = 'agent'`,
        [agent.id],
      ),
      getPool().query(
        // #213, the twin of the /stats sum. Same query, same defect, same fix —
        // a total corrected on one endpoint and not the other is the drift
        // behind #141, #153 and #182. OR started_at_estimated per #285's
        // second half — see the /stats query's fuller comment.
        `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(stopped_at, NOW()) - started_at))), 0) AS total_uptime_seconds,
         COALESCE(SUM(CASE WHEN stopped_at_estimated OR started_at_estimated
                           THEN EXTRACT(EPOCH FROM (COALESCE(stopped_at, NOW()) - started_at)) ELSE 0 END), 0) AS estimated_uptime_seconds,
         COUNT(*) FILTER (WHERE stopped_at IS NULL) AS open_sessions
         FROM agent_sessions WHERE agent_id = $1`,
        [agent.id],
      ),
    ]);

    // Knowledge entry type counts via AKM proxy.
    //
    // Each count is its own X-Total-Count, not a filter over one page (#188).
    // Filtering the page under-counted by an amount that depended on
    // `updated_at` ordering — invisible to the reader, and wrong in a quieter
    // way than the total was. `limit: 1` because only the header is wanted.
    let knowledgeEntries = 0;
    let planEntries = 0;
    let decisionEntries = 0;
    let researchEntries = 0;
    try {
      const akmProxy = await import('../services/akm-proxy');
      const [all, plans, decisions, research] = await Promise.all([
        akmProxy.listEntries(agent.agent_id, undefined, { limit: 1 }),
        akmProxy.listEntries(agent.agent_id, 'plan', { limit: 1 }),
        akmProxy.listEntries(agent.agent_id, 'decision', { limit: 1 }),
        akmProxy.listEntries(agent.agent_id, 'research', { limit: 1 }),
      ]);
      if (all.status === 200 && all.total !== null) knowledgeEntries = all.total;
      if (plans.status === 200 && plans.total !== null) planEntries = plans.total;
      if (decisions.status === 200 && decisions.total !== null) decisionEntries = decisions.total;
      if (research.status === 200 && research.total !== null) researchEntries = research.total;
    } catch { /* AKM unavailable */ }

    const signalData = {
      total_inferences: Number(infResult.rows[0].total_inferences),
      distinct_models: Number(infResult.rows[0].distinct_models),
      chat_messages: Number(chatResult.rows[0].total_messages),
      total_uptime_seconds: Math.floor(Number(sessResult.rows[0].total_uptime_seconds)),
      knowledge_entries: knowledgeEntries,
      plan_entries: planEntries,
      decision_entries: decisionEntries,
      research_entries: researchEntries,
    };

    const artifacts = ARTIFACT_CATALOG.map(a => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      description: a.description,
      earned: a.check(signalData),
    }));

    res.json({ artifacts, earned_count: artifacts.filter(a => a.earned).length });
  } catch (err: any) {
    console.error('[agents] Artifacts error:', err);
    res.status(500).json({ error: 'Failed to compute artifacts' });
  }
});

// Agent runtime metrics — live CPU/memory from Docker container stats
router.get('/:id/runtime-metrics', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT agent_id FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const stats = await getContainerStats(rows[0].agent_id);
    if (!stats) {
      res.status(404).json({ error: 'Agent not running' });
      return;
    }

    res.json(stats);
  } catch (err: any) {
    console.error('[agents] Runtime metrics error:', err);
    res.status(500).json({ error: 'Failed to fetch runtime metrics' });
  }
});

// Agent workspace file listing — proxied from agentbox container
router.get('/:id/workspace', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const agent = rows[0];

    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent is not running' });
      return;
    }

    const path = (req.query.path as string) || '/home/agentuser';
    const read = req.query.read === 'true';
    const endpoint = read ? 'file-read' : 'files';
    const url = `http://agentbox-${agent.agent_id}:8054/${endpoint}?path=${encodeURIComponent(path)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      res.status(504).json({ error: 'Agentbox timed out' });
      return;
    }
    console.error('[agents] Workspace listing error:', err);
    res.status(502).json({ error: 'Failed to list workspace files' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /agents/:id/clone — clone an agent with a new name and ID
// ───────────────────────────────────────────────────────────────────

router.post('/:id/clone', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const pool = getPool();

    // Fetch the source agent
    const { rows: srcRows } = await pool.query(
      `SELECT agent_id, name, description, tools_config, cpus, mem_limit, pids_limit,
              soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level
       FROM agents WHERE id = $1`,
      [req.params.id]
    );
    if (srcRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const src = srcRows[0];

    // Generate a unique slug: original-clone or original-clone-N
    let cloneSlug = `${src.agent_id}-clone`;
    const { rows: existing } = await pool.query(
      `SELECT agent_id FROM agents WHERE agent_id LIKE $1 ORDER BY agent_id`,
      [`${src.agent_id}-clone%`]
    );
    if (existing.length > 0) {
      const taken = new Set(existing.map((r: any) => r.agent_id));
      if (taken.has(cloneSlug)) {
        let n = 2;
        while (taken.has(`${src.agent_id}-clone-${n}`)) n++;
        cloneSlug = `${src.agent_id}-clone-${n}`;
      }
    }

    const cloneName = req.body.name || `${src.name} (Clone)`;

    // Validate model_policy ownership if present
    let policyId = src.model_policy_id;
    if (policyId) {
      const { rows: policyRows } = await pool.query(
        'SELECT id, created_by, description FROM model_policies WHERE id = $1',
        [policyId]
      );
      if (policyRows.length > 0) {
        const pol = policyRows[0];
        // Auto-agent policies are per-agent — don't copy, let the new agent get its own
        if (isAutoAgentModelsPolicy(pol.description)) {
          policyId = null;
        } else if (pol.created_by !== null && pol.created_by !== user.sub) {
          policyId = null; // Can't assign another user's policy
        }
      } else {
        policyId = null;
      }
    }

    // Insert the cloned agent
    const { rows: cloneRows } = await pool.query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit,
                           soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::uuid, (SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL LIMIT 1)),
               $11, $12, $13)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
      [
        cloneSlug,
        cloneName,
        src.description || '',
        JSON.stringify(src.tools_config),
        src.cpus,
        src.mem_limit,
        src.pids_limit,
        src.soul_md || '',
        src.rules_md || '',
        policyId,
        src.container_profile_id || null,
        src.autonomy_level || 'act_within_scope',
        user.sub,
      ]
    );
    const cloned = cloneRows[0];

    // Clone skill assignments
    const { rows: srcSkills } = await pool.query(
      `SELECT skill_id FROM agent_skills WHERE agent_id = $1`,
      [req.params.id]
    );
    for (const { skill_id } of srcSkills) {
      await pool.query(
        'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
        [cloned.id, skill_id, user.sub]
      );
    }

    // If source had auto-agent models, create one for the clone too
    if (src.model_policy_id && !policyId) {
      const models = await resolveAgentModels(src.model_policy_id);
      if (models.length > 0) {
        const autoPolicyId = await upsertAutoAgentModelsPolicy(
          cloned.id, cloned.agent_id, user.sub, user.sub, models
        );
        await pool.query(
          `UPDATE agents SET model_policy_id = $1, updated_at = NOW() WHERE id = $2`,
          [autoPolicyId, cloned.id]
        );
        cloned.model_policy_id = autoPolicyId;
        cloned.models = models;
      }
    }

    if (!cloned.models) {
      cloned.models = await resolveAgentModels(cloned.model_policy_id);
    }

    // Fetch skills for response
    const { rows: skillRows } = await pool.query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [cloned.id]
    );
    cloned.skills = skillRows;

    res.status(201).json(cloned);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Clone slug already exists — try again' });
      return;
    }
    console.error('[agents] Clone error:', err);
    res.status(500).json({ error: 'Failed to clone agent' });
  }
});

// ───────────────────────────────────────────────────────────────────
// Webhooks CRUD
// ───────────────────────────────────────────────────────────────────

const VALID_WEBHOOK_EVENTS = ['start', 'stop', 'error'] as const;

// GET /agents/:id/webhooks — list webhooks for an agent
router.get('/:id/webhooks', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, agent_id, url, events, active, created_by, created_at, updated_at
       FROM agent_webhooks WHERE agent_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[agents] List webhooks error:', err);
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// POST /agents/:id/webhooks — register a webhook
router.post('/:id/webhooks', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { url, events, secret } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL format' });
      return;
    }

    // Validate events array
    const eventList: string[] = Array.isArray(events) ? events : ['start', 'stop', 'error'];
    for (const e of eventList) {
      if (!VALID_WEBHOOK_EVENTS.includes(e as any)) {
        res.status(400).json({ error: `Invalid event: ${e}. Valid: ${VALID_WEBHOOK_EVENTS.join(', ')}` });
        return;
      }
    }

    // Verify agent exists
    const { rows: agentRows } = await getPool().query(
      'SELECT id FROM agents WHERE id = $1', [req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // app#374 tier two: encrypted, not hashed — webhook-dispatch.ts must
    // recover this in plaintext to HMAC-sign outbound deliveries, unlike
    // workflows.webhook_token (#341), which is only ever compared. Same
    // helper/key as env_vars above; a webhook's secret is a single string,
    // not a heterogeneous blob, so no JSON.stringify is needed here.
    let secretEncrypted: Buffer | null = null;
    let secretNonce: Buffer | null = null;
    if (secret) {
      const enc = encryptProviderKey(secret, getEnvVarsEncryptionKey());
      secretEncrypted = enc.encrypted;
      secretNonce = enc.nonce;
    }

    const { rows } = await getPool().query(
      `INSERT INTO agent_webhooks (agent_id, url, events, secret_encrypted, secret_nonce, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, agent_id, url, events, active, created_by, created_at, updated_at`,
      [req.params.id, url, eventList, secretEncrypted, secretNonce, user.sub]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[agents] Create webhook error:', err);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// DELETE /agents/:id/webhooks/:webhookId — remove a webhook
router.delete('/:id/webhooks/:webhookId', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM agent_webhooks WHERE id = $1 AND agent_id = $2',
      [req.params.webhookId, req.params.id]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[agents] Delete webhook error:', err);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});


// ───────────────────────────────────────────────────────────────────
// PUT /agents/:id/schedule — update agent auto-start schedule
// ───────────────────────────────────────────────────────────────────

const CRON_FIELD_RE = /^(\*|[0-9,\-\/]+)$/;

function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(f => CRON_FIELD_RE.test(f));
}

router.put('/:id/schedule', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;

    const { rows: existing } = await getPool().query(
      `SELECT id FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { schedule_cron, schedule_enabled } = req.body;

    if (schedule_cron !== undefined && schedule_cron !== null && schedule_cron !== '') {
      if (typeof schedule_cron !== 'string' || !isValidCron(schedule_cron)) {
        res.status(400).json({ error: 'Invalid cron expression. Must be 5 fields: minute hour day month weekday' });
        return;
      }
    }

    const cronValue = (schedule_cron === '' || schedule_cron === null) ? null : schedule_cron;
    const enabledValue = schedule_enabled === true;

    if (enabledValue && !cronValue) {
      res.status(400).json({ error: 'Cannot enable schedule without a cron expression' });
      return;
    }

    const { rows } = await getPool().query(
      `UPDATE agents
       SET schedule_cron = COALESCE($1, schedule_cron),
           schedule_enabled = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, agent_id, schedule_cron, schedule_enabled`,
      [cronValue, enabledValue, req.params.id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[agents] Schedule update error:', err);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// ---------------------------------------------------------------
// GET /agents/:id/status-history
// ---------------------------------------------------------------

router.get('/:id/status-history', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;

    const { rows: agentRows } = await getPool().query(
      `SELECT id FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const { rows } = await getPool().query(
      `SELECT id, agent_id, old_status, new_status, changed_at, changed_by
       FROM agent_status_history
       WHERE agent_id = $1
       ORDER BY changed_at DESC
       LIMIT $2`,
      [req.params.id, limit]
    );

    res.json(rows);
  } catch (err) {
    console.error('[agents] Status history error:', err);
    res.status(500).json({ error: 'Failed to fetch status history' });
  }
});


// ───────────────────────────────────────────────────────────────────
// GET /agents/:id/journal — list journal entries
// ───────────────────────────────────────────────────────────────────

router.get('/:id/journal', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const { rows } = await getPool().query(
      `SELECT id, agent_id, entry_type, content, created_at
       FROM agent_journal
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.id, limit]
    );

    res.json(rows);
  } catch (err) {
    console.error('[agents] Journal list error:', err);
    res.status(500).json({ error: 'Failed to fetch journal' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /agents/:id/journal — append journal entry
// ───────────────────────────────────────────────────────────────────

router.post('/:id/journal', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { entry_type, content } = req.body;
    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const validTypes = ['observation', 'decision', 'plan', 'note', 'error'];
    const type = validTypes.includes(entry_type) ? entry_type : 'observation';

    const { rows: [entry] } = await getPool().query(
      `INSERT INTO agent_journal (agent_id, entry_type, content)
       VALUES ($1, $2, $3)
       RETURNING id, agent_id, entry_type, content, created_at`,
      [req.params.id, type, content.trim()]
    );

    res.status(201).json(entry);
  } catch (err) {
    console.error('[agents] Journal append error:', err);
    res.status(500).json({ error: 'Failed to append journal entry' });
  }
});

export default router;
