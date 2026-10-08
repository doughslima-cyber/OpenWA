import { Entity, Column, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * Links an API key minted by a sign-in to the user it was minted for, so signing out, deactivating
 * or deleting a user can revoke exactly that user's keys. No FK: an admin may delete the key from
 * the API Keys page, and the orphan row is swept at the user's next sign-in.
 */
@Entity('user_sessions')
@Index('IDX_user_sessions_userId', ['userId'])
export class UserSession {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  apiKeyId!: string;

  @Column({ type: 'varchar', length: 36 })
  userId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
