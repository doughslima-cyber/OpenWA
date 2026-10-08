import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `users` and `user_sessions` tables on the **main** connection for email/password
 * sign-in. The main DB is always SQLite (boot config); `IF NOT EXISTS` keeps it idempotent.
 */
export class CreateUserTables1791000000000 implements MigrationInterface {
  name = 'CreateUserTables1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "users" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"email" varchar(254) NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"passwordHash" varchar(255) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"mustChangePassword" boolean NOT NULL DEFAULT (0), ` +
        `"lastLoginAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_sessions" (` +
        `"apiKeyId" varchar(36) PRIMARY KEY NOT NULL, ` +
        `"userId" varchar(36) NOT NULL, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_sessions_userId" ON "user_sessions" ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_sessions_userId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_sessions"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
