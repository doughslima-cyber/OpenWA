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

import { randomBytes, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { HookManager } from './../src/core/hooks';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Message } from './../src/modules/message/entities/message.entity';
import { WebhookService } from './../src/modules/webhook/webhook.service';
import { MetaCloudAccountStore } from './../src/engine/adapters/meta-cloud-account-store.service';
import { MetaCloudContact } from './../src/engine/adapters/meta-cloud-contact.entity';
import {
  FakeGraph,
  GraphScript,
  RecordedGraphRequest,
  graphError,
  refusedGraphUrl,
  sendingGraph,
  startFakeGraph,
} from './../src/engine/adapters/__fixtures__/fake-graph-server';

/** The account's templates as Graph lists them: one positional, one named, one still pending. */
const GRAPH_TEMPLATES = [
  {
    name: 'order_shipped',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    parameter_format: 'POSITIONAL',
    components: [{ type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} saiu', example: { body_text: [['Ana', '42']] } }],
    id: '900000001',
  },
  {
    name: 'greeting',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'MARKETING',
    parameter_format: 'NAMED',
    components: [
      {
        type: 'BODY',
        text: 'Oi {{first_name}}',
        example: { body_text_named_params: [{ param_name: 'first_name', example: 'Ana' }] },
      },
    ],
    id: '900000002',
  },
  {
    name: 'promo_pending',
    language: 'en_US',
    status: 'PENDING',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Sale!' }],
    id: '900000003',
  },
];

let templateSends = 0;

/** As sendingGraph, plus the template list and a recognisable `wamid` for each template send. */
const templatesGraph: GraphScript = request => {
  const path = request.path.split('?')[0];
  if (request.method === 'GET' && path.endsWith('/message_templates')) {
    return { status: 200, body: { data: GRAPH_TEMPLATES, paging: { cursors: { before: 'a', after: 'b' } } } };
  }
  if (request.method === 'POST' && path.endsWith('/messages') && request.body.includes('"type":"template"')) {
    return {
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '5511988887777', wa_id: '5511988887777' }],
        messages: [{ id: `wamid.TEMPLATE${++templateSends}` }],
      },
    };
  }
  return sendingGraph(request);
};

/**
 * OpenMsg (docs/32 F3): the Cloud API template list, the 24-hour service window and the template send,
 * against a fake Graph (META_GRAPH_BASE_URL). A template send goes through the same pipeline as
 * send-text: plugin gate, idempotency key, chat fence, pending row and one `message.sent`.
 */
