import { Pool } from 'pg';
import { decryptProviderKey, ProviderKeyDecryptionError } from './provider-key-crypto';

/**
 * app#396: PROVIDER_KEY_ENCRYPTION_KEY went from decrypting one column
 * (provider_connections.api_key) to four (mcp_servers.connection_config,
 * agents.env_vars, agent_webhooks.secret, plus the original) across three
 * PRs in one night — and the SOPS-stored key and the key the running
 * containers actually held had already drifted apart by the time anyone
 * checked, discovered only by comparing two hashes by hand.
 *
 * A self-round-trip (encrypt a fresh value, decrypt it back) proves nothing
 * about this: any 32-byte key passes it, including a freshly-rotated one
 * that cannot open a single row anyone has ever written. The only thing
 * that catches real drift is reading back a row that ACTUALLY EXISTS,
 * encrypted under whatever key was current when it was written. That is
 * what this module does, and only that — it is deliberately not a general
 * crypto self-test.
 *
 * NOTHING TO VERIFY IS NOT THE SAME RESULT AS VERIFIED. An empty estate
 * (no encrypted rows in any of the four tables) means this canary has
 * nothing to check the key against, and it says so plainly rather than
 * reporting success for a check that never ran — the exact conflation
 * CLAUDE.md's own hardening record exists to prevent elsewhere in this
 * codebase (a green run that proves less than it implies).
 */

export type CanaryResult =
  | { status: 'verified'; source: string }
  | { status: 'nothing_to_verify' };

interface CandidateRow {
  source: string;
  encrypted: Buffer;
  nonce: Buffer;
}

// Checked in this order, first hit wins — order has no significance beyond
// determinism (so a test can predict which table a mixed-population estate
// reports), since finding ANY one real row is sufficient to prove the key.
const CANDIDATES: Array<{ source: string; sql: string }> = [
  {
    source: 'provider_connections',
    sql: `SELECT api_key_encrypted AS encrypted, api_key_nonce AS nonce
          FROM provider_connections
          WHERE api_key_encrypted IS NOT NULL AND api_key_nonce IS NOT NULL
          LIMIT 1`,
  },
  {
    source: 'mcp_servers',
    sql: `SELECT connection_config_encrypted AS encrypted, connection_config_nonce AS nonce
          FROM mcp_servers
          WHERE connection_config_encrypted IS NOT NULL AND connection_config_nonce IS NOT NULL
          LIMIT 1`,
  },
  {
    source: 'agents.env_vars',
    sql: `SELECT env_vars_encrypted AS encrypted, env_vars_nonce AS nonce
          FROM agents
          WHERE env_vars_encrypted IS NOT NULL AND env_vars_nonce IS NOT NULL
          LIMIT 1`,
  },
  {
    source: 'agent_webhooks.secret',
    sql: `SELECT secret_encrypted AS encrypted, secret_nonce AS nonce
          FROM agent_webhooks
          WHERE secret_encrypted IS NOT NULL AND secret_nonce IS NOT NULL
          LIMIT 1`,
  },
];

async function findExistingCiphertext(pool: Pool): Promise<CandidateRow | null> {
  for (const candidate of CANDIDATES) {
    const { rows } = await pool.query(candidate.sql);
    if (rows.length > 0) {
      return { source: candidate.source, encrypted: rows[0].encrypted, nonce: rows[0].nonce };
    }
  }
  return null;
}

/**
 * Proves the key this process actually holds can decrypt REAL, already-
 * stored ciphertext — not a value this function generated itself.
 *
 * Throws on failure. Callers that want "fail the deploy/boot loudly" (the
 * intended use — see index.ts) get that for free by not catching it; a
 * caller that wants a softer signal can catch and inspect the thrown
 * ProviderKeyDecryptionError specifically.
 *
 * Never logs or returns the decrypted plaintext, on either path.
 */
export async function runProviderKeyCanary(pool: Pool): Promise<CanaryResult> {
  const candidate = await findExistingCiphertext(pool);

  if (!candidate) {
    return { status: 'nothing_to_verify' };
  }

  const key = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (!key) {
    throw new ProviderKeyDecryptionError(
      new Error('PROVIDER_KEY_ENCRYPTION_KEY is not set, but encrypted data exists')
    );
  }

  // The return value is discarded deliberately — proving decrypt SUCCEEDS is
  // the whole check; the plaintext itself must never reach a log or a
  // caller here.
  decryptProviderKey(candidate.encrypted, candidate.nonce, key);

  return { status: 'verified', source: candidate.source };
}
