import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { MetaCloudAccount } from '../../engine/adapters/meta-cloud-account.entity';
import { encryptMetaToken, parseMetaCloudKey } from '../../engine/adapters/meta-cloud-crypto';
import { META_CLOUD_ENGINE } from '../../engine/session-engine';
import { Session } from '../session/entities/session.entity';
import { MetaCloudCredentialsDto } from './dto/meta-cloud-credentials.dto';
import { MetaCloudAccountResponseDto } from './dto/meta-cloud-account.dto';

/**
 * The Cloud API account behind a `meta-cloud` session (OpenMsg, docs/32 D2): bound at create in the
 * same transaction as the session row, read and re-keyed through `.../meta/account`. The token is
 * encrypted before it reaches any query and is never logged or returned; only its last 4 characters are.
 */
@Injectable()
export class MetaCloudAccountService {
  private readonly logger = createLogger('MetaCloudAccountService');

  constructor(
    @InjectDataSource('data') private readonly dataSource: DataSource,
    @InjectRepository(MetaCloudAccount, 'data') private readonly accounts: Repository<MetaCloudAccount>,
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
  ) {}

  /** Saves the session row and its account row together: neither exists without the other. */
  async createSession(session: Session, credentials: MetaCloudCredentialsDto): Promise<Session> {
    const accessTokenEnc = encryptMetaToken(credentials.accessToken, this.requireKey());
    // Fast path; the unique index decides when two creates race past it.
    if (await this.accounts.existsBy({ phoneNumberId: credentials.phoneNumberId })) {
      throw phoneNumberInUse(credentials.phoneNumberId);
    }

    const saved = await this.dataSource.transaction(async manager => {
      const row = await manager.save(session);
      try {
        await manager.insert(MetaCloudAccount, {
          sessionId: row.id,
          phoneNumberId: credentials.phoneNumberId,
          wabaId: credentials.wabaId,
          accessTokenEnc,
          accessTokenLast4: last4(credentials.accessToken),
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw phoneNumberInUse(credentials.phoneNumberId);
        throw error;
      }
      return row;
    });
    this.logger.log('Cloud API number bound to a new session', {
      sessionId: saved.id,
      phoneNumberId: credentials.phoneNumberId,
      wabaId: credentials.wabaId,
      action: 'meta_account_created',
    });
    return saved;
  }

  async getAccount(sessionId: string, webhookUrl: string): Promise<MetaCloudAccountResponseDto> {
    return toResponse(await this.requireAccount(sessionId), webhookUrl);
  }

  /** Replaces the token; the session's next Graph call reads the new one. */
  async rotateToken(sessionId: string, accessToken: string, webhookUrl: string): Promise<MetaCloudAccountResponseDto> {
    const account = await this.requireAccount(sessionId);
    account.accessTokenEnc = encryptMetaToken(accessToken, this.requireKey());
    account.accessTokenLast4 = last4(accessToken);
    await this.accounts.update(
      { sessionId },
      { accessTokenEnc: account.accessTokenEnc, accessTokenLast4: account.accessTokenLast4 },
    );
    this.logger.log('Cloud API access token replaced', { sessionId, action: 'meta_token_rotated' });
    return toResponse(account, webhookUrl);
  }

  private requireKey(): Buffer {
    const key = parseMetaCloudKey();
    if (!key) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message:
          'WhatsApp Cloud API tokens cannot be stored: META_CLOUD_ENCRYPTION_KEY must be set to 32 bytes in base64',
        code: 'META_CLOUD_NOT_CONFIGURED',
      });
    }
    return key;
  }

  private async requireAccount(sessionId: string): Promise<MetaCloudAccount> {
    const session = await this.sessions.findOneBy({ id: sessionId });
    if (!session) throw new NotFoundException(`Session with id '${sessionId}' not found`);
    if (session.engine !== META_CLOUD_ENGINE) {
      throw new NotImplementedException(`Session '${sessionId}' is not a WhatsApp Cloud API session`);
    }
    const account = await this.accounts.findOneBy({ sessionId });
    if (!account) throw new NotFoundException(`Session '${sessionId}' has no WhatsApp Cloud API account`);
    return account;
  }
}

function phoneNumberInUse(phoneNumberId: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: `Phone number ID ${phoneNumberId} is already bound to another session`,
    code: 'META_PHONE_NUMBER_IN_USE',
  });
}

function last4(token: string): string {
  return token.slice(-4);
}

function toResponse(account: MetaCloudAccount, webhookUrl: string): MetaCloudAccountResponseDto {
  return {
    phoneNumberId: account.phoneNumberId,
    wabaId: account.wabaId,
    displayPhoneNumber: account.displayPhoneNumber ?? null,
    verifiedName: account.verifiedName ?? null,
    qualityRating: account.qualityRating ?? null,
    messagingLimitTier: account.messagingLimitTier ?? null,
    accessTokenLast4: account.accessTokenLast4 ?? null,
    webhookUrl,
  };
}
