import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { MetaCloudAccount } from './meta-cloud-account.entity';
import { decryptMetaToken, parseMetaCloudKey } from './meta-cloud-crypto';

/** What a `meta-cloud` session needs to reach Graph; `accessToken` is null when none can be used. */
export interface MetaCloudCredentials {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string | null;
}

/** What Graph reports about the number, kept for `GET .../meta/account`. */
export interface MetaCloudProfile {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
}

/** The account rows as the Cloud adapter sees them (OpenMsg, docs/32). */
export interface MetaCloudAccountPort {
  loadCredentials(sessionId: string): Promise<MetaCloudCredentials | null>;
  recordProfile(sessionId: string, profile: MetaCloudProfile): Promise<void>;
  clearToken(sessionId: string): Promise<void>;
}

/**
 * Reads and updates `meta_cloud_accounts` for the Cloud adapter. Read on every Graph call, so a token
 * rotated through `PUT .../meta/account` is the one the session's next request sends.
 */
@Injectable()
export class MetaCloudAccountStore implements MetaCloudAccountPort {
  private readonly logger = createLogger('MetaCloudAccountStore');

  constructor(@InjectRepository(MetaCloudAccount, 'data') private readonly accounts: Repository<MetaCloudAccount>) {}

  async loadCredentials(sessionId: string): Promise<MetaCloudCredentials | null> {
    const row = await this.accounts.findOneBy({ sessionId });
    if (!row) return null;
    return { phoneNumberId: row.phoneNumberId, wabaId: row.wabaId, accessToken: this.decrypt(row) };
  }

  async recordProfile(sessionId: string, profile: MetaCloudProfile): Promise<void> {
    await this.accounts.update({ sessionId }, { ...profile, lastCheckedAt: new Date() });
  }

  async clearToken(sessionId: string): Promise<void> {
    await this.accounts.update({ sessionId }, { accessTokenEnc: null, accessTokenLast4: null });
  }

  /** A token that cannot be read (key unset or changed) is treated as no token: the operator sets it again. */
  private decrypt(row: MetaCloudAccount): string | null {
    if (!row.accessTokenEnc) return null;
    const key = parseMetaCloudKey();
    if (!key) {
      this.logger.warn('META_CLOUD_ENCRYPTION_KEY is unset or invalid; the stored Cloud API token cannot be read', {
        sessionId: row.sessionId,
        action: 'meta_token_unreadable',
      });
      return null;
    }
    try {
      return decryptMetaToken(row.accessTokenEnc, key);
    } catch {
      this.logger.warn('The stored Cloud API token does not decrypt with META_CLOUD_ENCRYPTION_KEY', {
        sessionId: row.sessionId,
        action: 'meta_token_unreadable',
      });
      return null;
    }
  }
}
