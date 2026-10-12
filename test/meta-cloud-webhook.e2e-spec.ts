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

import { createHmac, randomBytes } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Message, MessageStatus } from './../src/modules/message/entities/message.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { WebhookService } from './../src/modules/webhook/webhook.service';
import { MetaCloudWebhookRouter } from './../src/modules/meta-cloud/meta-cloud-router.service';
import { MetaCloudContact } from './../src/engine/adapters/meta-cloud-contact.entity';
import { FakeGraph, sendingGraph, startFakeGraph } from './../src/engine/adapters/__fixtures__/fake-graph-server';
import {
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_PROFILE_NAME,
  FIXTURE_WA_ID,
  INBOUND_MESSAGES,
  STATUSES,
  messagesBody,
  messagesValue,
  webhookBody,
} from './../src/engine/adapters/__fixtures__/meta-cloud-webhooks';

/**
 * OpenMsg (docs/32): Meta's callbacks reach a Cloud API session through /api/meta-webhook. The app is
 * built as main.ts builds it (configureApp), so the HMAC is checked over the raw bytes it keeps, and the
 * global `short` throttle tier is at its production default of 10 per second.
 */
describe('Meta Cloud API webhook (e2e)', () => {
  let app: INestApplication<App>;
  let messages: Repository<Message>;
  let sessions: Repository<Session>;
  let contacts: Repository<MetaCloudContact>;
  let operatorKey: string;
  let graph: FakeGraph;
  let dispatch: jest.SpyInstance;
  let routed: jest.SpyInstance;
  const key = randomBytes(32);
  const APP_SECRET = 'e2e-meta-app-secret-6b1f0c2d9e8a';
  const VERIFY_TOKEN = 'e2e-meta-verify-token-41c9';
  const ENV = {
    ENGINE_TYPE: 'baileys',
    META_CLOUD_ENABLED: 'true',
    META_CLOUD_ENCRYPTION_KEY: key.toString('base64'),
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    RATE_LIMIT_SHORT_LIMIT: '10',
    SIMULATE_TYPING: 'false',
  };
  const prevEnv: Record<string, string | undefined> = {};

  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-e2e-webhook-token-01';
  const CHAT = `${FIXTURE_WA_ID}@c.us`;

  beforeAll(async () => {
    graph = await startFakeGraph(sendingGraph);
    for (const [name, value] of Object.entries({ ...ENV, META_GRAPH_BASE_URL: graph.url })) {
      prevEnv[name] = process.env[name];
      process.env[name] = value;
    }
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // As main.ts: no Nest body parser, configureApp installs the parsers that keep req.rawBody.
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app, { dashboard: { distDir: '/nonexistent', enabled: false } });
    applyGlobalValidation(app);
    await app.init();

    messages = app.get(getRepositoryToken(Message, 'data'));
    sessions = app.get(getRepositoryToken(Session, 'data'));
    contacts = app.get(getRepositoryToken(MetaCloudContact, 'data'));
    dispatch = jest.spyOn(app.get(WebhookService), 'dispatch');
    routed = jest.spyOn(app.get(MetaCloudWebhookRouter), 'handle');
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-webhook', role: ApiKeyRole.OPERATOR }))
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

  const http = () => request(app.getHttpServer());
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  /** Waits up to ~5 s for `until` to hold. */
  const eventually = async (until: () => Promise<boolean> | boolean): Promise<void> => {
    for (let i = 0; i < 50 && !(await until()); i++) await pause(100);
  };

  /** Posts `body` signed with `secret` (or with no signature when `secret` is null). */
  const postWebhook = (body: unknown, secret: string | null = APP_SECRET) => {
    const raw = JSON.stringify(body);
    const req = http().post('/api/meta-webhook').set('Content-Type', 'application/json');
    return (secret === null ? req : req.set('X-Hub-Signature-256', sign(raw, secret))).send(raw);
  };

  /** Router runs at the start of the current test; routerIdle waits for the ones started since. */
  let runsAtStart = 0;
  beforeEach(() => {
    runsAtStart = routed.mock.calls.length;
  });

  /** Waits until `runs` router runs started in this test, then settles them: delivery follows the 200. */
  const routerIdle = async (runs = 1): Promise<void> => {
    await eventually(() => routed.mock.results.length >= runsAtStart + runs);
    await Promise.all(routed.mock.results.map(r => r.value as Promise<void>));
  };

  const dispatchesOf = (event: string, match: (data: Record<string, unknown>) => boolean): unknown[][] =>
    (dispatch.mock.calls as unknown[][]).filter(
      ([, name, data]) => name === event && match((data ?? {}) as Record<string, unknown>),
    );

  // One READY Cloud session on the fixtures' number, created on first use, so each check runs alone with `-t`.
  // Its state is polled from the database, not over HTTP: the `short` tier allows 10 API calls a second.
  let sessionId: string | undefined;
  const readyCloudSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await http()
      .post('/api/sessions')
      .set('X-API-Key', operatorKey)
      .send({
        name: `e2e-cloud-webhook-${Date.now()}`,
        engine: 'meta-cloud',
        metaCloud: { phoneNumberId: FIXTURE_PHONE_NUMBER_ID, wabaId: '102290129340399', accessToken: TOKEN },
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await http().post(`/api/sessions/${id}/start`).set('X-API-Key', operatorKey).send({}).expect(200);
    let status = '';
    await eventually(async () => {
      status = (await sessions.findOneByOrFail({ id })).status;
      return status === 'ready';
    });
    expect(status).toBe('ready');
    sessionId = id;
    return id;
  };

  /** A sent Cloud message (its row at `sent`), as the S3 send path stores it; answers the wamid. */
  const sentMessage = async (id: string): Promise<string> => {
    const res = await http()
      .post(`/api/sessions/${id}/messages/send-text`)
      .set('X-API-Key', operatorKey)
      .send({ chatId: CHAT, text: 'your order shipped' })
      .expect(201);
    const wamid = (res.body as { messageId: string }).messageId;
    await eventually(
      async () => (await messages.findOneBy({ sessionId: id, waMessageId: wamid }))?.status === MessageStatus.SENT,
    );
    return wamid;
  };

  const statusFor = (wamid: string, status: keyof typeof STATUSES) =>
    messagesBody(messagesValue({ statuses: [{ ...STATUSES[status], id: wamid }] }));

  const rowStatus = async (id: string, wamid: string) =>
    (await messages.findOneByOrFail({ sessionId: id, waMessageId: wamid })).status;

  it('C49 the verify handshake answers 200 with the challenge as text/plain', async () => {
    const res = await http()
      .get('/api/meta-webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('1158201444');
  });

  it('C50 a verify with mode unsubscribe, a wrong token, or no token configured answers 403', async () => {
    const verify = (mode: string, token: string) =>
      http().get('/api/meta-webhook').query({ 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': '42' });

    await verify('unsubscribe', VERIFY_TOKEN).expect(403);
    await verify('subscribe', 'not-the-verify-token').expect(403);
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    try {
      await verify('subscribe', VERIFY_TOKEN).expect(403);
    } finally {
      process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
    }
  });

  it('C52 an unsigned POST and one signed with another secret answer 401 and dispatch nothing', async () => {
    await readyCloudSession();
    const body = messagesBody(messagesValue({ messages: [{ ...INBOUND_MESSAGES.text, id: 'wamid.C52-unsigned' }] }));
    const runsBefore = routed.mock.calls.length;
    const dispatchesBefore = dispatch.mock.calls.length;

    await postWebhook(body, null).expect(401);
    await postWebhook(body, 'some-other-app-secret-000000000').expect(401);
    await pause(300);

    expect(routed.mock.calls.length).toBe(runsBefore);
    expect(dispatch.mock.calls.length).toBe(dispatchesBefore);
  });

  it('C56 30 signed POSTs from one client within one second all answer 200', async () => {
    const empty = webhookBody();

    const started = Date.now();
    const answers = await Promise.all(Array.from({ length: 30 }, () => postWebhook(empty)));
    const elapsed = Date.now() - started;

    expect(answers.map(a => a.status)).toEqual(Array<number>(30).fill(200));
    expect(elapsed).toBeLessThan(1000);
  });

  it('C57 a signed inbound text leads to one message.received with the wamid, @c.us ids, the text and the sender name', async () => {
    const id = await readyCloudSession();
    const text = INBOUND_MESSAGES.text;
    const wamid = text.id as string;
    const received = () => dispatchesOf('message.received', d => d.id === wamid);

    await postWebhook(messagesBody(messagesValue({ messages: [text] }))).expect(200);
    await routerIdle();
    await eventually(() => received().length > 0);
    await pause(300);

    expect(received()).toHaveLength(1);
    const [sid, , payload] = received()[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe(id);
    expect(payload).toMatchObject({
      id: wamid,
      chatId: '5511988887777@c.us',
      from: '5511988887777@c.us',
      body: 'Hello, is the order ready?',
    });
    expect(payload.contact).toMatchObject({ pushName: FIXTURE_PROFILE_NAME });
    expect(await contacts.findOneBy({ sessionId: id, waId: FIXTURE_WA_ID })).toMatchObject({
      profileName: FIXTURE_PROFILE_NAME,
    });
  });

  it('C60 a signed reaction leads to one message.reaction for the reacted wamid with the emoji', async () => {
    await readyCloudSession();
    const reacted = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxURABIYEjAwMDAwMDAwMDAwMDAwMDBDNjAA';
    const reaction = {
      ...INBOUND_MESSAGES.reaction,
      id: 'wamid.C60-reaction',
      reaction: { message_id: reacted, emoji: '❤️' },
    };
    const reactions = () => dispatchesOf('message.reaction', d => d.messageId === reacted);

    await postWebhook(messagesBody(messagesValue({ messages: [reaction] }))).expect(200);
    await routerIdle();
    await eventually(() => reactions().length > 0);
    await pause(300);

    expect(reactions()).toHaveLength(1);
    expect(reactions()[0][2]).toMatchObject({ messageId: reacted, reaction: '❤️', chatId: CHAT });
  });

  it('C62 after a send, a signed delivered status leads to one message.ack with delivered and the row at delivered', async () => {
    const id = await readyCloudSession();
    const wamid = await sentMessage(id);
    const acks = () => dispatchesOf('message.ack', d => d.id === wamid);

    await postWebhook(statusFor(wamid, 'delivered')).expect(200);
    await routerIdle();
    await eventually(async () => acks().length > 0 && (await rowStatus(id, wamid)) === MessageStatus.DELIVERED);
    await pause(300);

    expect(acks()).toHaveLength(1);
    expect(acks()[0][2]).toMatchObject({ id: wamid, status: 'delivered', chatId: CHAT });
    expect(await rowStatus(id, wamid)).toBe('delivered');
  });

  it('C63 a signed failed status with errors[0].code 131026 sets the row to failed and dispatches one message.failed with it', async () => {
    const id = await readyCloudSession();
    const wamid = await sentMessage(id);
    const failures = () => dispatchesOf('message.failed', d => d.id === wamid);

    await postWebhook(statusFor(wamid, 'failed')).expect(200);
    await routerIdle();
    await eventually(async () => failures().length > 0 && (await rowStatus(id, wamid)) === MessageStatus.FAILED);
    await pause(300);

    expect(failures()).toHaveLength(1);
    expect(failures()[0][2]).toMatchObject({ id: wamid, status: 'failed', errorCode: 131026 });
    expect(await rowStatus(id, wamid)).toBe('failed');
  });

  it('C64 the same signed inbound posted twice leaves one messages row and one message.received', async () => {
    const id = await readyCloudSession();
    const wamid = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFkM2NERVUExJQ0FURQA=';
    const body = messagesBody(
      messagesValue({ messages: [{ ...INBOUND_MESSAGES.text, id: wamid, text: { body: 'twice' } }] }),
    );
    const received = () => dispatchesOf('message.received', d => d.id === wamid);

    await postWebhook(body).expect(200);
    await postWebhook(body).expect(200);
    await routerIdle(2);
    await eventually(
      async () => received().length > 0 && (await messages.countBy({ sessionId: id, waMessageId: wamid })) > 0,
    );
    await pause(500);

    expect(await messages.countBy({ sessionId: id, waMessageId: wamid })).toBe(1);
    expect(received()).toHaveLength(1);
  });

  it('C65 a read status posted before the delivered one leaves the row at read', async () => {
    const id = await readyCloudSession();
    const wamid = await sentMessage(id);
    const acks = () => dispatchesOf('message.ack', d => d.id === wamid);

    await postWebhook(statusFor(wamid, 'read')).expect(200);
    await routerIdle();
    await eventually(async () => (await rowStatus(id, wamid)) === MessageStatus.READ);
    await postWebhook(statusFor(wamid, 'delivered')).expect(200);
    await routerIdle(2);
    await eventually(() => acks().length === 2);
    // The late ack's guarded update, and its one retry after ACK_RECONCILE_DELAY_MS (750 ms), must find nothing to advance.
    await pause(1000);

    expect(acks().map(([, , d]) => (d as { status: string }).status)).toEqual(['read', 'delivered']);
    expect(await rowStatus(id, wamid)).toBe('read');
  });

  it('C66 a signed body for a phone_number_id no live session holds answers 200, dispatches nothing and logs the drop', async () => {
    await readyCloudSession();
    const router = app.get(MetaCloudWebhookRouter);
    const warn = jest.spyOn((router as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger, 'warn');
    const wamid = 'wamid.C66-unknown-number';
    const body = messagesBody(messagesValue({ messages: [{ ...INBOUND_MESSAGES.text, id: wamid }] }, '999000999000'));
    const dispatchesBefore = dispatch.mock.calls.length;

    await postWebhook(body).expect(200);
    await routerIdle();

    expect(dispatch.mock.calls.length).toBe(dispatchesBefore);
    expect(warn.mock.calls.some(([message]) => String(message).includes('999000999000'))).toBe(true);
    warn.mockRestore();
  });

  it('C87 no message.* payload dispatched for sent, received, ack and failed carries the token or an 8-character run of it', async () => {
    const id = await readyCloudSession();
    const delivered = await sentMessage(id);
    const failed = await sentMessage(id);
    const inbound = { ...INBOUND_MESSAGES.text, id: 'wamid.C87-inbound', text: { body: 'C87 inbound' } };

    await postWebhook(messagesBody(messagesValue({ messages: [inbound] }))).expect(200);
    await postWebhook(statusFor(delivered, 'delivered')).expect(200);
    await postWebhook(statusFor(failed, 'failed')).expect(200);
    await routerIdle(3);
    await eventually(
      () =>
        dispatchesOf('message.received', d => d.id === inbound.id).length > 0 &&
        dispatchesOf('message.ack', d => d.id === delivered).length > 0 &&
        dispatchesOf('message.failed', d => d.id === failed).length > 0,
    );

    const payloads = (dispatch.mock.calls as unknown[][]).filter(
      ([sid, event]) => sid === id && String(event).startsWith('message.'),
    );
    const events = new Set(payloads.map(([, event]) => event));
    for (const event of ['message.sent', 'message.received', 'message.ack', 'message.failed']) {
      expect(events.has(event)).toBe(true);
    }
    for (const [, event, data] of payloads) {
      const text = JSON.stringify(data);
      const runs: string[] = [];
      for (let i = 0; i + 8 <= TOKEN.length; i++)
        if (text.includes(TOKEN.slice(i, i + 8))) runs.push(TOKEN.slice(i, i + 8));
      expect({ event, runs }).toEqual({ event, runs: [] });
    }
  });

  it('C70 after the C57 inbound message, GET .../chats returns one chat for the sender with unreadCount 1', async () => {
    const id = await readyCloudSession();
    // A clean slate for this session, so the count does not depend on which checks ran before.
    await messages.delete({ sessionId: id });
    await contacts.delete({ sessionId: id });
    const wamid = INBOUND_MESSAGES.text.id as string;

    await postWebhook(messagesBody(messagesValue({ messages: [INBOUND_MESSAGES.text] }))).expect(200);
    await routerIdle();
    await eventually(async () => (await messages.countBy({ sessionId: id, waMessageId: wamid })) === 1);

    const res = await http().get(`/api/sessions/${id}/chats`).set('X-API-Key', operatorKey).expect(200);

    const chats = res.body as Array<{ id: string; unreadCount: number; name: string; lastMessage: string }>;
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      id: '5511988887777@c.us',
      unreadCount: 1,
      name: FIXTURE_PROFILE_NAME,
      lastMessage: 'Hello, is the order ready?',
    });
  });
});
