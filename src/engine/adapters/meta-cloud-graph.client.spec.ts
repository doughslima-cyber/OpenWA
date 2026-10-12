import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { LoggerService } from '../../common/services/logger.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { Session } from '../../modules/session/entities/session.entity';
import { MetaCloudAccountService } from '../../modules/meta-cloud/meta-cloud-account.service';
import { MetaCloudAccount } from './meta-cloud-account.entity';
import { MetaGraphClient, MetaGraphError, redactSecret } from './meta-cloud-graph.client';
import { FakeGraph, startFakeGraph } from './__fixtures__/fake-graph-server';

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
