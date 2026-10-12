import { DataSource, Repository } from 'typeorm';
import { Session } from '../../modules/session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../../modules/message/entities/message.entity';
import { MetaCloudChatStore } from './meta-cloud-chat-store.service';
import { MetaCloudContact } from './meta-cloud-contact.entity';

describe('MetaCloudChatStore', () => {
  let ds: DataSource;
  let contacts: Repository<MetaCloudContact>;
  let messages: Repository<Message>;
  let store: MetaCloudChatStore;
  const SESSION = 'f3b5a2c1-0d4e-4f6a-9b8c-7d6e5f4a3b2c';
  const WA_ID = '5511988887777';

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, MetaCloudContact, Message],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).insert({ id: SESSION, name: 'cloud' });
    contacts = ds.getRepository(MetaCloudContact);
    messages = ds.getRepository(Message);
    store = new MetaCloudChatStore(contacts, messages);
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

  /** One stored message, as the projector writes it; `at` is the message time in epoch seconds. */
  let seq = 0;
  const stored = (chatId: string, at: number, body: string, direction = MessageDirection.INCOMING) =>
    messages.insert({
      sessionId: SESSION,
      waMessageId: `wamid.${++seq}`,
      chatId,
      chatName: direction === MessageDirection.INCOMING ? 'Name on the message' : undefined,
      from: direction === MessageDirection.INCOMING ? chatId : '5511999990000@c.us',
      to: direction === MessageDirection.INCOMING ? '5511999990000@c.us' : chatId,
      body,
      type: 'text',
      direction,
      timestamp: at,
      status: MessageStatus.SENT,
    });
  const contact = (waId: string, profileName: string, lastSeenAt: Date | null) =>
    contacts.insert({ sessionId: SESSION, waId, profileName, lastSeenAt });

  it('C69 getChats returns one one-to-one (kind individual) summary per chat with its last message, its name and its unread count', async () => {
    const T = 1_760_000_000;
    // Never seen: both inbound messages are unread; the outgoing reply is not counted.
    await contact('5511900000001', 'Ana', null);
    await stored('5511900000001@c.us', T + 10, 'oi');
    await stored('5511900000001@c.us', T + 20, 'tudo bem?');
    await stored('5511900000001@c.us', T + 30, 'tudo, e você?', MessageDirection.OUTGOING);
    // Seen after its last inbound: nothing unread.
    await contact('5511900000002', 'Bruno', new Date((T + 50) * 1000));
    await stored('5511900000002@c.us', T + 40, 'pedido 12');
    // Seen between two inbound messages: only the newer one is unread. No profile name stored.
    await contacts.insert({ sessionId: SESSION, waId: '5511900000003', lastSeenAt: new Date((T + 15) * 1000) });
    await stored('5511900000003@c.us', T + 5, 'primeira');
    await stored('5511900000003@c.us', T + 25, 'segunda');

    const chats = await store.getChats(SESSION);

    expect(chats).toHaveLength(3);
    const byId = new Map(chats.map(chat => [chat.id, chat]));
    expect(byId.get('5511900000001@c.us')).toMatchObject({
      kind: 'individual',
      isGroup: false,
      name: 'Ana',
      lastMessage: 'tudo, e você?',
      timestamp: T + 30,
      unreadCount: 2,
    });
    expect(byId.get('5511900000002@c.us')).toMatchObject({
      kind: 'individual',
      name: 'Bruno',
      lastMessage: 'pedido 12',
      unreadCount: 0,
    });
    expect(byId.get('5511900000003@c.us')).toMatchObject({
      kind: 'individual',
      name: 'Name on the message',
      lastMessage: 'segunda',
      unreadCount: 1,
    });
  });

  it('C69 a chat whose sender has no contact row counts every inbound message and is named by its messages', async () => {
    await stored('5511900000009@c.us', 1_760_000_001, 'olá');

    const [chat] = await store.getChats(SESSION);

    expect(chat).toMatchObject({
      id: '5511900000009@c.us',
      kind: 'individual',
      unreadCount: 1,
      name: 'Name on the message',
    });
  });

  it('C69 markSeen moves the unread mark: a chat read after its last inbound counts 0', async () => {
    await contact('5511900000004', 'Carla', null);
    await stored('5511900000004@c.us', Math.floor(Date.now() / 1000) - 60, 'alô');
    expect((await store.getChats(SESSION))[0].unreadCount).toBe(1);

    await store.markSeen(SESSION, '5511900000004', new Date());

    expect((await store.getChats(SESSION))[0].unreadCount).toBe(0);
  });

  it('C71 getChatHistory with limit 3 over 5 stored messages returns the 3 newest, oldest first', async () => {
    const T = 1_760_000_000;
    for (let i = 1; i <= 5; i++) await stored('5511900000005@c.us', T + i, `m${i}`);

    const history = await store.getChatHistory(SESSION, '5511900000005@c.us', 3);

    expect(history.map(m => m.body)).toEqual(['m3', 'm4', 'm5']);
    expect(history.map(m => m.timestamp)).toEqual([T + 3, T + 4, T + 5]);
    expect(history[0]).toMatchObject({ chatId: '5511900000005@c.us', fromMe: false, kind: 'individual' });
  });

  it('C72 getContactById returns the stored profile name for a known @c.us id and null for an unknown one', async () => {
    await contact(WA_ID, 'Kerry Fisher', null);

    expect(await store.getContactById(SESSION, `${WA_ID}@c.us`)).toMatchObject({
      id: `${WA_ID}@c.us`,
      name: 'Kerry Fisher',
      pushName: 'Kerry Fisher',
      number: WA_ID,
    });
    expect(await store.getContactById(SESSION, '5511900000000@c.us')).toBeNull();
  });
});
