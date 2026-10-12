import { Injectable } from '@nestjs/common';
import type { MetaWebhookChangeValue } from './meta-cloud-inbound.mapper';

/** A live Cloud API session, as the webhook router hands it a change. */
export interface MetaCloudInboundTarget {
  readonly sessionId: string;
  handleWebhookChange(value: MetaWebhookChangeValue): Promise<void>;
}

/**
 * The Cloud API numbers whose session is live in this process, by `phone_number_id` (OpenMsg,
 * docs/32). An adapter registers its number when it reaches READY and removes it on disconnect,
 * logout and destroy; the webhook router reads it to find who a change belongs to.
 */
@Injectable()
export class MetaCloudNumberRegistry {
  private readonly live = new Map<string, MetaCloudInboundTarget>();

  register(phoneNumberId: string, target: MetaCloudInboundTarget): void {
    this.live.set(phoneNumberId, target);
  }

  /** Removes the number only while `target` holds it, so an old adapter cannot unregister its successor. */
  unregister(phoneNumberId: string, target: MetaCloudInboundTarget): void {
    if (this.live.get(phoneNumberId) === target) this.live.delete(phoneNumberId);
  }

  get(phoneNumberId: string): MetaCloudInboundTarget | undefined {
    return this.live.get(phoneNumberId);
  }
}
