import type { Request } from 'express';
import { webhookUrlOf } from './meta-cloud-account.controller';

describe('webhookUrlOf', () => {
  const prevBaseUrl = process.env.BASE_URL;

  afterEach(() => {
    if (prevBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = prevBaseUrl;
  });

  /** A request that reached the gateway over `protocol` at `host`. */
  const requestAt = (protocol: string, host: string): Request =>
    ({ protocol, get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) }) as unknown as Request;

  it.each([
    ['https://openmsg.example.com', 'https://openmsg.example.com/api/meta-webhook'],
    ['https://openmsg.example.com/', 'https://openmsg.example.com/api/meta-webhook'],
    ['https://openmsg.example.com///', 'https://openmsg.example.com/api/meta-webhook'],
  ])('C92 with BASE_URL=%s the URL is %s, whatever host the request reached', (baseUrl, expected) => {
    process.env.BASE_URL = baseUrl;

    expect(webhookUrlOf(requestAt('http', '10.0.0.7:2785'))).toBe(expected);
  });

  it('C92 with BASE_URL unset the URL is the request protocol and host', () => {
    delete process.env.BASE_URL;

    expect(webhookUrlOf(requestAt('http', '127.0.0.1:2785'))).toBe('http://127.0.0.1:2785/api/meta-webhook');
  });
});
