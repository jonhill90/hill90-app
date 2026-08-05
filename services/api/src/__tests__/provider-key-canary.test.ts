/**
 * app#396: PROVIDER_KEY_ENCRYPTION_KEY decrypts four tables now, and the
 * SOPS-stored key and the key a running container actually held had
 * already drifted apart the night it became four — undetected until
 * someone compared two hashes by hand. This proves the canary that would
 * have caught that: it reads back REAL, already-stored ciphertext (never a
 * value it generated itself — a self-round-trip passes for any key,
 * including a freshly wrong one) and proves the configured key can still
 * open it.
 */
import * as crypto from 'crypto';
import { encryptProviderKey } from '../services/provider-key-crypto';
import { runProviderKeyCanary } from '../services/provider-key-canary';

const REAL_KEY = crypto.randomBytes(32).toString('hex');
const WRONG_KEY = crypto.randomBytes(32).toString('hex');

/** A minimal stand-in for `pg.Pool` — the canary only ever calls `.query`. */
function fakePool(rowsByTableMatch: Record<string, { encrypted: Buffer; nonce: Buffer } | null>) {
  return {
    query: jest.fn(async (sql: string) => {
      for (const [needle, row] of Object.entries(rowsByTableMatch)) {
        if (sql.includes(needle) && row) {
          return { rows: [{ encrypted: row.encrypted, nonce: row.nonce }] };
        }
      }
      return { rows: [] };
    }),
  } as any;
}

describe('runProviderKeyCanary', () => {
  afterEach(() => {
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  });

  it('nothing to verify: zero encrypted rows across all four tables reports its own distinct status, not "verified"', async () => {
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = REAL_KEY;
    const pool = fakePool({});

    const result = await runProviderKeyCanary(pool);

    expect(result).toEqual({ status: 'nothing_to_verify' });
    // Queried all four candidate tables before concluding there's nothing —
    // not just the first one.
    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it('verified: a real row in provider_connections, decrypted with the correct key', async () => {
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = REAL_KEY;
    const { encrypted, nonce } = encryptProviderKey('sk-real-anthropic-key', REAL_KEY);
    const pool = fakePool({ provider_connections: { encrypted, nonce } });

    const result = await runProviderKeyCanary(pool);

    expect(result).toEqual({ status: 'verified', source: 'provider_connections' });
  });

  it('checks all four tables, not just the first: a row that exists ONLY in agent_webhooks is still found and verified', async () => {
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = REAL_KEY;
    const { encrypted, nonce } = encryptProviderKey('whsec_real-signing-key', REAL_KEY);
    const pool = fakePool({ agent_webhooks: { encrypted, nonce } });

    const result = await runProviderKeyCanary(pool);

    expect(result).toEqual({ status: 'verified', source: 'agent_webhooks.secret' });
  });

  it('the returned result never contains the decrypted plaintext, on the verified path', async () => {
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = REAL_KEY;
    const plaintext = 'sk-must-never-appear-in-the-result';
    const { encrypted, nonce } = encryptProviderKey(plaintext, REAL_KEY);
    const pool = fakePool({ provider_connections: { encrypted, nonce } });

    const result = await runProviderKeyCanary(pool);

    expect(JSON.stringify(result)).not.toContain(plaintext);
  });

  // POSITIVE CONTROL, matching #396's actual live finding: real ciphertext,
  // wrong key. This is exactly the scenario a self-round-trip cannot catch
  // (a fresh encrypt/decrypt with the wrong key would "succeed" against
  // itself) and exactly the scenario that went undetected in production.
  it('CONTROL: a real row, decrypted with the WRONG key, throws — and the thrown error names neither key nor the plaintext', async () => {
    const plaintext = 'sk-real-secret-must-not-leak';
    const { encrypted, nonce } = encryptProviderKey(plaintext, REAL_KEY);
    const pool = fakePool({ provider_connections: { encrypted, nonce } });
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = WRONG_KEY;

    await expect(runProviderKeyCanary(pool)).rejects.toThrow();

    try {
      await runProviderKeyCanary(pool);
      throw new Error('expected runProviderKeyCanary to reject');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(plaintext);
      expect(message).not.toContain(REAL_KEY);
      expect(message).not.toContain(WRONG_KEY);
    }
  });

  it('a real row but PROVIDER_KEY_ENCRYPTION_KEY entirely unset also throws, rather than silently reporting nothing to verify', async () => {
    const { encrypted, nonce } = encryptProviderKey('sk-whatever', REAL_KEY);
    const pool = fakePool({ provider_connections: { encrypted, nonce } });
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;

    await expect(runProviderKeyCanary(pool)).rejects.toThrow();
  });
});
