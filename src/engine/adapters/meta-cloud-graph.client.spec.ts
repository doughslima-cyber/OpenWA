import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LoggerService } from '../../common/services/logger.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { Session } from '../../modules/session/entities/session.entity';
import { MetaCloudAccountService } from '../../modules/meta-cloud/meta-cloud-account.service';
import { MetaCloudAccount } from './meta-cloud-account.entity';
import { MetaGraphClient, MetaGraphError, redactSecret } from './meta-cloud-graph.client';
import { FakeGraph, graphError, refusedGraphUrl, startFakeGraph } from './__fixtures__/fake-graph-server';

const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZDsecretTokenForTheLogSpec0123456789';

/** Every 8-character run of the token that appears in `text`. */
function tokenRunsIn(text: string, token = TOKEN): string[] {
  const found: string[] = [];
  for (let i = 0; i + 8 <= token.length; i++) {
    const run = token.slice(i, i + 8);
    if (text.includes(run)) found.push(run);
  }
  return found;
}

describe('MetaGraphClient', () => {
  let graph: FakeGraph;
  const levels = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
  let spies: jest.SpyInstance[];

  /** Everything any logger was handed, serialized, across every level. */
  const loggedText = (): string =>
    spies
      .flatMap(spy => spy.mock.calls as unknown[][])
      .map(call => JSON.stringify(call))
      .join('\n');
  const loggerCallCount = (): number => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);

  beforeEach(async () => {
    graph = await startFakeGraph();
    spies = levels.map(level => jest.spyOn(LoggerService.prototype, level).mockImplementation(() => undefined));
  });

  afterEach(async () => {
    for (const spy of spies) spy.mockRestore();
    await graph.close();
  });

  const client = (timeoutMs = 2000): MetaGraphClient =>
    new MetaGraphClient(() => ({ baseUrl: graph.url, version: 'v26.0', timeoutMs }));

  it('C21 logs no 8-character run of the token when Graph answers 401 code 190 with a body that echoes the request', async () => {
    graph.script = request => ({
      status: 401,
      body: {
        error: {
          message: `Malformed access token ${TOKEN} (request: ${request.method} ${request.path}, authorization: ${String(request.headers.authorization)})`,
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          fbtrace_id: 'AZx9fbtraceQ1',
        },
      },
    });

    const error = await client()
      .request('GET', '/106540352242922', TOKEN)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MetaGraphError);
    expect((error as MetaGraphError).metaCode).toBe(190);
    expect(tokenRunsIn((error as MetaGraphError).message)).toEqual([]);
    expect(loggerCallCount()).toBeGreaterThan(0);
    expect(tokenRunsIn(loggedText())).toEqual([]);
  });

  it('C21 logs no 8-character run of the token when Graph times out', async () => {
    graph.script = () => 'hang';

    const error = await client(150)
      .request('GET', '/106540352242922', TOKEN)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineTransportError);
    expect(tokenRunsIn((error as Error).message)).toEqual([]);
    expect(loggerCallCount()).toBeGreaterThan(0);
    expect(tokenRunsIn(loggedText())).toEqual([]);
  });

  describe('with the account service', () => {
    let ds: DataSource;
    const prevKey = process.env.META_CLOUD_ENCRYPTION_KEY;

    beforeEach(async () => {
      process.env.META_CLOUD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      ds = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [Session, MetaCloudAccount],
        synchronize: true,
      });
      await ds.initialize();
    });

    afterEach(async () => {
      if (prevKey === undefined) delete process.env.META_CLOUD_ENCRYPTION_KEY;
      else process.env.META_CLOUD_ENCRYPTION_KEY = prevKey;
      await ds.destroy();
    });

    it('C21 logs no 8-character run of the token while binding, refusing and rotating an account', async () => {
      const service = new MetaCloudAccountService(ds, ds.getRepository(MetaCloudAccount), ds.getRepository(Session));
      const sessions = ds.getRepository(Session);
      const credentials = { phoneNumberId: '106540352242922', wabaId: '102290129340398', accessToken: TOKEN };

      const saved = await service.createSession(
        sessions.create({ name: 'cloud-a', engine: 'meta-cloud', config: {} }),
        credentials,
      );
      await service
        .createSession(sessions.create({ name: 'cloud-b', engine: 'meta-cloud', config: {} }), credentials)
        .catch(() => undefined);
      await service.rotateToken(saved.id, `${TOKEN}-rotated`, 'http://localhost/api/meta-webhook');

      expect(loggerCallCount()).toBeGreaterThan(0);
      expect(tokenRunsIn(loggedText())).toEqual([]);
    });
  });

  describe('sends', () => {
    const PHONE = '106540352242922';
    const MESSAGES = `/${PHONE}/messages`;
    const BODY = { messaging_product: 'whatsapp', to: '5511988887777', type: 'text', text: { body: 'hi' } };

    /** What a send rejected with: its HTTP status and response body. */
    const rejection = async (promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown> };
    };

    // The plan's error table, one row per Meta code, plus a Graph 5xx with no Meta code at all.
    it.each([
      [190, 401, 409, 'META_TOKEN_INVALID'],
      [10, 403, 409, 'META_TOKEN_INVALID'],
      [200, 403, 409, 'META_TOKEN_INVALID'],
      [131005, 403, 409, 'META_TOKEN_INVALID'],
      [131047, 400, 409, 'META_OUTSIDE_SERVICE_WINDOW'],
      [131048, 400, 429, 'META_LIMIT_REACHED'],
      [131049, 400, 429, 'META_LIMIT_REACHED'],
      [131056, 400, 429, 'META_LIMIT_REACHED'],
      [130429, 400, 429, 'META_RATE_LIMITED'],
      [131026, 400, 400, 'META_RECIPIENT_UNAVAILABLE'],
      [131021, 400, 400, 'META_RECIPIENT_UNAVAILABLE'],
      [131008, 400, 400, 'META_INVALID_PARAMETER'],
      [131009, 400, 400, 'META_INVALID_PARAMETER'],
      [133010, 400, 409, 'META_ACCOUNT_RESTRICTED'],
      [131031, 400, 409, 'META_ACCOUNT_RESTRICTED'],
      [100, 400, 502, 'META_UPSTREAM_ERROR'],
    ])(
      'C44 maps Meta code %d (Graph HTTP %d) to %d %s with metaCode and fbtraceId',
      async (metaCode, graphStatus, status, code) => {
        graph.script = () => graphError(graphStatus, metaCode, `Meta error ${metaCode}`);
        const sender = new MetaGraphClient(() => ({ baseUrl: graph.url, version: 'v26.0', timeoutMs: 2000 }), {
          retryDelaysMs: [0, 0],
        });

        const answer = await rejection(sender.send(PHONE, MESSAGES, TOKEN, BODY));

        expect(answer.status).toBe(status);
        expect(answer.body).toMatchObject({ statusCode: status, code, metaCode, fbtraceId: 'AZx9fbtraceQ1' });
        expect(typeof answer.body.message).toBe('string');
      },
    );

    it('C44 maps a bare Graph 500 to 502 META_UPSTREAM_ERROR', async () => {
      graph.script = () => ({ status: 500 });

      const answer = await rejection(client().send(PHONE, MESSAGES, TOKEN, BODY));

      expect(answer.status).toBe(502);
      expect(answer.body).toMatchObject({ statusCode: 502, code: 'META_UPSTREAM_ERROR' });
      expect(answer.body).toHaveProperty('metaCode');
      expect(answer.body).toHaveProperty('fbtraceId');
    });

    describe('with fake timers', () => {
      let starts: Array<{ url: string; at: number }>;
      let answers: Array<() => Response>;

      beforeEach(() => {
        jest.useFakeTimers({ now: 1_000_000 });
        starts = [];
        answers = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(input => {
          starts.push({ url: input instanceof Request ? input.url : input.toString(), at: Date.now() });
          const next = answers.shift();
          return Promise.resolve(
            next ? next() : new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }), { status: 200 }),
          );
        });
      });

      afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
      });

      const throttled = (): Response =>
        new Response(
          JSON.stringify({ error: { message: 'Rate limit hit', code: 130429, fbtrace_id: 'AZx9fbtraceQ1' } }),
          { status: 400 },
        );
      const timed = (maxRps = 40, retryDelaysMs = [1000, 2000]): MetaGraphClient =>
        new MetaGraphClient(() => ({ baseUrl: 'http://graph.test', version: 'v26.0', timeoutMs: 60_000, maxRps }), {
          retryDelaysMs,
        });

      it('C46 on 130429 makes exactly 3 attempts, waiting between them, then raises 429 META_RATE_LIMITED', async () => {
        answers = [throttled, throttled, throttled, throttled];
        const outcome = timed()
          .send(PHONE, MESSAGES, TOKEN, BODY)
          .catch((e: unknown) => e);

        await jest.advanceTimersByTimeAsync(0);
        expect(starts).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(999);
        expect(starts).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(starts).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(1999);
        expect(starts).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(60_000);

        const error = (await outcome) as HttpException;
        expect(starts).toHaveLength(3);
        expect(error).toBeInstanceOf(HttpException);
        expect(error.getStatus()).toBe(429);
        expect(error.getResponse()).toMatchObject({ code: 'META_RATE_LIMITED', metaCode: 130429 });
      });

      it('C46 on 130429 then success makes exactly 2 attempts and returns the wamid', async () => {
        answers = [throttled];
        const outcome = timed().send<{ messages: Array<{ id: string }> }>(PHONE, MESSAGES, TOKEN, BODY);

        await jest.advanceTimersByTimeAsync(60_000);

        await expect(outcome).resolves.toEqual({ messages: [{ id: 'wamid.OK' }] });
        expect(starts).toHaveLength(2);
      });

      it('C47 with META_CLOUD_MAX_RPS=2 delays the third call of a number by a second and not another number', async () => {
        const sender = timed(2);
        const t0 = Date.now();
        const sameNumber = [1, 2, 3].map(() => sender.send(PHONE, MESSAGES, TOKEN, BODY));
        const otherNumber = sender.send('999000111222333', '/999000111222333/messages', TOKEN, BODY);

        await jest.advanceTimersByTimeAsync(0);
        const startsOf = (phone: string) => starts.filter(s => s.url.includes(`/${phone}/`)).map(s => s.at);
        expect(startsOf(PHONE)).toEqual([t0, t0]);
        expect(startsOf('999000111222333')).toEqual([t0]);

        await jest.advanceTimersByTimeAsync(999);
        expect(startsOf(PHONE)).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(1);

        await expect(Promise.all([...sameNumber, otherNumber])).resolves.toHaveLength(4);
        expect(startsOf(PHONE)).toHaveLength(3);
        expect(startsOf(PHONE)[2] - t0).toBeGreaterThanOrEqual(1000);
      });
    });

    it('C48 aborts a send that outlives META_CLOUD_TIMEOUT_MS with an EngineTransportError (503)', async () => {
      graph.script = () => 'hang';
      const started = Date.now();

      const error = await client(150)
        .send(PHONE, MESSAGES, TOKEN, BODY)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EngineTransportError);
      expect((error as EngineTransportError).getStatus()).toBe(503);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it('C48 raises an EngineTransportError (503) when the connection is refused', async () => {
      const refused = new MetaGraphClient(() => ({ baseUrl: refusedUrl, version: 'v26.0', timeoutMs: 2000 }));

      const error = await refused.send(PHONE, MESSAGES, TOKEN, BODY).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EngineTransportError);
      expect((error as EngineTransportError).getStatus()).toBe(503);
    });

    let refusedUrl: string;
    beforeAll(async () => {
      refusedUrl = await refusedGraphUrl();
    });
  });

  describe('redactSecret', () => {
    it('removes the whole secret and any run of 8 or more of its characters, and keeps shorter runs', () => {
      const text = `full ${TOKEN} part ${TOKEN.slice(5, 20)} short ${TOKEN.slice(0, 7)} end`;
      const redacted = redactSecret(text, TOKEN);

      expect(tokenRunsIn(redacted)).toEqual([]);
      expect(redacted).toContain(TOKEN.slice(0, 7));
      expect(redacted.startsWith('full [redacted] part [redacted] short')).toBe(true);
    });
  });
});
