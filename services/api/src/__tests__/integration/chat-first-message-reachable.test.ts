/**
 * Companion to agents-create-matches-seed.test.ts — same investigation, the
 * chat half. `chat_threads` holds ZERO rows in production (confirmed
 * read-only, alongside the agents-table read that file's header describes),
 * so there is no seeded row to compare a created one against. That makes
 * this file's question different in KIND, not just degree: not "does the
 * created row match a real example" (there is none) but "is the first-
 * message create path REACHABLE end to end against a real Postgres at
 * all" — per instruction, answered plainly rather than stubbed if it is not.
 *
 * IT IS REACHABLE, with one piece of test-only scaffolding stated
 * explicitly: POST /chat/threads refuses to dispatch to any agent whose
 * `status` is not 'running' with a `work_token` set (chat.ts's own
 * `getAgentForDispatch`/`dispatchableAgents` gate) — reaching that state for
 * real means starting a real container via the agent orchestration path,
 * which needs Docker/agentbox and is deliberately out of scope here (this
 * investigation is about the CHAT create path, not the agent-start path,
 * which is a different, already-real, unrelated piece of machinery). So
 * this file sets `status='running'` and a throwaway `work_token` directly
 * via SQL before calling the route — scaffolding for the thing NOT under
 * test, same as boot-migrations-fatal.test.ts constructing its own DEAD_POOL
 * rather than needing a real unreachable database.
 *
 * DISPATCH ITSELF THEN FAILS CLEANLY, BY THE ROUTE'S OWN DESIGN, NOT THIS
 * TEST'S: `dispatchToAgents` (chat.ts) checks `CHAT_CALLBACK_TOKEN` before
 * ever attempting a real network call and, if unset, marks every dispatch
 * placeholder `status='error'` with `error_message='Chat is not configured
 * on this server...'` and returns cleanly — no hang, no real agentbox
 * needed, no uncaught exception. This test does not set that env var,
 * deliberately, and asserts on exactly that clean-failure path rather than
 * pretending chat delivery was exercised.
 *
 * THE ASSERTION THAT MATTERS is on what chat.ts's own code proves is
 * ALREADY COMMITTED before dispatch is ever attempted: the `chat_threads`
 * row and the human's own first `chat_messages` row are written inside one
 * transaction (chat.ts:687-732) that commits and releases the connection
 * BEFORE `dispatchToAgents` is called at all — so this test reads them back
 * from Postgres directly, not from the HTTP response, the same "the table
 * is the claim, not the RETURNING clause" discipline as the agents file.
 *
 * Same harness, same gating, same identity constraint as
 * agents-create-matches-seed.test.ts — see that file's header for the parts
 * not repeated here (why a real Postgres, why no testcontainers, why gated
 * on API_INTEGRATION_DATABASE_URL, why testuser01).
 */
import { Pool } from 'pg';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';

const INTEGRATION_DB_URL = process.env.API_INTEGRATION_DATABASE_URL;

function describeOrSkip(): jest.Describe {
  if (INTEGRATION_DB_URL) return describe;
  // eslint-disable-next-line no-console
  console.warn(
    '[chat-first-message-reachable] SKIPPED: API_INTEGRATION_DATABASE_URL is not set. ' +
      'This is not evidence the chat create path is reachable — it is evidence this test did not run.'
  );
  return describe.skip;
}

