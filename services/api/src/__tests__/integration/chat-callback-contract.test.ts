/**
 * Third in the same investigation as agents-create-matches-seed.test.ts and
 * chat-first-message-reachable.test.ts. That second file proved POST
 * /chat/threads is reachable and commits the thread + human's first message
 * before dispatch is attempted. What was still unproven is the half AFTER
 * that: an agent REPLYING. chat_threads is 0 in production and no chat has
 * ever completed end to end, so the reply path — agentbox receives a
 * dispatch, assembles its system prompt, and posts back to
 * /internal/chat/callback with the CHAT_CALLBACK_TOKEN bearer — had never
 * been exercised against anything real.
 *
 * SCOPE, STATED PLAINLY. This proves the API's OWN contract at the callback
 * boundary — the half this repository (and this test's language) can
 * actually reach:
 *   - a correctly-signed callback persists an assistant message and
 *     advances the SSE sequence cursor (THE HAPPY-PATH ASSERTION)
 *   - a callback with a WRONG or ABSENT token is rejected, and rejected
 *     WITHOUT touching the row (THE SECURITY ASSERTION — this is the one
 *     Jon asked not to stub even if the happy path had to be narrowed)
 *
 * NOT PROVEN HERE, AND NOT STUBBED TO LOOK PROVEN: what agentbox itself does
 * BEFORE making that call — reading SOUL.md/RULES.md, assembling the actual
 * system prompt, running the model. That is services/agentbox's own Python
 * code (services/agentbox/app/chat.py, runtime.py), a different service and
 * a different language, and would need its own test there, not a stub
 * pretending to be it here. Reaching a REAL agentbox container is also out
 * of scope for the same reason chat-first-message-reachable.test.ts already
 * stated for the outbound half: it needs Docker/agentbox and is different
 * machinery from the API contract under test.
 *
 * HOW THE HAPPY-PATH PRECONDITION IS REACHED WITHOUT A REAL AGENTBOX. A real
 * dispatch (chat.ts's dispatchToAgents) creates the agent's placeholder
 * reply with one specific, fixed shape before it ever calls out anywhere:
 *   INSERT INTO chat_messages (thread_id, author_id, author_type, role,
 *     content, status, reply_to)
 *   VALUES ($1, $2, 'agent', 'assistant', '', 'pending', $3)
 * This test creates that exact row directly via SQL — test-only scaffolding
 * for the OUTBOUND half, which chat-first-message-reachable.test.ts already
 * proved — so execution can reach the actual thing under test: a real HTTP
 * POST to the real, exported chatCallbackHandler, mounted on the real app
 * exactly as app.ts mounts it (`app.post('/internal/chat/callback',
 * chatCallbackHandler)`), completing that specific pending row.
 *
 * TIMING-SAFETY OF THE TOKEN COMPARISON: verified by reading the code
 * (chat.ts, chatCallbackHandler), not by measuring response latency in a
 * black-box HTTP test — a timing side-channel is not something a jest
 * integration test can reliably assert without producing exactly the kind
 * of flaky, statistically unsound test this repo's own discipline warns
 * against elsewhere. What was found, stated here so the next reader does
 * not have to re-derive it:
 *   const expected = Buffer.from(configuredToken);
 *   const received = Buffer.from(token);
 *   if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received))
 * This IS timing-safe. crypto.timingSafeEqual itself throws on mismatched
 * buffer lengths (a Node API requirement, not a choice this code made), so
 * the `.length !== .length` short-circuit is required, not a shortcut
 * around it — and it leaks only whether the presented token happens to be
 * the same LENGTH as the real one, never which byte differs, which is the
 * actual thing a timing side-channel could otherwise exploit. One test
 * below exercises that length-mismatch branch specifically, since it is
 * structurally the one path that never reaches timingSafeEqual at all.
 *
 * Same harness, same gating, same identity constraint as the other two
 * files in this directory — see agents-create-matches-seed.test.ts's header
 * for the parts not repeated here.
 */
import { Pool } from 'pg';

const INTEGRATION_DB_URL = process.env.API_INTEGRATION_DATABASE_URL;

function describeOrSkip(): jest.Describe {
  if (INTEGRATION_DB_URL) return describe;
  // eslint-disable-next-line no-console
  console.warn(
    '[chat-callback-contract] SKIPPED: API_INTEGRATION_DATABASE_URL is not set. ' +
      'This is not evidence the callback contract holds — it is evidence this test did not run.'
  );
  return describe.skip;
}

