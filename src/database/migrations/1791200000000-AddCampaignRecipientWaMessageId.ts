import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `waMessageId` to `campaign_recipients` (OpenMsg): the WhatsApp id of the message a recipient was
 * sent, so campaign metrics can read its delivery and read status from the `messages` row with that id.
 *
 * Recipients sent before this column existed are backfilled best effort: the earliest outgoing message
 * of the campaign's session to that chat, carrying the campaign's text, written after the campaign was
 * created. A recipient whose message has no row (or whose text a plugin rewrote) stays null, and its
 * metrics then count it as sent only.
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres. Idempotent: the
 * column check covers a database synchronize already built, and the backfill only fills nulls.
 */
export class AddCampaignRecipientWaMessageId1791200000000 implements MigrationInterface {
  name = 'AddCampaignRecipientWaMessageId1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('campaign_recipients');
    if (!table) return;
    if (!table.findColumnByName('waMessageId')) {
      await queryRunner.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "waMessageId" varchar NULL`);
    }

    await queryRunner.query(
      `UPDATE "campaign_recipients" SET "waMessageId" = (` +
        `SELECT m."waMessageId" FROM "messages" m, "campaigns" c ` +
        `WHERE c."id" = "campaign_recipients"."campaignId" AND m."sessionId" = c."sessionId" ` +
        `AND m."chatId" = "campaign_recipients"."chatId" AND m."direction" = 'outgoing' ` +
        `AND m."body" = c."text" AND m."createdAt" >= c."createdAt" AND m."waMessageId" IS NOT NULL ` +
        `ORDER BY m."createdAt" ASC LIMIT 1) ` +
        `WHERE "waMessageId" IS NULL AND "status" IN ('sent', 'replied')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('campaign_recipients');
    if (!table?.findColumnByName('waMessageId')) return;
    await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "waMessageId"`);
  }
}
