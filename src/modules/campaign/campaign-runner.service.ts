import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { createLogger } from '../../common/services/logger.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';
import { HookManager } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { MessageStatus } from '../message/entities/message.entity';
import {
  SendPacingService,
  countsTowardSendBreaker,
  isPacingLimitedError,
  sentNothing,
  type SettleAdmission,
} from '../message/send-pacing.service';
import { sanitizeBatchError } from '../message/bulk-message.service';
import { SessionService } from '../session/session.service';
import { SessionStatus } from '../session/entities/session.entity';
import { SessionOwnershipService, nodeOwnsSession } from '../session/session-ownership.service';
import { Campaign, type CampaignWaitReason } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';

/**
 * The clock the runner waits on. Production waits for real; specs replace it to advance a fake clock
 * and record every wait the runner asked for.
 */
export interface CampaignTiming {
  /** Wait `ms`, or less when `signal` aborts (a cancel, or shutdown). Never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A number in [0, 1), for the random part of the gap between sends. */
  random(): number;
  /** How often a waiting campaign looks again at its session (not ready, restricted, not owned here). */
  idlePollMs: number;
  /** How often every process looks for running campaigns it is not driving yet. */
  sweepMs: number;
}

export const CAMPAIGN_TIMING = Symbol('CAMPAIGN_TIMING');

/** The gap between two sends: the bulk default, 3 000 ms plus up to 2 000 ms at random (criterion 8). */
export const SEND_GAP_BASE_MS = 3000;
export const SEND_GAP_RANDOM_MS = 2000;

const DEFAULT_TIMING: CampaignTiming = {
  sleep: (ms, signal) => sleepFor(ms, undefined, { signal }).catch(() => undefined),
  random: Math.random,
  idlePollMs: 15_000,
  sweepMs: 60_000,
};

/** What one pass of the loop decided: wait this long and look again, or stop driving the campaign. */
type Step = { done: true } | { done: false; delayMs: number };

/** Per-loop memory. Nothing here is needed for correctness after a restart; the rows carry that. */
interface LoopState {
  /** Whether this node owned the session on the previous pass; a false → true edge reaps `sending` rows. */
  owned: boolean;
  /** The wait reason last written, so an unchanged wait is not rewritten on every poll. */
  waitReason: CampaignWaitReason | null;
  /** Aborts the current sleep: a cancel or shutdown wakes the loop instead of letting it sleep on. */
  wake: AbortController;
}

/**
 * Drives running campaigns: one recipient at a time, inside the session's send pacing, waiting out a
 * spent allowance, a restriction or a disconnected session, and resuming after a restart (OpenMsg).
 *
 * Every process keeps one loop per running campaign, but a loop sends only while this node owns the
 * campaign's session (SessionOwnershipService); elsewhere it idles and writes nothing. The guard
 * against a double send does not rest on that, though: a recipient is claimed with one conditional
 * UPDATE (pending → sending, while the campaign is running), and only the writer whose UPDATE changed
 * the row calls the engine. A row left `sending` by a process that is gone is failed with
 * SEND_INTERRUPTED rather than sent again, because WhatsApp may already have taken it.
 *
 * Plain code on the send path, like bulk: pacing first (a send policy forbids is not offered to
 * plugins), then the `message:sending` gate, then the claim, then the engine.
 */
