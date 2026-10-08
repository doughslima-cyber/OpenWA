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
  type CampaignRecipientPageDto,
  type CampaignSummaryDto,
  type CreateCampaignDto,
  type ListRecipientsQueryDto,
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
    const counts = await this.countsFor(rows.map(row => row.id));
    return rows.map(row => this.summary(row, counts.get(row.id)));
  }

  async findOne(sessionId: string, campaignId: string): Promise<CampaignDetailDto> {
    const row = await this.requireCampaign(sessionId, campaignId);
    const counts = await this.countsFor([row.id]);
    const waiting =
      row.status === 'running' && row.waitReason ? { reason: row.waitReason, nextAttemptAt: row.nextAttemptAt } : null;
    return { ...this.summary(row, counts.get(row.id)), text: row.text, waiting };
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
    return {
      items: items.map(item => ({
        chatId: item.chatId,
        status: item.status,
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

  private summary(row: Campaign, counts: CampaignCountsDto | undefined): CampaignSummaryDto {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      counts: counts ?? emptyCounts(),
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
