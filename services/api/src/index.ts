// MUST be first: imports are hoisted, so redaction has to be installed by a
// module that is itself imported before the others. See bootstrap-redaction.ts.
import './bootstrap-redaction';

import * as jwt from 'jsonwebtoken';
import { app } from './app';
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { createJwksKeyResolver } from './middleware/auth';
import { getIssuer, getJwksUri, rolesFrom } from './middleware/keycloak-config';
import { runReconcilePass, startAgentReconciler, stopAgentReconciler } from './services/agent-reconciler';
import { getS3Client, ensureBucket, AVATAR_BUCKET } from './services/s3';
import { attachTerminalProxy } from './services/terminal-proxy';
import { startStaleSweeper, stopStaleSweeper } from './routes/chat';
import { dieOnStartupFailure, shutdownSafely, installUnhandledRejectionBackstop } from './boot/fatal';

const PORT = process.env.PORT || 3000;

async function start() {
  // Run migrations (safe-fail: log error but continue starting)
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations(getPool());
      console.log('[startup] Database migrations complete');
    } catch (err) {
      console.error('[startup] Migration failed, agent routes may return 503:', err);
    }

    // Reconcile agent container statuses. Awaited before app.listen below, so
    // the API never serves a status before a pass has at least been attempted —
    // and a pass that fails records itself, so the affected agents report
    // `unknown` instead of whatever the database last wrote (#238). Was: a
    // try/catch that logged the failure and carried on serving unverified state
    // as fact.
    await runReconcilePass();
  } else {
    // Was: log and carry on. During a cutover, where the variable name itself is
    // changing, that turns a typo into a GREEN container with no schema — a healthy
    // process serving an empty database, which no health check can see. Fail, so the
    // deploy fails instead.
    throw new Error(
      '[startup] DATABASE_URL is not set. Refusing to start: migrations would be ' +
      'skipped and the service would report healthy against an empty database.',
    );
  }

  // Ensure MinIO avatar bucket exists (safe-fail: log error but continue)
  try {
    const s3 = getS3Client();
    await ensureBucket(s3, AVATAR_BUCKET);
    await ensureBucket(s3, 'agent-avatars');
    await ensureBucket(s3, 'chat-attachments');
    console.log('[startup] Avatar buckets ready');
  } catch (err) {
    console.error('[startup] Avatar bucket init failed, avatar routes may error:', err);
  }

  // Keep reconciling. A docker-proxy fault used to persist until the next
  // restart because there was one call site and no timer.
  startAgentReconciler();
  console.log('[startup] Agent status reconciler started');

  // Start chat stale message sweeper (§9, cleanup path 2)
  startStaleSweeper();
  console.log('[startup] Chat stale message sweeper started');

  // Start workflow cron scheduler
  const { startWorkflowScheduler } = await import('./services/workflow-scheduler');
  startWorkflowScheduler();
  console.log('[startup] Workflow scheduler started');

  const server = app.listen(PORT, () => {
    console.log(`Hill90 API service listening on port ${PORT}`);
  });

  // Attach WebSocket terminal proxy for live agent terminal sessions
  const issuer = getIssuer();
  const jwksUri = getJwksUri(issuer);
  const getSigningKey = createJwksKeyResolver(jwksUri);

  attachTerminalProxy(server, async (token: string) => {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') return null;
      const signingKey = await getSigningKey(decoded.header);
      const payload = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        issuer,
      }) as jwt.JwtPayload;
      if (typeof payload.exp !== 'number') return null;
      // rolesFrom() reads ONLY resource_access.<client>.roles. This used to read
      // realm_access.roles FIRST, which in the shared platform realm would honour
      // a platform admin's realm role `admin` here — and the WebSocket terminal
      // proxy is the most privileged surface in the app.
      const roles: string[] = rolesFrom(payload);
      // exp is passed through, not just checked. The proxy ends the session when
      // the credential does; without this it had no way to know when that was.
      return { sub: payload.sub || '', roles, exp: payload.exp };
    } catch {
      return null;
    }
  });
  console.log('[startup] WebSocket terminal proxy attached');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[shutdown] Closing server...');
    stopStaleSweeper();
    stopAgentReconciler();
    server.close();
    // `process.on` ignores the promise this returns, so a rejection here had
    // nowhere to go and killed the process before the exit below. See boot/fatal.
    await shutdownSafely(closePool);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// The backstop first, so it covers the startup path too. It logs and exits; it
// does not make anything correct. See boot/fatal.ts.
installUnhandledRejectionBackstop();

dieOnStartupFailure(start());



