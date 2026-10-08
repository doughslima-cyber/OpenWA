import 'reflect-metadata';
import { HttpException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthLoginController } from './auth-login.controller';
import { UsersController, toUserResponse } from './users.controller';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import type { UsersService } from './users.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

const user = (over: Partial<User> = {}): User =>
  Object.assign(new User(), {
    id: 'u1',
    email: 'ana@example.com',
    name: 'Ana',
    role: ApiKeyRole.ADMIN,
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    passwordHash: 'scrypt$secret',
    ...over,
  });

const key = (over: Partial<ApiKey> = {}): ApiKey =>
  Object.assign(new ApiKey(), {
    id: 'k1',
    role: ApiKeyRole.ADMIN,
    expiresAt: new Date('2026-01-08T00:00:00Z'),
    ...over,
  });

const req = (ip = '203.0.113.7') =>
  ({ method: 'POST', path: '/api/auth/login', socket: { remoteAddress: ip }, headers: {} }) as unknown as Request;

function setup() {
  const usersService = {
    authenticate: jest.fn(),
    startSession: jest.fn(),
    endSession: jest.fn(),
    setOwnPassword: jest.fn().mockResolvedValue(true),
    findByApiKey: jest.fn(),
  };
  const audit = { logInfo: jest.fn(), logWarn: jest.fn() };
  const controller = new AuthLoginController(
    usersService as unknown as UsersService,
    { getCurrentEngine: () => 'baileys' } as never,
    audit as unknown as AuditService,
    { get: () => [] } as never,
  );
  return { controller, usersService, audit };
}

