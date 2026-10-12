import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.engine` (OpenMsg, docs/32 D1): the engine a session runs when it is not the
 * deployment's. NULL means "follow ENGINE_TYPE", so there is deliberately no default and no backfill:
 * every existing row keeps its behaviour, and the ENGINE_TYPE switch still moves them all. The only
 * value ever written is 'meta-cloud'.
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres. Idempotent: the
 * column check covers a database synchronize already built.
 */
export class AddSessionEngine1791300000000 implements MigrationInterface {
  name = 'AddSessionEngine1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('sessions');
    if (!table || table.findColumnByName('engine')) return;
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "engine" varchar(30) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('sessions');
    if (!table?.findColumnByName('engine')) return;
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "engine"`);
  }
}
