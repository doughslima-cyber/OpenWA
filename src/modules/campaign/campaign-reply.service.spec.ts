import { DataSource } from 'typeorm';
import { HookManager } from '../../core/hooks';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { Session } from '../session/entities/session.entity';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignReplyService } from './campaign-reply.service';
import { CampaignsService } from './campaigns.service';
import { createCampaignDataSource, recipientsOf, seedCampaign, seedSession } from './__fixtures__/campaign-db';

const NUMBER = '5511988887777';
const RECIPIENT = `${NUMBER}@c.us`;
const LID = '170000000000001';

interface Inbound {
  id: string;
  chatId: string;
  from: string;
  body: string;
  fromMe: boolean;
  isGroup: boolean;
  author?: string;
}

let seq = 0;
const inbound = (over: Partial<Inbound> = {}): Inbound => ({
  id: `wamid.${++seq}`,
  chatId: RECIPIENT,
  from: RECIPIENT,
  body: 'Oi, tenho interesse',
  fromMe: false,
  isGroup: false,
  ...over,
});

/** Mark `chatId` of a seeded campaign as sent at `sentAt`, as the runner would after the engine accepted it. */
async function markSent(ds: DataSource, campaignId: string, chatId: string, sentAt: Date): Promise<void> {
  await ds.getRepository(CampaignRecipient).update({ campaignId, chatId }, { status: 'sent', sentAt });
}