@Injectable()
export class CampaignRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('CampaignRunner');
  private readonly timing: CampaignTiming;
  private readonly loops = new Map<string, { state: LoopState; done: Promise<void> }>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipients: Repository<CampaignRecipient>,
    private readonly engines: EngineRegistry,
    private readonly sessions: SessionService,
    private readonly pacing: SendPacingService,
    private readonly messages: MessageService,
    private readonly hookManager: HookManager,
    // Trailing @Optional, as in BulkMessageService: the running app always provides it; without it every
    // session reads as this node's, which is a single-process deployment.
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    @Optional()
    @Inject(CAMPAIGN_TIMING)
    timing?: CampaignTiming,
  ) {
    this.timing = timing ?? DEFAULT_TIMING;
  }

  /** Pick up every running campaign after a restart, then keep looking for ones started elsewhere. */
  async onApplicationBootstrap(): Promise<void> {
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.timing.sweepMs);
    this.sweepTimer.unref?.();
  }

  /** Stop every loop before TypeORM closes the database (onApplicationShutdown). */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const loops = [...this.loops.values()];
    for (const { state } of loops) state.wake.abort();
    // A loop in the middle of an engine call finishes it; bounded so a hung call cannot hold shutdown.
    await Promise.race([Promise.allSettled(loops.map(loop => loop.done)), sleepFor(5000, undefined, { ref: false })]);
  }

  /** Start driving every running campaign this process is not driving yet. */
  async sweep(): Promise<void> {
    try {
      const running = await this.campaigns.find({ where: { status: 'running' }, select: { id: true } });
      for (const { id } of running) this.start(id);
    } catch (error) {
      this.logger.warn(`Campaign sweep failed: ${String(error)}`);
    }
  }

  /** Drive a campaign from this process, unless a loop for it already runs here. */
  start(campaignId: string): void {
    if (this.stopping || this.loops.has(campaignId)) return;
    const state: LoopState = { owned: false, waitReason: null, wake: new AbortController() };
    const done = this.drive(campaignId, state).finally(() => this.loops.delete(campaignId));
    this.loops.set(campaignId, { state, done });
  }

  /** Cut the current wait short, so the loop re-reads its campaign now (after a cancel). */
  wake(campaignId: string): void {
    this.loops.get(campaignId)?.state.wake.abort();
  }

  /** Resolves when this process has stopped driving the campaign. For specs and shutdown. */
  whenStopped(campaignId: string): Promise<void> {
    return this.loops.get(campaignId)?.done ?? Promise.resolve();
  }

  private async drive(campaignId: string, state: LoopState): Promise<void> {
    while (!this.stopping) {
      let step: Step;
      try {
        const campaign = await this.campaigns.findOne({ where: { id: campaignId } });
        if (!campaign || campaign.status !== 'running') return;
        step = await this.step(campaign, state);
      } catch (error) {
        this.logger.error(`Campaign ${campaignId} pass failed: ${String(error)}`);
        step = { done: false, delayMs: this.timing.idlePollMs };
      }
      if (step.done) return;
      // A wake that landed during the pass skips the wait, so a cancel is seen on the next read.
      if (step.delayMs > 0 && !state.wake.signal.aborted) await this.timing.sleep(step.delayMs, state.wake.signal);
      if (state.wake.signal.aborted) state.wake = new AbortController();
    }
  }

  /** One pass: wait for the session, send to the next pending recipient, or complete the campaign. */
  private async step(campaign: Campaign, state: LoopState): Promise<Step> {
    const { sessionId } = campaign;
    if (!nodeOwnsSession(this.ownership, sessionId)) {
      state.owned = false;
      return { done: false, delayMs: this.timing.idlePollMs };
    }
    if (!state.owned) {
      state.owned = true;
      await this.reapInterrupted(campaign.id);
    }

    const blocker = await this.sessionBlocker(sessionId);
    if (blocker) {
      await this.setWait(campaign.id, state, blocker, null);
      return { done: false, delayMs: this.timing.idlePollMs };
    }

    const next = await this.recipients.findOne({
      where: { campaignId: campaign.id, status: 'pending' },
      order: { position: 'ASC' },
    });
    if (!next) return this.finishIfDone(campaign, state);
    return this.sendTo(campaign, next, state);
  }

  /** Why the session cannot send right now, or null when it can. */
  private async sessionBlocker(sessionId: string): Promise<CampaignWaitReason | null> {
    let status: SessionStatus;
    let restricted: boolean;
    try {
      const session = await this.sessions.findOne(sessionId);
      status = session.status;
      restricted = Boolean(session.restriction);
    } catch (error) {
      // A deleted session takes its campaigns with it (CASCADE); the next pass finds no campaign.
      if (error instanceof NotFoundException) return 'disconnected';
      throw error;
    }
    if (restricted) return 'restricted';
    if (status !== SessionStatus.READY || !this.engines.get(sessionId)) return 'disconnected';
    return null;
  }

  private async sendTo(campaign: Campaign, recipient: CampaignRecipient, state: LoopState): Promise<Step> {
    const { sessionId } = campaign;
    let settle: SettleAdmission | undefined;
    try {
      settle = await this.pacing.assertSendAllowed(sessionId, recipient.chatId, { untilSettled: true });
    } catch (error) {
      if (!isPacingLimitedError(error)) throw error;
      // A spent allowance (or an open breaker) is a wait, not a failure: the recipient stays pending and
      // nothing is tried before the refusal says it lifts (criterion 9).
      const retryAfterSeconds = Number(
        ((error as HttpException).getResponse() as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0,
      );
      const delayMs = Math.max(1, retryAfterSeconds) * 1000;
      await this.setWait(campaign.id, state, 'pacing', new Date(Date.now() + delayMs));
      return { done: false, delayMs };
    }

    let gated: { text: string } | { blocked: string };
    try {
      gated = await this.applySendingGate(sessionId, recipient.chatId, campaign.text);
    } catch (error) {
      settle?.();
      throw error;
    }

    if (!(await this.claim(recipient.id, campaign.id))) {
      // Another writer took this recipient, or the campaign stopped running: nothing was sent.
      settle?.();
      return { done: false, delayMs: 0 };
    }

    if ('blocked' in gated) {
      settle?.();
      await this.finishRecipient(recipient.id, 'failed', { errorCode: 'SEND_BLOCKED', errorMessage: gated.blocked });
      this.logger.warn(`Campaign ${campaign.id}: plugin blocked the send to ${recipient.chatId}`);
      return { done: false, delayMs: 0 };
    }

    const engine = this.engines.get(sessionId);
    if (!engine) {
      settle?.();
      await this.unclaim(recipient.id);
      await this.setWait(campaign.id, state, 'disconnected', null);
      return { done: false, delayMs: this.timing.idlePollMs };
    }

    try {
      const result = await engine.sendTextMessage(recipient.chatId, gated.text);
      settle?.(true);
      this.pacing.recordSendSuccess(sessionId);
      await this.finishRecipient(recipient.id, 'sent', { sentAt: new Date() });
      await this.clearWait(campaign.id, state);
      await this.persistSent(sessionId, recipient.chatId, gated.text, result.id, result.timestamp);
    } catch (error) {
      // The socket dropped or WhatsApp throttled before taking it: not this recipient's failure. It goes
      // back to pending and the campaign waits for the session.
      if (error instanceof EngineNotReadyError || error instanceof EngineThrottledError) {
        settle?.();
        await this.unclaim(recipient.id);
        await this.setWait(campaign.id, state, 'disconnected', null);
        return { done: false, delayMs: this.timing.idlePollMs };
      }
      if (countsTowardSendBreaker(error)) this.pacing.recordSendFailure(sessionId);
      settle?.(!sentNothing(error));
      const sanitized = sanitizeBatchError(error);
      await this.finishRecipient(recipient.id, 'failed', {
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
      });
      this.logger.warn(`Campaign ${campaign.id}: send to ${recipient.chatId} failed: ${sanitized.message}`);
      await this.hookManager
        .execute(
          'message:failed',
          { sessionId, error: sanitized.message, input: { text: gated.text, chatId: recipient.chatId }, type: 'text' },
          { sessionId, source: 'CampaignRunner' },
        )
        .catch(() => undefined);
    }
    return { done: false, delayMs: SEND_GAP_BASE_MS + Math.floor(this.timing.random() * SEND_GAP_RANDOM_MS) };
  }

  /**
   * The `message:sending` gate single and bulk sends run, so a moderation plugin sees campaign traffic
   * too. Returns the text to send (a plugin may rewrite it) or why it was refused. Fails closed on a
   * reply it cannot read, as bulk does.
   */
  private async applySendingGate(
    sessionId: string,
    chatId: string,
    text: string,
  ): Promise<{ text: string } | { blocked: string }> {
    const gate = await this.hookManager.execute(
      'message:sending',
      { sessionId, input: { text, chatId }, type: 'text' },
      { sessionId, source: 'CampaignRunner' },
    );
    if (!gate.continue) return { blocked: 'Message sending blocked by plugin' };
    const envelope = gate.data as { input?: { text?: unknown } } | null | undefined;
    if (envelope === undefined) return { text };
    const rewritten = envelope?.input?.text;
    if (typeof rewritten !== 'string' || !rewritten) {
      return { blocked: 'A message:sending handler returned a payload without a usable text' };
    }
    return { text: rewritten };
  }

  /**
   * pending → sending in one statement, only while the campaign runs. The single writer whose UPDATE
   * changed the row sends; a cancel committed first leaves the row pending (then cancelled).
   */
  private async claim(recipientId: string, campaignId: string): Promise<boolean> {
    const result = await this.recipients
      .createQueryBuilder()
      .update(CampaignRecipient)
      .set({ status: 'sending', claimedAt: new Date() })
      .where('"id" = :recipientId AND "status" = :pending', { recipientId, pending: 'pending' })
      .andWhere(`EXISTS (SELECT 1 FROM "campaigns" c WHERE c."id" = :campaignId AND c."status" = :running)`, {
        campaignId,
        running: 'running',
      })
      .execute();
    return result.affected === 1;
  }

  /** Give a claimed recipient back, for a send that provably never reached the engine. */
  private async unclaim(recipientId: string): Promise<void> {
    await this.recipients.update({ id: recipientId, status: 'sending' }, { status: 'pending', claimedAt: null });
  }

  private async finishRecipient(
    recipientId: string,
    status: 'sent' | 'failed',
    fields: Partial<Pick<CampaignRecipient, 'sentAt' | 'errorCode' | 'errorMessage'>>,
  ): Promise<void> {
    await this.recipients.update({ id: recipientId, status: 'sending' }, { status, ...fields });
  }

  /**
   * Fail the rows a previous holder of the session left `sending` (criterion 13). Runs when this node
   * starts owning the session, boot included, before this loop claims anything itself.
   */
  private async reapInterrupted(campaignId: string): Promise<void> {
    const reaped = await this.recipients.update(
      { campaignId, status: 'sending' },
      {
        status: 'failed',
        errorCode: 'SEND_INTERRUPTED',
        errorMessage: 'The gateway stopped while this message was being sent; it was not sent again',
      },
    );
    if (reaped.affected) {
      this.logger.warn(`Campaign ${campaignId}: ${reaped.affected} interrupted send(s) marked failed`);
    }
  }

  /** Complete the campaign once every recipient row is in and none is pending or sending. */
  private async finishIfDone(campaign: Campaign, state: LoopState): Promise<Step> {
    const [open, all] = await Promise.all([
      this.recipients.count({ where: { campaignId: campaign.id, status: In(['pending', 'sending']) } }),
      this.recipients.count({ where: { campaignId: campaign.id } }),
    ]);
    // A row still `sending` belongs to a send in flight on another node; the create may still be inserting.
    if (open > 0 || all < campaign.total) return { done: false, delayMs: this.timing.idlePollMs };
    const completed = await this.campaigns.update(
      { id: campaign.id, status: 'running' },
      { status: 'completed', completedAt: new Date(), waitReason: null, nextAttemptAt: null },
    );
    state.waitReason = null;
    if (completed.affected) {
      this.logger.log(`Campaign ${campaign.id} completed`, {
        sessionId: campaign.sessionId,
        campaignId: campaign.id,
        action: 'campaign_completed',
      });
    }
    return { done: true };
  }

  private async setWait(
    campaignId: string,
    state: LoopState,
    reason: CampaignWaitReason,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    if (state.waitReason === reason && reason !== 'pacing') return;
    await this.campaigns.update({ id: campaignId, status: 'running' }, { waitReason: reason, nextAttemptAt });
    state.waitReason = reason;
  }

  private async clearWait(campaignId: string, state: LoopState): Promise<void> {
    if (state.waitReason === null) return;
    await this.campaigns.update({ id: campaignId, status: 'running' }, { waitReason: null, nextAttemptAt: null });
    state.waitReason = null;
  }

  /**
   * Record the send like any other outgoing message, so it shows in the chat and counts in the session's
   * pacing tallies. Best effort: a message that went out must never turn into a failed recipient.
   */
  private async persistSent(
    sessionId: string,
    chatId: string,
    text: string,
    waMessageId: string,
    timestamp: number,
  ): Promise<void> {
    try {
      await this.messages.saveOutgoingMessage(sessionId, {
        waMessageId,
        chatId,
        body: text,
        type: 'text',
        timestamp,
        status: MessageStatus.SENT,
      });
    } catch (error) {
      this.logger.warn(`Campaign message persisted-after-send failed: ${String(error)}`);
    }
  }
}
