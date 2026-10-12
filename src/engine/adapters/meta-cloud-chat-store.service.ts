import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetaCloudContact } from './meta-cloud-contact.entity';
import type { CloudContactSeen } from './meta-cloud-inbound.mapper';

/** The contact rows as the Cloud adapter writes them. */
export interface MetaCloudContactPort {
  recordInbound(sessionId: string, seen: CloudContactSeen): Promise<void>;
}

/**
 * What a `meta-cloud` session knows about its chats beyond the `messages` table (OpenMsg, docs/32,
 * door 5): one `meta_cloud_contacts` row per session and `wa_id`, holding the sender's profile name
 * and the last inbound `wamid`, which read receipts and the typing indicator answer to.
 */
@Injectable()
export class MetaCloudChatStore implements MetaCloudContactPort {
  constructor(@InjectRepository(MetaCloudContact, 'data') private readonly contacts: Repository<MetaCloudContact>) {}

  /** Upserts the sender's row on (sessionId, waId). A missing profile name keeps the one already stored. */
  async recordInbound(sessionId: string, seen: CloudContactSeen): Promise<void> {
    const fields = {
      lastInboundAt: seen.at,
      lastInboundWamid: seen.wamid,
      ...(seen.profileName ? { profileName: seen.profileName } : {}),
    };
    const updated = await this.contacts.update({ sessionId, waId: seen.waId }, fields);
    if (updated.affected) return;
    try {
      await this.contacts.insert({ sessionId, waId: seen.waId, profileName: seen.profileName, ...fields });
    } catch (error) {
      // A concurrent first message from the same sender inserted the row first: update that one.
      const retried = await this.contacts.update({ sessionId, waId: seen.waId }, fields);
      if (!retried.affected) throw error;
    }
  }
}
