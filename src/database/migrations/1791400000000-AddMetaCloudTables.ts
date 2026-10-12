import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `meta_cloud_accounts` and `meta_cloud_contacts` (OpenMsg, docs/32 D2, doors 3 and 5).
 *
 * `meta_cloud_accounts` holds the Cloud API number of a `meta-cloud` session, one row per session
 * (PK `sessionId`), with the token encrypted. `UQ_meta_cloud_accounts_phoneNumberId` binds a number to
 * one session, which is what turns two creates for the same number, even sent together, into a 409.
 * `meta_cloud_contacts` keeps what inbound messages taught about each contact, one row per session
 * and `wa_id`. Both foreign keys CASCADE: neither row means anything once its session is gone.
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres; the `hasTable`
 * guard keeps it idempotent where synchronize already created the tables. The DDL matches what
 * synchronize emits from the entities, so the migration-drift gate sees no difference.
 */
export class AddMetaCloudTables1791400000000 implements MigrationInterface {
  name = 'AddMetaCloudTables1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const uuid = isPostgres
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    const ts = isPostgres ? 'timestamp' : 'text';
    const created = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : `(datetime('now'))`;
    const onUpdate = isPostgres ? '' : ' ON UPDATE NO ACTION';

    if (!(await queryRunner.hasTable('meta_cloud_accounts'))) {
      await queryRunner.query(
        `CREATE TABLE "meta_cloud_accounts" ("sessionId" varchar PRIMARY KEY NOT NULL, ` +
          `"phoneNumberId" varchar(64) NOT NULL, "wabaId" varchar(64) NOT NULL, "accessTokenEnc" text, ` +
          `"accessTokenLast4" varchar(4), "displayPhoneNumber" varchar(32), "verifiedName" varchar(256), ` +
          `"qualityRating" varchar(20), "messagingLimitTier" varchar(30), "lastCheckedAt" ${ts}, ` +
          `"createdAt" ${created} NOT NULL DEFAULT ${now}, "updatedAt" ${created} NOT NULL DEFAULT ${now}, ` +
          `CONSTRAINT "FK_meta_cloud_accounts_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE${onUpdate})`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_meta_cloud_accounts_phoneNumberId" ON "meta_cloud_accounts" ("phoneNumberId")`,
      );
    }

    if (!(await queryRunner.hasTable('meta_cloud_contacts'))) {
      await queryRunner.query(
        `CREATE TABLE "meta_cloud_contacts" (${uuid}, "sessionId" varchar NOT NULL, "waId" varchar(32) NOT NULL, ` +
          `"profileName" varchar(256), "lastInboundAt" ${ts}, "lastInboundWamid" varchar(128), "lastSeenAt" ${ts}, ` +
          `"createdAt" ${created} NOT NULL DEFAULT ${now}, "updatedAt" ${created} NOT NULL DEFAULT ${now}, ` +
          `CONSTRAINT "FK_meta_cloud_contacts_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE${onUpdate})`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_meta_cloud_contacts_sessionId_waId" ON "meta_cloud_contacts" ("sessionId", "waId")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where up() took the hasTable
    // early return and the named indexes were never created by this migration.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_meta_cloud_contacts_sessionId_waId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "meta_cloud_contacts"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_meta_cloud_accounts_phoneNumberId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "meta_cloud_accounts"`);
  }
}
