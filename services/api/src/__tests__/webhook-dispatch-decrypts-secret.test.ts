/**
 * app#374 tier two: webhook-dispatch.ts must recover agent_webhooks.secret
 * in PLAINTEXT to HMAC-sign outbound deliveries — this is the whole reason
 * the column is encrypted rather than hashed (unlike workflows.webhook_token,
 * #341, which only ever needs a comparison). This file proves the full
 * chain end to end: real ciphertext in the mocked row -> decrypted ->
 * HMAC-SHA256 used to sign -> the actual outbound request carries a
 * signature a receiver could verify against the real secret. Not just that
 * decrypt() returns something — that dispatch produces the exact signature
 * the real secret would produce.
 */
import * as crypto from 'crypto';
import { encryptProviderKey } from '../services/provider-key-crypto';

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const SECRET = 'whsec_real-signing-key-abc123';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockFetch = jest.fn();

describe('webhook-dispatch decrypts the secret to sign deliveries', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mockFetch as unknown as typeof fetch;
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  });

  it('signs the real delivery body with the decrypted secret, matching an independently computed HMAC', async () => {
    const { encrypted, nonce } = encryptProviderKey(SECRET, TEST_ENCRYPTION_KEY);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'hook-1', url: 'https://example.com/hook', secret_encrypted: encrypted, secret_nonce: nonce }],
    });

    const { dispatchWebhooks } = require('../services/webhook-dispatch');
    dispatchWebhooks('test-agent', 'agent-uuid-1', 'start', { container_id: 'abc123' });

    // dispatchWebhooks is deliberately fire-and-forget (void) — wait a tick
    // for the async dispatch to actually run and call fetch.
    await new Promise((r) => setTimeout(r, 20));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');

    const sentBody = init.body as string;
    const sentSignature = init.headers['X-Webhook-Signature'];
    expect(sentSignature).toMatch(/^sha256=/);

    // THE ASSERTION THAT MATTERS: recompute the HMAC independently, using the
    // real secret and the real body actually sent, and confirm it matches —
    // proving decryption produced the exact original key, not merely "a" key.
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(sentBody).digest('hex');
    expect(sentSignature).toBe(expectedSignature);
  });

  it('a webhook with no secret configured (both columns null) sends no signature header', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'hook-2', url: 'https://example.com/no-secret', secret_encrypted: null, secret_nonce: null }],
    });

    const { dispatchWebhooks } = require('../services/webhook-dispatch');
    dispatchWebhooks('test-agent', 'agent-uuid-1', 'start', {});
    await new Promise((r) => setTimeout(r, 20));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Webhook-Signature']).toBeUndefined();
  });

  // POSITIVE CONTROL. Proves the "matches an independently computed HMAC"
  // assertion above can actually fail — a signature computed with the WRONG
  // secret must not accidentally match.
  it('CONTROL: a signature computed with a different secret does not match', () => {
    const body = '{"event":"start"}';
    const realSignature = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const wrongSignature = crypto.createHmac('sha256', 'a-different-secret').update(body).digest('hex');
    expect(realSignature).not.toBe(wrongSignature);
  });
});
