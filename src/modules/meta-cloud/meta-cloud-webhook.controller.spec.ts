import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { MetaCloudWebhookController } from './meta-cloud-webhook.controller';
import { MetaCloudWebhookRouter } from './meta-cloud-router.service';

describe('MetaCloudWebhookController', () => {
  const SECRET = 'controller-spec-app-secret-0001';
  const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const signature = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
  const prevEnv = { enabled: process.env.META_CLOUD_ENABLED, secret: process.env.META_APP_SECRET };

  let app: INestApplication<App>;
  const router = {
    handle: jest.fn<Promise<void>, [unknown]>(),
    knownNumbersNotLive: jest.fn<Promise<string[]>, [unknown]>(),
  };

  beforeEach(async () => {
    process.env.META_CLOUD_ENABLED = 'true';
    process.env.META_APP_SECRET = SECRET;
    router.handle.mockReset();
    router.knownNumbersNotLive.mockReset().mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      controllers: [MetaCloudWebhookController],
      providers: [{ provide: MetaCloudWebhookRouter, useValue: router }],
    }).compile();
    // rawBody: true keeps req.rawBody, as configure-app.ts does for the real app.
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const [name, value] of [
      ['META_CLOUD_ENABLED', prevEnv.enabled],
      ['META_APP_SECRET', prevEnv.secret],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const post = () =>
    request(app.getHttpServer())
      .post('/meta-webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(BODY);

  /** Lets the deferred processing (setImmediate, then the router's promise chain) run. */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };

  it('C53 with META_APP_SECRET unset answers 503 twice and logs the cause exactly once', async () => {
    delete process.env.META_APP_SECRET;
    const controller = app.get(MetaCloudWebhookController);
    const logged = jest.spyOn(
      (controller as unknown as { logger: { error: (...args: unknown[]) => void } }).logger,
      'error',
    );

    await post().expect(503);
    await post().expect(503);

    const causes = logged.mock.calls.filter(([message]) => String(message).includes('META_APP_SECRET'));
    expect(causes).toHaveLength(1);
    expect(router.handle).not.toHaveBeenCalled();
  });

  describe('a body naming a stored number whose session is not live here (Landing 16)', () => {
    it('C96 answers 503 and starts no router run', async () => {
      router.knownNumbersNotLive.mockResolvedValue(['444000444']);

      await post().expect(503);
      await flush();

      expect(router.knownNumbersNotLive).toHaveBeenCalledTimes(1);
      expect(router.handle).not.toHaveBeenCalled();
    });

    it('C97 a body whose numbers no stored account holds answers 200 and goes to the router, which drops it', async () => {
      router.knownNumbersNotLive.mockResolvedValue([]);
      router.handle.mockResolvedValue(undefined);

      await post().expect(200);
      await flush();

      expect(router.handle).toHaveBeenCalledTimes(1);
    });

    it('C98 a body with one live and one stored-but-not-live number answers 503 and none of it reaches the router', async () => {
      router.knownNumbersNotLive.mockResolvedValue(['444000444']);

      await post().expect(503);
      await flush();

      expect(router.handle).not.toHaveBeenCalled();
    });

    it('C98 a body whose numbers are all live answers 200 without waiting for its processing, then is processed', async () => {
      router.knownNumbersNotLive.mockResolvedValue([]);
      // Processing that never finishes: the 200 cannot be waiting on it.
      router.handle.mockReturnValue(new Promise<void>(() => undefined));

      await post().expect(200);
      await flush();

      expect(router.knownNumbersNotLive).toHaveBeenCalledTimes(1);
      expect(router.handle).toHaveBeenCalledTimes(1);
    });
  });

  it('C99 a failing stored-account lookup answers 503, starts no router run and logs each failure once', async () => {
    router.knownNumbersNotLive.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    const controller = app.get(MetaCloudWebhookController);
    const logged = jest.spyOn(
      (controller as unknown as { logger: { error: (...args: unknown[]) => void } }).logger,
      'error',
    );

    await post().expect(503);
    await post().expect(503);
    await flush();

    expect(router.knownNumbersNotLive).toHaveBeenCalledTimes(2);
    expect(router.handle).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(2);
  });

  describe('C55 the 200 does not wait on processing', () => {
    let unhandled: jest.Mock;
    beforeEach(() => {
      unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
    });
    afterEach(() => {
      process.off('unhandledRejection', unhandled);
    });

    it('C55 a router whose handle() never settles still lets a signed POST answer 200', async () => {
      router.handle.mockReturnValue(new Promise<void>(() => undefined));

      const res = await post().expect(200);

      expect(res.text).toBe('');
      await flush();
      expect(router.handle).toHaveBeenCalledTimes(1);
    });

    it('C55 a router whose handle() rejects still lets a signed POST answer 200, with no unhandled rejection', async () => {
      router.handle.mockRejectedValue(new Error('router exploded'));

      await post().expect(200);
      await flush();

      expect(router.handle).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('C55 a router whose handle() throws synchronously reaches no unhandled-rejection listener either', async () => {
      router.handle.mockImplementation(() => {
        throw new Error('thrown before any promise');
      });

      await post().expect(200);
      await flush();

      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});
