import { encryptProviderKey, decryptProviderKey, ProviderKeyDecryptionError } from '../services/provider-key-crypto';
import crypto from 'crypto';

const TEST_KEY = crypto.randomBytes(32).toString('hex');

describe('provider-key-crypto', () => {
  it('encrypt/decrypt roundtrip', () => {
    const plaintext = 'sk-test-key-abc123';
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    const result = decryptProviderKey(encrypted, nonce, TEST_KEY);
    expect(result).toBe(plaintext);
  });

  it('handles long API keys', () => {
    const plaintext = 'sk-' + 'a'.repeat(200);
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    const result = decryptProviderKey(encrypted, nonce, TEST_KEY);
    expect(result).toBe(plaintext);
  });

  it('different nonces produce different ciphertexts', () => {
    const plaintext = 'sk-test-key-abc123';
    const r1 = encryptProviderKey(plaintext, TEST_KEY);
    const r2 = encryptProviderKey(plaintext, TEST_KEY);
    expect(r1.encrypted.equals(r2.encrypted)).toBe(false);
    expect(r1.nonce.equals(r2.nonce)).toBe(false);
    // Both decrypt to same value
    expect(decryptProviderKey(r1.encrypted, r1.nonce, TEST_KEY)).toBe(plaintext);
    expect(decryptProviderKey(r2.encrypted, r2.nonce, TEST_KEY)).toBe(plaintext);
  });

  it('wrong key fails to decrypt', () => {
    const plaintext = 'sk-test-key-abc123';
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    const wrongKey = crypto.randomBytes(32).toString('hex');
    expect(() => decryptProviderKey(encrypted, nonce, wrongKey)).toThrow();
  });

  it('tampered ciphertext fails to decrypt', () => {
    const plaintext = 'sk-test-key-abc123';
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    // Flip a byte in the ciphertext
    const tampered = Buffer.from(encrypted);
    tampered[0] ^= 0xff;
    expect(() => decryptProviderKey(tampered, nonce, TEST_KEY)).toThrow();
  });

  it('rejects invalid key length', () => {
    expect(() => encryptProviderKey('test', 'aabbcc')).toThrow(
      'PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes'
    );
  });

  // app#396: every caller of decryptProviderKey (mcp-servers.ts, agents.ts,
  // webhook-dispatch.ts) needs to distinguish "the key is wrong" from any
  // other 500-shaped failure, so it can log something an operator can act
  // on instead of an indistinguishable generic error. That distinction only
  // works if the wrapped type is stable across every way a decrypt can fail.
  describe('ProviderKeyDecryptionError — the type callers need to distinguish this failure', () => {
    it('wrong key throws ProviderKeyDecryptionError specifically', () => {
      const plaintext = 'sk-test-key-abc123';
      const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
      const wrongKey = crypto.randomBytes(32).toString('hex');
      expect(() => decryptProviderKey(encrypted, nonce, wrongKey)).toThrow(ProviderKeyDecryptionError);
    });

    it('tampered ciphertext throws ProviderKeyDecryptionError specifically', () => {
      const plaintext = 'sk-test-key-abc123';
      const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
      const tampered = Buffer.from(encrypted);
      tampered[0] ^= 0xff;
      expect(() => decryptProviderKey(tampered, nonce, TEST_KEY)).toThrow(ProviderKeyDecryptionError);
    });

    it('a malformed key configured for decrypt also throws ProviderKeyDecryptionError, not the raw "must be 32 bytes" error', () => {
      const plaintext = 'sk-test-key-abc123';
      const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
      expect(() => decryptProviderKey(encrypted, nonce, 'aabbcc')).toThrow(ProviderKeyDecryptionError);
    });

    it('never mentions the key or the plaintext in its message', () => {
      const plaintext = 'sk-super-secret-do-not-leak';
      const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
      const wrongKey = crypto.randomBytes(32).toString('hex');
      try {
        decryptProviderKey(encrypted, nonce, wrongKey);
        throw new Error('expected decryptProviderKey to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderKeyDecryptionError);
        const message = (err as Error).message;
        expect(message).not.toContain(plaintext);
        expect(message).not.toContain(wrongKey);
        expect(message).not.toContain(TEST_KEY);
      }
    });

    it('malformed ciphertext (too short for an auth tag) stays a plain Error, not ProviderKeyDecryptionError — a data-integrity problem is not a key problem', () => {
      const tooShort = Buffer.from('short');
      const nonce = crypto.randomBytes(12);
      expect(() => decryptProviderKey(tooShort, nonce, TEST_KEY)).toThrow('Ciphertext too short');
      try {
        decryptProviderKey(tooShort, nonce, TEST_KEY);
      } catch (err) {
        expect(err).not.toBeInstanceOf(ProviderKeyDecryptionError);
      }
    });

    it('encryptProviderKey with an invalid key length is UNCHANGED — still the plain "must be 32 bytes" error, not wrapped', () => {
      // Only decryptProviderKey's failures are wrapped. encryptProviderKey's
      // own key-length check is a caller-input-validation error at the point
      // of writing new ciphertext, a different situation from "this key
      // cannot open ciphertext someone else wrote" — kept distinguishable on
      // purpose, and this pins the existing message so it doesn't drift.
      expect(() => encryptProviderKey('test', 'aabbcc')).toThrow(
        'PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes'
      );
      try {
        encryptProviderKey('test', 'aabbcc');
      } catch (err) {
        expect(err).not.toBeInstanceOf(ProviderKeyDecryptionError);
      }
    });
  });
});
