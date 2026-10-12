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
import { FakeGraph, startFakeGraph } from './../src/engine/adapters/__fixtures__/fake-graph-server';

/**
 * OpenMsg (docs/32, Landing 15, AD-005): a Cloud session's account goes into the `/infra` backup
 * without its token. Through the real routes: the export carries the number and no token, the restore
 * recreates the account with a NULL token, and the token set afterwards lets the session start.
 */
describe('Meta Cloud API accounts in the /infra backup (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let accounts: Repository<MetaCloudAccount>;
  let adminKey: string;
  let graph: FakeGraph;
  const key = randomBytes(32);
  const prevEnv: Record<string, string | undefined> = {};

  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-Hn4tYp8Wq2Jz5c';
  const NEW_TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-e2e-after-restore-9d41';
  const PHONE_NUMBER_ID = '106540352249393';
  const WABA_ID = '102290129349393';

  beforeAll(async () => {
    graph = await startFakeGraph();
    const env = {
      ENGINE_TYPE: 'baileys',
      META_CLOUD_ENABLED: 'true',
      META_CLOUD_ENCRYPTION_KEY: key.toString('base64'),
      META_GRAPH_BASE_URL: graph.url,
    };
    for (const [name, value] of Object.entries(env)) {
      prevEnv[name] = process.env[name];
      process.env[name] = value;
    }
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessions = app.get(getRepositoryToken(Session, 'data'));
    accounts = app.get<Repository<MetaCloudAccount>>(getRepositoryToken(MetaCloudAccount, 'data'));
    adminKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-backup', role: ApiKeyRole.ADMIN })).rawKey;
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

  /** Every 8-character run of `token` found in `text`. */
  const tokenRunsIn = (text: string, token: string): string[] => {
    const found: string[] = [];
    for (let i = 0; i + 8 <= token.length; i++) {
      if (text.includes(token.slice(i, i + 8))) found.push(token.slice(i, i + 8));
    }
    return found;
  };

  // One Cloud session holding TOKEN, created on first use, so each check runs alone with `-t`.
  let sessionId: string | undefined;
  const cloudSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await http()
      .post('/api/sessions')
      .set('X-API-Key', adminKey)
      .send({
        name: `e2e-cloud-backup-${Date.now()}`,
        engine: 'meta-cloud',
        metaCloud: { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN },
      })
      .expect(201);
    sessionId = (created.body as { id: string }).id;
    return sessionId;
  };

  const exportData = () => http().get('/api/infra/export-data').set('X-API-Key', adminKey).expect(200);

  it('C93 GET /api/infra/export-data carries the account with its number and WABA, and no run of the token', async () => {
    const id = await cloudSession();

    const res = await exportData();

    const rows = ((res.body as { tables: Record<string, unknown> }).tables.metaCloudAccounts ?? []) as Array<
      Record<string, unknown>
    >;
    const row = rows.find(r => r.sessionId === id);
    expect(row).toMatchObject({ phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID });
    expect(row?.accessTokenEnc ?? null).toBeNull();
    expect(row?.accessTokenLast4 ?? null).toBeNull();
    expect(tokenRunsIn(res.text, TOKEN)).toEqual([]);
  });

  it('C95 the export counts carry metaCloudAccounts equal to the exported account rows', async () => {
    await cloudSession();

    const body = (await exportData()).body as {
      tables: Record<string, unknown[]>;
      counts: Record<string, number>;
    };

    expect(body.tables.metaCloudAccounts).toHaveLength(1);
    expect(body.counts.metaCloudAccounts).toBe(1);
  });

  it('C94 restoring the export leaves a NULL token; PUT .../meta/account sets one and the session starts to READY', async () => {
    const id = await cloudSession();
    const backup = (await exportData()).body as Record<string, unknown>;

    const restored = await http().post('/api/infra/import-data').set('X-API-Key', adminKey).send(backup).expect(200);

    expect(restored.body).toMatchObject({ imported: true, warnings: [] });
    expect(await accounts.findOneByOrFail({ sessionId: id })).toMatchObject({
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      accessTokenEnc: null,
      accessTokenLast4: null,
    });

    const put = await http()
      .put(`/api/sessions/${id}/meta/account`)
      .set('X-API-Key', adminKey)
      .send({ accessToken: NEW_TOKEN })
      .expect(200);
    expect((put.body as { accessTokenLast4: string }).accessTokenLast4).toBe(NEW_TOKEN.slice(-4));

    await http().post(`/api/sessions/${id}/start`).set('X-API-Key', adminKey).send({}).expect(200);
    let status = '';
    for (let i = 0; i < 50 && status !== 'ready'; i++) {
      status = (await sessions.findOneByOrFail({ id })).status;
      if (status !== 'ready') await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(status).toBe('ready');
    const profileCall = graph.requests.find(r => r.method === 'GET' && r.path.includes(PHONE_NUMBER_ID));
    expect(profileCall?.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`);
  });
});