describe('AuthLoginController', () => {
  it('returns the sign-in key, role, engine and user (never the password hash)', async () => {
    const { controller, usersService, audit } = setup();
    usersService.authenticate.mockResolvedValue(user());
    usersService.startSession.mockResolvedValue({ apiKey: key(), rawKey: 'owa_k1_raw' });

    const res = await controller.login({ email: ' ANA@example.com ', password: 'pw' }, req());

    expect(usersService.authenticate).toHaveBeenCalledWith('ana@example.com', 'pw');
    expect(res).toEqual({
      passwordChangeRequired: false,
      apiKey: 'owa_k1_raw',
      expiresAt: new Date('2026-01-08T00:00:00Z'),
      role: ApiKeyRole.ADMIN,
      engineType: 'baileys',
      scoped: false,
      user: {
        id: 'u1',
        email: 'ana@example.com',
        name: 'Ana',
        role: ApiKeyRole.ADMIN,
        isActive: true,
        mustChangePassword: false,
        lastLoginAt: undefined,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    expect(JSON.stringify(res)).not.toContain('scrypt');
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_LOGIN,
      expect.objectContaining({ ipAddress: '203.0.113.7', metadata: { userId: 'u1', email: 'ana@example.com' } }),
    );
  });

  it('answers 401 for bad credentials and audits the failure', async () => {
    const { controller, usersService, audit } = setup();
    usersService.authenticate.mockResolvedValue(null);

    await expect(controller.login({ email: 'ana@example.com', password: 'bad' }, req())).rejects.toMatchObject({
      status: 401,
    });
    expect(usersService.startSession).not.toHaveBeenCalled();
    expect(audit.logWarn).toHaveBeenCalledWith(
      AuditAction.USER_LOGIN_FAILED,
      expect.objectContaining({ metadata: { email: 'ana@example.com' } }),
    );
  });

  it('locks an email after 5 failures without locking other emails', async () => {
    const { controller, usersService } = setup();
    usersService.authenticate.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) {
      await expect(controller.login({ email: 'ana@example.com', password: 'bad' }, req())).rejects.toMatchObject({
        status: 401,
      });
    }
    const locked = controller.login({ email: 'ana@example.com', password: 'bad' }, req());
    await expect(locked).rejects.toBeInstanceOf(HttpException);
    await expect(locked).rejects.toMatchObject({ status: 429 });
    expect(usersService.authenticate).toHaveBeenCalledTimes(5);

    await expect(controller.login({ email: 'bia@example.com', password: 'bad' }, req())).rejects.toMatchObject({
      status: 401,
    });
  });

  it('locks a client IP after 20 failures across emails', async () => {
    const { controller, usersService } = setup();
    usersService.authenticate.mockResolvedValue(null);
    for (let i = 0; i < 20; i++) {
      await expect(controller.login({ email: `u${i}@example.com`, password: 'bad' }, req())).rejects.toMatchObject({
        status: 401,
      });
    }
    await expect(controller.login({ email: 'new@example.com', password: 'bad' }, req())).rejects.toMatchObject({
      status: 429,
    });
    await expect(
      controller.login({ email: 'new@example.com', password: 'bad' }, req('198.51.100.1')),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does not count successful sign-ins against the budget', async () => {
    const { controller, usersService } = setup();
    usersService.authenticate.mockResolvedValue(user());
    usersService.startSession.mockResolvedValue({ apiKey: key(), rawKey: 'raw' });
    for (let i = 0; i < 10; i++) {
      await controller.login({ email: 'ana@example.com', password: 'pw' }, req());
    }
    expect(usersService.startSession).toHaveBeenCalledTimes(10);
  });

  it('a temporary password mints no key until the user chooses their own', async () => {
    const { controller, usersService, audit } = setup();
    usersService.authenticate.mockResolvedValue(user({ mustChangePassword: true }));
    usersService.startSession.mockResolvedValue({ apiKey: key(), rawKey: 'raw' });

    expect(await controller.login({ email: 'ana@example.com', password: 'temp' }, req())).toEqual({
      passwordChangeRequired: true,
    });
    expect(usersService.startSession).not.toHaveBeenCalled();

    const res = await controller.login(
      { email: 'ana@example.com', password: 'temp', newPassword: 'mine mine mine' },
      req(),
    );
    expect(usersService.setOwnPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'mine mine mine');
    expect(res).toMatchObject({ passwordChangeRequired: false, apiKey: 'raw' });
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_PASSWORD_CHANGED,
      expect.objectContaining({ metadata: expect.objectContaining({ via: 'sign-in' }) as unknown }),
    );
  });

  it('a newPassword sent for a password that is not temporary is ignored', async () => {
    const { controller, usersService } = setup();
    usersService.authenticate.mockResolvedValue(user());
    usersService.startSession.mockResolvedValue({ apiKey: key(), rawKey: 'raw' });
    await controller.login({ email: 'ana@example.com', password: 'pw', newPassword: 'other other' }, req());
    expect(usersService.setOwnPassword).not.toHaveBeenCalled();
  });

  describe('POST /auth/me/password', () => {
    const dto = { currentPassword: 'current pw', newPassword: 'new password!' };

    it('changes the password of the user behind the key, keeping this session', async () => {
      const { controller, usersService, audit } = setup();
      usersService.findByApiKey.mockResolvedValue(user());
      await controller.changePassword(dto, req(), key());
      expect(usersService.setOwnPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'new password!', {
        currentPassword: 'current pw',
        keepApiKeyId: 'k1',
      });
      expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.USER_PASSWORD_CHANGED, expect.anything());
    });

    it('answers 400 WRONG_PASSWORD (never 401) and locks after 5 wrong attempts', async () => {
      const { controller, usersService } = setup();
      usersService.findByApiKey.mockResolvedValue(user());
      usersService.setOwnPassword.mockResolvedValue(false);
      for (let i = 0; i < 5; i++) {
        await expect(controller.changePassword(dto, req(), key())).rejects.toMatchObject({ status: 400 });
      }
      await expect(controller.changePassword(dto, req(), key())).rejects.toMatchObject({ status: 429 });
    });

    it('answers 404 for a key no sign-in minted', async () => {
      const { controller, usersService } = setup();
      usersService.findByApiKey.mockResolvedValue(null);
      await expect(controller.changePassword(dto, req(), key())).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.changePassword(dto, req(), undefined)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('logout ends a sign-in session and audits it; other keys are a no-op', async () => {
    const { controller, usersService, audit } = setup();
    usersService.endSession.mockResolvedValueOnce(user()).mockResolvedValueOnce(null);

    await controller.logout(req(), key());
    expect(usersService.endSession).toHaveBeenCalledWith('k1');
    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.USER_LOGOUT, expect.anything());

    audit.logInfo.mockClear();
    await controller.logout(req(), key({ id: 'master' }));
    await controller.logout(req(), undefined);
    expect(audit.logInfo).not.toHaveBeenCalled();
  });
});

describe('UsersController', () => {
  function users() {
    const usersService = {
      findAll: jest.fn().mockResolvedValue([user()]),
      findOne: jest.fn().mockResolvedValue(user({ role: ApiKeyRole.OPERATOR })),
      findByApiKey: jest.fn().mockResolvedValue(user({ id: 'actor' })),
      create: jest.fn().mockResolvedValue(user()),
      update: jest.fn().mockResolvedValue(user()),
      remove: jest.fn().mockResolvedValue(user()),
    };
    const audit = { logInfo: jest.fn() };
    const controller = new UsersController(usersService as unknown as UsersService, audit as unknown as AuditService);
    return { controller, usersService, audit };
  }

  it('lists users without password hashes', async () => {
    const { controller } = users();
    const list = await controller.findAll();
    expect(list).toEqual([toUserResponse(user())]);
    expect(JSON.stringify(list)).not.toContain('scrypt');
  });

  it('creates, updates and deletes with an audit row each, passing the acting user', async () => {
    const { controller, usersService, audit } = users();
    const actor = key({ id: 'actor-key' });

    await controller.create({ email: 'ana@example.com', name: 'Ana', password: 'x'.repeat(10) }, req(), actor);
    expect(audit.logInfo).toHaveBeenLastCalledWith(AuditAction.USER_CREATED, expect.anything());

    await controller.update('u1', { role: ApiKeyRole.ADMIN, password: 'y'.repeat(10) }, req(), actor);
    expect(usersService.update).toHaveBeenCalledWith(
      'u1',
      { role: ApiKeyRole.ADMIN, password: 'y'.repeat(10) },
      expect.objectContaining({ id: 'actor' }),
      'actor-key',
    );
    const [action, ctx] = audit.logInfo.mock.lastCall as [AuditAction, { metadata: Record<string, unknown> }];
    expect(action).toBe(AuditAction.USER_UPDATED);
    expect(ctx.metadata).toMatchObject({ before: { role: ApiKeyRole.OPERATOR }, passwordChanged: true });
    expect(JSON.stringify(audit.logInfo.mock.calls)).not.toContain('y'.repeat(10));

    await controller.remove('u1', req(), actor);
    expect(usersService.remove).toHaveBeenCalledWith('u1', expect.objectContaining({ id: 'actor' }));
    expect(audit.logInfo).toHaveBeenLastCalledWith(AuditAction.USER_DELETED, expect.anything());
  });

  it('treats a request without a key as no acting user', async () => {
    const { controller, usersService } = users();
    await controller.update('u1', { name: 'A' }, req(), undefined);
    await controller.remove('u1', req(), undefined);
    expect(usersService.findByApiKey).not.toHaveBeenCalled();
    expect(usersService.update).toHaveBeenCalledWith('u1', { name: 'A' }, null, undefined);
  });
});