describeOrSkip()('POST /chat/threads against a real Postgres — is the first-message create path reachable?', () => {
  let pool: Pool;
  let app: import('express').Application;
  let userToken: string;
  let dispatchableAgentId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: INTEGRATION_DB_URL });

    const { runMigrations } = await import('../../db/migrate');
    await runMigrations(pool);
    await pool.query('TRUNCATE agents, chat_threads CASCADE');

    process.env.DATABASE_URL = INTEGRATION_DB_URL;
    // Deliberately NOT set — see the file header. This is the condition
    // under test for the dispatch half, not an oversight.
    delete process.env.CHAT_CALLBACK_TOKEN;

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const issuer = 'https://auth.hill90.com/realms/platform';
    userToken = jwt.sign(
      { sub: 'testuser01', resource_access: { 'hill90-ui': { roles: ['user'] } } },
      privateKey,
      { algorithm: 'RS256', issuer, expiresIn: '1h' }
    );

    const { createApp } = await import('../../app');
    app = createApp({ issuer, getSigningKey: async () => publicKey });

    // Create a real agent through the real route (this file's own
    // dependency on the OTHER integration test's finding: the create path
    // works and produces a real row) rather than hand-inserting one.
    const createRes = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'chat-reachability-probe', name: 'Chat Reachability Probe' });
    expect(createRes.status).toBe(201);
    dispatchableAgentId = createRes.body.id;

    // TEST-ONLY SCAFFOLDING for the thing NOT under test — see file header.
    // A real 'running' agent has a work_token minted by the start path,
    // which needs a real container; this is a throwaway stand-in so the
    // dispatch gate in chat.ts (`status === 'running' && work_token`) is
    // satisfied and execution reaches the actual chat-create SQL.
    await pool.query(
      `UPDATE agents SET status = 'running', work_token = $1 WHERE id = $2`,
      ['throwaway-not-a-real-work-token', dispatchableAgentId]
    );
  }, 60000);

  afterAll(async () => {
    await pool.end();
    const { getPool } = await import('../../db/pool');
    await getPool().end();
  });

  it('SANITY: chat_threads starts empty, matching production\'s own 0 rows — nothing to compare a created row against', async () => {
    const { rows } = await pool.query('SELECT count(*) FROM chat_threads');
    expect(Number(rows[0].count)).toBe(0);
  });

  describe('creating the first message on a new thread', () => {
    let responseBody: any;
    let responseStatus: number;
    let threadRow: any;
    let messageRow: any;

    beforeAll(async () => {
      const res = await request(app)
        .post('/chat/threads')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ agent_id: dispatchableAgentId, message: 'Hello from the reachability probe.' });
      responseStatus = res.status;
      responseBody = res.body;

      const { rows: threads } = await pool.query('SELECT * FROM chat_threads');
      threadRow = threads[0];
      const { rows: messages } = await pool.query(
        "SELECT * FROM chat_messages WHERE thread_id = $1 AND author_type = 'human'",
        [threadRow?.id]
      );
      messageRow = messages[0];
    }, 30000);

    it('THE ASSERTION THAT MATTERS: the thread and the human\'s first message are committed to Postgres, read from the table, not the response', () => {
      expect(threadRow).toBeDefined();
      expect(threadRow.type).toBe('direct');
      expect(threadRow.created_by).toBe('testuser01');
      expect(threadRow.lead_agent_id).toBeNull();

      expect(messageRow).toBeDefined();
      expect(messageRow.author_id).toBe('testuser01');
      expect(messageRow.author_type).toBe('human');
      expect(messageRow.role).toBe('user');
      expect(messageRow.content).toBe('Hello from the reachability probe.');
      expect(messageRow.status).toBe('complete');
    });

    it('dispatch fails CLEANLY on the missing CHAT_CALLBACK_TOKEN, by the route\'s own documented design — not a hang, not an uncaught exception', () => {
      // 201, not 500: chat.ts's own code path for "callback not configured"
      // marks the AGENT placeholder message as status='error' and returns a
      // normal `failed` array — it does not throw, and the request the
      // caller made (create the thread, send the message) still succeeds.
      expect(responseStatus).toBe(201);
      expect(responseBody.failed).toEqual([
        expect.objectContaining({ reason: 'callback_not_configured' }),
      ]);
      expect(responseBody.dispatched).toEqual([]);
    });

    it('the agent\'s own placeholder reply message reflects the clean dispatch failure in Postgres too', async () => {
      const { rows } = await pool.query(
        "SELECT status, error_message FROM chat_messages WHERE thread_id = $1 AND author_type = 'agent'",
        [threadRow.id]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('error');
      expect(rows[0].error_message).toContain('not configured');
    });
  });
});
