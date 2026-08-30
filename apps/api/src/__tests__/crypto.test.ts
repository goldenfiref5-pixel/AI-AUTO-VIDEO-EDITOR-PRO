import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, fingerprint, maskSecret } from '../utils/crypto';

describe('secret encryption', () => {
  it('round-trips a value', () => {
    const secret = 'AIzaSyExampleKeyValue1234567890';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    const secret = 'AIzaSyExampleKeyValue1234567890';
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it('rejects a tampered payload', () => {
    const encrypted = encryptSecret('secret-value');
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptSecret('garbage')).toThrow(/Malformed/);
  });
});

describe('fingerprint', () => {
  it('is stable for the same input', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
  });

  it('differs for different inputs', () => {
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
  });
});

describe('maskSecret', () => {
  it('keeps a recognisable prefix and suffix', () => {
    const masked = maskSecret('AIzaSyABCDEFGHIJKLMNOP9876');
    expect(masked.startsWith('AIzaSy')).toBe(true);
    expect(masked.endsWith('9876')).toBe(true);
    expect(masked).not.toContain('ABCDEFGH');
  });

  it('fully masks a short value', () => {
    expect(maskSecret('short')).toBe('•••••');
  });
});
