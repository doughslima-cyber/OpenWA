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
import { Session } from '../../modules/session/entities/session.entity';
import { dateColumnType } from '../../common/utils/column-types';
import { DateTransformer } from '../../common/transformers/date.transformer';

/**
 * A contact a `meta-cloud` session learned from an inbound message (OpenMsg, docs/32, door 5): the
 * Cloud API has no contact list, so the profile name and the last inbound `wamid` (which read
 * receipts and the typing indicator need) are kept here. One row per session and `wa_id`, deleted
 * with the session; excluded from `/infra` backups, since the next inbound message rebuilds it.
 */
@Entity('meta_cloud_contacts')
@Index('UQ_meta_cloud_contacts_sessionId_waId', ['sessionId', 'waId'], { unique: true })
export class MetaCloudContact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_meta_cloud_contacts_sessionId' })
  session!: Session;

  /** E.164 digits, as Meta sends `wa_id`. */
  @Column({ type: 'varchar', length: 32 })
  waId!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  profileName!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastInboundAt!: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  lastInboundWamid!: string | null;

  /** When the chat was last marked read through `sendSeen`; the unread count starts after it. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastSeenAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
