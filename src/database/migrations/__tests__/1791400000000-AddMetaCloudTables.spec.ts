import { DataSource } from 'typeorm';
import { AddMetaCloudTables1791400000000 } from '../1791400000000-AddMetaCloudTables';

describe('AddMetaCloudTables migration', () => {
  let ds: DataSource;
  const migration = new AddMetaCloudTables1791400000000();

  type ForeignKey = { table: string; from: string; to: string; on_delete: string };
  type IndexInfo = { name: string; unique: number };
  type PkColumn = { name: string; pk: number };

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

  const insertAccount = (sessionId: string, phoneNumberId: string): Promise<unknown> =>
    ds.query(`INSERT INTO "meta_cloud_accounts" ("sessionId","phoneNumberId","wabaId") VALUES (?,?,?)`, [
      sessionId,
      phoneNumberId,
      '102290129340398',
    ]);
  const insertContact = (id: string, sessionId: string, waId: string): Promise<unknown> =>
    ds.query(`INSERT INTO "meta_cloud_contacts" ("id","sessionId","waId") VALUES (?,?,?)`, [id, sessionId, waId]);
  const count = async (table: string): Promise<number> =>
    Number((await ds.query<{ n: number }[]>(`SELECT COUNT(*) AS n FROM "${table}"`))[0].n);

  it('C36 creates meta_cloud_accounts with PK sessionId, a cascading FK to sessions and the unique phoneNumberId index', async () => {
    await migration.up(ds.createQueryRunner());

    const columns: PkColumn[] = await ds.query(`PRAGMA table_info("meta_cloud_accounts")`);
    expect(columns.filter(c => c.pk > 0).map(c => c.name)).toEqual(['sessionId']);
    const fks: ForeignKey[] = await ds.query(`PRAGMA foreign_key_list("meta_cloud_accounts")`);
    expect(fks).toEqual([
      expect.objectContaining({ table: 'sessions', from: 'sessionId', to: 'id', on_delete: 'CASCADE' }),
    ]);
    const indexes: IndexInfo[] = await ds.query(`PRAGMA index_list("meta_cloud_accounts")`);
    expect(indexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'UQ_meta_cloud_accounts_phoneNumberId', unique: 1 })]),
    );
  });

  it('C36 refuses a second account for the same phoneNumberId', async () => {
    await migration.up(ds.createQueryRunner());
    await insertAccount('s1', '106540352242922');

    await expect(insertAccount('s2', '106540352242922')).rejects.toThrow(/UNIQUE/);
  });

  it('C36 creates meta_cloud_contacts with a cascading FK and the unique (sessionId, waId) index', async () => {
    await migration.up(ds.createQueryRunner());

    const fks: ForeignKey[] = await ds.query(`PRAGMA foreign_key_list("meta_cloud_contacts")`);
    expect(fks).toEqual([
      expect.objectContaining({ table: 'sessions', from: 'sessionId', to: 'id', on_delete: 'CASCADE' }),
    ]);
    const indexes: IndexInfo[] = await ds.query(`PRAGMA index_list("meta_cloud_contacts")`);
    expect(indexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'UQ_meta_cloud_contacts_sessionId_waId', unique: 1 })]),
    );
    await insertContact('c1', 's1', '5511988887777');
    await insertContact('c2', 's2', '5511988887777');
    await expect(insertContact('c3', 's1', '5511988887777')).rejects.toThrow(/UNIQUE/);
  });

  it('C36 deleting a session deletes its account and contacts', async () => {
    await migration.up(ds.createQueryRunner());
    await insertAccount('s1', '106540352242922');
    await insertContact('c1', 's1', '5511988887777');
    await insertAccount('s2', '106540352242923');

    await ds.query(`DELETE FROM "sessions" WHERE "id" = 's1'`);

    expect(await count('meta_cloud_accounts')).toBe(1);
    expect(await count('meta_cloud_contacts')).toBe(0);
  });

  it('C36 down drops both tables', async () => {
    await migration.up(ds.createQueryRunner());
    await migration.down(ds.createQueryRunner());

    const tables: { name: string }[] = await ds.query(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    expect(tables.map(t => t.name)).not.toContain('meta_cloud_contacts');
    expect(tables.map(t => t.name)).not.toContain('meta_cloud_accounts');
  });

  it('is idempotent in both directions', async () => {
    await migration.up(ds.createQueryRunner());
    await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();
    await migration.down(ds.createQueryRunner());
    await expect(migration.down(ds.createQueryRunner())).resolves.toBeUndefined();
  });
});
