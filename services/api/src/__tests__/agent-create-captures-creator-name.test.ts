/**
 * app#499: "we don't want that strange guid to represent users... we want
 * the names." AgentDetailClient.tsx's "Created ... by" line rendered a
 * truncated Keycloak sub for anyone but the viewer — the same GUID problem
 * #499 named for the knowledge graph, in a different table. The fix is the
 * same shape: resolve it AT WRITE TIME from the CALLER's own token, the one
 * moment this codebase can ever legitimately know it, and store it durably
 * (agents.created_by_name) rather than looking anyone else up later.
 *
 * This file pins that write for all three sites that can create an agents
 * row: POST /agents, POST /agents/import, POST /agents/:id/clone.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const insertCalls: Array<{ sql: string; params: unknown[] }> = [];

function answer(sql: string): { rows: any[] } {
  if (/INSERT INTO agents/i.test(sql)) {
    return { rows: [{ id: 'uuid-1', agent_id: 'an-agent', name: 'An Agent', status: 'stopped', created_by: 'the-caller', created_by_name: 'whatever the insert captured' }] };
  }
  if (/SELECT agent_id, name, description, tools_config, cpus, mem_limit, pids_limit,\s*\n\s*soul_md, rules_md, model_policy_id, container_profile_id\s*\n\s*FROM agents WHERE id/i.test(sql)) {
    return { rows: [{ agent_id: 'source-agent', name: 'Source', description: '', tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200, soul_md: '', rules_md: '', model_policy_id: null, container_profile_id: null }] };
  }
  if (/agent_id LIKE/i.test(sql)) return { rows: [] };
  return { rows: [] };
}

async function runStatement(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
  if (/INSERT INTO agents/i.test(sql)) insertCalls.push({ sql, params });
  return answer(sql);
}

const mockQuery = jest.fn((sql: string, params?: unknown[]) => runStatement(sql, params));

jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

function makeToken(sub: string, extraClaims: Record<string, unknown> = {}) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles: ['user'] } }, ...extraClaims },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
  );
}

beforeEach(() => {
  insertCalls.length = 0;
  mockQuery.mockClear();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

/** created_by_name is appended as the LAST param in every INSERT INTO agents this file touches. */
const capturedName = () => insertCalls[0].params[insertCalls[0].params.length - 1];

describe('POST /agents captures the creator\'s own name at write time', () => {
  it('prefers the token\'s `name` claim over `preferred_username`', async () => {
    const token = makeToken('named-user', { name: 'Dev Local', preferred_username: 'dev' });
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${token}`)
      .send({ agent_id: 'an-agent', name: 'An Agent' });

    expect(res.status).toBe(201);
    expect(insertCalls).toHaveLength(1);
    expect(capturedName()).toBe('Dev Local');
  });

  it('falls back to `preferred_username` when the token has no `name`', async () => {
    const token = makeToken('handle-user', { preferred_username: 'testuser01' });
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${token}`)
      .send({ agent_id: 'an-agent', name: 'An Agent' });

    expect(res.status).toBe(201);
    expect(capturedName()).toBe('testuser01');
  });

  it('stores null, not a fabricated name, when the token carries neither claim', async () => {
    const token = makeToken('bare-user');
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${token}`)
      .send({ agent_id: 'an-agent', name: 'An Agent' });

    expect(res.status).toBe(201);
    expect(capturedName()).toBeNull();
  });
});

describe('POST /agents/import captures the importing caller\'s own name', () => {
  it('same resolution, same site, the twin path', async () => {
    const token = makeToken('importer', { name: 'Import Er' });
    const res = await request(app)
      .post('/agents/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ agent_id: 'an-agent', name: 'An Agent' });

    expect(res.status).toBe(201);
    expect(capturedName()).toBe('Import Er');
  });
});

describe('POST /agents/:id/clone captures the CLONING caller\'s own name, not the source agent\'s', () => {
  it('the clone is credited to whoever clicked clone, not backfilled from the original creator', async () => {
    const token = makeToken('cloner', { name: 'Clone Instigator' });
    const res = await request(app)
      .post('/agents/source-id/clone')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    expect(capturedName()).toBe('Clone Instigator');
  });
});
