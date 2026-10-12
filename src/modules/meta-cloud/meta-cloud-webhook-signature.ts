import { createHmac } from 'node:crypto';
import { safeEqualStr } from '../integration/ingress-signature';

const PREFIX = 'sha256=';

/**
 * Meta's `X-Hub-Signature-256` check (OpenMsg, docs/32): `sha256=` and the hex HMAC-SHA256 of the
 * exact request bytes under the app secret. Compared in constant time; the bytes are the raw body
 * `configure-app.ts` keeps, never a re-serialization of the parsed JSON.
 */
export function isValidMetaSignature(
  rawBody: Buffer | string | undefined,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (rawBody === undefined || !header || !header.startsWith(PREFIX) || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqualStr(header.slice(PREFIX.length), expected);
}
