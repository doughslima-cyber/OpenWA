import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { ApiKeyRole } from './api-key.entity';

/**
 * A dashboard user who signs in with email and password. Signing in mints an expiring API key with
 * the user's role (see UserSession), so authorization still runs entirely through the API-key guard.
 */
@Entity('users')
@Index('IDX_users_email', ['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Stored lower-cased and trimmed, so the unique index is case-insensitive in practice.
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 20, default: ApiKeyRole.OPERATOR })
  role!: ApiKeyRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // Set while the password is one an admin (or ADMIN_PASSWORD) chose: sign-in then mints no key
  // until the user picks their own.
  @Column({ type: 'boolean', default: false })
  mustChangePassword!: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
