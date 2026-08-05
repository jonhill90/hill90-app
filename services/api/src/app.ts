// Must come before any router is invoked: it makes Express forward an async
// handler's rejection to the error middleware below instead of dropping it,
// which is the difference between a 500 and a dead process. See the file.
import './boot/async-errors';
import express, { Application, NextFunction, Request, Response } from 'express';
import { createRequireAuth, createJwksKeyResolver } from './middleware/auth';
import { getIssuer, getJwksUri } from './middleware/keycloak-config';
import { correlationId } from './middleware/correlation-id';
import type { JwtHeader } from 'jsonwebtoken';
import agentsRouter from './routes/agents';
import knowledgeRouter from './routes/knowledge';
import sharedKnowledgeRouter from './routes/shared-knowledge';
import modelPoliciesRouter from './routes/model-policies';
import skillsRouter from './routes/skills';
import toolsRouter from './routes/tools';
import containerProfilesRouter from './routes/container-profiles';
import providerConnectionsRouter from './routes/provider-connections';
import userModelsRouter from './routes/user-models';
import eligibleModelsRouter from './routes/eligible-models';
import profileRouter from './routes/profile';
import usageRouter from './routes/usage';
import { requireRole } from './middleware/role';
import { docsRouter, specRouter } from './routes/docs';
import secretsRouter from './routes/secrets';
import { delegationTokenHandler } from './services/model-router-delegation';
import chatRouter, { chatCallbackHandler, startStaleSweeper } from './routes/chat';
import tasksRouter from './routes/tasks';
import storageRouter from './routes/storage';
import notificationsRouter from './routes/notifications';
import workflowsRouter from './routes/workflows';
import workflowsWebhookRouter from './routes/workflows-webhook';
import mcpServersRouter from './routes/mcp-servers';
import { modelRouterRefreshHandler } from './services/model-router-refresh';
import discordInternalRouter from './routes/discord-internal';
import discordRouter from './routes/discord';

interface AppOptions {
  issuer?: string;
  getSigningKey?: (header: JwtHeader) => Promise<string>;
}

