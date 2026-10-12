import { DataSource, Repository } from 'typeorm';
import { Session } from '../../modules/session/entities/session.entity';
import { MetaCloudChatStore } from './meta-cloud-chat-store.service';
import { MetaCloudContact } from './meta-cloud-contact.entity';

describe('MetaCloudChatStore', () => {
  let ds: DataSource;
  let contacts: Repository<MetaCloudContact>;
  let store: MetaCloudChatStore;
  const SESSION = 'f3b5a2c1-0d4e-4f6a-9b8c-7d6e5f4a3b2c';
  const WA_ID = '5511988887777';

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, MetaCloudContact],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).insert({ id: SESSION, name: 'cloud' });
    contacts = ds.getRepository(MetaCloudContact);
    store = new MetaCloudChatStore(contacts);
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('C68 records one row per session and wa_id with the profile name, lastInboundAt and lastInboundWamid', async () => {
    const at = new Date('2026-10-11T12:00:00.000Z');

    await store.recordInbound(SESSION, { waId: WA_ID, profileName: 'Kerry Fisher', at, wamid: 'wamid.first' });

    const rows = await contacts.find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: SESSION,
      waId: WA_ID,
      profileName: 'Kerry Fisher',
      lastInboundWamid: 'wamid.first',
    });
    expect(rows[0].lastInboundAt?.getTime()).toBe(at.getTime());
  });

  it('C68 a second message from the same wa_id updates that row and adds none', async () => {
    await store.recordInbound(SESSION, {
      waId: WA_ID,
      profileName: 'Kerry Fisher',
      at: new Date('2026-10-11T12:00:00.000Z'),
      wamid: 'wamid.first',
    });
    const [first] = await contacts.find();
    const later = new Date('2026-10-11T12:05:00.000Z');

    await store.recordInbound(SESSION, { waId: WA_ID, profileName: 'Kerry F.', at: later, wamid: 'wamid.second' });

    const rows = await contacts.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0]).toMatchObject({ profileName: 'Kerry F.', lastInboundWamid: 'wamid.second' });
    expect(rows[0].lastInboundAt?.getTime()).toBe(later.getTime());
  });

  it('C68 a message with no profile name keeps the name already stored', async () => {
    await store.recordInbound(SESSION, { waId: WA_ID, profileName: 'Kerry Fisher', at: new Date(), wamid: 'wamid.a' });
    await store.recordInbound(SESSION, { waId: WA_ID, profileName: null, at: new Date(), wamid: 'wamid.b' });

    const rows = await contacts.find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profileName: 'Kerry Fisher', lastInboundWamid: 'wamid.b' });
  });

  it('C68 two first messages from the same wa_id at once still leave one row', async () => {
    await Promise.all([
      store.recordInbound(SESSION, { waId: WA_ID, profileName: 'Kerry', at: new Date(), wamid: 'wamid.x' }),
      store.recordInbound(SESSION, { waId: WA_ID, profileName: 'Kerry', at: new Date(), wamid: 'wamid.y' }),
    ]);

    expect(await contacts.count()).toBe(1);
  });
});
