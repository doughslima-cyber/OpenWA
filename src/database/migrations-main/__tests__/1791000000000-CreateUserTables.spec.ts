import { DataSource } from 'typeorm';
import { CreateUserTables1791000000000 } from '../1791000000000-CreateUserTables';

describe('CreateUserTables migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const tables = async () =>
    (await ds.query<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name);

  it('creates users (unique email) and user_sessions, idempotently', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateUserTables1791000000000();
    await migration.up(qr);
    await migration.up(qr);
    expect(await tables()).toEqual(expect.arrayContaining(['users', 'user_sessions']));

    await qr.query(`INSERT INTO users (id, email, name, passwordHash) VALUES ('1', 'a@x.com', 'A', 'h')`);
    const [row] = (await qr.query(`SELECT role, isActive FROM users WHERE id = '1'`)) as Array<{
      role: string;
      isActive: number;
    }>;
    expect(row).toEqual({ role: 'operator', isActive: 1 });
    await expect(
      qr.query(`INSERT INTO users (id, email, name, passwordHash) VALUES ('2', 'a@x.com', 'B', 'h')`),
    ).rejects.toThrow(/UNIQUE/);

    await qr.release();
  });

  it('down drops both tables', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateUserTables1791000000000();
    await migration.up(qr);
    await migration.down(qr);
    expect(await tables()).not.toEqual(expect.arrayContaining(['users']));
    expect(await tables()).not.toEqual(expect.arrayContaining(['user_sessions']));
    await qr.release();
  });
});
