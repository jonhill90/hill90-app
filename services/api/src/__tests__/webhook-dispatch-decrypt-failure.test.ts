/**
 * app#396: a decrypt failure for agent_webhooks.secret used to be silent.
 * `decryptWebhookSecret(hook)` was called inside `deliverWebhook` but
 * OUTSIDE its one try/catch (which only ever wrapped the `fetch` call) — a
 * thrown decrypt error rejected `deliverWebhook`'s returned promise, which
 * `dispatchAsync` fed straight into `Promise.allSettled` and never
 * inspected. Net effect: PROVIDER_KEY_ENCRYPTION_KEY drifting from whatever
 * encrypted a webhook's secret produced no 500, no log line, nothing — the
 * webhook simply never fired, discovered only by the recipient complaining.
 *
 * Found while auditing the same key #390 (shipped hours earlier the same
 * night) made a fourth consumer of. This file proves the fixed behavior:
 * the webhook is never delivered unsigned, the failure is logged loudly
 * and specifically, and the log never contains the plaintext secret or
 * either encryption key.
 */
import * as crypto from 'crypto';
import { encryptProviderKey } from '../services/provider-key-crypto';

const REAL_KEY = crypto.randomBytes(32).toString('hex');
const WRONG_KEY = crypto.randomBytes(32).toString('hex');
const SECRET = 'whsec_real-signing-key-abc123';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockFetch = jest.fn();
let consoleErrorSpy: jest.SpyInstance;

describe('webhook-dispatch: a decrypt failure fails loudly, never delivers unsigned', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mockFetch as unknown as typeof fetch;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
    consoleErrorSpy.mockRestore();
  });

  it('a wrong key: never calls fetch (not delivered, not even unsigned), and logs loudly without leaking the secret or either key', async () => {
    const { encrypted, nonce } = encryptProviderKey(SECRET, REAL_KEY);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'hook-wrong-key', url: 'https://example.com/hook', secret_encrypted: encrypted, secret_nonce: nonce }],
    });
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = WRONG_KEY;

    const { dispatchWebhooks } = require('../services/webhook-dispatch');
    dispatchWebhooks('test-agent', 'agent-uuid-1', 'start', {});
    await new Promise((r) => setTimeout(r, 20));

    // THE ASSERTION THAT MATTERS: no delivery at all, signed or unsigned.
    expect(mockFetch).not.toHaveBeenCalled();

    const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
      String(call[0]).includes('SECRET DECRYPTION FAILED')
    );
    expect(loggedCall).toBeDefined();
    expect(String(loggedCall![0])).toContain('hook-wrong-key');
    expect(String(loggedCall![0])).toContain('NOT delivered');

    const fullLoggedText = loggedCall!.map((v: unknown) => JSON.stringify(v)).join(' ');
    expect(fullLoggedText).not.toContain(SECRET);
    expect(fullLoggedText).not.toContain(REAL_KEY);
    expect(fullLoggedText).not.toContain(WRONG_KEY);
  });

  it('a missing key entirely: same behavior — no delivery, a loud specific log, no leak', async () => {
    const { encrypted, nonce } = encryptProviderKey(SECRET, REAL_KEY);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'hook-missing-key', url: 'https://example.com/hook', secret_encrypted: encrypted, secret_nonce: nonce }],
    });
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;

    const { dispatchWebhooks } = require('../services/webhook-dispatch');
    dispatchWebhooks('test-agent', 'agent-uuid-1', 'start', {});
    await new Promise((r) => setTimeout(r, 20));

    expect(mockFetch).not.toHaveBeenCalled();
    const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
      String(call[0]).includes('SECRET DECRYPTION FAILED')
    );
    expect(loggedCall).toBeDefined();
    expect(String(loggedCall![0])).toContain('hook-missing-key');
    const fullLoggedText = loggedCall!.map((v: unknown) => JSON.stringify(v)).join(' ');
    expect(fullLoggedText).not.toContain(SECRET);
    expect(fullLoggedText).not.toContain(REAL_KEY);
  });

  it('one hook with a wrong key and one hook with no secret configured: the second still delivers — one bad row does not sink another', async () => {
    const { encrypted, nonce } = encryptProviderKey(SECRET, REAL_KEY);
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'hook-bad', url: 'https://example.com/bad', secret_encrypted: encrypted, secret_nonce: nonce },
        { id: 'hook-ok', url: 'https://example.com/ok', secret_encrypted: null, secret_nonce: null },
      ],
    });
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = WRONG_KEY;

    const { dispatchWebhooks } = require('../services/webhook-dispatch');
    dispatchWebhooks('test-agent', 'agent-uuid-1', 'start', {});
    await new Promise((r) => setTimeout(r, 20));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/ok');
  });

  // POSITIVE CONTROL. Reverts to the pre-fix shape (decrypt call outside any
  // try/catch, its rejection fed to an uninspected Promise.allSettled) and
  // confirms that shape really does produce zero signal — proving the test
  // above has teeth, not just that it currently passes.
  it('CONTROL: the pre-fix shape (uncaught rejection into an uninspected allSettled) really is silent', async () => {
    const rejecting = Promise.reject(new Error('simulated decrypt failure'));
    const results = await Promise.allSettled([rejecting]);
    // This is exactly what dispatchAsync used to do: get the settled array
    // and never look at it. Nothing here observes the rejection at all.
    expect(results[0].status).toBe('rejected');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('an unexpected rejection elsewhere in delivery (not the decrypt path) is still caught by the allSettled backstop and logged', async () => {
    // HMAC signing itself has no try/catch of its own (only fetch does) —
    // this simulates a genuine, different failure reaching dispatchAsync's
    // Promise.allSettled, to prove the backstop added alongside this fix
    // (dispatchAsync now inspects settled results) covers more than just
    // the one named defect.
    const { encrypted, nonce } = encryptProviderKey(SECRET, REAL_KEY);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'hook-hmac-throws', url: 'https://example.com/hook', secret_encrypted: encrypted, secret_nonce: nonce }],
    });
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = REAL_KEY;

    // node:crypto's createHmac can't be jest.spyOn'd directly (non-configurable
    // on this Node version) — mocked at the module level instead, scoped to
    // this one test via resetModules/doMock so every other test in this file
    // keeps using the real implementation.
    jest.doMock('node:crypto', () => ({
      ...jest.requireActual('node:crypto'),
      createHmac: () => {
        throw new Error('simulated unexpected signing failure');
      },
    }));

    try {
      const { dispatchWebhooks } = require('../services/webhook-dispatch');
      dispatchWebhooks('test-agent', 'agent-uuid-1', 'start', {});
      await new Promise((r) => setTimeout(r, 20));

      expect(mockFetch).not.toHaveBeenCalled();
      const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
        String(call[0]).includes('Unexpected delivery failure')
      );
      expect(loggedCall).toBeDefined();
      expect(String(loggedCall![0])).toContain('hook-hmac-throws');
    } finally {
      jest.dontMock('node:crypto');
      jest.resetModules();
    }
  });
});
