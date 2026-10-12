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
import { Session } from './../src/modules/session/entities/session.entity';
import { MetaCloudAccount } from './../src/engine/adapters/meta-cloud-account.entity';
import { MetaCloudContact } from './../src/engine/adapters/meta-cloud-contact.entity';
import { decryptMetaToken } from './../src/engine/adapters/meta-cloud-crypto';
import { EngineRegistry } from './../src/engine/engine-registry.service';
import {
  FakeGraph,
  graphError,
  happyGraph,
  refusedGraphUrl,
  startFakeGraph,
} from './../src/engine/adapters/__fixtures__/fake-graph-server';

/**
 * OpenMsg (docs/32): Cloud API sessions on a Baileys deployment. Every session response carries
 * `engine` (the row's value, or ENGINE_TYPE when the row has none), and `POST /api/sessions` takes
 * only `meta-cloud` in `engine`. A Cloud session is created with its number, starts against a fake
 * Graph server (META_GRAPH_BASE_URL), and its token can be read only as its last 4 characters.
 */
describe('Meta Cloud API sessions (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let accounts: Repository<MetaCloudAccount>;
  let contacts: Repository<MetaCloudContact>;
  let operatorKey: string;
  let qrSessionId: string;
  let cloudSessionId: string;
  let graph: FakeGraph;
  const key = randomBytes(32);
  const prevEnv = {
    ENGINE_TYPE: process.env.ENGINE_TYPE,
    META_CLOUD_ENABLED: process.env.META_CLOUD_ENABLED,
    META_CLOUD_ENCRYPTION_KEY: process.env.META_CLOUD_ENCRYPTION_KEY,
    META_GRAPH_BASE_URL: process.env.META_GRAPH_BASE_URL,
  };

  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-e2e-system-user-token-0001';
  const ROTATED = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-e2e-rotated-token-zz99';
  const PHONE_NUMBER_ID = '106540352242922';
  const WABA_ID = '102290129340398';

  beforeAll(async () => {
    graph = await startFakeGraph();
    process.env.ENGINE_TYPE = 'baileys';
    process.env.META_CLOUD_ENABLED = 'true';
    process.env.META_CLOUD_ENCRYPTION_KEY = key.toString('base64');
    process.env.META_GRAPH_BASE_URL = graph.url;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessions = app.get(getRepositoryToken(Session, 'data'));
    accounts = app.get<Repository<MetaCloudAccount>>(getRepositoryToken(MetaCloudAccount, 'data'));
    contacts = sessions.manager.getRepository(MetaCloudContact);
    // A QR session that predates the column (engine NULL), and a Cloud row written directly.
    qrSessionId = (await sessions.save(sessions.create({ name: `e2e-qr-${Date.now()}` }))).id;
    cloudSessionId = (await sessions.save(sessions.create({ name: `e2e-cloud-${Date.now()}`, engine: 'meta-cloud' })))
      .id;
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-cloud', role: ApiKeyRole.OPERATOR }))
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
    graph.script = happyGraph;
    process.env.META_CLOUD_ENCRYPTION_KEY = key.toString('base64');
    process.env.META_GRAPH_BASE_URL = graph.url;
  });

  const http = () => request(app.getHttpServer());
  const get = (path: string) => http().get(path).set('X-API-Key', operatorKey);
  const createCloud = (name: string, metaCloud: Record<string, string>) =>
    http().post('/api/sessions').set('X-API-Key', operatorKey).send({ name, engine: 'meta-cloud', metaCloud });
  const credentials = (phoneNumberId: string, accessToken = TOKEN) => ({
    phoneNumberId,
    wabaId: WABA_ID,
    accessToken,
  });

  /** Every 8-character run of `token` found in `text`. */
  const tokenRunsIn = (text: string, token: string): string[] => {
    const found: string[] = [];
    for (let i = 0; i + 8 <= token.length; i++) {
      if (text.includes(token.slice(i, i + 8))) found.push(token.slice(i, i + 8));
    }
    return found;
  };

  /** The session as GET /api/sessions/:id reports it, once `until` holds or after ~5 s. */
  const sessionWhen = async (id: string, until: (s: Record<string, unknown>) => boolean) => {
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      body = (await get(`/api/sessions/${id}`).expect(200)).body as Record<string, unknown>;
      if (until(body)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return body;
  };

  it('C1 GET /api/sessions returns engine baileys for a NULL row and meta-cloud for a Cloud row', async () => {
    const res = await get('/api/sessions').expect(200);
    const byId = new Map((res.body as Array<{ id: string; engine: string }>).map(s => [s.id, s.engine]));

    expect(byId.get(qrSessionId)).toBe('baileys');
    expect(byId.get(cloudSessionId)).toBe('meta-cloud');
  });

  it('C1 GET /api/sessions/:id returns engine baileys for a NULL row and meta-cloud for a Cloud row', async () => {
    const qr = await get(`/api/sessions/${qrSessionId}`).expect(200);
    const cloud = await get(`/api/sessions/${cloudSessionId}`).expect(200);

    expect((qr.body as { engine: string }).engine).toBe('baileys');
    expect((cloud.body as { engine: string }).engine).toBe('meta-cloud');
  });

  it.each(['baileys', 'whatsapp-web.js', 'META-CLOUD', ''])(
    'C4 POST /api/sessions with engine %j answers 400 and creates no row',
    async engine => {
      const before = await sessions.count();

      await request(app.getHttpServer())
        .post('/api/sessions')
        .set('X-API-Key', operatorKey)
        .send({ name: `e2e-engine-${Date.now()}`, engine })
        .expect(400);

      expect(await sessions.count()).toBe(before);
    },
  );

  // The Cloud session C11 creates and C23 starts; C14, C18, C20 and C29-C33 work on it. Created (and
  // started) on first use, so each check's proof also runs on its own with `-t`.
  let created: { id: string; body: string } | undefined;
  let started = false;
  const cloudSession = async (): Promise<{ id: string; body: string }> => {
    if (!created) {
      const res = await createCloud(`e2e-cloud-c11-${Date.now()}`, credentials(PHONE_NUMBER_ID));
      expect(res.status).toBe(201);
      created = { id: (res.body as { id: string }).id, body: JSON.stringify(res.body) };
    }
    return created;
  };
  const startedCloudSession = async (): Promise<string> => {
    const { id } = await cloudSession();
    if (!started) {
      await http().post(`/api/sessions/${id}/start`).set('X-API-Key', operatorKey).expect(200);
      await sessionWhen(id, s => s.status === 'ready');
      started = true;
    }
    return id;
  };

  it('C11 POST /api/sessions with engine meta-cloud and complete metaCloud answers 201 and writes both rows', async () => {
    const { id: createdId, body } = await cloudSession();

    expect((JSON.parse(body) as { engine: string }).engine).toBe('meta-cloud');
    expect(await sessions.countBy({ id: createdId })).toBe(1);
    const rows = await accounts.findBy({ sessionId: createdId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID });
  });

  it('C14 stores the C11 token encrypted: it differs from the token and decrypts to it with the key', async () => {
    const { id: createdId } = await cloudSession();
    const row = await accounts.findOneByOrFail({ sessionId: createdId });

    expect(row.accessTokenEnc).not.toBe(TOKEN);
    expect(row.accessTokenEnc).not.toContain(TOKEN);
    expect(decryptMetaToken(row.accessTokenEnc as string, key)).toBe(TOKEN);
  });

  it.each([
    ['unset', undefined],
    ['not base64', 'definitely not base64!'],
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
  ])(
    'C15 with META_CLOUD_ENCRYPTION_KEY %s answers 400 META_CLOUD_NOT_CONFIGURED and writes no row',
    async (_l, raw) => {
      if (raw === undefined) delete process.env.META_CLOUD_ENCRYPTION_KEY;
      else process.env.META_CLOUD_ENCRYPTION_KEY = raw;
      const [sessionsBefore, accountsBefore] = [await sessions.count(), await accounts.count()];

      const res = await createCloud(`e2e-cloud-c15-${Date.now()}`, credentials('200000000000015')).expect(400);

      expect((res.body as { code?: string }).code).toBe('META_CLOUD_NOT_CONFIGURED');
      expect(await sessions.count()).toBe(sessionsBefore);
      expect(await accounts.count()).toBe(accountsBefore);
    },
  );

  it.each([
    ['metaCloud missing', undefined],
    ['an empty phoneNumberId', { phoneNumberId: '', wabaId: WABA_ID, accessToken: TOKEN }],
    ['an empty wabaId', { phoneNumberId: '200000000000016', wabaId: '', accessToken: TOKEN }],
    ['an empty accessToken', { phoneNumberId: '200000000000016', wabaId: WABA_ID, accessToken: '' }],
  ])('C16 POST /api/sessions with engine meta-cloud and %s answers 400 and creates no row', async (_l, metaCloud) => {
    const before = await sessions.count();

    await http()
      .post('/api/sessions')
      .set('X-API-Key', operatorKey)
      .send({ name: `e2e-cloud-c16-${Date.now()}`, engine: 'meta-cloud', ...(metaCloud ? { metaCloud } : {}) })
      .expect(400);

    expect(await sessions.count()).toBe(before);
  });

  it('C17 POST /api/sessions with metaCloud and no engine answers 400 and creates no row', async () => {
    const before = await sessions.count();

    await http()
      .post('/api/sessions')
      .set('X-API-Key', operatorKey)
      .send({ name: `e2e-cloud-c17-${Date.now()}`, metaCloud: credentials('200000000000017') })
      .expect(400);

    expect(await sessions.count()).toBe(before);
  });

  it('C18 a second create for a bound phoneNumberId answers 409 META_PHONE_NUMBER_IN_USE and adds no session', async () => {
    await cloudSession();
    const before = await sessions.count();

    const res = await createCloud(`e2e-cloud-c18-${Date.now()}`, credentials(PHONE_NUMBER_ID)).expect(409);

    expect((res.body as { code?: string }).code).toBe('META_PHONE_NUMBER_IN_USE');
    expect(await sessions.count()).toBe(before);
  });

  it('C19 two creates for one phoneNumberId sent at once end with one 201, one 409 and one account row', async () => {
    const phone = '200000000000019';
    const stamp = Date.now();

    const results = await Promise.all([
      createCloud(`e2e-cloud-c19a-${stamp}`, credentials(phone)),
      createCloud(`e2e-cloud-c19b-${stamp}`, credentials(phone)),
    ]);

    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const conflict = results.find(r => r.status === 409);
    expect((conflict?.body as { code?: string }).code).toBe('META_PHONE_NUMBER_IN_USE');
    expect(await accounts.countBy({ phoneNumberId: phone })).toBe(1);
  });

  it('C23 starting the C11 session moves it to READY with the phone digits and the verified name', async () => {
    const createdId = await startedCloudSession();

    const session = await sessionWhen(createdId, s => s.status === 'ready');

    expect(session).toMatchObject({ status: 'ready', phone: '5511999990000', pushName: 'Acme' });
  });

  it('C29 POST /api/sessions/:id/pairing-code on a meta-cloud session answers 501', async () => {
    const { id: createdId } = await cloudSession();
    await http()
      .post(`/api/sessions/${createdId}/pairing-code`)
      .set('X-API-Key', operatorKey)
      .send({ phoneNumber: '5511999990000' })
      .expect(501);
  });

  it('C30 GET .../meta/account answers 200 with exactly the public keys, the token last 4 and the webhook URL', async () => {
    const createdId = await startedCloudSession();
    const res = await get(`/api/sessions/${createdId}/meta/account`).expect(200);
    const body = res.body as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        'phoneNumberId',
        'wabaId',
        'displayPhoneNumber',
        'verifiedName',
        'qualityRating',
        'messagingLimitTier',
        'accessTokenLast4',
        'webhookUrl',
      ].sort(),
    );
    expect(body.accessTokenLast4).toBe(TOKEN.slice(-4));
    expect(String(body.webhookUrl).endsWith('/api/meta-webhook')).toBe(true);
    expect(body).toMatchObject({ phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, verifiedName: 'Acme' });
  });

  it('C92 webhookUrl is built from BASE_URL when it is set, and from the request when it is not', async () => {
    const createdId = await startedCloudSession();
    const previous = process.env.BASE_URL;
    try {
      process.env.BASE_URL = 'https://openmsg.example.com/';
      const withBase = await get(`/api/sessions/${createdId}/meta/account`).expect(200);
      expect((withBase.body as { webhookUrl: string }).webhookUrl).toBe('https://openmsg.example.com/api/meta-webhook');

      delete process.env.BASE_URL;
      const withoutBase = await get(`/api/sessions/${createdId}/meta/account`).expect(200);
      expect((withoutBase.body as { webhookUrl: string }).webhookUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/api\/meta-webhook$/,
      );
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }
  });

  it('C31 GET and PUT .../meta/account answer 501 on a session whose engine is NULL', async () => {
    await get(`/api/sessions/${qrSessionId}/meta/account`).expect(501);
    await http()
      .put(`/api/sessions/${qrSessionId}/meta/account`)
      .set('X-API-Key', operatorKey)
      .send({ accessToken: ROTATED })
      .expect(501);
  });

  it('C31 GET and PUT .../meta/account answer 404 on an unknown session id', async () => {
    const unknown = '3f1c8a52-6d0e-4b8e-9a51-0c2f6b1d7e90';
    await get(`/api/sessions/${unknown}/meta/account`).expect(404);
    await http()
      .put(`/api/sessions/${unknown}/meta/account`)
      .set('X-API-Key', operatorKey)
      .send({ accessToken: ROTATED })
      .expect(404);
  });

  it.each([
    ['no accessToken', {}],
    ['an empty accessToken', { accessToken: '' }],
    ['an extra phoneNumberId', { accessToken: ROTATED, phoneNumberId: '200000000000033' }],
  ])('C33 PUT .../meta/account with %s answers 400 and leaves the stored token unchanged', async (_l, body) => {
    const { id: createdId } = await cloudSession();
    const before = (await accounts.findOneByOrFail({ sessionId: createdId })).accessTokenEnc;

    await http().put(`/api/sessions/${createdId}/meta/account`).set('X-API-Key', operatorKey).send(body).expect(400);

    expect((await accounts.findOneByOrFail({ sessionId: createdId })).accessTokenEnc).toBe(before);
  });

  it('C84 PUT .../meta/account with META_CLOUD_ENCRYPTION_KEY unset answers 400 META_CLOUD_NOT_CONFIGURED and keeps the token', async () => {
    const { id: createdId } = await cloudSession();
    const before = (await accounts.findOneByOrFail({ sessionId: createdId })).accessTokenEnc;
    delete process.env.META_CLOUD_ENCRYPTION_KEY;

    const res = await http()
      .put(`/api/sessions/${createdId}/meta/account`)
      .set('X-API-Key', operatorKey)
      .send({ accessToken: ROTATED })
      .expect(400);

    expect((res.body as { code?: string }).code).toBe('META_CLOUD_NOT_CONFIGURED');
    expect((await accounts.findOneByOrFail({ sessionId: createdId })).accessTokenEnc).toBe(before);
  });

  it('C85 GET and PUT .../meta/account answer 404 on a meta-cloud session whose account row is missing', async () => {
    // The row written directly in beforeAll has engine meta-cloud and no account, as after an /infra restore.
    expect(await accounts.countBy({ sessionId: cloudSessionId })).toBe(0);

    await get(`/api/sessions/${cloudSessionId}/meta/account`).expect(404);
    await http()
      .put(`/api/sessions/${cloudSessionId}/meta/account`)
      .set('X-API-Key', operatorKey)
      .send({ accessToken: ROTATED })
      .expect(404);

    expect(await accounts.countBy({ sessionId: cloudSessionId })).toBe(0);
  });

  it('C88 GET and PUT .../meta/account with a session id that is not a UUID answer 400', async () => {
    await get('/api/sessions/not-a-uuid/meta/account').expect(400);
    await http()
      .put('/api/sessions/not-a-uuid/meta/account')
      .set('X-API-Key', operatorKey)
      .send({ accessToken: ROTATED })
      .expect(400);
  });

  it('C20 no response body carries the token or any 8-character run of it', async () => {
    const { id: createdId, body: createBody } = await cloudSession();
    const bodies = [
      createBody,
      JSON.stringify((await get('/api/sessions').expect(200)).body),
      JSON.stringify((await get(`/api/sessions/${createdId}`).expect(200)).body),
      JSON.stringify((await get(`/api/sessions/${createdId}/config`).expect(200)).body),
      JSON.stringify((await get(`/api/sessions/${createdId}/meta/account`).expect(200)).body),
      JSON.stringify(
        (
          await http()
            .put(`/api/sessions/${createdId}/meta/account`)
            .set('X-API-Key', operatorKey)
            .send({ accessToken: TOKEN })
            .expect(200)
        ).body,
      ),
    ];

    for (const body of bodies) expect(tokenRunsIn(body, TOKEN)).toEqual([]);
  });

  it("C32 PUT .../meta/account with a new token answers its last 4, and the session's next Graph call sends it", async () => {
    const createdId = await startedCloudSession();
    const res = await http()
      .put(`/api/sessions/${createdId}/meta/account`)
      .set('X-API-Key', operatorKey)
      .send({ accessToken: ROTATED })
      .expect(200);
    expect((res.body as { accessTokenLast4: string }).accessTokenLast4).toBe(ROTATED.slice(-4));
    expect(tokenRunsIn(JSON.stringify(res.body), ROTATED)).toEqual([]);

    const sent = graph.requests.length;
    const engine = app.get(EngineRegistry).get(createdId);
    expect(engine).toBeDefined();
    await engine?.probeLiveness?.();

    expect(graph.requests.length).toBeGreaterThan(sent);
    expect(graph.requests[sent].headers.authorization).toBe(`Bearer ${ROTATED}`);
  });

  it.each([
    ['refuses the connection', 'refused'],
    ['answers 500', '500'],
  ])('C27 when Graph %s during start, the session does not reach READY and lastError is set', async (_l, mode) => {
    const created = await createCloud(
      `e2e-cloud-c27-${mode}-${Date.now()}`,
      credentials(`2000000000270${mode.length}`),
    );
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    if (mode === 'refused') process.env.META_GRAPH_BASE_URL = await refusedGraphUrl();
    else graph.script = () => graphError(500, 1, 'An unknown error occurred', { type: 'OAuthException' });

    const start = await http().post(`/api/sessions/${id}/start`).set('X-API-Key', operatorKey);

    expect(start.status).toBeGreaterThanOrEqual(500);
    const session = await sessionWhen(id, s => s.lastError != null);
    expect(session.status).not.toBe('ready');
    expect(session.lastError).toEqual(expect.any(String));
  });

  it('C35 DELETE /api/sessions/:id on a meta-cloud session removes its account and contact rows', async () => {
    const created = await createCloud(`e2e-cloud-c35-${Date.now()}`, credentials('200000000000035'));
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    await contacts.save(contacts.create({ sessionId: id, waId: '5511988887777', profileName: 'Maria' }));
    expect(await contacts.countBy({ sessionId: id })).toBe(1);

    await http().delete(`/api/sessions/${id}`).set('X-API-Key', operatorKey).expect(204);

    expect(await accounts.countBy({ sessionId: id })).toBe(0);
    expect(await contacts.countBy({ sessionId: id })).toBe(0);
  });

  it('C76 GET /api/sessions/:id/groups on a started Cloud session answers 501', async () => {
    const id = await startedCloudSession();

    const res = await get(`/api/sessions/${id}/groups`);

    expect(res.status).toBe(501);
  });
});
