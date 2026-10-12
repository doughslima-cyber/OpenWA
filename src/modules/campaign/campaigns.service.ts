import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { Session } from '../session/entities/session.entity';
import { META_CLOUD_ENGINE } from '../../engine/session-engine';
import { Message, MessageStatus } from '../message/entities/message.entity';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient, RECIPIENT_STATUSES, type RecipientStatus } from './entities/campaign-recipient.entity';
import { parseCampaignRecipients } from './campaign-recipients';
import { CampaignRunner } from './campaign-runner.service';
import {
  CAMPAIGN_RECIPIENTS_MAX,
  CAMPAIGN_RECIPIENTS_PAGE_DEFAULT,
  type CampaignCancelledDto,
  type CampaignCountsDto,
  type CampaignCreatedDto,
  type CampaignDetailDto,
  type CampaignMetricsDto,
  type CampaignRecipientPageDto,
  type CampaignSummaryDto,
  type CreateCampaignDto,
  type ListRecipientsQueryDto,
  type RecipientDelivery,
} from './dto/campaign.dto';

/** Rows per INSERT: 500 × 5 bound columns stays far under SQLite's parameter limit. */
const INSERT_CHUNK = 500;

/** The `{ statusCode, error, message, code }` body the dashboard maps to translated text. */
function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, error: 'Bad Request', message, code });
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', message, code });
}

/** Counts by current status, exclusive buckets summing to `total`. */
export function emptyCounts(): CampaignCountsDto {
  return { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, replied: 0, cancelled: 0 };
}

export function emptyMetrics(): CampaignMetricsDto {
  return { sent: 0, delivered: 0, read: 0, replied: 0, medianReplySeconds: null };
}

/** The recipient statuses whose message went out. */
const WENT_OUT: RecipientStatus[] = ['sent', 'replied'];

/** Median of a non-empty list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** How far a recipient's message got. A reply proves it was read, whatever acks WhatsApp reported. */
function deliveryOf(status: RecipientStatus, messageStatus: string | undefined): RecipientDelivery | null {
  if (!WENT_OUT.includes(status)) return null;
  if (status === 'replied' || messageStatus === MessageStatus.READ) return 'read';
  if (messageStatus === MessageStatus.DELIVERED) return 'delivered';
  return 'sent';
}

