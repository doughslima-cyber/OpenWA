import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Session } from '../../modules/session/entities/session.entity';
import { dateColumnType } from '../../common/utils/column-types';
import { DateTransformer } from '../../common/transformers/date.transformer';

/**
 * The WhatsApp Cloud API number a `meta-cloud` session is bound to (OpenMsg, docs/32 D2, door 3).
 *
 * One row per session, deleted with it. A number belongs to at most one session: the unique index
 * is what turns a second create for the same number, including two sent at once, into a 409.
 * The token is stored only encrypted (`meta-cloud-crypto.ts`) and never returned by any route;
 * the table is excluded from `/infra` backups.
 */
@Entity('meta_cloud_accounts')
@Index('UQ_meta_cloud_accounts_phoneNumberId', ['phoneNumberId'], { unique: true })
export class MetaCloudAccount {
  // varchar (not uuid) to match sessions.id, as on campaigns.
  @PrimaryColumn({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_meta_cloud_accounts_sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 64 })
  phoneNumberId!: string;

  @Column({ type: 'varchar', length: 64 })
  wabaId!: string;

  /** `v1.<iv>.<tag>.<ciphertext>`; NULL after a logout, until a new token is set. */
  @Column({ type: 'text', nullable: true })
  accessTokenEnc!: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  accessTokenLast4!: string | null;

  /** What Graph last reported for the number; NULL until the session first starts. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  displayPhoneNumber!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  verifiedName!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  qualityRating!: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  messagingLimitTier!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastCheckedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
