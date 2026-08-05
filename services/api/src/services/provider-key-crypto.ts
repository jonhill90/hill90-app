/**
 * AES-256-GCM encryption for provider API keys.
 *
 * Encrypt on write (API service), decrypt for validation passthrough.
 * The AI service has its own decrypt-only module (crypto.py).
 *
 * Key: 32-byte hex string from PROVIDER_KEY_ENCRYPTION_KEY env var.
 * Nonce: 12 bytes, randomly generated per encryption.
 * Output: ciphertext with 16-byte auth tag appended.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getKeyBuffer(hexKey: string): Buffer {
  const buf = Buffer.from(hexKey, 'hex');
  if (buf.length !== 32) {
    throw new Error('PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return buf;
}

export interface EncryptedKey {
  encrypted: Buffer;
  nonce: Buffer;
}

// app#396: a wrong or missing key and a genuinely wrong key are both, from a
// caller's perspective, "this process cannot recover what was stored" — the
// same remediation (check PROVIDER_KEY_ENCRYPTION_KEY) applies either way.
// Before this, the four consumers of decryptProviderKey (provider-connections,
// mcp-servers, agents.env_vars, webhook-dispatch) each caught the same raw
// Node error ("Unsupported state or unable to authenticate data" — empirically
// captured, not documented anywhere) and turned it into an indistinguishable
// generic 500, or in webhook-dispatch's case, into nothing at all (#396).
// A distinct, exported error type lets every caller `instanceof`-check for
// this specific failure and log it as what it actually is, without leaking
// the key or the plaintext in the message.
export class ProviderKeyDecryptionError extends Error {
  constructor(cause: unknown) {
    super(
      'PROVIDER_KEY_ENCRYPTION_KEY could not decrypt this ciphertext — either the ' +
      'key is missing/malformed, or it does not match the key that encrypted the ' +
      'stored data.'
    );
    this.name = 'ProviderKeyDecryptionError';
    this.cause = cause;
  }
}

export function encryptProviderKey(plaintext: string, hexKey: string): EncryptedKey {
  const key = getKeyBuffer(hexKey);
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([ciphertext, tag]),
    nonce,
  };
}

export function decryptProviderKey(encrypted: Buffer, nonce: Buffer, hexKey: string): string {
  // Malformed ciphertext (too short to even hold an auth tag) is a data-
  // integrity problem, not a key problem — kept as a plain Error, not wrapped
  // below, so the two remain distinguishable to a caller that cares.
  if (encrypted.length < TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }
  try {
    const key = getKeyBuffer(hexKey);
    const ciphertext = encrypted.subarray(0, encrypted.length - TAG_LENGTH);
    const tag = encrypted.subarray(encrypted.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch (err) {
    throw new ProviderKeyDecryptionError(err);
  }
}