describe('CampaignReplyService', () => {
  let ds: DataSource;
  let hooks: HookManager;
  let directory: LidMappingStoreService;
  let reply: CampaignReplyService;
  let campaigns: CampaignsService;
  let session: Session;

  beforeEach(async () => {
    ds = await createCampaignDataSource();
    hooks = new HookManager();
    directory = new LidMappingStoreService(ds.getRepository(LidMapping));
    reply = new CampaignReplyService(hooks, ds.getRepository(CampaignRecipient), directory);
    reply.onModuleInit();
    campaigns = new CampaignsService(
      ds.getRepository(Campaign),
      ds.getRepository(CampaignRecipient),
      ds.getRepository(Session),
    );
    session = await seedSession(ds);
  });

  afterEach(async () => {
    reply.onModuleDestroy();
    await ds.destroy();
  });

  /** Run the message through the real hook chain, as the projector does. */
  const receive = (message: Inbound, sessionId = session.id) =>
    hooks.execute<Record<string, unknown>>('message:received', { ...message }, { sessionId, source: 'Engine' });

  async function sentCampaign(name = 'Outubro') {
    const campaign = await seedCampaign(ds, session.id, [RECIPIENT, '5511977776666@c.us'], { name });
    await markSent(ds, campaign.id, RECIPIENT, new Date('2026-10-08T12:00:00.000Z'));
    return campaign;
  }

  const recipient = async (campaignId: string, chatId = RECIPIENT) =>
    (await recipientsOf(ds, campaignId)).find(r => r.chatId === chatId)!;

  const replied = async (campaignId: string) => (await campaigns.findOne(session.id, campaignId)).counts.replied;

  it('registers on message:received at priority 0, ahead of plugins at the default 100', () => {
    hooks.register('some-plugin', 'message:received', ctx => Promise.resolve({ continue: true, data: ctx.data }));
    expect(hooks.getRegisteredHooks()['message:received']).toEqual([
      { pluginId: 'openmsg-campaigns', priority: 0 },
      { pluginId: 'some-plugin', priority: 100 },
    ]);
  });

  it('C29 a message in the @c.us chat of a sent recipient marks it replied, sets repliedAt and raises counts.replied by 1', async () => {
    const campaign = await sentCampaign();
    expect(await replied(campaign.id)).toBe(0);

    const before = Date.now();
    const result = await receive(inbound());

    const row = await recipient(campaign.id);
    expect(row.status).toBe('replied');
    expect(row.repliedAt).toBeInstanceOf(Date);
    expect(row.repliedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await replied(campaign.id)).toBe(1);
    expect(result.data.campaign).toEqual({ id: campaign.id, name: 'Outubro' });
    // The other recipient is untouched.
    expect((await recipient(campaign.id, '5511977776666@c.us')).status).toBe('pending');
  });

  it('C30 a message in the @s.whatsapp.net chat of a sent recipient marks it replied', async () => {
    const campaign = await sentCampaign();
    const jid = `${NUMBER}@s.whatsapp.net`;

    await receive(inbound({ chatId: jid, from: jid }));

    const row = await recipient(campaign.id);
    expect(row.status).toBe('replied');
    expect(row.repliedAt).toBeInstanceOf(Date);
    expect(await replied(campaign.id)).toBe(1);
  });

  it('C31 a message in a @lid chat the directory resolves to the number marks it replied', async () => {
    const campaign = await sentCampaign();
    await directory.remember(LID, NUMBER, session.id);
    const jid = `${LID}@lid`;

    await receive(inbound({ chatId: jid, from: jid }));

    const row = await recipient(campaign.id);
    expect(row.status).toBe('replied');
    expect(row.repliedAt).toBeInstanceOf(Date);
    expect(await replied(campaign.id)).toBe(1);
  });

  it('C32 a second message from the same recipient leaves repliedAt and counts.replied unchanged', async () => {
    const campaign = await sentCampaign();
    await receive(inbound());
    const first = (await recipient(campaign.id)).repliedAt!.getTime();

    await new Promise(resolve => setTimeout(resolve, 15));
    const second = await receive(inbound({ body: 'Mais uma coisa' }));

    expect((await recipient(campaign.id)).repliedAt!.getTime()).toBe(first);
    expect(await replied(campaign.id)).toBe(1);
    expect(second.data).not.toHaveProperty('campaign');
  });

  it('C32 a fromMe message in the recipient chat never marks it', async () => {
    const campaign = await sentCampaign();

    const result = await receive(inbound({ fromMe: true }));

    expect((await recipient(campaign.id)).status).toBe('sent');
    expect((await recipient(campaign.id)).repliedAt).toBeNull();
    expect(await replied(campaign.id)).toBe(0);
    expect(result.data).not.toHaveProperty('campaign');
  });

  it('C32 a group message written by the recipient never marks it', async () => {
    const campaign = await sentCampaign();
    const group = '120363000000000001@g.us';

    // As the engines report it: isGroup set, the group in chatId, the participant in author.
    const flagged = await receive(inbound({ chatId: group, from: group, author: RECIPIENT, isGroup: true }));
    // A group chat id alone is enough, whatever the flag says.
    const unflagged = await receive(inbound({ chatId: group, from: RECIPIENT, author: RECIPIENT }));

    expect((await recipient(campaign.id)).status).toBe('sent');
    expect(await replied(campaign.id)).toBe(0);
    expect(flagged.data).not.toHaveProperty('campaign');
    expect(unflagged.data).not.toHaveProperty('campaign');
  });

  it('C32 a second message does not mark an older campaign that sent to the same number', async () => {
    const older = await seedCampaign(ds, session.id, [RECIPIENT], { name: 'Setembro', status: 'completed' });
    await markSent(ds, older.id, RECIPIENT, new Date('2026-09-01T12:00:00.000Z'));
    const latest = await sentCampaign('Outubro');

    const first = await receive(inbound());
    const second = await receive(inbound({ body: 'Ainda aí?' }));

    expect(first.data.campaign).toEqual({ id: latest.id, name: 'Outubro' });
    expect(second.data).not.toHaveProperty('campaign');
    expect((await recipient(latest.id)).status).toBe('replied');
    expect((await recipient(older.id)).status).toBe('sent');
  });

  it('marks only the recipient of the campaign that sent last, and announces that campaign', async () => {
    const older = await seedCampaign(ds, session.id, [RECIPIENT], { name: 'Setembro', status: 'completed' });
    await markSent(ds, older.id, RECIPIENT, new Date('2026-09-01T12:00:00.000Z'));
    const latest = await sentCampaign('Outubro');

    const result = await receive(inbound());

    expect(result.data.campaign).toEqual({ id: latest.id, name: 'Outubro' });
    expect((await recipient(latest.id)).status).toBe('replied');
    expect((await recipient(older.id)).status).toBe('sent');
  });

  it("ignores another session's campaign that sent to the same number", async () => {
    const other = await seedSession(ds);
    const campaign = await seedCampaign(ds, other.id, [RECIPIENT]);
    await markSent(ds, campaign.id, RECIPIENT, new Date('2026-10-08T12:00:00.000Z'));

    const result = await receive(inbound());

    expect((await recipient(campaign.id)).status).toBe('sent');
    expect(result.data).not.toHaveProperty('campaign');
  });

  it('leaves a recipient that is still pending alone', async () => {
    const campaign = await seedCampaign(ds, session.id, [RECIPIENT]);

    const result = await receive(inbound());

    expect((await recipient(campaign.id)).status).toBe('pending');
    expect(result.data).not.toHaveProperty('campaign');
  });
});
