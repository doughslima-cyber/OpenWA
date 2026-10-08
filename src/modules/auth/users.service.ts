import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { AuthService } from './auth.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { CreateUserDto, UpdateUserDto, USER_PASSWORD_MIN_LENGTH } from './dto/user.dto';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password-hash';
import { createLogger } from '../../common/services/logger.service';

/** Server-side lifetime of a sign-in key; the dashboard also drops it when the tab closes. */
export const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

@Injectable()
export class UsersService implements OnApplicationBootstrap {
  private readonly logger = createLogger('UsersService');

  constructor(
    @InjectRepository(User, 'main') private readonly users: Repository<User>,
    @InjectRepository(UserSession, 'main') private readonly sessions: Repository<UserSession>,
    private readonly authService: AuthService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrapAdmin(process.env);
  }

  /**
   * Seed the first admin from ADMIN_EMAIL / ADMIN_PASSWORD while no user exists. With
   * ADMIN_PASSWORD_RESET=true the same pair instead restores that account (active, admin, new
   * password) even when users exist: the recovery path when no other admin can reset it. Either way
   * the password is temporary, since it sits in the environment.
   */
  async bootstrapAdmin(env: NodeJS.ProcessEnv): Promise<void> {
    const email = env.ADMIN_EMAIL ? normalizeEmail(env.ADMIN_EMAIL) : '';
    const password = env.ADMIN_PASSWORD ?? '';
    if (!email || !password) return;
    if (password.length < USER_PASSWORD_MIN_LENGTH) {
      this.logger.error(`ADMIN_PASSWORD is shorter than ${USER_PASSWORD_MIN_LENGTH} characters; admin not seeded`);
      return;
    }

    const reset = env.ADMIN_PASSWORD_RESET === 'true';
    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      if (!reset) return;
      existing.passwordHash = await hashPassword(password);
      existing.role = ApiKeyRole.ADMIN;
      existing.isActive = true;
      existing.mustChangePassword = true;
      await this.users.save(existing);
      await this.revokeSessions(existing.id);
      this.logger.warn(`Admin ${email} restored from ADMIN_PASSWORD_RESET; unset it now`);
      return;
    }
    if (!reset && (await this.users.count()) > 0) return;

