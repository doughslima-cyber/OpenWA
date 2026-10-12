import * as inboundMediaCap from './inbound-media-cap';
import { MetaCloudAdapter } from './meta-cloud-adapter';
import type { MetaCloudAccountPort } from './meta-cloud-account-store.service';
import { MetaGraphClient } from './meta-cloud-graph.client';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { FakeGraph, startFakeGraph } from './__fixtures__/fake-graph-server';
import { INBOUND_MESSAGES, messagesValue } from './__fixtures__/meta-cloud-webhooks';

describe('Cloud API inbound media', () => {
  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-media-spec-token';
  const MEDIA_ID = (INBOUND_MESSAGES.image.image as { id: string }).id;
  const BYTES = Buffer.from('ffd8ffe000104a46494600010101004800480000ffdb004300', 'hex');
  const prevMax = process.env.MEDIA_DOWNLOAD_MAX_BYTES;

  let graph: FakeGraph;
  let fileSize: number;

  beforeAll(async () => {
    graph = await startFakeGraph(request => {
      const path = request.path.split('?')[0];
      if (path === `/v26.0/${MEDIA_ID}`) {
        return {
          status: 200,
          body: {
            messaging_product: 'whatsapp',
            url: `${graph.url}/lookaside/whatsapp_business/attachments/?mid=${MEDIA_ID}`,
            mime_type: 'image/jpeg',
            sha256: 'K3bY9oSZ5gRj4X2b1u4zq8D1W1u0kWw7c7gPGG0Q0aQ=',
            file_size: fileSize,
            id: MEDIA_ID,
          },
        };
      }
      if (path === '/lookaside/whatsapp_business/attachments/') {
        return { status: 200, raw: BYTES, contentType: 'image/jpeg' };
      }
      return { status: 404, body: { error: { message: 'unknown path', code: 100 } } };
    });
  });

  afterAll(async () => {
    await graph.close();
    if (prevMax === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    else process.env.MEDIA_DOWNLOAD_MAX_BYTES = prevMax;
  });

  beforeEach(() => {
    graph.requests.length = 0;
    fileSize = BYTES.length;
    delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
  });

  afterEach(() => jest.restoreAllMocks());

  /** Hands the image fixture to an adapter pointed at the fake Graph; answers the delivered message. */
  async function deliverImage(): Promise<IncomingMessage> {
    const accounts: MetaCloudAccountPort = {
      loadCredentials: jest
        .fn()
        .mockResolvedValue({ phoneNumberId: '106540352242924', wabaId: 'w', accessToken: TOKEN }),
      recordProfile: jest.fn(),
      clearToken: jest.fn(),
    };
    const adapter = new MetaCloudAdapter({
      sessionId: 's',
      dbSessionId: 'db-s',
      accounts,
      graph: new MetaGraphClient(() => ({ baseUrl: graph.url, version: 'v26.0', timeoutMs: 5000 })),
    });
    const onMessage = jest.fn<void, [IncomingMessage]>();
    (adapter as unknown as { callbacks: object }).callbacks = { onMessage };

    await adapter.handleWebhookChange(messagesValue({ messages: [INBOUND_MESSAGES.image] }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    return onMessage.mock.calls[0][0];
  }

  it('C59 fetches GET /<MEDIA_ID> and then the returned URL, both with the bearer token', async () => {
    const message = await deliverImage();

    expect(graph.requests.map(r => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
      `GET /v26.0/${MEDIA_ID}`,
      'GET /lookaside/whatsapp_business/attachments/',
    ]);
    for (const request of graph.requests) expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(message.media).toEqual({ mimetype: 'image/jpeg', data: BYTES.toString('base64') });
  });

  it('C59 an image whose file_size exceeds MEDIA_DOWNLOAD_MAX_BYTES is delivered without a download, through capInboundMedia', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
    fileSize = 5 * 1024 * 1024;
    const cap = jest.spyOn(inboundMediaCap, 'capInboundMedia');

    const message = await deliverImage();

    expect(graph.requests.map(r => r.path.split('?')[0])).toEqual([`/v26.0/${MEDIA_ID}`]);
    expect(cap).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: fileSize, maxBytes: 1024 }));
    expect(message.media).toEqual({ mimetype: 'image/jpeg', omitted: true, sizeBytes: fileSize });
    expect(message.type).toBe('image');
  });

  it('C59 a file larger than it declared is dropped mid-download and delivered as omitted', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '8';
    fileSize = 4;

    const message = await deliverImage();

    expect(graph.requests).toHaveLength(2);
    expect(message.media).toMatchObject({ mimetype: 'image/jpeg', omitted: true });
    expect(message.media?.data).toBeUndefined();
  });
});
