import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import type { MetaWebhookChangeValue } from '../../engine/adapters/meta-cloud-inbound.mapper';
import { MetaCloudNumberRegistry } from '../../engine/adapters/meta-cloud-number-registry';

type Obj = Record<string, unknown>;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Obj => (value && typeof value === 'object' ? (value as Obj) : {});

/**
 * Hands each `messages` change of a verified `/api/meta-webhook` body to the session live in this
 * process for its `phone_number_id` (OpenMsg, docs/32). Every `entry[]` and `changes[]` is walked in
 * order; other fields (`account_update`, template and quality updates) are skipped, and a change for
 * a number no live session holds is logged and dropped: Meta has its 200 already (door 7).
 */
@Injectable()
export class MetaCloudWebhookRouter {
  private readonly logger = createLogger('MetaCloudWebhookRouter');

  constructor(private readonly numbers: MetaCloudNumberRegistry) {}

  async handle(body: unknown): Promise<void> {
    for (const entry of list(obj(body).entry)) {
      for (const change of list(obj(entry).changes)) {
        const { field, value } = obj(change);
        if (field !== 'messages') continue;
        await this.deliver(obj(value));
      }
    }
  }

  private async deliver(value: MetaWebhookChangeValue): Promise<void> {
    const phoneNumberId = String(value.metadata?.phone_number_id ?? '');
    const target = this.numbers.get(phoneNumberId);
    if (!target) {
      this.logger.warn(`Dropped a Cloud API webhook change for phone_number_id ${phoneNumberId}: no live session`, {
        phoneNumberId,
        action: 'meta_webhook_unrouted',
      });
      return;
    }
    try {
      await target.handleWebhookChange(value);
    } catch (error) {
      this.logger.error(
        `Cloud API webhook change for phone_number_id ${phoneNumberId} failed`,
        error instanceof Error ? error.message : String(error),
        { sessionId: target.sessionId, phoneNumberId, action: 'meta_webhook_change_failed' },
      );
    }
  }
}