describe('Meta Cloud API templates and service window (e2e)', () => {
  let app: INestApplication<App>;
  let messages: Repository<Message>;
  let contacts: Repository<MetaCloudContact>;
  let operatorKey: string;
  let graph: FakeGraph;
  let dispatch: jest.SpyInstance;
  const key = randomBytes(32);
  const ENV = {
    ENGINE_TYPE: 'baileys',
    META_CLOUD_ENABLED: 'true',
    META_CLOUD_ENCRYPTION_KEY: key.toString('base64'),
    SIMULATE_TYPING: 'false',
  };
  const prevEnv: Record<string, string | undefined> = {};

  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-e2e-templates-token-0001';
  const PHONE_NUMBER_ID = '106540352242931';
  const IDLE_PHONE_NUMBER_ID = '106540352242932';
  const WABA_ID = '102290129340398';
  const CHAT = '5511988887777@c.us';

  beforeAll(async () => {
    graph = await startFakeGraph(templatesGraph);
    for (const [name, value] of Object.entries({ ...ENV, META_GRAPH_BASE_URL: graph.url })) {
      prevEnv[name] = process.env[name];
      process.env[name] = value;
    }
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    messages = app.get(getRepositoryToken(Message, 'data'));
    contacts = app.get(getRepositoryToken(MetaCloudContact, 'data'));
    dispatch = jest.spyOn(app.get(WebhookService), 'dispatch');
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-templates', role: ApiKeyRole.OPERATOR }))
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
    graph.script = templatesGraph;
  });

  const http = () => request(app.getHttpServer());
  const get = (path: string) => http().get(path).set('X-API-Key', operatorKey);
  const post = (path: string, body: object) => http().post(path).set('X-API-Key', operatorKey).send(body);
  const sendTemplate = (id: string, body: object) => post(`/api/sessions/${id}/meta/send-template`, body);
  const windowOf = (id: string, chatId: string) =>
    get(`/api/sessions/${id}/meta/chats/${encodeURIComponent(chatId)}/window`);
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /** Waits up to ~5 s for `until` to hold. */
  const eventually = async (until: () => Promise<boolean> | boolean): Promise<void> => {
    for (let i = 0; i < 50 && !(await until()); i++) await pause(100);
  };

  // Sessions created on first use, so each check also runs alone with `-t`.
  let readyId: string | undefined;
  const readyCloudSession = async (): Promise<string> => {
    if (readyId) return readyId;
    const created = await post('/api/sessions', {
      name: `e2e-cloud-templates-${Date.now()}`,
      engine: 'meta-cloud',
      metaCloud: { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN },
    }).expect(201);
    const id = (created.body as { id: string }).id;
    await post(`/api/sessions/${id}/start`, {}).expect(200);
    let status = '';
    await eventually(async () => {
      const res = await get(`/api/sessions/${id}`).expect(200);
      status = (res.body as { status: string }).status;
      return status === 'ready';
    });
    expect(status).toBe('ready');
    readyId = id;
    return id;
  };

  let idleId: string | undefined;
  const idleCloudSession = async (): Promise<string> => {
    if (idleId) return idleId;
    const created = await post('/api/sessions', {
      name: `e2e-cloud-idle-${Date.now()}`,
      engine: 'meta-cloud',
      metaCloud: { phoneNumberId: IDLE_PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN },
    }).expect(201);
    idleId = (created.body as { id: string }).id;
    return idleId;
  };

  let qrId: string | undefined;
  const qrSession = async (): Promise<string> => {
    if (qrId) return qrId;
    const created = await post('/api/sessions', { name: `e2e-qr-${Date.now()}` }).expect(201);
    qrId = (created.body as { id: string }).id;
    return qrId;
  };

  const requestsDuring = async (act: () => Promise<unknown>): Promise<RecordedGraphRequest[]> => {
    const from = graph.requests.length;
    await act();
    return graph.requests.slice(from);
  };

  const messageSends = (requests: RecordedGraphRequest[]) =>
    requests.filter(r => r.method === 'POST' && r.path.split('?')[0].endsWith('/messages'));

  const sentDispatchesFor = (wamid: string): unknown[][] =>
    (dispatch.mock.calls as unknown[][]).filter(
      ([, event, data]) => event === 'message.sent' && (data as { id?: string } | undefined)?.id === wamid,
    );

  it('C23 GET .../meta/templates answers 200 with the Graph templates of the account', async () => {
    const id = await readyCloudSession();

    const res = await get(`/api/sessions/${id}/meta/templates?refresh=true`).expect(200);

    expect(res.body).toEqual({
      templates: GRAPH_TEMPLATES.map(t => ({
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
        parameterFormat: t.parameter_format ?? 'POSITIONAL',
        components: t.components,
      })),
    });
  });

  it('C25 the templates and window routes answer 501 on a NULL-engine session and 404 on an unknown one', async () => {
    const qr = await qrSession();
    const unknown = randomUUID();

    await get(`/api/sessions/${qr}/meta/templates`).expect(501);
    await windowOf(qr, CHAT).expect(501);
    await get(`/api/sessions/${unknown}/meta/templates`).expect(404);
    await windowOf(unknown, CHAT).expect(404);
  });

  it('C26 the templates route maps Graph 190 to 409 META_TOKEN_INVALID, a Graph 500 to 502 and no answer to 503', async () => {
    const id = await readyCloudSession();
    const list = () => get(`/api/sessions/${id}/meta/templates?refresh=true`);

    graph.script = r =>
      r.path.split('?')[0].endsWith('/message_templates') ? graphError(401, 190, 'Token expired') : templatesGraph(r);
    const refused = await list().expect(409);
    expect(refused.body).toMatchObject({ code: 'META_TOKEN_INVALID', metaCode: 190 });

    graph.script = r => (r.path.split('?')[0].endsWith('/message_templates') ? { status: 500 } : templatesGraph(r));
    const upstream = await list().expect(502);
    expect(upstream.body).toMatchObject({ code: 'META_UPSTREAM_ERROR' });

    const previous = process.env.META_GRAPH_BASE_URL;
    process.env.META_GRAPH_BASE_URL = await refusedGraphUrl();
    try {
      await list().expect(503);
    } finally {
      process.env.META_GRAPH_BASE_URL = previous;
    }
  });

  it('C27 the window route answers open, closed and no window from the contact rows', async () => {
    const id = await readyCloudSession();
    const now = Date.now();
    const openAt = new Date(now - (23 * 60 + 59) * 60_000);
    const closedAt = new Date(now - (24 * 60 + 1) * 60_000);
    await contacts.delete({ sessionId: id, waId: '5511900000001' });
    await contacts.delete({ sessionId: id, waId: '5511900000002' });
    await contacts.insert({ sessionId: id, waId: '5511900000001', lastInboundAt: openAt, lastInboundWamid: 'wamid.A' });
    await contacts.insert({
      sessionId: id,
      waId: '5511900000002',
      lastInboundAt: closedAt,
      lastInboundWamid: 'wamid.B',
    });

    const open = await windowOf(id, '5511900000001@c.us').expect(200);
    expect(open.body).toEqual({
      lastInboundAt: openAt.toISOString(),
      open: true,
      closesAt: new Date(openAt.getTime() + 24 * 3_600_000).toISOString(),
    });

    const closed = await windowOf(id, '5511900000002@c.us').expect(200);
    expect(closed.body).toEqual({
      lastInboundAt: closedAt.toISOString(),
      open: false,
      closesAt: new Date(closedAt.getTime() + 24 * 3_600_000).toISOString(),
    });

    const none = await windowOf(id, '5511900000003@c.us').expect(200);
    expect(none.body).toEqual({ lastInboundAt: null, open: false, closesAt: null });
  });

  it('C29 send-template with a positional template answers 201 with the wamid Graph returned', async () => {
    const id = await readyCloudSession();

    let res: request.Response | undefined;
    const requests = await requestsDuring(async () => {
      res = await sendTemplate(id, {
        chatId: CHAT,
        name: 'order_shipped',
        language: 'pt_BR',
        parameters: ['Ana', '42'],
      }).expect(201);
    });

    const sends = messageSends(requests);
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0].body)).toMatchObject({
      type: 'template',
      template: {
        name: 'order_shipped',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: '42' },
            ],
          },
        ],
      },
    });
    expect((res?.body as { messageId: string }).messageId).toBe(`wamid.TEMPLATE${templateSends}`);
  });

  it('C30 stores the rendered body of a positional and a named template and dispatches one message.sent each', async () => {
    const id = await readyCloudSession();

    const cases: Array<[object, string]> = [
      [
        { chatId: CHAT, name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] },
        'Olá Ana, seu pedido 42 saiu',
      ],
      [{ chatId: CHAT, name: 'greeting', language: 'pt_BR', parameters: { first_name: 'Ana' } }, 'Oi Ana'],
    ];
    for (const [body, rendered] of cases) {
      const res = await sendTemplate(id, body).expect(201);
      const wamid = (res.body as { messageId: string }).messageId;
      await eventually(async () => (await messages.findOne({ where: { sessionId: id, waMessageId: wamid } })) !== null);
      await eventually(() => sentDispatchesFor(wamid).length > 0);
      // Room for a second, wrong dispatch to show up before counting.
      await pause(500);

      const rows = await messages.find({ where: { sessionId: id, waMessageId: wamid } });
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe(rendered);
      expect(sentDispatchesFor(wamid)).toHaveLength(1);
    }
  });

  it('C31 a plugin veto refuses as send-text does, an Idempotency-Key replays, and a chat-restricted key gets 403', async () => {
    const id = await readyCloudSession();
    const body = { chatId: CHAT, name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] };

    // A plugin that cancels message:sending.
    const hooks = app.get(HookManager);
    const hookId = hooks.register('e2e-veto', 'message:sending', () => Promise.resolve({ continue: false }));
    try {
      let templateRefusal: request.Response | undefined;
      let textRefusal: request.Response | undefined;
      const vetoed = await requestsDuring(async () => {
        templateRefusal = await sendTemplate(id, body);
        textRefusal = await post(`/api/sessions/${id}/messages/send-text`, { chatId: CHAT, text: 'vetoed' });
      });
      expect(textRefusal?.status).toBe(400);
      expect(templateRefusal?.status).toBe(textRefusal?.status);
      expect(templateRefusal?.body).toEqual(textRefusal?.body);
      expect(vetoed).toEqual([]);
    } finally {
      hooks.unregister(hookId);
    }

    // The same Idempotency-Key twice: one Graph send, the same messageId.
    const idemKey = `e2e-template-${randomUUID()}`;
    const answers: string[] = [];
    const idempotent = await requestsDuring(async () => {
      for (let i = 0; i < 2; i++) {
        const res = await sendTemplate(id, body).set('Idempotency-Key', idemKey).expect(201);
        answers.push((res.body as { messageId: string }).messageId);
      }
    });
    expect(messageSends(idempotent)).toHaveLength(1);
    expect(answers[1]).toBe(answers[0]);

    // A key restricted to another chat.
    const fenced = (
      await app.get(AuthService).createApiKey({
        name: 'e2e-templates-fenced',
        role: ApiKeyRole.OPERATOR,
        allowedChats: ['5511900000099@c.us'],
      })
    ).rawKey;
    const outside = await requestsDuring(() =>
      http().post(`/api/sessions/${id}/meta/send-template`).set('X-API-Key', fenced).send(body).expect(403),
    );
    expect(outside).toEqual([]);
  });

  it('C33 a template send Graph refuses with 132001 answers 400 META_TEMPLATE_INVALID with metaCode', async () => {
    const id = await readyCloudSession();
    graph.script = r =>
      r.method === 'POST' && r.path.split('?')[0].endsWith('/messages')
        ? graphError(400, 132001, 'Template name does not exist in the translation')
        : templatesGraph(r);

    const res = await sendTemplate(id, { chatId: CHAT, name: 'no_such_template', language: 'pt_BR' }).expect(400);

    expect(res.body).toMatchObject({ statusCode: 400, code: 'META_TEMPLATE_INVALID', metaCode: 132001 });
  });

  it('C34 send-template answers 409 before start, 400 for a missing or malformed field, and 501 on a NULL-engine session', async () => {
    const idle = await idleCloudSession();
    const valid = { chatId: CHAT, name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] };

    await sendTemplate(idle, valid).expect(409);

    const id = await readyCloudSession();
    for (const field of ['chatId', 'name', 'language'] as const) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      await sendTemplate(id, body).expect(400);
    }
    await sendTemplate(id, { ...valid, parameters: 42 }).expect(400);

    await sendTemplate(await qrSession(), valid).expect(501);
  });

  it('C54 a key restricted to chat A reaches the window and send-template of A, and gets 403 with no Graph call for B', async () => {
    const id = await readyCloudSession();
    const OTHER = '5511900000098@c.us';
    const fenced = (
      await app.get(AuthService).createApiKey({
        name: 'e2e-templates-chat-a',
        role: ApiKeyRole.OPERATOR,
        allowedChats: [CHAT],
      })
    ).rawKey;
    const windowAs = (chatId: string) =>
      http()
        .get(`/api/sessions/${id}/meta/chats/${encodeURIComponent(chatId)}/window`)
        .set('X-API-Key', fenced);
    const sendAs = (chatId: string) =>
      http()
        .post(`/api/sessions/${id}/meta/send-template`)
        .set('X-API-Key', fenced)
        .send({ chatId, name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] });

    await windowAs(CHAT).expect(200);
    await windowAs(OTHER).expect(403);

    const inside = await requestsDuring(() => sendAs(CHAT).expect(201));
    expect(messageSends(inside)).toHaveLength(1);
    const outside = await requestsDuring(() => sendAs(OTHER).expect(403));
    expect(outside).toEqual([]);
  });

  it('C55 stores the template name when the template list cannot be read, and when it does not hold the template', async () => {
    // A session of its own, so no earlier list read sits in the template cache.
    const created = await post('/api/sessions', {
      name: `e2e-cloud-fallback-${Date.now()}`,
      engine: 'meta-cloud',
      metaCloud: { phoneNumberId: '106540352242933', wabaId: WABA_ID, accessToken: TOKEN },
    }).expect(201);
    const id = (created.body as { id: string }).id;
    await post(`/api/sessions/${id}/start`, {}).expect(200);
    await eventually(async () => ((await get(`/api/sessions/${id}`)).body as { status: string }).status === 'ready');

    const storedBodyOf = async (body: object): Promise<string | undefined> => {
      const res = await sendTemplate(id, body).expect(201);
      const wamid = (res.body as { messageId: string }).messageId;
      await eventually(async () => (await messages.findOne({ where: { sessionId: id, waMessageId: wamid } })) !== null);
      return (await messages.findOne({ where: { sessionId: id, waMessageId: wamid } }))?.body;
    };

    graph.script = r => (r.path.split('?')[0].endsWith('/message_templates') ? { status: 500 } : templatesGraph(r));
    expect(
      await storedBodyOf({ chatId: CHAT, name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] }),
    ).toBe('order_shipped');

    graph.script = templatesGraph;
    expect(await storedBodyOf({ chatId: CHAT, name: 'not_in_the_list', language: 'pt_BR', parameters: ['Ana'] })).toBe(
      'not_in_the_list',
    );
  });

  it('C56 send-template answers 404 on an unknown session id', async () => {
    await sendTemplate(randomUUID(), {
      chatId: CHAT,
      name: 'order_shipped',
      language: 'pt_BR',
      parameters: ['Ana', '42'],
    }).expect(404);
  });

  it('C56 send-template answers 429 META_RATE_LIMITED after Graph throttles three attempts with 130429', async () => {
    const id = await readyCloudSession();
    graph.script = r =>
      r.method === 'POST' && r.path.split('?')[0].endsWith('/messages')
        ? graphError(400, 130429, 'Rate limit hit')
        : templatesGraph(r);

    let res: request.Response | undefined;
    const requests = await requestsDuring(async () => {
      res = await sendTemplate(id, {
        chatId: CHAT,
        name: 'order_shipped',
        language: 'pt_BR',
        parameters: ['Ana', '42'],
      });
    });

    expect(res?.status).toBe(429);
    expect(res?.body).toMatchObject({ code: 'META_RATE_LIMITED', metaCode: 130429 });
    expect(messageSends(requests)).toHaveLength(3);
  }, 30_000);

  it('C56 send-template answers 502 META_UPSTREAM_ERROR on a Graph 500 and 503 when Graph does not answer', async () => {
    const id = await readyCloudSession();
    const body = { chatId: CHAT, name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] };

    graph.script = r =>
      r.method === 'POST' && r.path.split('?')[0].endsWith('/messages') ? { status: 500 } : templatesGraph(r);
    const upstream = await sendTemplate(id, body).expect(502);
    expect(upstream.body).toMatchObject({ code: 'META_UPSTREAM_ERROR' });

    const previous = process.env.META_GRAPH_BASE_URL;
    process.env.META_GRAPH_BASE_URL = await refusedGraphUrl();
    try {
      await sendTemplate(id, body).expect(503);
    } finally {
      process.env.META_GRAPH_BASE_URL = previous;
    }
  });

  it('C56 the templates route answers 409 on a Cloud session whose stored token is NULL', async () => {
    const created = await post('/api/sessions', {
      name: `e2e-cloud-tokenless-${Date.now()}`,
      engine: 'meta-cloud',
      metaCloud: { phoneNumberId: '106540352242934', wabaId: WABA_ID, accessToken: TOKEN },
    }).expect(201);
    const id = (created.body as { id: string }).id;
    // What logout leaves behind (MetaCloudAdapter.logout), and a restore that carried no token.
    await app.get(MetaCloudAccountStore, { strict: false }).clearToken(id);

    const requests = await requestsDuring(async () => {
      const res = await get(`/api/sessions/${id}/meta/templates?refresh=true`).expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: 'The Cloud API session has no usable access token. Set one and restart it.',
      });
    });
    expect(requests).toEqual([]);
  });
});
