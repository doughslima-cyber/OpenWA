import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { USER_SESSION_TTL_MS, UsersService } from './users.service';
import { hashPassword, verifyPassword } from './password-hash';

/**
 * UsersService against a REAL better-sqlite3 DataSource and the real AuthService, so a sign-in key
 * is an actual api_keys row the guard would accept, and revoking a user really deletes it.
 */
describe('UsersService', () => {
  let ds: DataSource;
  let keys: Repository<ApiKey>;
  let users: Repository<User>;
  let sessions: Repository<UserSession>;
  let auth: AuthService;
  let service: UsersService;

  const PASSWORD = 'correct horse battery';

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, User, UserSession],
      synchronize: true,
    });
    await ds.initialize();
    keys = ds.getRepository(ApiKey);
    users = ds.getRepository(User);
    sessions = ds.getRepository(UserSession);
    const tracker = { record: jest.fn(), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    auth = new AuthService(keys, tracker, { get: () => undefined } as never);
    service = new UsersService(users, sessions, auth);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await sessions.clear();
    await users.clear();
    await keys.clear();
    // A non-expiring admin key, as the bootstrap master key would be, so the last-admin-key guard
    // never blocks deleting a sign-in key in these tests.
    await keys.save(keys.create({ name: 'master', keyPrefix: 'm', keyHash: 'm', role: ApiKeyRole.ADMIN }));
  });

  const makeUser = (email: string, role = ApiKeyRole.OPERATOR) =>
    service.create({ email, name: email.split('@')[0], password: PASSWORD, role });

  describe('password hashing', () => {
    it('verifies the right password and rejects a wrong one or a malformed hash', async () => {
      const hash = await hashPassword(PASSWORD);
      expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
      expect(await verifyPassword(PASSWORD, hash)).toBe(true);
      expect(await verifyPassword('wrong password!', hash)).toBe(false);
      expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
      expect(await verifyPassword(PASSWORD, 'scrypt$x$8$1$c2FsdA==$ZGln')).toBe(false);
      expect(await verifyPassword(PASSWORD, 'scrypt$16384$8$1$$')).toBe(false);
      expect(await verifyPassword(PASSWORD, 'scrypt$1048576$64$1$c2FsdA==$ZGln')).toBe(false);
    });

    it('salts each hash', async () => {
      expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
    });
  });

  describe('bootstrapAdmin', () => {
    it('seeds an admin while no user exists, and never twice', async () => {
      await service.bootstrapAdmin({ ADMIN_EMAIL: ' Admin@Example.com ', ADMIN_PASSWORD: PASSWORD });
      const seeded = await users.findOneByOrFail({ email: 'admin@example.com' });
      expect(seeded).toMatchObject({ role: ApiKeyRole.ADMIN, isActive: true, name: 'admin' });

      await service.bootstrapAdmin({ ADMIN_EMAIL: 'other@example.com', ADMIN_PASSWORD: PASSWORD });
      expect(await users.count()).toBe(1);
    });

    it('does nothing without both values or with a short password', async () => {
      await service.bootstrapAdmin({ ADMIN_EMAIL: 'a@example.com' });
      await service.bootstrapAdmin({ ADMIN_PASSWORD: PASSWORD });
      await service.bootstrapAdmin({ ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD: 'short' });
      expect(await users.count()).toBe(0);
    });

    it('leaves an existing account alone unless ADMIN_PASSWORD_RESET=true, which restores it', async () => {
      const user = await makeUser('ana@example.com');
      await service.update(user.id, { isActive: false }, null);
      await service.startSession(await users.findOneByOrFail({ id: user.id }));

      await service.bootstrapAdmin({ ADMIN_EMAIL: 'ana@example.com', ADMIN_PASSWORD: 'brand new password' });
      expect(await service.authenticate('ana@example.com', 'brand new password')).toBeNull();

      await service.bootstrapAdmin({
        ADMIN_EMAIL: 'ana@example.com',
        ADMIN_PASSWORD: 'brand new password',
        ADMIN_PASSWORD_RESET: 'true',
      });
      const restored = await service.authenticate('ana@example.com', 'brand new password');
      expect(restored).toMatchObject({ role: ApiKeyRole.ADMIN, isActive: true });
      expect(await sessions.count()).toBe(0);
    });

    it('creates the reset account even when other users exist', async () => {
      await makeUser('ana@example.com');
      await service.bootstrapAdmin({
        ADMIN_EMAIL: 'root@example.com',
        ADMIN_PASSWORD: PASSWORD,
        ADMIN_PASSWORD_RESET: 'true',
      });
      expect(await users.findOneBy({ email: 'root@example.com' })).toMatchObject({ role: ApiKeyRole.ADMIN });
    });
  });

  describe('create and authenticate', () => {
    it('normalizes the email and refuses a duplicate in any case', async () => {
      const user = await makeUser('Ana@Example.COM');
      expect(user.email).toBe('ana@example.com');
      expect(user.passwordHash).not.toContain(PASSWORD);
      await expect(makeUser('ANA@example.com')).rejects.toThrow(ConflictException);
    });

    it('defaults the role to operator', async () => {
      const user = await service.create({ email: 'b@example.com', name: ' Bia ', password: PASSWORD });
      expect(user).toMatchObject({ role: ApiKeyRole.OPERATOR, name: 'Bia' });
    });

    it('authenticates only an active user with the right password', async () => {
      const user = await makeUser('ana@example.com');
      expect(await service.authenticate(' ANA@example.com', PASSWORD)).toMatchObject({ id: user.id });
      expect(await service.authenticate('ana@example.com', 'wrong password')).toBeNull();
      expect(await service.authenticate('nobody@example.com', PASSWORD)).toBeNull();

      await service.update(user.id, { isActive: false }, null);
      expect(await service.authenticate('ana@example.com', PASSWORD)).toBeNull();
    });
  });

  describe('sign-in sessions', () => {
    it('mints an expiring key with the user role that AuthService accepts', async () => {
      const user = await makeUser('ana@example.com', ApiKeyRole.ADMIN);
      const before = Date.now();
      const { apiKey, rawKey } = await service.startSession(user);

      expect(apiKey).toMatchObject({ role: ApiKeyRole.ADMIN, name: 'Login: ana@example.com', allowedSessions: null });
      const ttl = (apiKey.expiresAt as Date).getTime() - before;
      expect(ttl).toBeGreaterThan(USER_SESSION_TTL_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(USER_SESSION_TTL_MS + 1000);
      expect(await auth.validateApiKey(rawKey)).toMatchObject({ id: apiKey.id });
      expect(await service.findByApiKey(apiKey.id)).toMatchObject({ id: user.id });
      expect((await users.findOneByOrFail({ id: user.id })).lastLoginAt).toBeInstanceOf(Date);
    });

    it('ends a session by deleting its key, and ignores a key no sign-in minted', async () => {
      const user = await makeUser('ana@example.com');
      const { apiKey } = await service.startSession(user);
      expect(await service.endSession(apiKey.id)).toMatchObject({ id: user.id });
      expect(await keys.findOneBy({ id: apiKey.id })).toBeNull();
      expect(await sessions.count()).toBe(0);

      const master = await keys.findOneByOrFail({ name: 'master' });
      expect(await service.endSession(master.id)).toBeNull();
      expect(await keys.findOneBy({ id: master.id })).not.toBeNull();
    });

    it('drops the session row even when the key cannot be deleted (the last usable admin key)', async () => {
      await keys.clear();
      const user = await makeUser('ana@example.com', ApiKeyRole.ADMIN);
      const { apiKey } = await service.startSession(user);
      await service.endSession(apiKey.id);
      expect(await sessions.count()).toBe(0);
      expect(await keys.findOneBy({ id: apiKey.id })).not.toBeNull();
    });

    it('sweeps dead session rows at the next sign-in', async () => {
      const user = await makeUser('ana@example.com');
      const expired = await service.startSession(user);
      const deleted = await service.startSession(user);
      const live = await service.startSession(user);
      await keys.update({ id: expired.apiKey.id }, { expiresAt: new Date(Date.now() - 1000) });
      await keys.delete({ id: deleted.apiKey.id });

      const fresh = await service.startSession(user);
      const remaining = (await sessions.find()).map(s => s.apiKeyId).sort();
      expect(remaining).toEqual([live.apiKey.id, fresh.apiKey.id].sort());
      expect(await keys.findOneBy({ id: expired.apiKey.id })).toBeNull();
    });
  });

  describe('update and remove', () => {
    it('ends other sign-ins on a role, status or password change, keeping the editor key', async () => {
      const user = await makeUser('ana@example.com');
      const first = await service.startSession(user);
      const second = await service.startSession(user);

      await service.update(user.id, { name: 'Ana S' }, null);
      expect(await sessions.count()).toBe(2);

      await service.update(user.id, { password: 'another password' }, null, second.apiKey.id);
      expect((await sessions.find()).map(s => s.apiKeyId)).toEqual([second.apiKey.id]);
      expect(await keys.findOneBy({ id: first.apiKey.id })).toBeNull();
      expect(await service.authenticate('ana@example.com', 'another password')).not.toBeNull();

      await service.update(user.id, { role: ApiKeyRole.VIEWER }, null);
      expect(await sessions.count()).toBe(0);
    });

    it('refuses to let an admin demote, deactivate or delete themselves', async () => {
      const me = await makeUser('me@example.com', ApiKeyRole.ADMIN);
      await makeUser('other@example.com', ApiKeyRole.ADMIN);
      await expect(service.update(me.id, { role: ApiKeyRole.OPERATOR }, me)).rejects.toThrow(ConflictException);
      await expect(service.update(me.id, { isActive: false }, me)).rejects.toThrow(ConflictException);
      await expect(service.remove(me.id, me)).rejects.toThrow(ConflictException);
      await expect(service.update(me.id, { name: 'Me' }, me)).resolves.toMatchObject({ name: 'Me' });
    });

    it('keeps at least one active admin user', async () => {
      const only = await makeUser('only@example.com', ApiKeyRole.ADMIN);
      const refusal = await service.update(only.id, { isActive: false }, null).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'LAST_ADMIN' });
      await expect(service.remove(only.id, null)).rejects.toThrow(ConflictException);

      const second = await makeUser('second@example.com', ApiKeyRole.ADMIN);
      await expect(service.update(only.id, { role: ApiKeyRole.OPERATOR }, second)).resolves.toMatchObject({
        role: ApiKeyRole.OPERATOR,
      });
    });

    it('deletes a user and their sign-in keys', async () => {
      const user = await makeUser('ana@example.com');
      const { apiKey } = await service.startSession(user);
      await service.remove(user.id, null);
      expect(await users.count()).toBe(0);
      expect(await keys.findOneBy({ id: apiKey.id })).toBeNull();
    });

    it('answers 404 for an unknown user', async () => {
      await expect(service.findOne('00000000-0000-0000-0000-000000000000')).rejects.toThrow(NotFoundException);
      await expect(service.update('missing', { name: 'x' }, null)).rejects.toThrow(NotFoundException);
    });

    it('lists users oldest first', async () => {
      await makeUser('a@example.com');
      await makeUser('b@example.com');
      expect((await service.findAll()).map(u => u.email)).toEqual(['a@example.com', 'b@example.com']);
    });
  });
});

