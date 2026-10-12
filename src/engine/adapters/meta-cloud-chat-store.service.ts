import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { Message, MessageDirection } from '../../modules/message/entities/message.entity';
import type { ChatSummary, Contact, IncomingMessage, MessageType } from '../interfaces/whatsapp-engine.interface';
import { MetaCloudContact } from './meta-cloud-contact.entity';
import type { CloudContactSeen } from './meta-cloud-inbound.mapper';

/** The contact rows and the stored messages as the Cloud adapter writes and reads them. */
export interface MetaCloudContactPort {
  recordInbound(sessionId: string, seen: CloudContactSeen): Promise<void>;
  getChats(sessionId: string): Promise<ChatSummary[]>;
  getChatHistory(sessionId: string, chatId: string, limit: number): Promise<IncomingMessage[]>;
  getContactById(sessionId: string, contactId: string): Promise<Contact | null>;
  /** The `wamid` of the chat's last inbound message, which read receipts and the typing indicator answer to. */
  lastInboundWamid(sessionId: string, waId: string): Promise<string | null>;
  /** Records the chat as read at `at`: the unread count starts after it. */
  markSeen(sessionId: string, waId: string, at: Date): Promise<void>;
}

/** The `wa_id` of a phone-number chat id (`<digits>@c.us`), or null for any other id. */
export function cloudWaId(chatId: string): string | null {
  return /^(\d+)@c\.us$/.exec(chatId)?.[1] ?? null;
}

/**
 * What a `meta-cloud` session knows about its chats (OpenMsg, docs/32 D6, door 5). The Cloud API has
 * no server-side chat list or history, so both are read from the gateway's own `messages` table, and
 * each sender's profile name, last inbound `wamid` and last read mark from one `meta_cloud_contacts`
 * row per session and `wa_id`.
 */
@Injectable()
export class MetaCloudChatStore implements MetaCloudContactPort {
  constructor(
    @InjectRepository(MetaCloudContact, 'data') private readonly contacts: Repository<MetaCloudContact>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
  ) {}

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

  /**
   * One summary per `chatId` in the session's messages, newest chat first: its last message, the
   * sender's profile name (else the name stored on its messages, else the number), and the inbound
   * messages newer than the chat's last `sendSeen` as unread.
   */
  async getChats(sessionId: string): Promise<ChatSummary[]> {
    const chats = await this.messages
      .createQueryBuilder('m')
      .select('m.chatId', 'chatId')
      .where('m.sessionId = :sessionId', { sessionId })
      .groupBy('m.chatId')
      .getRawMany<{ chatId: string }>();
    const known = new Map((await this.contacts.findBy({ sessionId })).map(row => [row.waId, row]));

    const summaries: ChatSummary[] = [];
    for (const { chatId } of chats) {
      const last = await this.messages.findOne({
        where: { sessionId, chatId },
        order: { timestamp: 'DESC', createdAt: 'DESC' },
      });
      if (!last) continue;
      const contact = known.get(cloudWaId(chatId) ?? '');
      const seenAt = contact?.lastSeenAt ?? null;
      const unreadCount = await this.messages.countBy({
        sessionId,
        chatId,
        direction: MessageDirection.INCOMING,
        ...(seenAt ? { timestamp: MoreThan(seenAt.getTime() / 1000) } : {}),
      });
      summaries.push({
        id: chatId,
        name: contact?.profileName || (await this.storedChatName(sessionId, chatId)) || chatId.split('@')[0],
        isGroup: false,
        kind: 'individual',
        unreadCount,
        timestamp: last.timestamp ?? 0,
        lastMessage: last.body ?? '',
        lastMessageType: last.type as MessageType,
        archived: false,
        pinned: false,
        muted: false,
      });
    }
    return summaries.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** The chat's most recent `limit` messages, oldest first (ChatHistoryCapability.getChatHistory). */
  async getChatHistory(sessionId: string, chatId: string, limit: number): Promise<IncomingMessage[]> {
    const rows = await this.messages.find({
      where: { sessionId, chatId },
      order: { timestamp: 'DESC', createdAt: 'DESC' },
      take: limit,
    });
    return rows.reverse().map(row => ({
      id: row.waMessageId,
      from: row.from,
      to: row.to,
      chatId: row.chatId,
      body: row.body ?? '',
      type: row.type as MessageType,
      timestamp: row.timestamp ?? 0,
      fromMe: row.direction === MessageDirection.OUTGOING,
      isGroup: false,
      kind: 'individual',
    }));
  }

  /** The contact a Cloud session learned from an inbound message, or null for one it never heard from. */
  async getContactById(sessionId: string, contactId: string): Promise<Contact | null> {
    const waId = cloudWaId(contactId);
    if (!waId) return null;
    const row = await this.contacts.findOneBy({ sessionId, waId });
    if (!row) return null;
    return {
      id: `${waId}@c.us`,
      ...(row.profileName ? { name: row.profileName, pushName: row.profileName } : {}),
      number: waId,
      isMyContact: false,
      isBlocked: false,
    };
  }

  async lastInboundWamid(sessionId: string, waId: string): Promise<string | null> {
    return (await this.contacts.findOneBy({ sessionId, waId }))?.lastInboundWamid ?? null;
  }

  async markSeen(sessionId: string, waId: string, at: Date): Promise<void> {
    await this.contacts.update({ sessionId, waId }, { lastSeenAt: at });
  }

  /** The sender name the newest inbound message of the chat carried, when the contact row has none. */
  private async storedChatName(sessionId: string, chatId: string): Promise<string | undefined> {
    const row = await this.messages.findOne({
      where: { sessionId, chatId, direction: MessageDirection.INCOMING },
      order: { timestamp: 'DESC', createdAt: 'DESC' },
    });
    return row?.chatName ?? undefined;
  }
}
