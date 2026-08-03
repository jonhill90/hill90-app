/**
 * An SSE stream must not outlive the credential that authorised it.
 *
 * app#145 fixed exactly this on the terminal WebSocket. The four SSE endpoints
 * have the same shape — authenticated once by requireAuth, then held open
 * indefinitely by a 3s poll and a heartbeat that defeat any idle timeout — and
 * were missed, because that fix was applied where the defect was found rather
 * than everywhere the shape lives.
 *
 * The practical effect for a browser is mild and deliberate: EventSource
 * reconnects on close, and the UI proxy attaches a freshly minted session token,
 * so a user whose session is still valid sees a blink. A user whose session is
 * gone gets refused at the proxy. Enforcement moves to where the credential is.
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
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

const mockExecInContainer = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));

/** A token that expires `secs` from now — the deadline the stream must honour. */
function tokenExpiringIn(secs: number) {
  return jwt.sign(
    { sub: 'owner-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: secs },
  );
}

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

/** A container stream that stays open, so only the deadline can end the response. */
function idleStream() {
  return new Readable({ read() { /* never pushes, never ends */ } });
}

describe('an SSE stream ends when its credential does', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockExecInContainer.mockImplementation(() => Promise.resolve(idleStream()));
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('closes the agents event stream at expiry, and says why', async () => {
    const res = await request(app)
      .get('/agents/agent-uuid/events?follow=true')
      .set('Authorization', `Bearer ${tokenExpiringIn(2)}`);

    // The response completes because the server ended it: an idle container
    // stream cannot end it, so only the deadline can.
    expect(res.text).toMatch(/event: error/);
    expect(res.text).toMatch(/expired/i);
  }, 15000);

  // Guard rail: an ordinary session must not be cut short.
  it('leaves a stream with a long-lived credential open', async () => {
    const pending = request(app)
      .get('/agents/agent-uuid/events?follow=true')
      .set('Authorization', `Bearer ${tokenExpiringIn(3600)}`)
      .then(() => 'ENDED' as const);

    const outcome = await Promise.race([
      pending,
      new Promise<'STILL OPEN'>((r) => setTimeout(() => r('STILL OPEN'), 2500)),
    ]);

    expect(outcome).toBe('STILL OPEN');
  }, 15000);
});
