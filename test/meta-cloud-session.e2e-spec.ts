// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));
// Stub the heavy Baileys lib: these tests never start a session, they only read and create rows.
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  fetchLatestBaileysVersion: jest.fn(),
  getContentType: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

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

/**
 * OpenMsg (docs/32): Cloud API sessions on a Baileys deployment. Every session response carries
 * `engine` (the row's value, or ENGINE_TYPE when the row has none), and `POST /api/sessions` takes
 * only `meta-cloud` in `engine`.
 */
describe('Meta Cloud API sessions (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let operatorKey: string;
  let qrSessionId: string;
  let cloudSessionId: string;
  const prevEngine = process.env.ENGINE_TYPE;
  const prevFlag = process.env.META_CLOUD_ENABLED;

  beforeAll(async () => {
    process.env.ENGINE_TYPE = 'baileys';
    process.env.META_CLOUD_ENABLED = 'true';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessions = app.get(getRepositoryToken(Session, 'data'));
    // A QR session that predates the column (engine NULL), and a Cloud row written directly: creating
    // one with its credentials through the API is a later slice.
    qrSessionId = (await sessions.save(sessions.create({ name: `e2e-qr-${Date.now()}` }))).id;
    cloudSessionId = (await sessions.save(sessions.create({ name: `e2e-cloud-${Date.now()}`, engine: 'meta-cloud' })))
      .id;
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-cloud', role: ApiKeyRole.OPERATOR }))
      .rawKey;
  });

  afterAll(async () => {
    if (prevEngine === undefined) delete process.env.ENGINE_TYPE;
    else process.env.ENGINE_TYPE = prevEngine;
    if (prevFlag === undefined) delete process.env.META_CLOUD_ENABLED;
    else process.env.META_CLOUD_ENABLED = prevFlag;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  const get = (path: string) => request(app.getHttpServer()).get(path).set('X-API-Key', operatorKey);

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
});