const REAL_TOKEN = 'a-real-throwaway-callback-token-not-used-anywhere-else';

describeOrSkip()('POST /internal/chat/callback against a real Postgres — does the reply contract hold?', () => {
  let pool: Pool;
  let app: import('express').Application;
  let threadId: string;
  let humanMessageId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: INTEGRATION_DB_URL });

    const { runMigrations } = await import('../../db/migrate');
    await runMigrations(pool);
    await pool.query('TRUNCATE agents, chat_threads CASCADE');

    process.env.DATABASE_URL = INTEGRATION_DB_URL;
    process.env.CHAT_CALLBACK_TOKEN = REAL_TOKEN;

    const { createApp } = await import('../../app');
    // No issuer/getSigningKey needed: /internal/chat/callback is mounted
    // directly on the app (app.ts) outside requireAuth's router chain —
    // its own auth is the bearer-token check under test, not Keycloak.
    app = createApp({});

    // Test-only scaffolding for the OUTBOUND half — see file header.
    const { rows: [thread] } = await pool.query(
      `INSERT INTO chat_threads (type, created_by) VALUES ('direct', 'testuser01') RETURNING id`
    );
    threadId = thread.id;
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type, role)
       VALUES ($1, 'testuser01', 'human', 'owner')`,
      [threadId]
    );
    const { rows: [humanMsg] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status)
       VALUES ($1, 'testuser01', 'human', 'user', 'Hello, agent.', 'complete')
       RETURNING id`,
      [threadId]
    );
    humanMessageId = humanMsg.id;
  }, 60000);

  afterAll(async () => {
    await pool.end();
    const { getPool } = await import('../../db/pool');
    await getPool().end();
  });

  /** Fresh pending agent placeholder per test — the exact shape dispatchToAgents itself creates. */
  async function insertPendingPlaceholder(): Promise<{ id: string; seqAtInsert: number }> {
    const { rows: [placeholder] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, reply_to)
       VALUES ($1, $2, 'agent', 'assistant', '', 'pending', $3)
       RETURNING id, seq`,
      [threadId, 'aaaaaaaa-0000-0000-0000-000000000000', humanMessageId]
    );
    return { id: placeholder.id, seqAtInsert: Number(placeholder.seq) };
  }

  async function readMessage(id: string) {
    const { rows } = await pool.query('SELECT * FROM chat_messages WHERE id = $1', [id]);
    return rows[0];
  }

  describe('the happy path: a correctly-signed callback', () => {
    let placeholderId: string;
    let seqAtInsert: number;
    let response: { status: number; body: any };

    beforeAll(async () => {
      const request = (await import('supertest')).default;
      const placeholder = await insertPendingPlaceholder();
      placeholderId = placeholder.id;
      seqAtInsert = placeholder.seqAtInsert;

      const res = await request(app)
        .post('/internal/chat/callback')
        .set('Authorization', `Bearer ${REAL_TOKEN}`)
        .send({
          message_id: placeholderId,
          content: 'Hello, this is the agent replying.',
          status: 'complete',
          model: 'test-model',
          input_tokens: 12,
          output_tokens: 34,
          duration_ms: 567,
        });
      response = { status: res.status, body: res.body };
    });

    it('THE HAPPY-PATH ASSERTION: the response confirms the update, and the row read back from Postgres carries the real content', async () => {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ updated: true });

      const row = await readMessage(placeholderId);
      expect(row.status).toBe('complete');
      expect(row.content).toBe('Hello, this is the agent replying.');
      expect(row.model).toBe('test-model');
      expect(Number(row.input_tokens)).toBe(12);
      expect(Number(row.output_tokens)).toBe(34);
      expect(Number(row.duration_ms)).toBe(567);
    });

    it('the SSE sequence cursor genuinely advances — seq after the callback is strictly greater than at insert', async () => {
      const row = await readMessage(placeholderId);
      expect(Number(row.seq)).toBeGreaterThan(seqAtInsert);
    });

    it('the thread is auto-titled from the human\'s first message, proving the whole UPDATE ... chat_threads statement ran, not just the message row', async () => {
      const { rows: [thread] } = await pool.query('SELECT title FROM chat_threads WHERE id = $1', [threadId]);
      expect(thread.title).toBe('Hello, agent.');
    });

    it('a SECOND callback for the same, now-terminal message is a no-op, not a second write — the guarded UPDATE only matches pending/thinking', async () => {
      const request = (await import('supertest')).default;
      const res = await request(app)
        .post('/internal/chat/callback')
        .set('Authorization', `Bearer ${REAL_TOKEN}`)
        .send({ message_id: placeholderId, content: 'a different reply that must not land', status: 'complete' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: false });

      const row = await readMessage(placeholderId);
      expect(row.content).toBe('Hello, this is the agent replying.');
    });
  });

  describe('THE SECURITY ASSERTION: a callback with a WRONG or ABSENT token is rejected, not stubbed', () => {
    it('no Authorization header at all is rejected with 401, and the pending row is untouched', async () => {
      const request = (await import('supertest')).default;
      const { id, seqAtInsert } = await insertPendingPlaceholder();

      const res = await request(app)
        .post('/internal/chat/callback')
        .send({ message_id: id, content: 'should never land', status: 'complete' });

      expect(res.status).toBe(401);
      const row = await readMessage(id);
      expect(row.status).toBe('pending');
      expect(row.content).toBe('');
      expect(Number(row.seq)).toBe(seqAtInsert);
    });

    it('a WRONG token of the SAME length as the real one is rejected with 401, and the row is untouched — exercises the real crypto.timingSafeEqual branch', async () => {
      const request = (await import('supertest')).default;
      const { id, seqAtInsert } = await insertPendingPlaceholder();
      const wrongSameLength = REAL_TOKEN.split('').reverse().join('');
      expect(wrongSameLength.length).toBe(REAL_TOKEN.length);
      expect(wrongSameLength).not.toBe(REAL_TOKEN);

      const res = await request(app)
        .post('/internal/chat/callback')
        .set('Authorization', `Bearer ${wrongSameLength}`)
        .send({ message_id: id, content: 'should never land', status: 'complete' });

      expect(res.status).toBe(401);
      const row = await readMessage(id);
      expect(row.status).toBe('pending');
      expect(Number(row.seq)).toBe(seqAtInsert);
    });

    it('a WRONG token of a DIFFERENT length is rejected with 401, and the row is untouched — exercises the length short-circuit that never reaches timingSafeEqual', async () => {
      const request = (await import('supertest')).default;
      const { id, seqAtInsert } = await insertPendingPlaceholder();

      const res = await request(app)
        .post('/internal/chat/callback')
        .set('Authorization', 'Bearer short')
        .send({ message_id: id, content: 'should never land', status: 'complete' });

      expect(res.status).toBe(401);
      const row = await readMessage(id);
      expect(row.status).toBe('pending');
      expect(Number(row.seq)).toBe(seqAtInsert);
    });

    it('a malformed Authorization header (no "Bearer " prefix) is rejected with 401, and the row is untouched', async () => {
      const request = (await import('supertest')).default;
      const { id, seqAtInsert } = await insertPendingPlaceholder();

      const res = await request(app)
        .post('/internal/chat/callback')
        .set('Authorization', REAL_TOKEN)
        .send({ message_id: id, content: 'should never land', status: 'complete' });

      expect(res.status).toBe(401);
      const row = await readMessage(id);
      expect(row.status).toBe('pending');
      expect(Number(row.seq)).toBe(seqAtInsert);
    });

    it('a server with NO CHAT_CALLBACK_TOKEN configured refuses with 503, distinct from a 401 — "not configured" is not the same claim as "wrong credential"', async () => {
      const request = (await import('supertest')).default;
      const { id } = await insertPendingPlaceholder();

      const saved = process.env.CHAT_CALLBACK_TOKEN;
      delete process.env.CHAT_CALLBACK_TOKEN;
      let res: { status: number };
      try {
        res = await request(app)
          .post('/internal/chat/callback')
          .set('Authorization', `Bearer ${REAL_TOKEN}`)
          .send({ message_id: id, content: 'should never land', status: 'complete' });
      } finally {
        process.env.CHAT_CALLBACK_TOKEN = saved;
      }

      expect(res.status).toBe(503);
      const row = await readMessage(id);
      expect(row.status).toBe('pending');
    });
  });
});
