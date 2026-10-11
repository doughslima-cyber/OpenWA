import { DataSource } from 'typeorm';
import { AddSessionEngine1791300000000 } from '../1791300000000-AddSessionEngine';

describe('AddSessionEngine migration', () => {
  let ds: DataSource;
  const migration = new AddSessionEngine1791300000000();

  type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };
  const columns = async (): Promise<ColumnInfo[]> => ds.query(`PRAGMA table_info("sessions")`);
  const rows = async (): Promise<Array<Record<string, unknown>>> => ds.query(`SELECT * FROM "sessions" ORDER BY "id"`);

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query(
      `CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, ` +
        `"status" varchar(50) NOT NULL DEFAULT ('created'))`,
    );
    await ds.query(
      `INSERT INTO "sessions" ("id", "name", "status") VALUES ('s1', 'one', 'ready'), ('s2', 'two', 'created')`,
    );
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('C8 adds a nullable varchar(30) engine column with no default and leaves existing rows NULL', async () => {
    await migration.up(ds.createQueryRunner());

    const engine = (await columns()).find(c => c.name === 'engine');
    expect(engine).toEqual(expect.objectContaining({ type: 'varchar(30)', notnull: 0, dflt_value: null }));
    expect(await rows()).toEqual([
      { id: 's1', name: 'one', status: 'ready', engine: null },
      { id: 's2', name: 'two', status: 'created', engine: null },
    ]);
  });

  it('C8 down removes the column and keeps the rows', async () => {
    await migration.up(ds.createQueryRunner());
    await migration.down(ds.createQueryRunner());

    expect((await columns()).map(c => c.name)).not.toContain('engine');
    expect(await rows()).toEqual([
      { id: 's1', name: 'one', status: 'ready' },
      { id: 's2', name: 'two', status: 'created' },
    ]);
  });

  it('is idempotent in both directions', async () => {
    await migration.up(ds.createQueryRunner());
    await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();
    await migration.down(ds.createQueryRunner());
    await expect(migration.down(ds.createQueryRunner())).resolves.toBeUndefined();
  });
});
