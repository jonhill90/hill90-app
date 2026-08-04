/**
 * The uptime figure must be able to say what it does not know (#213).
 *
 * WHAT THE CODE ACTUALLY DOES, established before deciding anything:
 *
 *   - `POST /agents/:id/start` inserts a session row, best-effort (`:1420`).
 *   - `POST /agents/:id/stop` closes every open session, best-effort (`:1512`).
 *   - `/:id/stats` sums `COALESCE(stopped_at, NOW()) - started_at` (`:2486`),
 *     and `/:id/metrics` has a second copy of the same sum (`:2628`).
 *   - **the reconciler does not touch `agent_sessions` at all** — `grep -c` over
 *     `agent-reconciler.ts` and `docker.ts` returns 0 and 0.
 *
 * SO THE ISSUE IS HALF RIGHT. A dropped INSERT understates, as it says. But an
 * agent that stops WITHOUT going through `POST /stop` — its container killed,
 * the host rebooted, the API restarted, or the reconciler demoting it because
 * the container vanished — leaves its session open, and `COALESCE(stopped_at,
 * NOW())` then accrues uptime **for ever**. That direction is unbounded, it
 * flatters, and nothing in the service closes it.
 *
 * WHY NOT "MAKE THE INSERT RELIABLE". It fixes the smaller half of the error
 * and leaves the unbounded half untouched, while making the number look more
 * trustworthy — a partial fix that reads as complete. The insert stays
 * best-effort on purpose: an audit row must not fail a start that worked.
 *
 * WHAT IS FIXED HERE: the reconciler closes sessions it demotes, which bounds
 * the growth, and the figure carries how much of itself rests on an estimated
 * close and how many sessions are still open. The number can now say "I do not
 * know", which it could not before.
 *
 * WHAT IS NOT, and is filed rather than implied: uptime still measures
 * API-and-reconciler-observed lifecycle, not the container's real life. Docker
 * knows `State.StartedAt` and `State.FinishedAt` exactly and `inspectContainer`
 * already reads that struct and discards both.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const mockContainerInspect = jest.fn();
jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    getContainer: () => ({ inspect: mockContainerInspect }),
  })),
);

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/notifications', () => ({ notify: jest.fn() }));

import { createApp } from '../app';
import { runReconcilePass } from '../services/agent-reconciler';
import { resetStatusVerification } from '../services/agent-status-verification';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

const sessionWrites = () =>
  mockQuery.mock.calls.filter((c) => /UPDATE agent_sessions/i.test(String(c[0])));

beforeEach(() => {
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  resetStatusVerification();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('a session nothing closes is what makes the number unbounded', () => {
  it('POSITIVE CONTROL: the reconciler closes the session of an agent it demotes', async () => {
    // The fixture that separates the versions: an agent recorded running whose
    // container is gone. On a healthy agent the reconciler writes nothing at
    // all, so nothing distinguishes the two versions there.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'ghost', status: 'running',
        container_id: 'c1', container_state: 'running',
        created_by: 'admin-user', model_router_exp: null,
      }],
    });
    const gone: any = new Error('no such container');
    gone.statusCode = 404;
    mockContainerInspect.mockRejectedValue(gone);
    mockQuery.mockResolvedValue({ rows: [] });

    await runReconcilePass();

    const closes = sessionWrites();
    expect(closes).toHaveLength(1);
    expect(String(closes[0][0])).toMatch(/stopped_at IS NULL/);
    // Marked as an estimate: the reconciler knows the container is gone, not
    // when it went. Claiming NOW() as the true stop time without saying so
    // would be the same false precision this issue is about.
    expect(String(closes[0][0])).toMatch(/stopped_at_estimated/);
  });

  it('TWIN: a running agent cannot have its session closed by the sweep', async () => {
    // The sweep runs on EVERY pass — it is a statement about the state, not a
    // hook on a transition — so the assertion is on what it can touch, not on
    // whether it ran. A running agent's open session is the normal case and
    // must survive.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'fine', status: 'running',
        container_id: 'c1', container_state: 'running',
        created_by: 'admin-user', model_router_exp: null,
      }],
    });
    mockContainerInspect.mockResolvedValue({
      Id: 'c1', State: { Status: 'running' }, Config: { Labels: { 'managed-by': 'hill90-api' } },
    });
    mockQuery.mockResolvedValue({ rows: [] });

    await runReconcilePass();

    const sweep = sessionWrites();
    expect(sweep).toHaveLength(1);
    expect(String(sweep[0][0])).toMatch(/a\.status <> 'running'/);
    expect(String(sweep[0][0])).toMatch(/s\.stopped_at IS NULL/);
  });

  it('SELF-HEALING: a session left open by an agent that is ALREADY stopped is closed', async () => {
    // The case the first version of this fix could not reach, and the reason it
    // was rewritten. Closing inside the demotion's patch meant a crash between
    // the two writes — or the close simply failing — left `stopped` beside an
    // open session, and no later pass would retry, because a stopped row whose
    // container is gone produces no patch at all. The window was smaller than
    // the defect and just as permanent.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'already-stopped', status: 'stopped',
        container_id: null, container_state: 'absent',
        created_by: 'admin-user', model_router_exp: null,
      }],
    });
    const gone: any = new Error('no such container');
    gone.statusCode = 404;
    mockContainerInspect.mockRejectedValue(gone);
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await runReconcilePass();

    // No transition: the row already agrees with the container.
    expect(result!.reconciled).toBe(0);
    // And the sweep still repairs the contradiction.
    expect(sessionWrites()).toHaveLength(1);
  });
});

describe('GET /agents/:id/stats — the figure carries its own confidence', () => {
  function statsRows(session: Record<string, unknown>) {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'a1', created_by: 'admin-user', created_at: '2026-08-01T00:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [{ total_inferences: '3', total_tokens: '100', estimated_cost: '0.01', distinct_models: '1' }] })
      .mockResolvedValueOnce({ rows: [{ total_messages: '2' }] })
      .mockResolvedValueOnce({ rows: [session] })
      .mockResolvedValueOnce({ rows: [{ skill_count: '1' }] });
  }

  it('POSITIVE CONTROL: an estimated close is declared, not folded into the total', async () => {
    statsRows({ total_uptime_seconds: '3600', estimated_uptime_seconds: '3000', open_sessions: '0' });

    const res = await request(app)
      .get('/agents/uuid-1/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total_uptime_seconds).toBe(3600);
    // The part the user cannot otherwise see: most of that hour is a guess.
    expect(res.body.uptime_estimated_seconds).toBe(3000);
    expect(res.body.uptime_complete).toBe(false);
  });

  it('POSITIVE CONTROL: an open session is declared too — it is still accruing', async () => {
    statsRows({ total_uptime_seconds: '7200', estimated_uptime_seconds: '0', open_sessions: '1' });

    const res = await request(app)
      .get('/agents/uuid-1/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.open_sessions).toBe(1);
    expect(res.body.uptime_complete).toBe(false);
  });

  it('TWIN: a clean history reports complete — the flag must mean something', async () => {
    statsRows({ total_uptime_seconds: '600', estimated_uptime_seconds: '0', open_sessions: '0' });

    const res = await request(app)
      .get('/agents/uuid-1/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.total_uptime_seconds).toBe(600);
    expect(res.body.uptime_estimated_seconds).toBe(0);
    expect(res.body.uptime_complete).toBe(true);
  });

  it('the query asks the database for both figures, not just the sum', async () => {
    statsRows({ total_uptime_seconds: '600', estimated_uptime_seconds: '0', open_sessions: '0' });

    await request(app)
      .get('/agents/uuid-1/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    const uptimeSql = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .find((s) => /FROM agent_sessions/i.test(s));
    expect(uptimeSql).toBeDefined();
    expect(uptimeSql).toMatch(/estimated_uptime_seconds/);
    expect(uptimeSql).toMatch(/open_sessions/);
  });
});
