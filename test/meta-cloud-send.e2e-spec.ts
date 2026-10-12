// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));
// Stub the heavy Baileys lib: no QR session is started here; Cloud sessions talk to a fake Graph.
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  fetchLatestBaileysVersion: jest.fn(),
  getContentType: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomBytes } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Message } from './../src/modules/message/entities/message.entity';
import { WebhookService } from './../src/modules/webhook/webhook.service';
import {
  FakeGraph,
  RecordedGraphRequest,
  graphError,
  sendingGraph,
  startFakeGraph,
} from './../src/engine/adapters/__fixtures__/fake-graph-server';

/**
 * OpenMsg (docs/32): sends on a Cloud API session reach Graph (a fake one, META_GRAPH_BASE_URL) through
 * the existing send routes. The answer carries Meta's `wamid`, the row stores it, and the projector
 * dispatches one `message.sent`. Send pacing is on with a daily cap of 1, which a Cloud session ignores.
 */
describe('Meta Cloud API sends (e2e)', () => {
  let app: INestApplication<App>;
  let messages: Repository<Message>;
  let operatorKey: string;
  let graph: FakeGraph;
  let dispatch: jest.SpyInstance;
  const key = randomBytes(32);
  const ENV = {
    ENGINE_TYPE: 'baileys',
    META_CLOUD_ENABLED: 'true',
    META_CLOUD_ENCRYPTION_KEY: key.toString('base64'),
    SEND_PACING_ENABLED: 'true',
    SEND_PACING_WARMUP_SCHEDULE: '1',
    SIMULATE_TYPING: 'false',
  };
  const prevEnv: Record<string, string | undefined> = {};

  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-e2e-send-token-0001';
  const PHONE_NUMBER_ID = '106540352242923';
  const WABA_ID = '102290129340398';
  const CHAT = '5511988887777@c.us';
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

  beforeAll(async () => {
    graph = await startFakeGraph(sendingGraph);
    for (const [name, value] of Object.entries({ ...ENV, META_GRAPH_BASE_URL: graph.url })) {
      prevEnv[name] = process.env[name];
      process.env[name] = value;
    }
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    messages = app.get(getRepositoryToken(Message, 'data'));
    dispatch = jest.spyOn(app.get(WebhookService), 'dispatch');
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-send', role: ApiKeyRole.OPERATOR }))
      .rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
    await graph?.close();
    for (const [name, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    graph.script = sendingGraph;
  });

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object) => http().post(path).set('X-API-Key', operatorKey).send(body);
  const send = (id: string, verb: string, body: object) => post(`/api/sessions/${id}/messages/${verb}`, body);
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /** Waits up to ~5 s for `until` to hold. */
  const eventually = async (until: () => Promise<boolean> | boolean): Promise<void> => {
    for (let i = 0; i < 50 && !(await until()); i++) await pause(100);
  };

  // One READY Cloud session, created and started on first use, so each check also runs alone with `-t`.
  let sessionId: string | undefined;
  const readyCloudSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await post('/api/sessions', {
      name: `e2e-cloud-send-${Date.now()}`,
      engine: 'meta-cloud',
      metaCloud: { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN },
    }).expect(201);
    const id = (created.body as { id: string }).id;
    await post(`/api/sessions/${id}/start`, {}).expect(200);
    let status = '';
    await eventually(async () => {
      const res = await http().get(`/api/sessions/${id}`).set('X-API-Key', operatorKey).expect(200);
      status = (res.body as { status: string }).status;
      return status === 'ready';
    });
    expect(status).toBe('ready');
    sessionId = id;
    return id;
  };

  /** The Graph requests made by `act`, without the method or query noise. */
  const requestsDuring = async (act: () => Promise<unknown>): Promise<RecordedGraphRequest[]> => {
    const from = graph.requests.length;
    await act();
    return graph.requests.slice(from);
  };

  const sentDispatchesFor = (wamid: string): unknown[][] =>
    (dispatch.mock.calls as unknown[][]).filter(
      ([, event, data]) => event === 'message.sent' && (data as { id?: string } | undefined)?.id === wamid,
    );

  it('C38 send-text answers the wamid, stores it as sent, and dispatches exactly one message.sent', async () => {
    const id = await readyCloudSession();

    let wamid = '';
    const requests = await requestsDuring(async () => {
      const res = await send(id, 'send-text', { chatId: CHAT, text: 'hello from the Cloud API' }).expect(201);
      wamid = (res.body as { messageId: string }).messageId;
    });

    const answered = requests.filter(r => r.path.split('?')[0] === `/v26.0/${PHONE_NUMBER_ID}/messages`);
    expect(answered).toHaveLength(1);
    expect(wamid).toMatch(/^wamid\./);
    await eventually(async () => (await messages.findOne({ where: { sessionId: id, waMessageId: wamid } })) !== null);
    await eventually(() => sentDispatchesFor(wamid).length > 0);
    // Room for a second, wrong dispatch to show up before counting.
    await pause(500);

    const rows = await messages.find({ where: { sessionId: id, waMessageId: wamid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(sentDispatchesFor(wamid)).toHaveLength(1);
  });

  it('C40 send-image reaches Graph as one /media upload followed by one /messages call', async () => {
    const id = await readyCloudSession();

    const requests = await requestsDuring(() =>
      send(id, 'send-image', { chatId: CHAT, base64: PNG, mimetype: 'image/png', caption: 'a pixel' }).expect(201),
    );

    expect(requests.map(r => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
      `POST /v26.0/${PHONE_NUMBER_ID}/media`,
      `POST /v26.0/${PHONE_NUMBER_ID}/messages`,
    ]);
    expect(String(requests[0].headers['content-type'])).toMatch(/^multipart\/form-data/);
    expect(JSON.parse(requests[1].body)).toMatchObject({ type: 'image', image: { caption: 'a pixel' } });
  });

  it('C43 with SEND_PACING_ENABLED=true and a daily cap of 1, two send-text calls both answer 201', async () => {
    const id = await readyCloudSession();

    await send(id, 'send-text', { chatId: CHAT, text: 'first of the day' }).expect(201);
    await send(id, 'send-text', { chatId: CHAT, text: 'second of the day' }).expect(201);
  });

  it('C45 send-text against a Graph answering 131047 returns 409 META_OUTSIDE_SERVICE_WINDOW with metaCode', async () => {
    const id = await readyCloudSession();
    graph.script = r =>
      r.path.split('?')[0].endsWith('/messages')
        ? graphError(400, 131047, 'Re-engagement message', { type: 'OAuthException' })
        : sendingGraph(r);

    const res = await send(id, 'send-text', { chatId: CHAT, text: 'too late' }).expect(409);

    expect(res.body).toMatchObject({ code: 'META_OUTSIDE_SERVICE_WINDOW', metaCode: 131047 });
    expect(res.body).toHaveProperty('fbtraceId', 'AZx9fbtraceQ1');
  });

  /** Every 8-character run of `token` found in `text`. */
  const tokenRunsIn = (text: string, token: string): string[] => {
    const found: string[] = [];
    for (let i = 0; i + 8 <= token.length; i++) {
      if (text.includes(token.slice(i, i + 8))) found.push(token.slice(i, i + 8));
    }
    return found;
  };

  it('C87 no message.* webhook payload dispatched for a Cloud send carries the token or an 8-character run of it', async () => {
    const id = await readyCloudSession();
    const res = await send(id, 'send-text', { chatId: CHAT, text: 'no secrets here' }).expect(201);
    const wamid = (res.body as { messageId: string }).messageId;
    await eventually(() => sentDispatchesFor(wamid).length > 0);

    const payloads = (dispatch.mock.calls as unknown[][]).filter(
      ([sid, event]) => sid === id && String(event).startsWith('message.'),
    );
    expect(sentDispatchesFor(wamid)).toHaveLength(1);
    for (const [, event, data] of payloads) {
      expect({ event, runs: tokenRunsIn(JSON.stringify(data), TOKEN) }).toEqual({ event, runs: [] });
    }
  });

  it('C89 after a Meta 4xx refusal the same Idempotency-Key is admitted again; after a 502 it is IDEMPOTENCY_OUTCOME_UNKNOWN', async () => {
    const id = await readyCloudSession();
    const failMessagesWith = (status: number, code: number) => {
      graph.script = r =>
        r.path.split('?')[0].endsWith('/messages') ? graphError(status, code, 'Graph refused') : sendingGraph(r);
    };
    const sendWithKey = (key: string, text: string) =>
      send(id, 'send-text', { chatId: CHAT, text }).set('Idempotency-Key', key);

    const refusedKey = `c89-refused-${Date.now()}`;
    failMessagesWith(400, 131047);
    await sendWithKey(refusedKey, 'refused by Meta').expect(409);
    graph.script = sendingGraph;
    const retried = await sendWithKey(refusedKey, 'refused by Meta').expect(201);
    expect((retried.body as { messageId: string }).messageId).toMatch(/^wamid\./);

    const upstreamKey = `c89-upstream-${Date.now()}`;
    failMessagesWith(500, 2);
    const upstream = await sendWithKey(upstreamKey, 'unknown outcome').expect(502);
    expect((upstream.body as { code?: string }).code).toBe('META_UPSTREAM_ERROR');
    graph.script = sendingGraph;
    const unknown = await sendWithKey(upstreamKey, 'unknown outcome').expect(409);
    expect((unknown.body as { code?: string }).code).toBe('IDEMPOTENCY_OUTCOME_UNKNOWN');
  });
});
