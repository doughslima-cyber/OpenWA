import { BadGatewayException } from '@nestjs/common';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';
import { EngineStatus, type EngineEventCallbacks, type IWhatsAppEngine } from '../interfaces/whatsapp-engine.interface';
import type { MetaCloudAccountPort, MetaCloudCredentials } from './meta-cloud-account-store.service';
import { MetaGraphClient, MetaGraphError, isMetaTokenInvalid } from './meta-cloud-graph.client';

export interface MetaCloudAdapterOptions {
  sessionId: string;
  dbSessionId: string;
  accounts: MetaCloudAccountPort;
  graph?: MetaGraphClient;
}

/** The reasons a Cloud session reports through `onActionRequired`. */
export const META_TOKEN_INVALID = 'META_TOKEN_INVALID';
export const META_TOKEN_MISSING = 'META_TOKEN_MISSING';

const PROFILE_FIELDS = 'display_phone_number,verified_name,quality_rating,messaging_limit_tier';

interface PhoneNumberProfile {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
}

/**
 * WhatsApp Cloud API engine (OpenMsg, docs/32 D3). There is no socket and no QR: starting the session
 * reads the number from Graph, subscribes the app to the WABA's webhooks and reports READY. A refused
 * token moves the session to ACTION_REQUIRED, which only a new token and a restart clear.
 *
 * Methods this adapter does not define answer 501 through EngineNotSupportedError (see asEngine).
 */
export class MetaCloudAdapter {
  readonly sessionId: string;
  readonly dbSessionId: string;
  private readonly accounts: MetaCloudAccountPort;
  private readonly graph: MetaGraphClient;
  private readonly logger = createLogger('MetaCloudAdapter');
  private callbacks: EngineEventCallbacks = {};
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;

  constructor(options: MetaCloudAdapterOptions) {
    this.sessionId = options.sessionId;
    this.dbSessionId = options.dbSessionId;
    this.accounts = options.accounts;
    this.graph = options.graph ?? new MetaGraphClient();
  }

  /** The adapter as an engine: any method it does not define rejects with a 501. */
  asEngine(): IWhatsAppEngine {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        // `then` stays undefined so the engine is never mistaken for a promise when awaited.
        if (typeof prop !== 'string' || prop === 'then' || prop in target) {
          return Reflect.get(target, prop, receiver) as unknown;
        }
        return () => target.unsupported(prop);
      },
    }) as unknown as IWhatsAppEngine;
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    const credentials = await this.accounts.loadCredentials(this.dbSessionId);
    if (!credentials?.accessToken) {
      this.requireAction(META_TOKEN_MISSING);
      return;
    }
    const token = credentials.accessToken;

    let profile: PhoneNumberProfile;
    try {
      profile = await this.graph.request<PhoneNumberProfile>(
        'GET',
        `/${encodeURIComponent(credentials.phoneNumberId)}?fields=${PROFILE_FIELDS}`,
        token,
      );
      await this.graph.request('POST', `/${encodeURIComponent(credentials.wabaId)}/subscribed_apps`, token);
    } catch (error) {
      if (isMetaTokenInvalid(error)) {
        this.requireAction(META_TOKEN_INVALID);
        return;
      }
      // No callback: start() records the failure in lastError and lands the session in FAILED.
      this.status = EngineStatus.FAILED;
      throw this.startFailure(error);
    }

    await this.recordProfile(credentials, profile);
    this.phoneNumber = (profile.display_phone_number ?? '').replace(/\D/g, '');
    this.pushName = profile.verified_name ?? '';
    this.setStatus(EngineStatus.READY);
    this.callbacks.onReady?.(this.phoneNumber, this.pushName);
  }

  /**
   * One `GET /<PHONE_NUMBER_ID>` per probe. A refused token is not a dead connection: it moves the
   * session to ACTION_REQUIRED and answers true, so the watchdog does not restart into the same refusal.
   */
  async probeLiveness(): Promise<boolean> {
    const credentials = await this.accounts.loadCredentials(this.dbSessionId);
    if (!credentials?.accessToken) return false;
    try {
      await this.graph.request(
        'GET',
        `/${encodeURIComponent(credentials.phoneNumberId)}?fields=id`,
        credentials.accessToken,
      );
      return true;
    } catch (error) {
      if (isMetaTokenInvalid(error)) {
        this.requireAction(META_TOKEN_INVALID);
        return true;
      }
      return false;
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return null;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  disconnect(): Promise<void> {
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  /** As disconnect, and the stored token is cleared: starting again needs a new token. */
  async logout(): Promise<void> {
    await this.accounts.clearToken(this.dbSessionId);
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  destroy(): Promise<void> {
    this.setStatus(EngineStatus.DISCONNECTED);
    this.callbacks = {};
    return Promise.resolve();
  }

  forceDestroy(): Promise<void> {
    return this.destroy();
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  private requireAction(reason: string): void {
    this.logger.warn('Cloud API session needs a new access token', {
      sessionId: this.sessionId,
      reason,
      action: 'meta_action_required',
    });
    this.setStatus(EngineStatus.ACTION_REQUIRED);
    this.callbacks.onActionRequired?.(reason);
  }

  /** Graph unreachable or 5xx is a transport failure (503); any other Graph refusal is a 502. */
  private startFailure(error: unknown): Error {
    if (error instanceof MetaGraphError) {
      if (error.httpStatus >= 500) return new EngineTransportError(error.message);
      return new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: error.message,
        code: 'META_UPSTREAM_ERROR',
        metaCode: error.metaCode,
        fbtraceId: error.fbtraceId,
      });
    }
    return error instanceof Error ? error : new EngineTransportError(String(error));
  }

  /** Best effort: a failed write leaves GET .../meta/account one start behind, never the session down. */
  private async recordProfile(credentials: MetaCloudCredentials, profile: PhoneNumberProfile): Promise<void> {
    try {
      await this.accounts.recordProfile(this.dbSessionId, {
        displayPhoneNumber: profile.display_phone_number ?? null,
        verifiedName: profile.verified_name ?? null,
        qualityRating: profile.quality_rating ?? null,
        messagingLimitTier: profile.messaging_limit_tier ?? null,
      });
    } catch (error) {
      this.logger.warn('Could not record the Cloud API number profile', {
        sessionId: this.sessionId,
        phoneNumberId: credentials.phoneNumberId,
        error: error instanceof Error ? error.message : String(error),
        action: 'meta_profile_record_failed',
      });
    }
  }

  private unsupported(method: string): Promise<never> {
    return Promise.reject(new EngineNotSupportedError(method));
  }
}
