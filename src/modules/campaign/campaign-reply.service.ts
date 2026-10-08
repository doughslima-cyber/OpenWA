import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks';
import type { HookContext, HookResult } from '../../core/hooks/hook.interfaces';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { parseWaId } from '../../engine/identity/wa-id';
import { CampaignRecipient } from './entities/campaign-recipient.entity';

/** The `pluginId` the reply hook registers under in the HookManager. */
export const CAMPAIGN_REPLY_HOOK_ID = 'openmsg-campaigns';

/**
 * Priority of the reply hook: before every plugin (default 100), so a plugin that stops the chain with
 * `continue: false` cannot keep the recipient from being marked.
 */
export const CAMPAIGN_REPLY_HOOK_PRIORITY = 0;

/** The `campaign` field a reply's `message.received` carries (decision 6). */
export interface CampaignReplyTag {
  id: string;
  name: string;
}

/** The inbound message fields the hook reads; the rest of the payload passes through untouched. */
interface InboundLike {
  chatId?: unknown;
  fromMe?: unknown;
  isGroup?: unknown;
  isStatusBroadcast?: unknown;
}

/**
 * Marks a campaign recipient `replied` when the first message from its number arrives, and tags that
 * one `message.received` with `campaign: { id, name }` (criteria 15-17, OpenMsg).
 *
 * It is a `message:received` hook rather than an edit to the upstream MessageProjector (decision 6):
 * whatever the chain returns is what the projector persists and dispatches to the webhooks.
 */
@Injectable()
export class CampaignReplyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('CampaignReplyService');
  private hookId: string | null = null;

  constructor(
    private readonly hooks: HookManager,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipients: Repository<CampaignRecipient>,
    private readonly directory: LidMappingStoreService,
  ) {}

  onModuleInit(): void {
    this.hookId = this.hooks.register(
      CAMPAIGN_REPLY_HOOK_ID,
      'message:received',
      ctx => this.onMessageReceived(ctx),
      CAMPAIGN_REPLY_HOOK_PRIORITY,
    );
  }

  onModuleDestroy(): void {
    if (this.hookId) this.hooks.unregister(this.hookId);
    this.hookId = null;
  }

  /** The hook handler: the message unchanged, or tagged with its campaign when it marked a reply. */
  async onMessageReceived(ctx: HookContext): Promise<HookResult> {
    const message = ctx.data;
    if (!ctx.sessionId || !message || typeof message !== 'object') return { continue: true };
    try {
      const campaign = await this.markReply(ctx.sessionId, message);
      if (!campaign) return { continue: true };
      return { continue: true, data: { ...(message as Record<string, unknown>), campaign } };
    } catch (error) {
      // Best-effort: a failed lookup must never hold up or alter the message itself.
      this.logger.warn(`Could not check an inbound message against campaigns: ${String(error)}`, {
        sessionId: ctx.sessionId,
        action: 'campaign_reply_check_failed',
      });
      return { continue: true };
    }
  }

  /**
   * Mark the recipient this message answers, if any, and return its campaign. Null when the message is
   * not a contact's 1:1 message, when its chat does not resolve to a number, when no campaign sent to
   * that number, or when the latest campaign to reach it already counted its reply.
   */
  async markReply(sessionId: string, message: InboundLike): Promise<CampaignReplyTag | null> {
    if (message.fromMe === true || message.isGroup === true || message.isStatusBroadcast === true) return null;
    if (typeof message.chatId !== 'string') return null;
    // Only a contact's chat: groups, status, channels and broadcast lists never answer a campaign.
    const kind = parseWaId(message.chatId).kind;
    if (kind !== 'user' && kind !== 'lid') return null;

    const candidates = await resolveJidCandidates(message.chatId, {
      resolveLid: lid => this.directory.findPhoneForLid(lid),
      lidsForPhone: phone => this.directory.findLidsForPhone(phone),
    });
    // Recipients are stored as `<digits>@c.us` (decision 2); an unresolved lid yields no such form.
    const chatIds = candidates.filter(candidate => candidate.endsWith('@c.us'));
    if (chatIds.length === 0) return null;

    // The latest send to this number decides. When it was already answered, this is a later message
    // of a conversation that has started, not a reply to an older campaign (Landing, batch B).
    const latest = await this.recipients.findOne({
      where: { chatId: In(chatIds), status: In(['sent', 'replied']), campaign: { sessionId } },
      relations: { campaign: true },
      order: { sentAt: 'DESC' },
    });
    if (!latest || latest.status !== 'sent') return null;

    // Two messages racing through the chain both find the row; only one flips it.
    const flipped = await this.recipients.update(
      { id: latest.id, status: 'sent' },
      { status: 'replied', repliedAt: new Date() },
    );
    if (flipped.affected !== 1) return null;

    this.logger.log(`Campaign ${latest.campaignId}: a recipient replied`, {
      sessionId,
      campaignId: latest.campaignId,
      action: 'campaign_recipient_replied',
    });
    return { id: latest.campaign.id, name: latest.campaign.name };
  }
}
