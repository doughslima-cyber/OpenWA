import { Body, Controller, HttpCode, HttpException, HttpStatus, NotFoundException, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentApiKey, Public, RequireUnscopedKey } from './decorators/auth.decorators';
import { ApiKey } from './entities/api-key.entity';
import { ChangePasswordDto, LoginDto, LoginResponseDto } from './dto/user.dto';
import { normalizeEmail, UsersService } from './users.service';
import { toUserResponse } from './users.controller';
import { EngineFactory } from '../../engine/engine.factory';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SlidingWindowLimiter } from '../events/ws-rate-limit';
import { limiterKeyForIp, resolveClientIp } from '../../common/utils/ip';

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(): HttpException {
  return new HttpException(
    { statusCode: 429, error: 'Too Many Requests', message: 'Too many sign-in attempts', code: 'TOO_MANY_ATTEMPTS' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@ApiTags('auth')
@Controller('auth')
export class AuthLoginController {
  // Failed attempts per client and per account. A success refunds its attempt, so the budgets
  // count failures: guessing one account's password and spraying many accounts are both bounded.
  private readonly perIp = new SlidingWindowLimiter(20, ATTEMPT_WINDOW_MS);
  private readonly perEmail = new SlidingWindowLimiter(5, ATTEMPT_WINDOW_MS);
  // Wrong current passwords on the account page, per user: a stolen open session cannot be used
  // to guess the password behind it.
  private readonly perUser = new SlidingWindowLimiter(5, ATTEMPT_WINDOW_MS);

  constructor(
    private readonly usersService: UsersService,
    private readonly engineFactory: EngineFactory,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({
    status: 200,
    description:
      'Signed in with an expiring API key, or passwordChangeRequired: the password is temporary and no key was minted.',
    type: LoginResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or newPassword equals the temporary password (code SAME_PASSWORD).',
  })
  @ApiResponse({ status: 401, description: 'Invalid email or password, or the user is deactivated.' })
  @ApiResponse({ status: 429, description: 'Too many failed sign-in attempts from this client or for this email.' })
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    const ipAddress = resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
    const email = normalizeEmail(dto.email);
    const ipSubject = limiterKeyForIp(ipAddress);
    const allowedByIp = this.perIp.allow(ipSubject);
    const allowedByEmail = allowedByIp && this.perEmail.allow(email);
    if (!allowedByIp || !allowedByEmail) {
      if (allowedByIp) this.perIp.refund(ipSubject);
      throw tooManyAttempts();
    }

    const user = await this.usersService.authenticate(email, dto.password);
    if (!user) {
      await this.auditService.logWarn(AuditAction.USER_LOGIN_FAILED, {
        ipAddress,
        method: req.method,
        path: req.path,
        metadata: { email },
      });
      throw new HttpException(
        { statusCode: 401, error: 'Unauthorized', message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.perIp.refund(ipSubject);
    this.perEmail.refund(email);
    // A temporary password proves who the user is but mints nothing until they choose their own,
    // so the admin who set it never holds a working session for them.
    if (user.mustChangePassword) {
      if (!dto.newPassword) return { passwordChangeRequired: true };
      await this.usersService.setOwnPassword(user, dto.newPassword);
      await this.auditService.logInfo(AuditAction.USER_PASSWORD_CHANGED, {
        ipAddress,
        method: req.method,
        path: req.path,
        metadata: { userId: user.id, email: user.email, via: 'sign-in' },
      });
    }
    const { apiKey, rawKey } = await this.usersService.startSession(user);
    await this.auditService.logInfo(AuditAction.USER_LOGIN, {
      apiKey,
      ipAddress,
      method: req.method,
      path: req.path,
      metadata: { userId: user.id, email: user.email },
    });
    return {
      passwordChangeRequired: false,
      apiKey: rawKey,
      expiresAt: apiKey.expiresAt as Date,
      role: apiKey.role,
      engineType: this.engineFactory.getCurrentEngine(),
      scoped: false,
      user: toUserResponse(user),
    };
  }

  @Post('me/password')
  @RequireUnscopedKey()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the signed-in user password' })
  @ApiResponse({ status: 204, description: 'Password changed; the other sign-ins of this user end.' })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, the current password is wrong (code WRONG_PASSWORD), or the new one equals it (SAME_PASSWORD).',
  })
  @ApiResponse({ status: 404, description: 'The calling key was not minted by a sign-in.' })
  @ApiResponse({ status: 429, description: 'Too many wrong current passwords for this user.' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<void> {
    const user = apiKey ? await this.usersService.findByApiKey(apiKey.id) : null;
    if (!user) throw new NotFoundException('No dashboard user signed in with this key');
    if (!this.perUser.allow(user.id)) throw tooManyAttempts();

    const changed = await this.usersService.setOwnPassword(user, dto.newPassword, {
      currentPassword: dto.currentPassword,
      keepApiKeyId: apiKey?.id,
    });
    if (!changed) {
      // 400, not 401: the dashboard treats a 401 as an unusable key and signs the user out.
      throw new HttpException(
        { statusCode: 400, error: 'Bad Request', message: 'The current password is wrong', code: 'WRONG_PASSWORD' },
        HttpStatus.BAD_REQUEST,
      );
    }
    this.perUser.refund(user.id);
    await this.auditService.logInfo(AuditAction.USER_PASSWORD_CHANGED, {
      apiKey,
      method: req.method,
      path: req.path,
      metadata: { userId: user.id, email: user.email, via: 'account' },
    });
  }

  @Post('logout')
  @RequireUnscopedKey()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out: delete the calling sign-in key' })
  @ApiResponse({ status: 204, description: 'Signed out. A key not minted by a sign-in is left untouched.' })
  async logout(@Req() req: Request, @CurrentApiKey() apiKey?: ApiKey): Promise<void> {
    if (!apiKey) return;
    const user = await this.usersService.endSession(apiKey.id);
    if (!user) return;
    await this.auditService.logInfo(AuditAction.USER_LOGOUT, {
      apiKey,
      method: req.method,
      path: req.path,
      metadata: { userId: user.id, email: user.email },
    });
  }
}