describe('UsersService temporary passwords', () => {
  let ds: DataSource;
  let users: Repository<User>;
  let sessions: Repository<UserSession>;
  let keys: Repository<ApiKey>;
  let service: UsersService;
  const PASSWORD = 'correct horse battery';

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, User, UserSession],
      synchronize: true,
    });
    await ds.initialize();
    keys = ds.getRepository(ApiKey);
    users = ds.getRepository(User);
    sessions = ds.getRepository(UserSession);
    const tracker = { record: jest.fn(), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    const auth = new AuthService(keys, tracker, { get: () => undefined } as never);
    service = new UsersService(users, sessions, auth);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await sessions.clear();
    await users.clear();
    await keys.clear();
    await keys.save(keys.create({ name: 'master', keyPrefix: 'm', keyHash: 'm', role: ApiKeyRole.ADMIN }));
  });

  it('marks a password chosen by an admin or by ADMIN_PASSWORD as temporary', async () => {
    const created = await service.create({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    expect(created.mustChangePassword).toBe(true);

    await service.bootstrapAdmin({
      ADMIN_EMAIL: 'root@example.com',
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_PASSWORD_RESET: 'true',
    });
    expect(await users.findOneByOrFail({ email: 'root@example.com' })).toMatchObject({ mustChangePassword: true });
  });

  it('a password reset by another admin is temporary; one an admin sets for themselves is not', async () => {
    const admin = await service.create({
      email: 'adm@example.com',
      name: 'Adm',
      password: PASSWORD,
      role: ApiKeyRole.ADMIN,
    });
    const ana = await service.create({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    await users.update({ id: In([admin.id, ana.id]) }, { mustChangePassword: false });

    await service.update(ana.id, { password: 'reset by admin 1' }, admin);
    expect((await users.findOneByOrFail({ id: ana.id })).mustChangePassword).toBe(true);

    await service.update(admin.id, { password: 'my own password 1' }, admin);
    expect((await users.findOneByOrFail({ id: admin.id })).mustChangePassword).toBe(false);
  });

  it('setOwnPassword checks the current password, refuses reuse, clears the flag and ends other sign-ins', async () => {
    const ana = await service.create({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    const kept = await service.startSession(ana);
    const other = await service.startSession(ana);

    expect(await service.setOwnPassword(ana, 'brand new password', { currentPassword: 'wrong one!' })).toBe(false);
    await expect(service.setOwnPassword(ana, PASSWORD)).rejects.toThrow(BadRequestException);

    expect(
      await service.setOwnPassword(ana, 'brand new password', {
        currentPassword: PASSWORD,
        keepApiKeyId: kept.apiKey.id,
      }),
    ).toBe(true);
    const saved = await users.findOneByOrFail({ id: ana.id });
    expect(saved.mustChangePassword).toBe(false);
    expect(await verifyPassword('brand new password', saved.passwordHash)).toBe(true);
    expect((await sessions.find()).map(s => s.apiKeyId)).toEqual([kept.apiKey.id]);
    expect(await keys.findOneBy({ id: other.apiKey.id })).toBeNull();
  });
});
