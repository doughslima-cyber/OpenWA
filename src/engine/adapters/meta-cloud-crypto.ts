import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cloud API access tokens at rest (OpenMsg, docs/32 D2, door 4).
 *
 * AES-256-GCM under the 32-byte key in `META_CLOUD_ENCRYPTION_KEY` (base64), stored as
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64url. A changed key cannot read the old tokens: every
 * Cloud session then needs its token entered again.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The key from `META_CLOUD_ENCRYPTION_KEY`, or null when it is unset, not base64, or not 32 bytes. */
export function parseMetaCloudKey(raw: string | undefined = process.env.META_CLOUD_ENCRYPTION_KEY): Buffer | null {
  const value = raw?.trim();
  if (!value || !BASE64.test(value)) return null;
  const key = Buffer.from(value, 'base64');
  return key.length === KEY_BYTES ? key : null;
}

export function encryptMetaToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Decrypts a stored token; throws on an unknown format, a tampered part or another key. */
export function decryptMetaToken(stored: string, key: Buffer): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every(p => BASE64URL.test(p))) {
    throw new Error('Unrecognised encrypted token format');
  }
  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Unrecognised encrypted token format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}
