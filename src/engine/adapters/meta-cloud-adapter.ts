import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import type { IWhatsAppEngine } from '../interfaces/whatsapp-engine.interface';

export interface MetaCloudAdapterOptions {
  sessionId: string;
  dbSessionId: string;
}

/**
 * WhatsApp Cloud API engine (OpenMsg, docs/32). A placeholder until the adapter lands: every
 * interface method answers 501 through EngineNotSupportedError, so a Cloud session can be selected
 * and started without anything pretending to succeed.
 */
export class MetaCloudAdapter {
  readonly sessionId: string;
  readonly dbSessionId: string;

  constructor(options: MetaCloudAdapterOptions) {
    this.sessionId = options.sessionId;
    this.dbSessionId = options.dbSessionId;
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

  private unsupported(method: string): Promise<never> {
    return Promise.reject(new EngineNotSupportedError(method));
  }
}
