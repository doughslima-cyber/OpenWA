import { BadRequestException } from '@nestjs/common';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import {
  EngineStatus,
  type EngineEventCallbacks,
  type IncomingMessage,
  type MediaInput,
} from '../interfaces/whatsapp-engine.interface';
import { MetaCloudAdapter } from './meta-cloud-adapter';
import type { MetaCloudAccountPort, MetaCloudCredentials, MetaCloudProfile } from './meta-cloud-account-store.service';
import { MetaGraphClient } from './meta-cloud-graph.client';
import type { MetaCloudContactPort } from './meta-cloud-chat-store.service';
import { engineCapabilityMatrix } from '../engine-capability-matrix';
import {
  FakeGraph,
  GraphScript,
  RecordedGraphRequest,
  graphError,
  happyGraph,
  refusedGraphUrl,
  startFakeGraph,
} from './__fixtures__/fake-graph-server';

const PHONE_NUMBER_ID = '106540352242922';
const WABA_ID = '102290129340398';
const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-adapter-spec-token';

/** The account rows in memory: one session, its token encrypted elsewhere and handed over in clear. */
class InMemoryAccounts implements MetaCloudAccountPort {
  credentials: MetaCloudCredentials | null = { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN };
  profile: MetaCloudProfile | null = null;

  loadCredentials(): Promise<MetaCloudCredentials | null> {
    return Promise.resolve(this.credentials && { ...this.credentials });
  }
  recordProfile(_sessionId: string, profile: MetaCloudProfile): Promise<void> {
    this.profile = profile;
    return Promise.resolve();
  }
  clearToken(): Promise<void> {
    if (this.credentials) this.credentials.accessToken = null;
    return Promise.resolve();
  }
}

function recordingCallbacks() {
  const calls = {
    onReady: jest.fn<void, [string, string]>(),
    onQRCode: jest.fn<void, [string]>(),
    onStateChanged: jest.fn<void, [EngineStatus]>(),
    onActionRequired: jest.fn<void, [string]>(),
  };
  return { calls, callbacks: calls as EngineEventCallbacks };
}

