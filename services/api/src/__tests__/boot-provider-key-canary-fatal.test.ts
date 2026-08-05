/**
 * app#396: proves the canary is actually wired into boot the way migrations
 * already are — a real child process, a fake pool returning REAL ciphertext
 * encrypted under one key, PROVIDER_KEY_ENCRYPTION_KEY set to a DIFFERENT
 * one. Same shape as boot-migrations-fatal.test.ts, same reason: reading
 * the wiring in index.ts is not the same claim as watching a process
 * actually refuse to start on it.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const API_ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(API_ROOT, 'node_modules/.bin/tsx');

type Run = { code: number; stdout: string; stderr: string };

function run(source: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(TSX, ['-e', source], {
    cwd: API_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// A fake pool whose .query returns real ciphertext for provider_connections
// and nothing for the other three candidates — built inline in the spawned
// script so it never depends on a real database.
const FAKE_POOL_WITH_ONE_ROW = `
  import { encryptProviderKey } from './src/services/provider-key-crypto';
  const REAL_KEY = 'aa'.repeat(32);
  const { encrypted, nonce } = encryptProviderKey('sk-a-real-secret-encrypted-under-REAL_KEY', REAL_KEY);
  const pool = {
    query: async (sql) => {
      if (sql.includes('provider_connections')) return { rows: [{ encrypted, nonce }] };
      return { rows: [] };
    },
  };
`;

describe('the provider-key canary at boot', () => {
  it('a wrong key refuses to start, exits non-zero, and never prints LISTENING', () => {
    const r = run(
      `
      ${FAKE_POOL_WITH_ONE_ROW}
      import { runProviderKeyCanary } from './src/services/provider-key-canary';
      import { dieOnStartupFailure } from './src/boot/fatal';
      const start = async () => {
        try {
          await runProviderKeyCanary(pool as any);
        } catch (err) {
          throw new Error('PROVIDER_KEY_ENCRYPTION_KEY cannot decrypt existing stored ciphertext — refusing to start on a key that would make encrypted data unreadable.', { cause: err });
        }
        console.log('LISTENING');
      };
      dieOnStartupFailure(start());
      `,
      // A key that is validly-shaped (64 hex chars) but WRONG — the exact
      // shape #396 found live: not absent, not malformed, just different
      // from whatever encrypted the stored row.
      { PROVIDER_KEY_ENCRYPTION_KEY: 'bb'.repeat(32) }
    );

    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('LISTENING');
    expect(r.stderr).toMatch(/\[startup\] fatal: the service could not start/);
    expect(r.stderr).toMatch(/refusing to start on a key/);
    // The whole point: neither key, nor the plaintext, ever reaches stderr.
    expect(r.stderr).not.toContain('aa'.repeat(32));
    expect(r.stderr).not.toContain('bb'.repeat(32));
    expect(r.stderr).not.toContain('sk-a-real-secret-encrypted-under-REAL_KEY');
  });

  it('the correct key starts cleanly and reports which table it verified against', () => {
    const r = run(
      `
      ${FAKE_POOL_WITH_ONE_ROW}
      import { runProviderKeyCanary } from './src/services/provider-key-canary';
      import { dieOnStartupFailure } from './src/boot/fatal';
      const start = async () => {
        const result = await runProviderKeyCanary(pool as any);
        console.log('[startup] Provider-key canary:', result.status, result.source ?? '');
        console.log('LISTENING');
      };
      dieOnStartupFailure(start());
      `,
      { PROVIDER_KEY_ENCRYPTION_KEY: 'aa'.repeat(32) }
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('LISTENING');
    expect(r.stdout).toContain('verified');
    expect(r.stdout).toContain('provider_connections');
  });

  it('an empty estate (nothing to verify) also starts cleanly, and says so distinctly from "verified"', () => {
    const r = run(
      `
      const pool = { query: async () => ({ rows: [] }) };
      import { runProviderKeyCanary } from './src/services/provider-key-canary';
      import { dieOnStartupFailure } from './src/boot/fatal';
      const start = async () => {
        const result = await runProviderKeyCanary(pool as any);
        console.log('[startup] Provider-key canary:', result.status);
        console.log('LISTENING');
      };
      dieOnStartupFailure(start());
      `,
      { PROVIDER_KEY_ENCRYPTION_KEY: 'cc'.repeat(32) }
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('LISTENING');
    expect(r.stdout).toContain('nothing_to_verify');
    expect(r.stdout).not.toContain('"status":"verified"');
  });
});
