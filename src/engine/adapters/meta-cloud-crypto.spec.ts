import { randomBytes } from 'node:crypto';
import { decryptMetaToken, encryptMetaToken, parseMetaCloudKey } from './meta-cloud-crypto';

describe('meta-cloud token cipher', () => {
  const key = randomBytes(32);
  const token = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-system-user-token-0123456789';

  /** Flip one byte of the decoded part at `index` (1 = IV, 2 = tag, 3 = ciphertext). */
  const tamper = (stored: string, index: number): string => {
    const parts = stored.split('.');
    const bytes = Buffer.from(parts[index], 'base64url');
    bytes[0] ^= 0x01;
    parts[index] = bytes.toString('base64url');
    return parts.join('.');
  };

  it('C13 writes v1.<iv>.<tag>.<ciphertext> in base64url with a 12-byte IV and a 16-byte tag', () => {
    const stored = encryptMetaToken(token, key);
    const parts = stored.split('.');

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2], 'base64url')).toHaveLength(16);
  });

  it('C13 never equals and never contains the plaintext, and decrypts back to it', () => {
    const stored = encryptMetaToken(token, key);

    expect(stored).not.toBe(token);
    expect(stored).not.toContain(token);
    expect(decryptMetaToken(stored, key)).toBe(token);
  });

  it.each([
    ['IV', 1],
    ['tag', 2],
    ['ciphertext', 3],
  ])('C13 throws when one byte of the %s changes', (_part, index) => {
    const stored = encryptMetaToken(token, key);
    expect(() => decryptMetaToken(tamper(stored, index), key)).toThrow();
  });

  it('C13 throws when decrypting with another 32-byte key', () => {
    const stored = encryptMetaToken(token, key);
    expect(() => decryptMetaToken(stored, randomBytes(32))).toThrow();
  });

  it('rejects a value that is not in the v1 format', () => {
    expect(() => decryptMetaToken(token, key)).toThrow(/format/);
  });

  describe('parseMetaCloudKey', () => {
    it('accepts base64 that decodes to exactly 32 bytes', () => {
      const raw = randomBytes(32).toString('base64');
      expect(parseMetaCloudKey(raw)).toEqual(Buffer.from(raw, 'base64'));
    });

    it.each([
      ['unset', undefined],
      ['blank', ''],
      ['not base64', 'not base64 at all!'],
      ['31 bytes', randomBytes(31).toString('base64')],
      ['33 bytes', randomBytes(33).toString('base64')],
    ])('returns null when the key is %s', (_label, raw) => {
      expect(parseMetaCloudKey(raw)).toBeNull();
    });
  });
});
