// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

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
 * OpenMsg (docs/32): with META_CLOUD_ENABLED anything but `true`, a Cloud API session is refused with
 * a machine-readable code before any row is written. The QR deployment is unaffected.
 */
describe('Meta Cloud API sessions switched off (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let operatorKey: string;
  const prevFlag = process.env.META_CLOUD_ENABLED;

  beforeAll(async () => {
    delete process.env.META_CLOUD_ENABLED;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();
    sessions = app.get(getRepositoryToken(Session, 'data'));
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-meta-off', role: ApiKeyRole.OPERATOR })).rawKey;
  });

  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.META_CLOUD_ENABLED;
    else process.env.META_CLOUD_ENABLED = prevFlag;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  const createCloud = () =>
    request(app.getHttpServer())
      .post('/api/sessions')
      .set('X-API-Key', operatorKey)
      .send({
        name: `e2e-cloud-off-${Date.now()}`,
        engine: 'meta-cloud',
        metaCloud: { phoneNumberId: '106540352242922', wabaId: '102290129340398', accessToken: 'EAAG-e2e-token' },
      });

  it.each([
    ['unset', undefined],
    ['false', 'false'],
  ])('C5 with META_CLOUD_ENABLED %s answers 400 META_CLOUD_DISABLED and creates no row', async (_label, value) => {
    if (value === undefined) delete process.env.META_CLOUD_ENABLED;
    else process.env.META_CLOUD_ENABLED = value;
    const before = await sessions.count();

    const res = await createCloud().expect(400);

    expect((res.body as { code?: string }).code).toBe('META_CLOUD_DISABLED');
    expect(await sessions.count()).toBe(before);
  });

  it('still creates a QR session, with the deployment engine', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sessions')
      .set('X-API-Key', operatorKey)
      .send({ name: `e2e-qr-off-${Date.now()}` })
      .expect(201);

    expect((res.body as { engine: string }).engine).toBe(process.env.ENGINE_TYPE || 'whatsapp-web.js');
  });
});
