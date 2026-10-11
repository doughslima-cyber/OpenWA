import { DataSource } from 'typeorm';
import { AddCampaigns1791100000000 } from '../1791100000000-AddCampaigns';
import { AddCampaignRecipientWaMessageId1791200000000 } from '../1791200000000-AddCampaignRecipientWaMessageId';

describe('AddCampaignRecipientWaMessageId migration', () => {
  let ds: DataSource;
  const migration = new AddCampaignRecipientWaMessageId1791200000000();

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL)`);
    await ds.query(
      `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"waMessageId" varchar, "chatId" varchar NOT NULL, "body" text, "direction" varchar NOT NULL, ` +
        `"createdAt" datetime NOT NULL)`,
    );
    await ds.query(`INSERT INTO "sessions" ("id", "name") VALUES ('s1', 'one'), ('s2', 'two')`);
    await new AddCampaigns1791100000000().up(ds.createQueryRunner());
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  const campaign = (id: string, sessionId: string, text: string, createdAt: string) =>
    ds.query(
      `INSERT INTO "campaigns" ("id","sessionId","name","text","status","total","createdAt") VALUES (?,?,?,?,?,?,?)`,
      [id, sessionId, id, text, 'completed', 1, createdAt],
    );
  const recipient = (id: string, campaignId: string, chatId: string, status: string) =>
    ds.query(`INSERT INTO "campaign_recipients" ("id","campaignId","position","chatId","status") VALUES (?,?,?,?,?)`, [
      id,
      campaignId,
      0,
      chatId,
      status,
    ]);
  const message = (id: string, sessionId: string, chatId: string, body: string, direction: string, at: string) =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","waMessageId","chatId","body","direction","createdAt") VALUES (?,?,?,?,?,?,?)`,
      [id, sessionId, `wa-${id}`, chatId, body, direction, at],
    );
  const waMessageIds = async (): Promise<Record<string, string | null>> => {
    const rows: { id: string; waMessageId: string | null }[] = await ds.query(
      `SELECT "id", "waMessageId" FROM "campaign_recipients" ORDER BY "id"`,
    );
    return Object.fromEntries(rows.map(row => [row.id, row.waMessageId]));
  };

  it('adds the column and backfills each sent recipient with its own campaign message', async () => {
    await campaign('c1', 's1', 'Olá!', '2026-10-01 10:00:00');
    await campaign('c2', 's1', 'Olá!', '2026-10-05 10:00:00');
    await recipient('r1', 'c1', '111@c.us', 'sent');
    await recipient('r2', 'c1', '222@c.us', 'replied');
    await recipient('r3', 'c1', '333@c.us', 'failed');
    await recipient('r4', 'c2', '111@c.us', 'sent');
    await recipient('r5', 'c1', '444@c.us', 'sent');

    // Older than the campaign, other text, incoming, other session: none is a campaign message.
    await message('old', 's1', '111@c.us', 'Olá!', 'outgoing', '2026-09-30 10:00:00');
    await message('m1', 's1', '111@c.us', 'Olá!', 'outgoing', '2026-10-01 10:00:05');
    await message('m2', 's1', '222@c.us', 'Olá!', 'outgoing', '2026-10-01 10:00:10');
    await message('in2', 's1', '222@c.us', 'Oi', 'incoming', '2026-10-01 10:05:00');
    await message('m4', 's1', '111@c.us', 'Olá!', 'outgoing', '2026-10-05 10:00:05');
    await message('x4', 's1', '444@c.us', 'Outro texto', 'outgoing', '2026-10-01 10:00:20');
    await message('y4', 's2', '444@c.us', 'Olá!', 'outgoing', '2026-10-01 10:00:20');
    await message('m3', 's1', '333@c.us', 'Olá!', 'outgoing', '2026-10-01 10:00:15');

    await migration.up(ds.createQueryRunner());

    expect(await waMessageIds()).toEqual({ r1: 'wa-m1', r2: 'wa-m2', r3: null, r4: 'wa-m4', r5: null });
  });

  it('is a no-op the second time, keeps an id already recorded, and reverts idempotently', async () => {
    await migration.up(ds.createQueryRunner());
    await campaign('c1', 's1', 'Olá!', '2026-10-01 10:00:00');
    await recipient('r1', 'c1', '111@c.us', 'sent');
    await ds.query(`UPDATE "campaign_recipients" SET "waMessageId" = 'wa-engine'`);
    await message('m1', 's1', '111@c.us', 'Olá!', 'outgoing', '2026-10-01 10:00:05');

    await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();
    expect(await waMessageIds()).toEqual({ r1: 'wa-engine' });

    await migration.down(ds.createQueryRunner());
    const columns: { name: string }[] = await ds.query(`PRAGMA table_info("campaign_recipients")`);
    expect(columns.map(c => c.name)).not.toContain('waMessageId');
    await expect(migration.down(ds.createQueryRunner())).resolves.toBeUndefined();
  });
});