export function createApp(opts: AppOptions = {}): Application {
  const app = express();

  app.use(express.json());
  app.use(correlationId);

  // Health check — public
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'api' });
  });

  // Internal service-to-service endpoints (service-token auth, not Keycloak)
  app.post('/internal/delegation-token', delegationTokenHandler);
  app.post('/internal/chat/callback', chatCallbackHandler);
  app.post('/internal/model-router/refresh-token', modelRouterRefreshHandler);
  app.use('/internal/discord', discordInternalRouter);

  // Protected routes
  const issuer = getIssuer(opts.issuer);
  const jwksUri = getJwksUri(issuer);

  const requireAuth = createRequireAuth({
    issuer,
    getSigningKey: opts.getSigningKey || createJwksKeyResolver(jwksUri),
  });

  app.get('/me', requireAuth, (req, res) => {
    res.json((req as any).user);
  });

  // Detailed health — REQUIRES A SESSION. It reports the exact Node build, process
  // uptime, memory, database reachability and latency, and the tenant's inventory of
  // agents, threads and workflows. Served anonymously from api.hill90.com until this
  // gate was added, while /agents and /me next to it answered 401.
  //
  // Authentication, not `admin`: the caller is the UI's monitoring page, which is
  // linked from the dashboard and reachable by any signed-in user. requireAuth also
  // puts the refusal BEFORE the four database queries below, so an anonymous caller
  // cannot drive load into the internal network or time its reachability.
  //
  // /health above stays public on purpose — the platform's TenantApiDown alert
  // probes it. Both properties are pinned by tests.
  app.get('/health/detailed', requireAuth, async (_req, res) => {
    const mem = process.memoryUsage();
    let dbStatus: 'connected' | 'error' = 'error';
    let dbLatencyMs: number | null = null;

    try {
      const { getPool } = await import('./db/pool');
      const start = Date.now();
      await getPool().query('SELECT 1');
      dbLatencyMs = Date.now() - start;
      dbStatus = 'connected';
    } catch { /* db unreachable */ }

    // PLATFORM STATS: a figure that could not be read is NULL, never zero.
    //
    // The workflows query used to carry `.catch(() => ({ rows: [{ total: 0,
    // enabled: 0 }] }))`, so a failed query was served as a system with no
    // workflows — and the surrounding catch left `platform_stats` empty for any
    // other failure. Both are worse than an error: a reader who sees 0 stops
    // looking. This endpoint is read during an incident, which is exactly when a
    // plausible number costs the most.
    //
    // The status stays 200 and the shape stays the same, deliberately. The only
    // programmatic consumer is MonitoringClient.tsx, which does
    // `if (detRes.ok) setDetailed(...)` inside a try/catch that ignores failure —
    // a non-2xx would make the outage LESS visible by dropping the body. So the
    // honesty goes in the body: `null` for what could not be read, plus a list
    // naming it, so the reader is told rather than left to notice a null.
    const platformStats: Record<string, unknown> = {};
    const statsUnavailable: string[] = [];
    if (dbStatus === 'connected') {
      const { getPool } = await import('./db/pool');
      const pool = getPool();
      const settled = await Promise.allSettled([
        pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE status = 'running') AS running FROM agents`),
        pool.query(`SELECT count(*) AS total FROM chat_threads`),
        pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE enabled = true) AS enabled FROM workflows`),
      ]);
      const [agents, threads, workflows] = settled;

      platformStats.agents = agents.status === 'fulfilled'
        ? { total: Number(agents.value.rows[0].total), running: Number(agents.value.rows[0].running) }
        : null;
      platformStats.threads = threads.status === 'fulfilled' ? Number(threads.value.rows[0].total) : null;
      platformStats.workflows = workflows.status === 'fulfilled'
        ? { total: Number(workflows.value.rows[0].total), enabled: Number(workflows.value.rows[0].enabled) }
        : null;

      for (const [name, r] of [['agents', agents], ['threads', threads], ['workflows', workflows]] as const) {
        if (r.status === 'rejected') {
          statsUnavailable.push(name);
          console.warn(`[health] platform stat '${name}' could not be read; reporting it as unknown:`, r.reason);
        }
      }
    }

    res.json({
      status: dbStatus === 'connected' ? 'healthy' : 'degraded',
      // Which figures below are NOT answers. Empty means every one was read.
      stats_unavailable: statsUnavailable,
      service: 'api',
      // WHICH CODE IS RUNNING — the question #158 was filed about, and which
      // nothing outside the host could answer. Set by the deploy from the
      // commit it pinned; 'unstamped' means the container predates the
      // mechanism or was made by hand, and that is reported rather than hidden.
      //
      // Here and NOT on /health. That one is public — the platform's
      // TenantApiDown and the container healthcheck both probe it — and a build
      // SHA there would re-open what #136 closed. #158's text says /health; the
      // issue is wrong and has been amended.
      revision: process.env.DEPLOY_REVISION || 'unstamped',
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      database: {
        status: dbStatus,
        latency_ms: dbLatencyMs,
      },
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      platform: platformStats,
    });
  });

  // Agent management routes
  app.use('/agents', requireAuth, agentsRouter);

  // Model policy management routes (admin-only, enforced in router)
  app.use('/model-policies', requireAuth, modelPoliciesRouter);

  // Skill management routes (admin-only mutations, enforced in router)
  app.use('/skills', requireAuth, skillsRouter);

  // Tools catalog routes (admin-only mutations, enforced in router)
  app.use('/tools', requireAuth, toolsRouter);

  // Container profiles (read-only list, user role)
  app.use('/container-profiles', requireAuth, containerProfilesRouter);

  // Provider connections (user-scoped BYOK credentials)
  app.use('/provider-connections', requireAuth, providerConnectionsRouter);

  // User-defined models (user-scoped BYOK model definitions)
  app.use('/user-models', requireAuth, userModelsRouter);

  // Eligible models discovery (AI-120: user's own connection-derived models only)
  app.use('/eligible-models', requireAuth, eligibleModelsRouter);

  // Usage query routes (enforced in router)
  app.use('/usage', requireAuth, usageRouter);

  // Knowledge proxy routes (read-only, owner-scoped)
  app.use('/knowledge', requireAuth, knowledgeRouter);

  // Shared knowledge proxy routes (user-scoped CRUD)
  app.use('/shared-knowledge', requireAuth, sharedKnowledgeRouter);

  // Task management routes (user-scoped Kanban)
  app.use('/tasks', requireAuth, tasksRouter);

  // Chat routes (user-scoped, participant-enforced in router)
  app.use('/chat', requireAuth, chatRouter);

  // User profile routes
  app.use('/profile', requireAuth, profileRouter);

  // Storage routes (admin-only, MinIO bucket operations)
  app.use('/storage', requireAuth, storageRouter);

  // Notifications
  app.use('/notifications', requireAuth, notificationsRouter);

  // Genuinely public: the inbound workflow webhook trigger authenticates
  // via its own 256-bit token, not a Keycloak session — see that route's
  // header for why the token alone is sufficient. MUST be mounted before
  // the requireAuth-guarded /workflows below: Express falls through to the
  // next matching app.use when a router has no route for the request, so
  // every other /workflows/* path passes through this one untouched and
  // still reaches requireAuth exactly as before. Reversing this order
  // would make requireAuth run first and reintroduce the exact defect this
  // split exists to fix.
  app.use('/workflows', workflowsWebhookRouter);
  app.use('/workflows', requireAuth, workflowsRouter);
  app.use('/mcp-servers', requireAuth, mcpServersRouter);
  app.use('/discord', requireAuth, discordRouter);

  // Secrets vault inventory (admin-only, AI-147)
  app.use('/admin/secrets', requireAuth, requireRole('admin'), secretsRouter);

  // API documentation (admin-only)
  app.use('/docs', requireAuth, requireRole('admin'), docsRouter);
  app.use('/openapi.json', requireAuth, requireRole('admin'), specRouter);

  // Terminal error handler. Four arguments, and registered after every route,
  // because that is how Express recognises it. Everything the async-errors
  // patch forwards arrives here; without it, Express's default handler would
  // leak the stack trace into the response body.
  //
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api] Unhandled error in request pipeline:', err);
    if (res.headersSent) {
      // A response is already on the wire; the only honest thing left is to
      // stop writing to it. Express would do the same.
      res.end();
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// Default app instance for production
const app = createApp();
export { app };
