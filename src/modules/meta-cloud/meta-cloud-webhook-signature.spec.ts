import { createHmac } from 'node:crypto';
import { isValidMetaSignature } from './meta-cloud-webhook-signature';

describe('isValidMetaSignature', () => {
  const SECRET = 'a3f1c0de9b8e7d6c5b4a39281706f5e4';
  // Meta signs the bytes it sent: spacing and key order a JSON.stringify would not reproduce.
  const RAW = Buffer.from('{"object": "whatsapp_business_account",  "entry": [{"id": "102290129340399"}]}');
  const hmac = (body: Buffer | string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');

  it('C51 accepts sha256= followed by the hex HMAC-SHA256 of the raw body under the app secret', () => {
    expect(isValidMetaSignature(RAW, `sha256=${hmac(RAW, SECRET)}`, SECRET)).toBe(true);
  });

  const reserialized = JSON.stringify(JSON.parse(RAW.toString('utf8')));

  it.each([
    ['no header', undefined],
    ['a header without the sha256= prefix', hmac(RAW, SECRET)],
    ['an HMAC under another secret', `sha256=${hmac(RAW, 'another-app-secret-0000000000000')}`],
    ['an HMAC of the re-serialized JSON', `sha256=${hmac(reserialized, SECRET)}`],
    ['a header of different length', `sha256=${hmac(RAW, SECRET)}00`],
  ])('C51 rejects %s', (_case, header) => {
    expect(reserialized).not.toBe(RAW.toString('utf8'));
    expect(isValidMetaSignature(RAW, header, SECRET)).toBe(false);
  });
});
