import { createServer, IncomingHttpHeaders, Server } from 'http';
import type { AddressInfo } from 'net';

/**
 * A local stand-in for graph.facebook.com (OpenMsg, docs/32): binds 127.0.0.1, records every request
 * and answers from a per-test script. Its `url` goes into `META_GRAPH_BASE_URL`.
 */

export interface RecordedGraphRequest {
  method: string;
  /** Path and query, version prefix included (`/v26.0/106540352242922?fields=...`). */
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** An answer, or `'hang'` to never answer (a timeout). */
export type GraphReply = { status: number; body?: unknown } | 'hang';
export type GraphScript = (request: RecordedGraphRequest) => GraphReply;

export const FAKE_PROFILE = {
  display_phone_number: '+55 11 99999-0000',
  verified_name: 'Acme',
  quality_rating: 'GREEN',
  messaging_limit_tier: 'TIER_1K',
  id: '106540352242922',
};

/** Answers the two calls a start makes: the number's profile and the WABA subscription. */
export const happyGraph: GraphScript = request =>
  request.method === 'POST' && request.path.endsWith('/subscribed_apps')
    ? { status: 200, body: { success: true } }
    : { status: 200, body: FAKE_PROFILE };

let sent = 0;

/** As happyGraph, plus a fresh `wamid` for each message sent and a fresh id for each media upload. */
export const sendingGraph: GraphScript = request => {
  const path = request.path.split('?')[0];
  if (request.method === 'POST' && path.endsWith('/messages')) {
    const n = ++sent;
    return {
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '5511988887777', wa_id: '5511988887777' }],
        messages: [{ id: `wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABEYEjAw${n}` }],
      },
    };
  }
  if (request.method === 'POST' && path.endsWith('/media')) return { status: 200, body: { id: `1037543291${++sent}` } };
  return happyGraph(request);
};

/** A Meta error envelope as Graph sends it. */
export function graphError(
  status: number,
  code: number,
  message: string,
  extra: { type?: string; error_subcode?: number } = {},
): GraphReply {
  return {
    status,
    body: { error: { message, type: extra.type ?? 'OAuthException', code, ...extra, fbtrace_id: 'AZx9fbtraceQ1' } },
  };
}

export interface FakeGraph {
  url: string;
  requests: RecordedGraphRequest[];
  script: GraphScript;
  close(): Promise<void>;
}

export async function startFakeGraph(script: GraphScript = happyGraph): Promise<FakeGraph> {
  const hanging = new Set<() => void>();
  const fake: FakeGraph = { url: '', requests: [], script, close: () => Promise.resolve() };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedGraphRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      fake.requests.push(recorded);
      const reply = fake.script(recorded);
      if (reply === 'hang') {
        hanging.add(() => res.destroy());
        return;
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>(resolve => {
      for (const end of hanging) end();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

/** A loopback URL nothing listens on, so a request to it is refused. */
export async function refusedGraphUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