describe('MetaCloudAdapter', () => {
  let graph: FakeGraph;
  let accounts: InMemoryAccounts;

  const adapterAt = (baseUrl: string): MetaCloudAdapter =>
    new MetaCloudAdapter({
      sessionId: 'sess-cloud',
      dbSessionId: 'sess-cloud',
      accounts,
      graph: new MetaGraphClient(() => ({ baseUrl, version: 'v26.0', timeoutMs: 2000 })),
    });

  beforeEach(async () => {
    graph = await startFakeGraph();
    accounts = new InMemoryAccounts();
  });

  afterEach(async () => {
    await graph.close();
  });

  it('C22 reads the number, subscribes the app once, then reports ready with the digits and the verified name', async () => {
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();
    let requestsAtReady = -1;
    calls.onReady.mockImplementation(() => {
      requestsAtReady = graph.requests.length;
    });

    await adapter.initialize(callbacks);

    expect(graph.requests.map(r => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
      `GET /v26.0/${PHONE_NUMBER_ID}`,
      `POST /v26.0/${WABA_ID}/subscribed_apps`,
    ]);
    expect(graph.requests[0].path).toContain('fields=display_phone_number,verified_name');
    expect(graph.requests.every(r => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.onReady).toHaveBeenCalledTimes(1);
    expect(calls.onReady).toHaveBeenCalledWith('5511999990000', 'Acme');
    // Both calls, the subscription included, are made before the session is reported ready.
    expect(requestsAtReady).toBe(2);
    expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.READY);
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('5511999990000');
    expect(accounts.profile).toEqual({
      displayPhoneNumber: '+55 11 99999-0000',
      verifiedName: 'Acme',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
    });
  });

  it('C24 never calls onQRCode nor reports QR_READY while starting, and getQRCode() is null', async () => {
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();

    await adapter.initialize(callbacks);

    expect(calls.onQRCode).not.toHaveBeenCalled();
    expect(calls.onStateChanged.mock.calls.map(([s]) => s)).not.toContain(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBeNull();
  });

  const tokenRefusals: Array<[number, number, string]> = [
    [190, 401, 'Error validating access token: Session has expired on Tuesday, 07-Oct-26 10:00:00 PDT.'],
    [10, 403, '(#10) Application does not have permission for this action'],
    [200, 403, '(#200) Requires whatsapp_business_messaging permission to manage the object'],
  ];

  it.each(tokenRefusals)(
    'C25 Graph code %i on initialize() moves the session to ACTION_REQUIRED with META_TOKEN_INVALID',
    async (code, status, message) => {
      graph.script = () => graphError(status, code, message);
      const adapter = adapterAt(graph.url);
      const { calls, callbacks } = recordingCallbacks();

      await adapter.initialize(callbacks);

      expect(calls.onActionRequired).toHaveBeenCalledWith('META_TOKEN_INVALID');
      expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.ACTION_REQUIRED);
      expect(adapter.getStatus()).toBe(EngineStatus.ACTION_REQUIRED);
      expect(calls.onReady).not.toHaveBeenCalled();
    },
  );

  it.each(tokenRefusals)(
    'C25 Graph code %i on probeLiveness() moves the session to ACTION_REQUIRED with META_TOKEN_INVALID',
    async (code, status, message) => {
      const adapter = adapterAt(graph.url);
      const { calls, callbacks } = recordingCallbacks();
      await adapter.initialize(callbacks);
      calls.onReady.mockClear();
      graph.script = () => graphError(status, code, message);

      await adapter.probeLiveness();

      expect(calls.onActionRequired).toHaveBeenCalledWith('META_TOKEN_INVALID');
      expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.ACTION_REQUIRED);
      expect(adapter.getStatus()).toBe(EngineStatus.ACTION_REQUIRED);
      expect(calls.onReady).not.toHaveBeenCalled();
    },
  );

  it('C26 with no stored token reports ACTION_REQUIRED with META_TOKEN_MISSING and makes no Graph request', async () => {
    accounts.credentials = { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: null };
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();

    await adapter.initialize(callbacks);

    expect(calls.onActionRequired).toHaveBeenCalledWith('META_TOKEN_MISSING');
    expect(adapter.getStatus()).toBe(EngineStatus.ACTION_REQUIRED);
    expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.ACTION_REQUIRED);
    expect(graph.requests).toHaveLength(0);
    expect(calls.onReady).not.toHaveBeenCalled();
  });

  it('C27 rejects with an EngineTransportError and never reports ready when Graph refuses the connection', async () => {
    const adapter = adapterAt(await refusedGraphUrl());
    const { calls, callbacks } = recordingCallbacks();

    await expect(adapter.initialize(callbacks)).rejects.toBeInstanceOf(EngineTransportError);
    expect(calls.onReady).not.toHaveBeenCalled();
    expect(adapter.getStatus()).not.toBe(EngineStatus.READY);
  });

  it('C27 rejects with an EngineTransportError and never reports ready when Graph answers 500', async () => {
    graph.script = () => ({
      status: 500,
      body: { error: { message: 'An unknown error occurred', type: 'OAuthException', code: 1, fbtrace_id: 'AZx9' } },
    });
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();

    await expect(adapter.initialize(callbacks)).rejects.toBeInstanceOf(EngineTransportError);
    expect(calls.onReady).not.toHaveBeenCalled();
    expect(adapter.getStatus()).not.toBe(EngineStatus.READY);
  });

  it('C28 probeLiveness() is true for a 200', async () => {
    const adapter = adapterAt(graph.url);
    await adapter.initialize(recordingCallbacks().callbacks);

    await expect(adapter.probeLiveness()).resolves.toBe(true);
    expect(graph.requests.at(-1)).toEqual(
      expect.objectContaining({ method: 'GET', path: expect.stringMatching(`^/v26.0/${PHONE_NUMBER_ID}`) as unknown }),
    );
  });

  it('C28 probeLiveness() is false when Graph refuses the connection', async () => {
    const adapter = adapterAt(await refusedGraphUrl());
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it.each([500, 503])('C28 probeLiveness() is false when Graph answers %i', async status => {
    const adapter = adapterAt(graph.url);
    await adapter.initialize(recordingCallbacks().callbacks);
    graph.script = () => ({ status, body: { error: { message: 'Service temporarily unavailable', code: 2 } } });

    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('C34 logout() clears the stored token and reports DISCONNECTED', async () => {
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();
    await adapter.initialize(callbacks);

    await adapter.logout();

    expect(accounts.credentials?.accessToken).toBeNull();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.DISCONNECTED);
  });

  it('answers 501 for a method the Cloud API does not offer, such as a pairing code', async () => {
    const engine = adapterAt(graph.url).asEngine();
    await expect(engine.requestPairingCode('5511999990000')).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
  describe('sends', () => {
    const CHAT = '5511988887777@c.us';
    const WAMID = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABEYEjBBQzM3';
    const MEDIA_ID = '1037543291543636';
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

    /** Starts answered like happyGraph; every message answers WAMID and every upload MEDIA_ID. */
    const sendScript: GraphScript = request => {
      const path = request.path.split('?')[0];
      if (request.method === 'POST' && path.endsWith('/messages')) {
        return { status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: WAMID }] } };
      }
      if (request.method === 'POST' && path.endsWith('/media')) return { status: 200, body: { id: MEDIA_ID } };
      return happyGraph(request);
    };

    /** A READY adapter whose start requests are already cleared from the recording. */
    const readyAdapter = async () => {
      graph.script = sendScript;
      const adapter = adapterAt(graph.url);
      const onMessageCreate = jest.fn<void, [IncomingMessage]>();
      await adapter.initialize({ ...recordingCallbacks().callbacks, onMessageCreate });
      graph.requests.length = 0;
      return { adapter, onMessageCreate };
    };

    const jsonOf = (request: RecordedGraphRequest): Record<string, unknown> =>
      JSON.parse(request.body) as Record<string, unknown>;
    const messageBodies = () =>
      graph.requests.filter(r => r.path.split('?')[0].endsWith('/messages')).map(r => jsonOf(r));

    it('C37 sendTextMessage posts the text body to /v26.0/<PHONE_NUMBER_ID>/messages and returns the wamid', async () => {
      const { adapter } = await readyAdapter();

      const result = await adapter.sendTextMessage(CHAT, 'hi');

      expect(graph.requests.map(r => `${r.method} ${r.path}`)).toEqual([`POST /v26.0/${PHONE_NUMBER_ID}/messages`]);
      expect(graph.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(jsonOf(graph.requests[0])).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511988887777',
        type: 'text',
        text: { body: 'hi', preview_url: false },
      });
      expect(result).toMatchObject({ id: WAMID });
    });

    it('sends preview_url true when the caller asks for a link preview', async () => {
      const { adapter } = await readyAdapter();

      await adapter.sendTextMessage(CHAT, 'see https://example.com', undefined, { linkPreview: true });

      expect(messageBodies()[0]).toMatchObject({ text: { body: 'see https://example.com', preview_url: true } });
    });

    it('answers 501 to a custom link preview and calls no Graph', async () => {
      const { adapter } = await readyAdapter();

      await expect(
        adapter.sendTextMessage(CHAT, 'hi', undefined, {
          customPreview: { title: 'Acme', description: 'd', canonicalUrl: 'https://example.com' },
        } as never),
      ).rejects.toBeInstanceOf(EngineNotSupportedError);
      expect(graph.requests).toEqual([]);
    });

    it('reports a sent message once through onMessageCreate, as the account own outgoing message', async () => {
      const { adapter, onMessageCreate } = await readyAdapter();

      await adapter.sendTextMessage(CHAT, 'hi');

      expect(onMessageCreate).toHaveBeenCalledTimes(1);
      expect(onMessageCreate.mock.calls[0][0]).toMatchObject({
        id: WAMID,
        chatId: CHAT,
        to: CHAT,
        from: '5511999990000@c.us',
        body: 'hi',
        type: 'text',
        fromMe: true,
        isGroup: false,
      });
    });

    it('refuses a chat that is not a phone number with 400 and calls no Graph', async () => {
      const { adapter } = await readyAdapter();

      await expect(adapter.sendTextMessage('120363025246125486@g.us', 'hi')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(graph.requests).toEqual([]);
    });

    it('refuses to send before the session is ready, with the engine-not-ready 409', async () => {
      graph.script = sendScript;
      const adapter = adapterAt(graph.url);

      await expect(adapter.sendTextMessage(CHAT, 'hi')).rejects.toBeInstanceOf(EngineNotReadyError);
      expect(graph.requests).toEqual([]);
    });

    const mediaSends: Array<[string, string, (a: MetaCloudAdapter, media: MediaInput) => Promise<unknown>]> = [
      ['image', 'image', (a, m) => a.sendImageMessage(CHAT, m)],
      ['video', 'video', (a, m) => a.sendVideoMessage(CHAT, m)],
      ['audio', 'audio', (a, m) => a.sendAudioMessage(CHAT, m)],
      ['document', 'document', (a, m) => a.sendDocumentMessage(CHAT, m)],
      ['sticker', 'sticker', (a, m) => a.sendStickerMessage(CHAT, m)],
      ['voice note (PTT)', 'audio', (a, m) => a.sendAudioMessage(CHAT, { ...m, ptt: true })],
    ];

    it.each(mediaSends)(
      'C39 %s uploads multipart to /<PHONE_NUMBER_ID>/media, then sends type %s by the returned id with no link',
      async (_label, type, send) => {
        const { adapter } = await readyAdapter();

        await send(adapter, { mimetype: 'image/png', data: PNG, filename: 'f.bin', caption: 'cap' });

        expect(graph.requests.map(r => `${r.method} ${r.path}`)).toEqual([
          `POST /v26.0/${PHONE_NUMBER_ID}/media`,
          `POST /v26.0/${PHONE_NUMBER_ID}/messages`,
        ]);
        const [upload, message] = graph.requests;
        expect(String(upload.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
        expect(upload.body).toContain('name="messaging_product"');
        expect(upload.body).toContain('name="file"');
        const sent = jsonOf(message);
        expect(sent).toMatchObject({ messaging_product: 'whatsapp', to: '5511988887777', type });
        expect((sent[type] as { id: string }).id).toBe(MEDIA_ID);
        for (const request of graph.requests) {
          expect(request.body).not.toMatch(/"link"|name="link"/);
        }
      },
    );

    it('loads a media URL through the SSRF guard: an internal address is refused and nothing is uploaded', async () => {
      const { adapter } = await readyAdapter();

      await expect(
        adapter.sendImageMessage(CHAT, { mimetype: 'image/png', data: 'http://169.254.169.254/latest/meta-data' }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(graph.requests).toEqual([]);
    });

    it('C41 sendLocationMessage sends type location with latitude, longitude, name and address', async () => {
      const { adapter } = await readyAdapter();

      await adapter.sendLocationMessage(CHAT, {
        latitude: -23.5505,
        longitude: -46.6333,
        description: 'Praca da Se',
        address: 'Se, Sao Paulo - SP',
      });

      expect(messageBodies()).toEqual([
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '5511988887777',
          type: 'location',
          location: { latitude: -23.5505, longitude: -46.6333, name: 'Praca da Se', address: 'Se, Sao Paulo - SP' },
        },
      ]);
    });

    it('C41 sendContactMessage sends type contacts', async () => {
      const { adapter } = await readyAdapter();

      await adapter.sendContactMessage(CHAT, { name: 'Maria Souza', number: '5511977776666' });

      const [sent] = messageBodies();
      expect(sent).toMatchObject({ to: '5511988887777', type: 'contacts' });
      expect(sent.contacts).toEqual([
        {
          name: { formatted_name: 'Maria Souza', first_name: 'Maria Souza' },
          phones: [{ phone: '+5511977776666', wa_id: '5511977776666', type: 'CELL' }],
        },
      ]);
    });

    it('C41 replyToMessage sends the text with context.message_id set to the quoted wamid', async () => {
      const { adapter } = await readyAdapter();
      const quoted = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDMEE';

      await adapter.replyToMessage(CHAT, quoted, 'yes');

      expect(messageBodies()).toEqual([
        expect.objectContaining({
          to: '5511988887777',
          type: 'text',
          text: { body: 'yes', preview_url: false },
          context: { message_id: quoted },
        }),
      ]);
    });

    it('C41 reactToMessage sends type reaction with message_id and emoji', async () => {
      const { adapter, onMessageCreate } = await readyAdapter();
      const target = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDMEE';

      await adapter.reactToMessage(CHAT, target, '👍');

      expect(messageBodies()).toEqual([
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '5511988887777',
          type: 'reaction',
          reaction: { message_id: target, emoji: '👍' },
        },
      ]);
      // A reaction is not a message of its own, so no message.sent follows it.
      expect(onMessageCreate).not.toHaveBeenCalled();
    });
  });

  describe('read side and refusals', () => {
    const CHAT = '5511988887777@c.us';
    const LAST_INBOUND = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFkxBU1RJTkJPVU5E';

    /** The contact rows in memory: the last inbound wamid by wa_id, and every markSeen call. */
    class InMemoryContacts implements Pick<MetaCloudContactPort, 'lastInboundWamid' | 'markSeen'> {
      wamids = new Map<string, string>();
      seen: Array<[string, string, Date]> = [];
      lastInboundWamid(_sessionId: string, waId: string): Promise<string | null> {
        return Promise.resolve(this.wamids.get(waId) ?? null);
      }
      markSeen(sessionId: string, waId: string, at: Date): Promise<void> {
        this.seen.push([sessionId, waId, at]);
        return Promise.resolve();
      }
    }

    let contacts: InMemoryContacts;

    /** A READY adapter on the contact rows above, its start requests cleared from the recording. */
    const readyAdapter = async (): Promise<MetaCloudAdapter> => {
      graph.script = request =>
        request.method === 'POST' && request.path.split('?')[0].endsWith('/messages')
          ? { status: 200, body: { success: true } }
          : happyGraph(request);
      const adapter = new MetaCloudAdapter({
        sessionId: 'sess-cloud',
        dbSessionId: 'sess-cloud',
        accounts,
        contacts: contacts as unknown as MetaCloudContactPort,
        graph: new MetaGraphClient(() => ({ baseUrl: graph.url, version: 'v26.0', timeoutMs: 2000 })),
      });
      await adapter.initialize(recordingCallbacks().callbacks);
      graph.requests.length = 0;
      return adapter;
    };

    beforeEach(() => {
      contacts = new InMemoryContacts();
    });

    it('C73 sendSeen posts status read for the last inbound wamid and records the chat as seen', async () => {
      contacts.wamids.set('5511988887777', LAST_INBOUND);
      const adapter = await readyAdapter();
      const before = Date.now();

      await expect(adapter.sendSeen(CHAT)).resolves.toBe(true);

      expect(graph.requests.map(r => `${r.method} ${r.path}`)).toEqual([`POST /v26.0/${PHONE_NUMBER_ID}/messages`]);
      expect(graph.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(graph.requests[0].body)).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: LAST_INBOUND,
      });
      expect(contacts.seen).toHaveLength(1);
      expect(contacts.seen[0][0]).toBe('sess-cloud');
      expect(contacts.seen[0][1]).toBe('5511988887777');
      expect(contacts.seen[0][2].getTime()).toBeGreaterThanOrEqual(before);
    });

    it('C73 sendSeen on a chat with no inbound message resolves false and calls no Graph', async () => {
      const adapter = await readyAdapter();

      await expect(adapter.sendSeen(CHAT)).resolves.toBe(false);

      expect(graph.requests).toEqual([]);
      expect(contacts.seen).toEqual([]);
    });

    it('C74 sendChatState typing posts status read, the last inbound wamid and typing_indicator text', async () => {
      contacts.wamids.set('5511988887777', LAST_INBOUND);
      const adapter = await readyAdapter();

      await adapter.sendChatState(CHAT, 'typing');

      expect(graph.requests.map(r => `${r.method} ${r.path}`)).toEqual([`POST /v26.0/${PHONE_NUMBER_ID}/messages`]);
      expect(JSON.parse(graph.requests[0].body)).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: LAST_INBOUND,
        typing_indicator: { type: 'text' },
      });
    });

    it('C74 sendChatState typing with no inbound wamid recorded resolves and the fake Graph records zero requests', async () => {
      const adapter = await readyAdapter();

      await expect(adapter.sendChatState(CHAT, 'typing')).resolves.toBeUndefined();

      expect(graph.requests).toHaveLength(0);
    });

    // Every not-available cell of the cloud column, read from the matrix itself, so a cell marked
    // not-available that quietly starts answering fails here as well as in engine-parity.spec.ts.
    const matrix = engineCapabilityMatrix();
    const notAvailable = Object.keys(matrix).filter(method => matrix[method].cloud.status === 'not-available');

    it('C75 the table covers the whole not-available cloud column of the matrix', () => {
      const columnCount = Object.values(matrix).filter(entry => entry.cloud.status === 'not-available').length;
      expect(notAvailable).toHaveLength(columnCount);
      // docs/32 D6 for F2: 26 supported methods out of the interface's, every other one a 501.
      expect(Object.keys(matrix).length - notAvailable.length).toBe(26);
      expect(notAvailable.length).toBe(Object.keys(matrix).length - 26);
    });

    it.each(notAvailable)('C75 %s rejects with EngineNotSupportedError and calls no Graph', async method => {
      const adapter = await readyAdapter();
      const engine = adapter.asEngine() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

      await expect(engine[method](CHAT, 'x')).rejects.toBeInstanceOf(EngineNotSupportedError);
      expect(graph.requests).toEqual([]);
    });
  });
});
