import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetaCloudContact } from '../../engine/adapters/meta-cloud-contact.entity';
import { Session } from '../session/entities/session.entity';
import type { MetaChatWindowResponseDto } from './dto/meta-cloud-templates.dto';
import { requireCloudSession } from './meta-cloud-templates.service';

/** How long after the customer's last message free-form messages are allowed. */
export const META_SERVICE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The 24-hour customer service window of a Cloud chat (OpenMsg, docs/32 F3 door 5), read from the
 * last inbound time F2 records on the chat's `meta_cloud_contacts` row.
 */
@Injectable()
export class MetaCloudWindowService {
  constructor(
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    @InjectRepository(MetaCloudContact, 'data') private readonly contacts: Repository<MetaCloudContact>,
  ) {}

  async window(sessionId: string, chatId: string): Promise<MetaChatWindowResponseDto> {
    await requireCloudSession(this.sessions, sessionId);
    const waId = /^(\d+)(?:@c\.us|@s\.whatsapp\.net)?$/.exec(chatId)?.[1];
    const row = waId ? await this.contacts.findOneBy({ sessionId, waId }) : null;
    if (!row?.lastInboundAt) return { lastInboundAt: null, open: false, closesAt: null };
    const closesAt = row.lastInboundAt.getTime() + META_SERVICE_WINDOW_MS;
    return {
      lastInboundAt: row.lastInboundAt.toISOString(),
      open: closesAt > Date.now(),
      closesAt: new Date(closesAt).toISOString(),
    };
  }
}
