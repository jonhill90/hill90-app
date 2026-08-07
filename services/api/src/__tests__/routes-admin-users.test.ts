import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
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

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: jest.fn(),
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
}));

jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: jest.fn().mockResolvedValue({ accepted: true, work_id: 'work-123' }),
}));

const mockListUsers = jest.fn();
const mockGetClientUuid = jest.fn();
const mockGetUserClientRoles = jest.fn();

jest.mock('../helpers/keycloak-admin-client', () => {
  const actual = jest.requireActual('../helpers/keycloak-admin-client');
  return {
    ...actual,
    listUsers: (...args: unknown[]) => mockListUsers(...args),
    getClientUuid: (...args: unknown[]) => mockGetClientUuid(...args),
    getUserClientRoles: (...args: unknown[]) => mockGetUserClientRoles(...args),
  };
});

// Real class, not a mock — the route's instanceof check must see the real thing.
const { KeycloakAdminNotConfiguredError } = jest.requireActual('../helpers/keycloak-admin-client');

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);

describe('GET /admin/users (app#500 read-only slice)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockListUsers.mockReset();
    mockGetClientUuid.mockReset();
    mockGetUserClientRoles.mockReset();
  });

  it('returns every user with their current hill90-ui client roles (T1)', async () => {
    mockListUsers.mockResolvedValue([
      { id: 'u1', username: 'jon', email: 'jon@hill90.com', enabled: true },
      { id: 'u2', username: 'testuser01', email: 'testuser01@hill90.com', enabled: true },
    ]);
    mockGetClientUuid.mockResolvedValue('client-uuid-hill90-ui');
    mockGetUserClientRoles.mockImplementation(async (userId: string) => {
      if (userId === 'u1') return [{ id: 'r1', name: 'admin' }, { id: 'r2', name: 'user' }];
      return [{ id: 'r2', name: 'user' }];
    });

    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    const jonRow = res.body.users.find((u: any) => u.username === 'jon');
    const testRow = res.body.users.find((u: any) => u.username === 'testuser01');
    expect(jonRow.hill90UiRoles).toEqual(['admin', 'user']);
    expect(testRow.hill90UiRoles).toEqual(['user']);
    expect(mockGetClientUuid).toHaveBeenCalledWith('hill90-ui');
  });

  it('rejects non-admin (T2)', async () => {
    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    const res = await request(app).get('/admin/users');
    expect(res.status).toBe(401);
  });

  it('returns 503, not an empty 200, when the service account credential is not configured (T3)', async () => {
    // This is the case the whole file exists to prevent: a missing credential
    // must never render as "there are no users". See CONTRIBUTING.md, "An
    // Operation That Fails and Reports Success".
    mockListUsers.mockRejectedValue(new KeycloakAdminNotConfiguredError());

    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/KEYCLOAK_REALM_ADMIN_CLIENT_ID/);
    expect(res.body.users).toBeUndefined();
  });

  it('propagates an unexpected Keycloak error as a 5xx via the terminal handler, not a 200 (T4)', async () => {
    mockListUsers.mockRejectedValue(new Error('Keycloak GET /users failed (500): boom'));

    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.users).toBeUndefined();
  });
});
