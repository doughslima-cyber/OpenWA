import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { MetaCloudAccount } from '../../engine/adapters/meta-cloud-account.entity';
import type { MetaWebhookChangeValue } from '../../engine/adapters/meta-cloud-inbound.mapper';
import { MetaCloudNumberRegistry } from '../../engine/adapters/meta-cloud-number-registry';

type Obj = Record<string, unknown>;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Obj => (value && typeof value === 'object' ? (value as Obj) : {});

/** The `value` of every `messages` change, in `entry[]` then `changes[]` order; other fields are skipped. */
function messagesChanges(body: unknown): MetaWebhookChangeValue[] {
  const values: MetaWebhookChangeValue[] = [];
  for (const entry of list(obj(body).entry)) {
    for (const change of list(obj(entry).changes)) {
      const { field, value } = obj(change);
      if (field === 'messages') values.push(obj(value));
    }
  }
  return values;
}

/**
 * Hands each `messages` change of a verified `/api/meta-webhook` body to the session live in this
 * process for its `phone_number_id` (OpenMsg, docs/32). Every `entry[]` and `changes[]` is walked in
 * order; other fields (`account_update`, template and quality updates) are skipped, and a change for
 * a number no live session holds is logged and dropped: Meta has its 200 already (door 7).
 *
 * Before answering, the controller asks `knownNumbersNotLive` whether the body names a number this
 * gateway has an account for but no live session in this process (a restart, a session not started
 * yet). Such a body is refused with 503 so Meta redelivers it later (Landing 16); only a number with no
 * account at all reaches the drop above.
 */
@Injectable()
export class MetaCloudWebhookRouter {
  private readonly logger = createLogger('MetaCloudWebhookRouter');

  constructor(
    private readonly numbers: MetaCloudNumberRegistry,
    @InjectRepository(MetaCloudAccount, 'data') private readonly accounts: Repository<MetaCloudAccount>,
  ) {}

  /**
   * The `phone_number_id`s of the body's `messages` changes that have a stored account but no live
   * session in this process. One query for the distinct numbers not live here, none when all are live.
   */
  async knownNumbersNotLive(body: unknown): Promise<string[]> {
    const notLive = new Set<string>();
    for (const value of messagesChanges(body)) {
      const phoneNumberId = String(value.metadata?.phone_number_id ?? '');
      if (!this.numbers.get(phoneNumberId)) notLive.add(phoneNumberId);
    }
    if (notLive.size === 0) return [];
    const stored = await this.accounts.find({
      select: { phoneNumberId: true },
      where: { phoneNumberId: In([...notLive]) },
    });
    return stored.map(account => account.phoneNumberId);
  }

  async handle(body: unknown): Promise<void> {
    for (const value of messagesChanges(body)) await this.deliver(value);
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
