import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { MetaCloudAccount } from '../../engine/adapters/meta-cloud-account.entity';
import { decryptMetaToken, parseMetaCloudKey } from '../../engine/adapters/meta-cloud-crypto';
import { Session } from '../session/entities/session.entity';
import { MetaCloudAccountService } from './meta-cloud-account.service';

const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-account-service-token';
const CREDENTIALS = { phoneNumberId: '106540352242922', wabaId: '102290129340398', accessToken: TOKEN };
const WEBHOOK_URL = 'https://openmsg.example.com/api/meta-webhook';

describe('MetaCloudAccountService', () => {
  let ds: DataSource;
  let sessions: Repository<Session>;
  let accounts: Repository<MetaCloudAccount>;
  let service: MetaCloudAccountService;
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
    sessions = ds.getRepository(Session);
    accounts = ds.getRepository(MetaCloudAccount);
    service = new MetaCloudAccountService(ds, accounts, sessions);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (prevKey === undefined) delete process.env.META_CLOUD_ENCRYPTION_KEY;
    else process.env.META_CLOUD_ENCRYPTION_KEY = prevKey;
    await ds.destroy();
  });

  const newSession = (name = 'cloud-one'): Session => sessions.create({ name, engine: 'meta-cloud', config: {} });
  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (e: unknown) => e,
    );

  it('saves the session and its account, with the token encrypted', async () => {
    const saved = await service.createSession(newSession(), CREDENTIALS);

    const row = await accounts.findOneByOrFail({ sessionId: saved.id });
    expect(await sessions.count()).toBe(1);
    expect(row).toMatchObject({ phoneNumberId: CREDENTIALS.phoneNumberId, wabaId: CREDENTIALS.wabaId });
    expect(row.accessTokenEnc).not.toContain(TOKEN);
    expect(decryptMetaToken(row.accessTokenEnc as string, parseMetaCloudKey() as Buffer)).toBe(TOKEN);
  });

  it('C12 leaves no sessions row behind when the account insert throws inside the create', async () => {
    jest.spyOn(EntityManager.prototype, 'insert').mockRejectedValueOnce(new Error('SQLITE_IOERR: disk I/O error'));

    const error = await failure(service.createSession(newSession(), CREDENTIALS));

    expect(error).toEqual(expect.objectContaining({ message: 'SQLITE_IOERR: disk I/O error' }));
    expect(await sessions.count()).toBe(0);
    expect(await accounts.count()).toBe(0);
  });

  it('C12 leaves no sessions row behind when the unique phoneNumberId index refuses the account insert', async () => {
    await service.createSession(newSession('first'), CREDENTIALS);
    // As when a concurrent create passed the existence check before this one committed.
    jest.spyOn(accounts, 'existsBy').mockResolvedValueOnce(false);

    const error = await failure(service.createSession(newSession('second'), CREDENTIALS));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ statusCode: 409, code: 'META_PHONE_NUMBER_IN_USE' }),
    );
    expect(await sessions.count()).toBe(1);
    expect(await accounts.count()).toBe(1);
  });

  it.each([
    ['unset', undefined],
    ['not base64', 'this is not a base64 key!'],
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
  ])(
    'C15 with META_CLOUD_ENCRYPTION_KEY %s answers 400 META_CLOUD_NOT_CONFIGURED and writes no row',
    async (_label, key) => {
      if (key === undefined) delete process.env.META_CLOUD_ENCRYPTION_KEY;
      else process.env.META_CLOUD_ENCRYPTION_KEY = key;

      const error = await failure(service.createSession(newSession(), CREDENTIALS));

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ statusCode: 400, code: 'META_CLOUD_NOT_CONFIGURED' }),
      );
      expect(await sessions.count()).toBe(0);
      expect(await accounts.count()).toBe(0);
    },
  );

  it('reads the account without the token, with its last 4 characters and the webhook URL', async () => {
    const saved = await service.createSession(newSession(), CREDENTIALS);

    await expect(service.getAccount(saved.id, WEBHOOK_URL)).resolves.toEqual({
      phoneNumberId: CREDENTIALS.phoneNumberId,
      wabaId: CREDENTIALS.wabaId,
      displayPhoneNumber: null,
      verifiedName: null,
      qualityRating: null,
      messagingLimitTier: null,
      accessTokenLast4: TOKEN.slice(-4),
      webhookUrl: WEBHOOK_URL,
    });
  });

  it('rotates the token: the stored value decrypts to the new one', async () => {
    const saved = await service.createSession(newSession(), CREDENTIALS);

    const res = await service.rotateToken(saved.id, 'EAAG-new-token-wxyz', WEBHOOK_URL);

    expect(res.accessTokenLast4).toBe('wxyz');
    const row = await accounts.findOneByOrFail({ sessionId: saved.id });
    expect(decryptMetaToken(row.accessTokenEnc as string, parseMetaCloudKey() as Buffer)).toBe('EAAG-new-token-wxyz');
  });

  it('answers 404 for an unknown session and 501 for a session that is not meta-cloud', async () => {
    const qr = await sessions.save(sessions.create({ name: 'qr', config: {} }));

    await expect(service.getAccount('00000000-0000-4000-8000-000000000000', WEBHOOK_URL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getAccount(qr.id, WEBHOOK_URL)).rejects.toBeInstanceOf(NotImplementedException);
    await expect(service.rotateToken(qr.id, 'EAAG-x', WEBHOOK_URL)).rejects.toBeInstanceOf(NotImplementedException);
  });
});