    await this.users.save(
      this.users.create({
        email,
        name: email.split('@')[0],
        passwordHash: await hashPassword(password),
        role: ApiKeyRole.ADMIN,
        isActive: true,
        mustChangePassword: true,
      }),
    );
    this.logger.log(`Admin user ${email} created from ADMIN_EMAIL`);
  }

  findAll(): Promise<User[]> {
    return this.users.find({ order: { createdAt: 'ASC' } });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** The user a sign-in key was minted for, or null for any other key. */
  async findByApiKey(apiKeyId: string): Promise<User | null> {
    const session = await this.sessions.findOne({ where: { apiKeyId } });
    return session ? this.users.findOne({ where: { id: session.userId } }) : null;
  }

  async create(dto: CreateUserDto): Promise<User> {
    const email = normalizeEmail(dto.email);
    if (await this.users.findOne({ where: { email } })) {
      throw conflict('EMAIL_TAKEN', 'A user with this email already exists');
    }
    return this.users.save(
      this.users.create({
        email,
        name: dto.name.trim(),
        passwordHash: await hashPassword(dto.password),
        role: dto.role ?? ApiKeyRole.OPERATOR,
        isActive: true,
        // The admin chose it, so it only gets the user in once.
        mustChangePassword: true,
      }),
    );
  }

  /**
   * Apply an admin's edit. A change to role, status or password ends the target's open sign-ins
   * (their keys carry the old role) except `keepApiKeyId`, the editor's own current key. A password
   * an admin sets for someone else is temporary, like the one chosen at creation.
   */
  async update(id: string, dto: UpdateUserDto, actor: User | null, keepApiKeyId?: string): Promise<User> {
    const user = await this.findOne(id);
    const demoted = dto.role !== undefined && dto.role !== ApiKeyRole.ADMIN;
    const deactivated = dto.isActive === false;
    if (actor?.id === user.id && (demoted || deactivated)) {
      throw conflict('SELF_LOCKOUT', 'You cannot remove your own admin access');
    }
    if (demoted || deactivated) await this.assertNotLastAdmin(user);

    const roleChanged = dto.role !== undefined && dto.role !== user.role;
    if (dto.name !== undefined) user.name = dto.name.trim();
    if (dto.role !== undefined) user.role = dto.role;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    if (dto.password !== undefined) {
      user.passwordHash = await hashPassword(dto.password);
      user.mustChangePassword = actor?.id !== user.id;
    }
    const saved = await this.users.save(user);

    if (roleChanged || deactivated || dto.password !== undefined) {
      await this.revokeSessions(user.id, keepApiKeyId);
    }
    return saved;
  }

  async remove(id: string, actor: User | null): Promise<User> {
    const user = await this.findOne(id);
    if (actor?.id === user.id) throw conflict('SELF_LOCKOUT', 'You cannot delete your own user');
    await this.assertNotLastAdmin(user);
    await this.revokeSessions(user.id);
    await this.users.delete({ id: user.id });
    return user;
  }

  /** The active user for these credentials, or null. Costs one scrypt either way. */
  async authenticate(email: string, password: string): Promise<User | null> {
    const user = await this.users.findOne({ where: { email: normalizeEmail(email) } });
    const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
    return user && valid && user.isActive ? user : null;
  }

  /**
   * Replace `user`'s password with one they chose and clear the temporary flag. With
   * `currentPassword` it is first checked (the account page); sign-in has already verified it.
   * Other sign-ins end, except `keepApiKeyId`. Returns false when `currentPassword` is wrong.
   */
  async setOwnPassword(
    user: User,
    newPassword: string,
    opts: { currentPassword?: string; keepApiKeyId?: string } = {},
  ): Promise<boolean> {
    if (opts.currentPassword !== undefined && !(await verifyPassword(opts.currentPassword, user.passwordHash))) {
      return false;
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'The new password must differ from the current one',
        code: 'SAME_PASSWORD',
      });
    }
    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    await this.users.save(user);
    await this.revokeSessions(user.id, opts.keepApiKeyId);
    return true;
  }

  /** Mint the sign-in key for `user` and record which user it belongs to. */
  async startSession(user: User): Promise<{ apiKey: ApiKey; rawKey: string }> {
    await this.sweepDeadSessions(user.id);
    const minted = await this.authService.createApiKey({
      name: `Login: ${user.email}`.slice(0, 100),
      role: user.role,
      expiresAt: new Date(Date.now() + USER_SESSION_TTL_MS).toISOString(),
    });
    await this.sessions.save(this.sessions.create({ apiKeyId: minted.apiKey.id, userId: user.id }));
    user.lastLoginAt = new Date();
    await this.users.save(user);
    return minted;
  }

  /** End the sign-in that minted `apiKeyId`. Returns the user, or null for a non-sign-in key. */
  async endSession(apiKeyId: string): Promise<User | null> {
    const user = await this.findByApiKey(apiKeyId);
    if (!user) return null;
    await this.dropKey(apiKeyId);
    return user;
  }

  private async revokeSessions(userId: string, keepApiKeyId?: string): Promise<void> {
    const where = keepApiKeyId ? { userId, apiKeyId: Not(keepApiKeyId) } : { userId };
    for (const session of await this.sessions.find({ where })) {
      await this.dropKey(session.apiKeyId);
    }
  }

  // Delete the key and its session row. A 409 from the last-admin guard (the key is the only
  // usable admin key left) or a key already gone still drops the row; an undeletable key expires.
  private async dropKey(apiKeyId: string): Promise<void> {
    try {
      await this.authService.delete(apiKeyId);
    } catch (err) {
      if (!(err instanceof ConflictException) && !(err instanceof NotFoundException)) throw err;
      this.logger.warn(`Sign-in key ${apiKeyId} not deleted: ${(err as Error).message}`);
    }
    await this.sessions.delete({ apiKeyId });
  }

  // Remove this user's session rows whose key was deleted, revoked or has expired.
  private async sweepDeadSessions(userId: string): Promise<void> {
    const rows = await this.sessions.find({ where: { userId } });
    if (rows.length === 0) return;
    const now = new Date();
    const keys = await this.authService.findAll();
    const live = new Set(keys.filter(k => k.isActive && (!k.expiresAt || k.expiresAt > now)).map(k => k.id));
    const dead = rows.filter(r => !live.has(r.apiKeyId)).map(r => r.apiKeyId);
    if (dead.length === 0) return;
    for (const id of dead) {
      if (keys.some(k => k.id === id)) await this.dropKey(id);
    }
    await this.sessions.delete({ apiKeyId: In(dead) });
  }

  private async assertNotLastAdmin(user: User): Promise<void> {
    if (user.role !== ApiKeyRole.ADMIN || !user.isActive) return;
    const otherAdmins = await this.users.count({
      where: { role: ApiKeyRole.ADMIN, isActive: true, id: Not(user.id) },
    });
    if (otherAdmins === 0) throw conflict('LAST_ADMIN', 'At least one active admin user must remain');
  }
}
