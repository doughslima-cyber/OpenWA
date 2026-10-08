import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `campaigns` and `campaign_recipients` (OpenMsg): a text sent to a list of numbers through one
 * session over as many days as send pacing needs. Both foreign keys CASCADE: a campaign has no meaning
 * once its session is gone, nor a recipient once its campaign is.
 *
 * `UQ_campaigns_session_running` is a partial unique index: one `running` campaign per session, which
 * is what turns a second concurrent create into a 409 instead of two campaigns sharing one allowance.
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres; the `hasTable`
 * guard keeps it idempotent where synchronize already created the tables. The DDL matches what
 * synchronize emits from the entities (dateColumnType() is `text` on SQLite, @CreateDateColumn is
 * `datetime`), so the migration-drift gate sees no difference.
 */
export class AddCampaigns1791100000000 implements MigrationInterface {
  name = 'AddCampaigns1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const id = isPostgres
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    const ts = isPostgres ? 'timestamp' : 'text';
    const created = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : `(datetime('now'))`;
    const onUpdate = isPostgres ? '' : ' ON UPDATE NO ACTION';

    if (!(await queryRunner.hasTable('campaigns'))) {
      await queryRunner.query(
        `CREATE TABLE "campaigns" (${id}, "sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, ` +
          `"text" text NOT NULL, "status" varchar(20) NOT NULL, "total" integer NOT NULL, ` +
          `"waitReason" varchar(20), "nextAttemptAt" ${ts}, ` +
          `"createdAt" ${created} NOT NULL DEFAULT ${now}, "updatedAt" ${created} NOT NULL DEFAULT ${now}, ` +
          `"completedAt" ${ts}, ` +
          `CONSTRAINT "FK_campaigns_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE${onUpdate})`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_campaigns_sessionId_createdAt" ON "campaigns" ("sessionId", "createdAt")`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_campaigns_session_running" ON "campaigns" ("sessionId") WHERE "status" = 'running'`,
      );
    }

    if (!(await queryRunner.hasTable('campaign_recipients'))) {
      await queryRunner.query(
        `CREATE TABLE "campaign_recipients" (${id}, "campaignId" varchar NOT NULL, "position" integer NOT NULL, ` +
          `"chatId" varchar NOT NULL, "status" varchar(20) NOT NULL, "claimedAt" ${ts}, "sentAt" ${ts}, ` +
          `"repliedAt" ${ts}, "errorCode" varchar(40), "errorMessage" text, ` +
          `CONSTRAINT "FK_campaign_recipients_campaignId" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE${onUpdate})`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_campaign_recipients_campaign_chat" ON "campaign_recipients" ("campaignId", "chatId")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_campaign_recipients_campaign_status_position" ON "campaign_recipients" ("campaignId", "status", "position")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_campaign_recipients_chatId_status" ON "campaign_recipients" ("chatId", "status")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where up() took the hasTable
    // early return and the named indexes were never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_chatId_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_campaign_status_position"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_campaign_recipients_campaign_chat"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaign_recipients"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_campaigns_session_running"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaigns_sessionId_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaigns"`);
  }
}
