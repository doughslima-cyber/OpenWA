import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export const CAMPAIGN_STATUSES = ['running', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * Why a running campaign is not sending right now: the session's pacing allowance is spent (`pacing`,
 * with `nextAttemptAt`), WhatsApp restricts the account (`restricted`), or the session is not ready
 * (`disconnected`). Null while it sends.
 */
export const CAMPAIGN_WAIT_REASONS = ['pacing', 'restricted', 'disconnected'] as const;
export type CampaignWaitReason = (typeof CAMPAIGN_WAIT_REASONS)[number];

/**
 * One text sent to a list of numbers through one session, over as many days as the session's send
 * pacing needs (OpenMsg). The recipients and their state live in `campaign_recipients`; counts are
 * read from there rather than stored here, so the runner and the reply hook never race on a counter.
 *
 * At most one `running` campaign per session: the partial unique index is what refuses the second,
 * including two creates that arrive together.
 */
@Entity('campaigns')
@Index('IDX_campaigns_sessionId_createdAt', ['sessionId', 'createdAt'])
@Index('UQ_campaigns_session_running', ['sessionId'], { unique: true, where: `"status" = 'running'` })
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // varchar (not uuid) to match sessions.id, as on automation_rules.
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_campaigns_sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: CampaignStatus;

  /** Accepted recipients at creation; never changes. */
  @Column({ type: 'int' })
  total!: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  waitReason!: CampaignWaitReason | null;

  /** When the runner tries again after a pacing refusal; null for the other reasons. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  nextAttemptAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;
}