@Injectable()
export class CampaignsService {
  private readonly logger = createLogger('CampaignsService');

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipients: Repository<CampaignRecipient>,
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    // Absent only in specs that exercise the API without sending anything.
    @Optional()
    private readonly runner?: CampaignRunner,
  ) {}

  async create(sessionId: string, dto: CreateCampaignDto): Promise<CampaignCreatedDto> {
    await this.requireSession(sessionId);
    // A Cloud API session sends free text only inside Meta's 24 h window; campaigns there need
    // Meta templates, which docs/32 F4 adds. Until then they are refused before anything is written.
    if (await this.sessions.exists({ where: { id: sessionId, engine: META_CLOUD_ENGINE } })) {
      throw badRequest(
        'CAMPAIGN_ENGINE_UNSUPPORTED',
        'Campaigns are not available on a WhatsApp Cloud API session yet',
      );
    }
    const chatIds = parseCampaignRecipients(dto.recipients);
    if (chatIds.length === 0) {
      throw badRequest('CAMPAIGN_NO_RECIPIENTS', 'None of the recipients is a phone number with at least 6 digits');
    }
    if (chatIds.length > CAMPAIGN_RECIPIENTS_MAX) {
      throw badRequest(
        'CAMPAIGN_TOO_MANY_RECIPIENTS',
        `A campaign holds at most ${CAMPAIGN_RECIPIENTS_MAX} numbers; this list has ${chatIds.length}`,
      );
    }

    const campaign = {
      id: randomUUID(),
      sessionId,
      name: dto.name.trim(),
      text: dto.text,
      status: 'running' as const,
      total: chatIds.length,
      waitReason: null,
      nextAttemptAt: null,
      completedAt: null,
    };
    try {
      // The partial unique index on (sessionId) WHERE status = 'running' decides between two creates,
      // concurrent ones included: the loser's insert fails here.
      await this.campaigns.insert(campaign);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('CAMPAIGN_ALREADY_RUNNING', 'This session already has a running campaign');
      }
      throw error;
    }

    // No transaction around the two inserts: on SQLite every query runner shares one connection, so a
    // second create would run inside this one's. A failed recipient insert removes the campaign instead
    // (its recipients go with it), and the runner never completes a campaign whose rows are not all in.
    try {
      for (let start = 0; start < chatIds.length; start += INSERT_CHUNK) {
        await this.recipients.insert(
          chatIds.slice(start, start + INSERT_CHUNK).map((chatId, i) => ({
            id: randomUUID(),
            campaignId: campaign.id,
            position: start + i,
            chatId,
            status: 'pending' as const,
          })),
        );
      }
    } catch (error) {
      await this.campaigns.delete({ id: campaign.id }).catch(() => undefined);
      throw error;
    }

    this.logger.log(`Campaign ${campaign.id} created with ${chatIds.length} recipient(s)`, {
      sessionId,
      campaignId: campaign.id,
      action: 'campaign_created',
    });
    this.runner?.start(campaign.id);
    return { id: campaign.id, name: campaign.name, status: campaign.status, total: campaign.total };
  }

  async list(sessionId: string): Promise<CampaignSummaryDto[]> {
    await this.requireSession(sessionId);
    const rows = await this.campaigns.find({ where: { sessionId }, order: { createdAt: 'DESC', id: 'DESC' } });
    const ids = rows.map(row => row.id);
    const [counts, metrics] = await Promise.all([this.countsFor(ids), this.metricsFor(ids)]);
    return rows.map(row => this.summary(row, counts.get(row.id), metrics.get(row.id)));
  }

  async findOne(sessionId: string, campaignId: string): Promise<CampaignDetailDto> {
    const row = await this.requireCampaign(sessionId, campaignId);
    const [counts, metrics] = await Promise.all([this.countsFor([row.id]), this.metricsFor([row.id])]);
    const waiting =
      row.status === 'running' && row.waitReason ? { reason: row.waitReason, nextAttemptAt: row.nextAttemptAt } : null;
    return { ...this.summary(row, counts.get(row.id), metrics.get(row.id)), text: row.text, waiting };
  }

  async listRecipients(
    sessionId: string,
    campaignId: string,
    query: ListRecipientsQueryDto,
  ): Promise<CampaignRecipientPageDto> {
    const row = await this.requireCampaign(sessionId, campaignId);
    const where = query.status ? { campaignId: row.id, status: query.status } : { campaignId: row.id };
    const [items, total] = await this.recipients.findAndCount({
      where,
      order: { position: 'ASC' },
      take: query.limit ?? CAMPAIGN_RECIPIENTS_PAGE_DEFAULT,
      skip: query.offset ?? 0,
    });
    const messageStatus = await this.messageStatuses(row.sessionId, items);
    return {
      items: items.map(item => ({
        chatId: item.chatId,
        status: item.status,
        delivery: deliveryOf(item.status, item.waMessageId ? messageStatus.get(item.waMessageId) : undefined),
        sentAt: item.sentAt,
        repliedAt: item.repliedAt,
        error: item.errorCode ? { code: item.errorCode, message: item.errorMessage ?? '' } : null,
      })),
      total,
    };
  }

  /**
   * Cancel a running campaign. The campaign row flips first: every claim the runner makes is
   * conditioned on the campaign still running, so once this UPDATE lands no new send can start; the
   * pending recipients are then closed. A send already in the engine finishes as sent or failed.
   */
  async cancel(sessionId: string, campaignId: string): Promise<CampaignCancelledDto> {
    const row = await this.requireCampaign(sessionId, campaignId);
    const cancelled = await this.campaigns.update(
      { id: row.id, status: 'running' },
      { status: 'cancelled', completedAt: new Date(), waitReason: null, nextAttemptAt: null },
    );
    if (!cancelled.affected) {
      throw conflict(
        'CAMPAIGN_NOT_RUNNING',
        `Campaign is already ${row.status === 'running' ? 'finished' : row.status}`,
      );
    }
    await this.recipients.update({ campaignId: row.id, status: 'pending' }, { status: 'cancelled' });
    this.runner?.wake(row.id);
    this.logger.log(`Campaign ${row.id} cancelled`, { sessionId, campaignId: row.id, action: 'campaign_cancelled' });
    const counts = await this.countsFor([row.id]);
    return { id: row.id, status: 'cancelled', counts: counts.get(row.id) ?? emptyCounts() };
  }

  /** Recipients by status for each campaign, from one grouped query over the recipient index. */
  async countsFor(campaignIds: string[]): Promise<Map<string, CampaignCountsDto>> {
    const out = new Map<string, CampaignCountsDto>();
    if (campaignIds.length === 0) return out;
    const rows = await this.recipients
      .createQueryBuilder('r')
      .select('r.campaignId', 'campaignId')
      .addSelect('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where({ campaignId: In(campaignIds) })
      .groupBy('r.campaignId')
      .addGroupBy('r.status')
      .getRawMany<{ campaignId: string; status: RecipientStatus; count: string | number }>();
    for (const { campaignId, status, count } of rows) {
      const counts = out.get(campaignId) ?? emptyCounts();
      if ((RECIPIENT_STATUSES as readonly string[]).includes(status)) counts[status] += Number(count);
      counts.total += Number(count);
      out.set(campaignId, counts);
    }
    return out;
  }

  /**
   * Delivery, read and reply figures over each campaign's sent messages: one grouped query joining every
   * sent recipient to its `messages` row through the (sessionId, waMessageId) unique index, and one read
   * of the replied recipients' send and reply times for the median. A recipient without a message row
   * (sent before waMessageId was recorded, or whose row was cleared with its chat) counts as sent only.
   */
  async metricsFor(campaignIds: string[]): Promise<Map<string, CampaignMetricsDto>> {
    const out = new Map<string, CampaignMetricsDto>();
    if (campaignIds.length === 0) return out;
    const delivered = `CASE WHEN r.status = 'replied' OR m.status IN ('${MessageStatus.DELIVERED}', '${MessageStatus.READ}') THEN 1 ELSE 0 END`;
    const read = `CASE WHEN r.status = 'replied' OR m.status = '${MessageStatus.READ}' THEN 1 ELSE 0 END`;
    const rows = await this.recipients
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .leftJoin(Message, 'm', 'm.sessionId = c.sessionId AND m.waMessageId = r.waMessageId')
      .select('r.campaignId', 'campaignId')
      .addSelect('COUNT(*)', 'sent')
      .addSelect(`SUM(${delivered})`, 'delivered')
      .addSelect(`SUM(${read})`, 'read')
      .addSelect(`SUM(CASE WHEN r.status = 'replied' THEN 1 ELSE 0 END)`, 'replied')
      .where({ campaignId: In(campaignIds), status: In(WENT_OUT) })
      .groupBy('r.campaignId')
      .getRawMany<Record<'campaignId' | 'sent' | 'delivered' | 'read' | 'replied', string | number>>();
    for (const row of rows) {
      out.set(String(row.campaignId), {
        sent: Number(row.sent),
        delivered: Number(row.delivered),
        read: Number(row.read),
        replied: Number(row.replied),
        medianReplySeconds: null,
      });
    }

    const replies = await this.recipients.find({
      select: { campaignId: true, sentAt: true, repliedAt: true },
      where: { campaignId: In(campaignIds), status: 'replied' },
    });
    const waits = new Map<string, number[]>();
    for (const { campaignId, sentAt, repliedAt } of replies) {
      if (!sentAt || !repliedAt) continue;
      const seconds = Math.max(0, (repliedAt.getTime() - sentAt.getTime()) / 1000);
      waits.set(campaignId, [...(waits.get(campaignId) ?? []), seconds]);
    }
    for (const [campaignId, list] of waits) {
      const metrics = out.get(campaignId);
      if (metrics) metrics.medianReplySeconds = Math.round(median(list));
    }
    return out;
  }

  /** The `messages` status of each recipient's sent message, by WhatsApp id. */
  private async messageStatuses(sessionId: string, items: CampaignRecipient[]): Promise<Map<string, string>> {
    const ids = items.map(item => item.waMessageId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return new Map();
    const rows = await this.recipients.manager.getRepository(Message).find({
      select: { waMessageId: true, status: true },
      where: { sessionId, waMessageId: In(ids) },
    });
    return new Map(rows.map(row => [row.waMessageId, row.status]));
  }

  private summary(
    row: Campaign,
    counts: CampaignCountsDto | undefined,
    metrics: CampaignMetricsDto | undefined,
  ): CampaignSummaryDto {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      counts: counts ?? emptyCounts(),
      metrics: metrics ?? emptyMetrics(),
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  private async requireSession(sessionId: string): Promise<void> {
    if (!(await this.sessions.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
  }

  private async requireCampaign(sessionId: string, campaignId: string): Promise<Campaign> {
    const row = await this.campaigns.findOne({ where: { id: campaignId, sessionId } });
    if (!row) throw new NotFoundException(`Campaign '${campaignId}' not found`);
    return row;
  }
}
