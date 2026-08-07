// MUST be first: imports are hoisted, so redaction has to be installed by a
// module that is itself imported before the others. See bootstrap-redaction.ts.
import './bootstrap-redaction';

import { app } from './app';
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { runProviderKeyCanary } from './services/provider-key-canary';
import { runReconcilePass, startAgentReconciler, stopAgentReconciler } from './services/agent-reconciler';
import { getS3Client, ensureBucket, AVATAR_BUCKET } from './services/s3';
import { attachTerminalProxyFromConfig } from './services/terminal-wiring';
import { startStaleSweeper, stopStaleSweeper } from './routes/chat';
import { dieOnStartupFailure, shutdownSafely, installUnhandledRejectionBackstop } from './boot/fatal';
import { containerProfileCeilingViolations } from './routes/agents';

const PORT = process.env.PORT || 3000;

async function start() {
  // A FAILED MIGRATION IS FATAL. This was `try { … } catch { console.error(…) }`
  // with the comment "safe-fail: log error but continue starting", and it was the
  // same defect family this service has closed repeatedly: an operation that fails
  // and reports success. The API started, answered its health check, and served on
  // whatever schema the database happened to have — while the code above it assumed
  // the schema it shipped with. Nothing downstream could tell the difference: the
  // promised 503 does not exist, so a route reading a column that was never added
  // answers 500, and only under load that reaches it.
  //
  // NO MIGRATION FAILURE IS SURVIVABLE HERE, and the case for each was checked
  // rather than waved away:
  //   * the database is unreachable        — nothing this service does works anyway
  //   * a migration's SQL fails            — runMigrations rolls that file back, so
  //                                          the schema is a KNOWN older one, but the
  //                                          code is the newer one. That mismatch is
  //                                          exactly what must not serve.
  //   * the migrations directory is absent — a build defect; see migrate.ts
  //   * two instances start together       — pg_advisory_lock(42) makes them queue,
  //                                          it does not fail. Not a failure case.
  // If a genuinely survivable case appears, handle THAT case explicitly. Do not
  // widen this back into a catch-all.
  //
  // The throw reaches dieOnStartupFailure at the bottom of this file, which logs
  // under [startup] and exits 1 — flushing stderr first, because a container's
  // stderr is a pipe and `console.error` then `process.exit()` loses the message.
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations(getPool());
      console.log('[startup] Database migrations complete');
    } catch (err) {
      throw new Error(
        'database migrations failed — refusing to serve on an unverified schema',
        { cause: err },
      );
    }

    // app#396: PROVIDER_KEY_ENCRYPTION_KEY decrypts four tables now, not
    // one, and the key stored in SOPS and the key a running container
    // actually held had ALREADY drifted apart the night this went from one
    // consumer to four — found only because someone happened to compare two
    // hashes by hand. A self-encrypt-then-decrypt round trip would not have
    // caught that: any 32-byte key passes it, including a freshly wrong
    // one. This reads back a row that genuinely exists, encrypted under
    // whatever key was current when it was written, and proves THIS
    // process's key can still open it — same doctrine as the migration
    // check just above: an unverified piece of config that would otherwise
    // only surface per-feature, per-request, in whichever of several
    // different failure shapes that feature happens to have, must not get
    // to serve as if it were fine.
    //
    // NOTHING TO VERIFY (an empty estate, zero encrypted rows in any of the
    // four tables) is reported as its own status, not folded into
    // "verified" — those are different claims, and this codebase has
    // already been burned once by a status tracker that couldn't tell them
    // apart (see CLAUDE.md's own account of that, elsewhere in this repo).
    try {
      const result = await runProviderKeyCanary(getPool());
      if (result.status === 'verified') {
        console.log(`[startup] Provider-key canary: verified (decrypted an existing row from ${result.source})`);
      } else {
        console.log('[startup] Provider-key canary: nothing to verify (zero encrypted rows across provider_connections/mcp_servers/agents/agent_webhooks)');
      }
    } catch (err) {
      throw new Error(
        'PROVIDER_KEY_ENCRYPTION_KEY cannot decrypt existing stored ciphertext — refusing ' +
        'to start on a key that would make encrypted data in provider_connections, ' +
        'mcp_servers, agents, or agent_webhooks unreadable. This is not a schema problem; ' +
        'check whether the key configured for this container matches the key that last ' +
        'wrote that data (see docs/reference/secret-layout.md and app#396).',
        { cause: err },
      );
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

  // app#593: MAX_AGENT_CPUS/MAX_AGENT_MEM_BYTES/MAX_AGENT_PIDS_LIMIT
  // (routes/agents.ts) must stay >= every container_profiles row's own
  // default_cpus/default_mem_limit/default_pids_limit. POST
  // /container-profiles (admin-only) validates none of those three columns
  // today, so an admin CAN create a profile that already violates this —
  // safe-fail, same severity as the avatar-bucket check above, because a
  // violation here means one specific profile is unusable once its
  // defaults are wired into agent creation, not that this whole service is
  // unverified the way a failed migration or a bad encryption key would be.
  try {
    const { rows: profiles } = await getPool().query(
      'SELECT name, default_cpus, default_mem_limit, default_pids_limit FROM container_profiles'
    );
    const violations = containerProfileCeilingViolations(profiles);
    if (violations.length === 0) {
      console.log(`[startup] Container-profile resource ceilings: ${profiles.length} profile(s) checked, all within MAX_AGENT_* bounds`);
    } else {
      for (const v of violations) {
        console.error(`[startup] Container-profile resource ceiling violated: profile "${v.profile}".${v.field} — ${v.error}`);
      }
    }
  } catch (err) {
    console.error('[startup] Container-profile resource ceiling check failed to run:', err);
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

  // Attach WebSocket terminal proxy for live agent terminal sessions.
  //
  // The wiring itself — which issuer, which key resolver — lives in
  // terminal-wiring.ts, not inline here, so a test can import it without also
  // running this file's migrations-and-listen sequence at module load (#313).
  const terminals = attachTerminalProxyFromConfig(server);

  console.log('[startup] WebSocket terminal proxy attached');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[shutdown] Closing server...');
    stopStaleSweeper();
    stopAgentReconciler();

    // SAY GOING AWAY, do not just vanish (#318). `server.close()` stops the listener
    // accepting new connections and leaves established ones alone — an upgraded
    // WebSocket included — and the `process.exit(0)` below then severs every live
    // terminal with no frame at all. The client sees 1006, which is indistinguishable
    // from a network fault, on a surface that went to the trouble of distinguishing
    // 4001, 4002 and 4004 precisely so a client could act on the difference.
    //
    // 1001 is the standard "going away". It does not change what the ui does today —
    // `shouldReconnect()` reconnects on 1001 exactly as it does on 1006, with the
    // 2s/4s/…/10s ramp in XTerminal.tsx and a five-attempt cap — and that behaviour is
    // correct for a restart: unlike 4004, reconnecting after a deploy is what the user
    // wants. What changes is that a deliberate shutdown stops looking like a broken
    // connection, in the client and in anything reading logs.
    //
    // Ordered BEFORE server.close() so the frames go out on a listener that is still
    // running, and awaited so the writes happen before the exit below — the same
    // property boot/fatal.ts records for stderr.
    await terminals.closeAllSessions(1001, 'server shutting down');

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



