/**
 * GET /agents/:id/events must bound `tail`. Its sibling already does.
 *
 * THE DEFECT. routes/agents.ts read the parameter as:
 *
 *   const parsedTail = parseInt(req.query.tail as string);
 *   const tail = Number.isNaN(parsedTail) ? 100 : Math.max(0, parsedTail);   // no ceiling
 *
 * while GET /agents/:id/events/export, twenty lines further down, reads:
 *
 *   const tail = Number.isNaN(parsedTail) ? 500 : Math.max(0, Math.min(parsedTail, 5000));
 *
 * Same input, same two consumers, one clamped and one not — which is what makes
 * the missing ceiling an oversight rather than a decision.
 *
 * WHAT AN UNBOUNDED VALUE REACHES. Both of them, on one request:
 *
 *   1. `tail -n <n> /var/log/agentbox/events.jsonl` inside the agent container.
 *      The one-shot path accumulates every chunk into an array and then calls
 *      Buffer.concat().toString('utf-8') — the whole log in memory, twice.
 *   2. getRecentInference(agentId, <n>, …), which puts <n> straight into a SQL
 *      `LIMIT`, so the same request can also pull the agent's entire model_usage
 *      history into the process.
 *
 * WHY IT MATTERS OPERATIONALLY. `app-api` declares no mem_limit in
 * deploy/compose/prod/docker-compose.api.yml — checked, unlike `docker-proxy`
 * which is capped at 128m. So the ceiling is the VPS's memory, and the VPS is
 * shared with the platform. An ordinary signed-in user, on an agent they own,
 * can make one request that pressures memory for every tenant on the host.
 *
 * The tests assert the bound where it is observable — the argv handed to the
 * container and the LIMIT handed to Postgres — rather than trying to exhaust
 * memory in a unit test.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockExecInContainer = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: any[]) => mockExecInContainer(...args),
}));

const userToken = jwt.sign(
  { sub: 'owner-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

/** The documented ceiling, taken from the sibling export endpoint. */
const MAX_TAIL = 5000;

function emptyLogStream() {
  return new Readable({
    read() {
      this.push(null);
    },
  });
}

/** The `-n` value actually handed to `tail` inside the container. */
function tailArgFromExec(): number {
  const argv = mockExecInContainer.mock.calls[0]?.[1] as string[];
  const i = argv.indexOf('-n');
  return Number(argv[i + 1]);
}

/** The value bound to the SQL LIMIT on model_usage. */
function limitFromInferenceQuery(): number | undefined {
  const call = mockQuery.mock.calls.find(
    (c) => typeof c[0] === 'string' && /FROM model_usage/.test(c[0]) && /LIMIT/.test(c[0])
  );
  if (!call) return undefined;
  const params = call[1] as unknown[];
  return Number(params[params.length - 1]);
}

describe('GET /agents/:id/events bounds the tail parameter', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

    // Ownership lookup, then whatever the handler asks for.
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockExecInContainer.mockResolvedValue(emptyLogStream());
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('clamps an absurd tail before it reaches the container', async () => {
    await request(app)
      .get('/agents/agent-uuid/events?tail=999999999')
      .set('Authorization', `Bearer ${userToken}`);

    expect(mockExecInContainer).toHaveBeenCalled();
    expect(tailArgFromExec()).toBeLessThanOrEqual(MAX_TAIL);
  });

  it('clamps an absurd tail before it reaches the SQL LIMIT', async () => {
    await request(app)
      .get('/agents/agent-uuid/events?tail=999999999')
      .set('Authorization', `Bearer ${userToken}`);

    const limit = limitFromInferenceQuery();
    expect(limit).toBeDefined();
    expect(limit as number).toBeLessThanOrEqual(MAX_TAIL);
  });

  it('clamps the streaming path too, which reads the same parameter', async () => {
    await request(app)
      .get('/agents/agent-uuid/events?tail=999999999&follow=true')
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(false);

    expect(mockExecInContainer).toHaveBeenCalled();
    expect(tailArgFromExec()).toBeLessThanOrEqual(MAX_TAIL);
  });

  it('leaves the default alone', async () => {
    await request(app)
      .get('/agents/agent-uuid/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(tailArgFromExec()).toBe(100);
  });

  it('still honours a reasonable explicit tail', async () => {
    await request(app)
      .get('/agents/agent-uuid/events?tail=250')
      .set('Authorization', `Bearer ${userToken}`);

    expect(tailArgFromExec()).toBe(250);
  });
});
