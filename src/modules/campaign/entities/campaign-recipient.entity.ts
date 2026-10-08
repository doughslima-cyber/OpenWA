import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Campaign } from './campaign.entity';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'replied', 'cancelled'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/**
 * One number of a campaign. `chatId` is always `<digits>@c.us`, whatever form the operator typed or the
 * engine answers with, so a reply can be matched to it (see CampaignReplyService).
 *
 * `sending` is held only while the engine call runs. A row found `sending` by a process that did not
 * start that call is failed with SEND_INTERRUPTED, never sent again: WhatsApp may already have it.
 */
@Entity('campaign_recipients')
@Index('UQ_campaign_recipients_campaign_chat', ['campaignId', 'chatId'], { unique: true })
@Index('IDX_campaign_recipients_campaign_status_position', ['campaignId', 'status', 'position'])
@Index('IDX_campaign_recipients_chatId_status', ['chatId', 'status'])
export class CampaignRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  campaignId!: string;

  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId', foreignKeyConstraintName: 'FK_campaign_recipients_campaignId' })
  campaign!: Campaign;

  /** Order in the operator's list; the runner sends in this order. */
  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'varchar' })
  chatId!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: RecipientStatus;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  claimedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  repliedAt!: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
