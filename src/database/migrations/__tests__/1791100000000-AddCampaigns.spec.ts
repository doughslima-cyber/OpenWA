import { DataSource } from 'typeorm';
import { AddCampaigns1791100000000 } from '../1791100000000-AddCampaigns';

describe('AddCampaigns migration', () => {
  let ds: DataSource;
  const migration = new AddCampaigns1791100000000();

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query('PRAGMA foreign_keys = ON');
    await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL)`);
    await ds.query(`INSERT INTO "sessions" ("id", "name") VALUES ('s1', 'one'), ('s2', 'two')`);
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  const insertCampaign = (id: string, sessionId: string, status: string): Promise<unknown> =>
    ds.query(`INSERT INTO "campaigns" ("id","sessionId","name","text","status","total") VALUES (?,?,?,?,?,?)`, [
      id,
      sessionId,
      `c-${id}`,
      'hello',
      status,
      1,
    ]);
  const insertRecipient = (id: string, campaignId: string, chatId: string): Promise<unknown> =>
    ds.query(`INSERT INTO "campaign_recipients" ("id","campaignId","position","chatId","status") VALUES (?,?,?,?,?)`, [
      id,
      campaignId,
      0,
      chatId,
      'pending',
    ]);

  it('C16 creates both tables with the named indexes', async () => {
    await migration.up(ds.createQueryRunner());

    const campaignIndexes: { name: string }[] = await ds.query(`PRAGMA index_list("campaigns")`);
    expect(campaignIndexes.map(i => i.name)).toEqual(
      expect.arrayContaining(['IDX_campaigns_sessionId_createdAt', 'UQ_campaigns_session_running']),
    );
    const recipientIndexes: { name: string }[] = await ds.query(`PRAGMA index_list("campaign_recipients")`);
    expect(recipientIndexes.map(i => i.name)).toEqual(
      expect.arrayContaining([
        'UQ_campaign_recipients_campaign_chat',
        'IDX_campaign_recipients_campaign_status_position',
        'IDX_campaign_recipients_chatId_status',
      ]),
    );
  });

  it('C16 refuses a second recipient with the same chat in one campaign', async () => {
    await migration.up(ds.createQueryRunner());
    await insertCampaign('c1', 's1', 'completed');
    await insertCampaign('c2', 's1', 'completed');

    await insertRecipient('r1', 'c1', '5511988887777@c.us');
    await expect(insertRecipient('r2', 'c1', '5511988887777@c.us')).rejects.toThrow(/UNIQUE/);
    await expect(insertRecipient('r3', 'c2', '5511988887777@c.us')).resolves.toBeDefined();
  });

  it('C16 allows one running campaign per session, any number of finished ones', async () => {
    await migration.up(ds.createQueryRunner());

    await insertCampaign('c1', 's1', 'running');
    await expect(insertCampaign('c2', 's1', 'running')).rejects.toThrow(/UNIQUE/);
    await expect(insertCampaign('c3', 's1', 'completed')).resolves.toBeDefined();
    await expect(insertCampaign('c4', 's1', 'cancelled')).resolves.toBeDefined();
    await expect(insertCampaign('c5', 's2', 'running')).resolves.toBeDefined();
  });

  it('C16 deletes the campaigns and their recipients with the session', async () => {
    await migration.up(ds.createQueryRunner());
    await insertCampaign('c1', 's1', 'running');
    await insertRecipient('r1', 'c1', '5511988887777@c.us');

    await ds.query(`DELETE FROM "sessions" WHERE "id" = 's1'`);

    expect(await ds.query(`SELECT "id" FROM "campaigns"`)).toEqual([]);
    expect(await ds.query(`SELECT "id" FROM "campaign_recipients"`)).toEqual([]);
  });

  it('is a no-op when the tables already exist, and reverts idempotently', async () => {
    await migration.up(ds.createQueryRunner());
    await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();

    await migration.down(ds.createQueryRunner());
    const tables: unknown[] = await ds.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('campaigns','campaign_recipients')`,
    );
    expect(tables).toHaveLength(0);
    await expect(migration.down(ds.createQueryRunner())).resolves.toBeUndefined();
  });
});
