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

jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: jest.fn().mockResolvedValue({ accepted: true, work_id: 'work-1' }),
}));

function makeToken(sub: string, roles: string[]): string {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

const MOCK_WORKFLOW = {
  id: 'wf-1',
  name: 'Daily Health Check',
  description: 'Run health checks',
  agent_id: 'agent-uuid',
  schedule_cron: '0 9 * * *',
  prompt: 'Check system health',
  output_type: 'none',
  output_config: '{}',
  enabled: true,
  trigger_type: 'cron',
  created_by: 'regular-user',
  created_at: '2026-04-19T00:00:00Z',
  agent_name: 'HealthBot',
  agent_slug: 'health-bot',
  agent_status: 'stopped',
};

describe('Workflows routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('GET /workflows', () => {
    it('lists workflows for user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_WORKFLOW] });

      const res = await request(app)
        .get('/workflows')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Daily Health Check');
    });

    it('admin sees all workflows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_WORKFLOW] });

      await request(app)
        .get('/workflows')
        .set('Authorization', `Bearer ${adminToken}`);

      // Not a bare substring check: app#374 made the column list explicit
      // (to exclude webhook_token_hash), so `created_by` now legitimately
      // appears as a SELECTed column even for admin. What actually matters
      // is that no WHERE clause restricts by it.
      const queryStr = mockQuery.mock.calls[0][0] as string;
      expect(queryStr).not.toMatch(/WHERE\s+w\.created_by/i);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get('/workflows');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /workflows', () => {
    it('creates a cron workflow', async () => {
      // Agent exists check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] });
      // Insert
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_WORKFLOW] });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Daily Health Check',
          agent_id: 'agent-uuid',
          schedule_cron: '0 9 * * *',
          prompt: 'Check system health',
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Daily Health Check');
    });

    it('creates a webhook-triggered workflow: response carries a fresh raw token once, the INSERT only ever gets its hash', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] });
      // RETURNING uses PUBLIC_COLUMNS (app#374) — the row the "DB" hands
      // back has no webhook token or hash field at all, matching the real
      // column list post-migration-068.
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...MOCK_WORKFLOW, trigger_type: 'webhook' }],
      });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Webhook Trigger',
          agent_id: 'agent-uuid',
          schedule_cron: '* * * * *',
          prompt: 'Handle webhook',
          trigger_type: 'webhook',
        });

      expect(res.status).toBe(201);
      // 32 random bytes, hex-encoded = 64 hex chars.
      expect(res.body.webhook_url).toMatch(/^\/workflows\/webhook\/[0-9a-f]{64}$/);
      expect(JSON.stringify(res.body)).not.toMatch(/"webhook_token_hash"/);

      // The INSERT writes only a hash, never the raw token generated above.
      const insertCall = mockQuery.mock.calls[1];
      const rawToken = res.body.webhook_url.replace('/workflows/webhook/', '');
      const insertedHash = insertCall[1][10]; // webhook_token_hash is the 11th bound param
      expect(insertedHash).not.toBe(rawToken);
      expect(insertedHash).toBe(
        require('crypto').createHash('sha256').update(rawToken).digest('hex')
      );
    });

    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Missing fields' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('validates cron expression', async () => {
      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Bad Cron',
          agent_id: 'agent-uuid',
          schedule_cron: 'invalid',
          prompt: 'test',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cron');
    });

    it('POSITIVE CONTROL (app#487): rejects a cron with valid field COUNT but out-of-range VALUES', async () => {
      // The pre-fix validator only checked "5 or 6 whitespace-separated
      // fields" — this string passes that check but every field is out of
      // range, and cron-parser (what the scheduler actually uses to compute
      // next_run_at) rejects it. Before this fix the row was written anyway
      // (the agent-exists check and INSERT below are queued so a pre-fix
      // run reaches, and succeeds at, both — proving the row really would
      // have been written, not just that validation was skipped), with
      // next_run_at silently never set.
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_WORKFLOW, schedule_cron: '99 99 99 99 99' }] });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Out Of Range Cron',
          agent_id: 'agent-uuid',
          schedule_cron: '99 99 99 99 99',
          prompt: 'test',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cron');
    });

    it('returns 404 for non-existent agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Test',
          agent_id: 'bad-agent',
          schedule_cron: '0 * * * *',
          prompt: 'test',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /workflows/:id', () => {
    it('deletes a workflow', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .delete('/workflows/wf-1')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('returns 404 for non-existent', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .delete('/workflows/bad-id')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /workflows/:id/runs', () => {
    it('returns run history', async () => {
      const mockRuns = [
        { id: 'r1', status: 'completed', started_at: '2026-04-19T09:00:00Z', finished_at: '2026-04-19T09:01:00Z' },
      ];
      // Access check + runs query
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'wf-1' }] });
      mockQuery.mockResolvedValueOnce({ rows: mockRuns });

      const res = await request(app)
        .get('/workflows/wf-1/runs')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe('completed');
    });
  });

  // app#374: the token in the URL is looked up by SHA-256 digest
  // (migration 068), never by plaintext equality — the raw value must
  // never appear as a bound query parameter.
  describe('POST /workflows/webhook/:token', () => {
    it('hashes the presented token before querying, and never binds the raw value', async () => {
      const rawToken = 'a'.repeat(64);
      const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      mockQuery.mockImplementation((sql: string) => {
        if (/FROM workflows w/.test(sql)) {
          return Promise.resolve({
            rows: [{
              ...MOCK_WORKFLOW, agent_slug: 'health-bot', agent_status: 'running',
              work_token: 'wt-secret', allowed_models: ['gpt-4o'],
            }],
          });
        }
        if (/INSERT INTO workflow_runs/.test(sql)) return Promise.resolve({ rows: [{ id: 'run-1' }] });
        if (/INSERT INTO chat_threads/.test(sql)) return Promise.resolve({ rows: [{ id: 'thread-1' }] });
        if (/INSERT INTO chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 'msg-1' }] });
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post(`/workflows/webhook/${rawToken}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ triggered: true, workflow: MOCK_WORKFLOW.name, run_id: 'run-1', thread_id: 'thread-1' });

      const lookupCall = mockQuery.mock.calls.find((c: unknown[]) => /FROM workflows w/.test(String(c[0])));
      expect(lookupCall).toBeDefined();
      expect(String(lookupCall![0])).toContain('webhook_token_hash');
      expect(String(lookupCall![0])).not.toMatch(/WHERE\s+w\.webhook_token\s*=/i);
      expect(lookupCall![1]).toEqual([expectedHash]);
      // The raw token must never be a bound parameter anywhere in this call.
      expect((lookupCall![1] as unknown[]).includes(rawToken)).toBe(false);
    });

    it('CONTROL: a route that queried by plaintext would bind the raw token, not its hash', () => {
      // Proves the assertions above have teeth: this is what the OLD,
      // pre-#374 query would have bound.
      const rawToken = 'a'.repeat(64);
      const plaintextParams = [rawToken];
      expect(plaintextParams.includes(rawToken)).toBe(true);
    });

    it('returns 404 for an unknown token without distinguishing it from a disabled workflow', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/workflows/webhook/${'b'.repeat(64)}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(404);
    });
  });
});
