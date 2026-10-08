import type { DataSource, Repository } from 'typeorm';
import { HookManager } from '../../core/hooks';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { EventsGateway } from '../events/events.gateway';
import type { Message } from '../message/entities/message.entity';
import { MessageProjector } from '../session/message-projector.service';
import type { Session } from '../session/entities/session.entity';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { WebhookService } from '../webhook/webhook.service';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignReplyService } from './campaign-reply.service';
import { createCampaignDataSource, recipientsOf, seedCampaign, seedSession } from './__fixtures__/campaign-db';

const NUMBER = '5511988887777';
const RECIPIENT = `${NUMBER}@c.us`;

/**
 * The real MessageProjector, wired as in message-projector.service.spec.ts, with a REAL HookManager
 * carrying the campaign reply hook. Only the message-table writes, the websocket and the webhook
 * service are stand-ins; what reaches `webhookService.dispatch` is what a session's webhooks receive.
 */
describe('Campaign reply through the MessageProjector', () => {
  let ds: DataSource;
  let hooks: HookManager;
  let reply: CampaignReplyService;
  let projector: MessageProjector;
  let engine: IWhatsAppEngine;
  let dispatch: jest.Mock;
  let sessionId: string;
  let seq = 0;

  beforeEach(async () => {
    ds = await createCampaignDataSource();
    sessionId = (await seedSession(ds)).id;

    hooks = new HookManager();
    reply = new CampaignReplyService(
      hooks,
      ds.getRepository(CampaignRecipient),
      new LidMappingStoreService(ds.getRepository(LidMapping)),
    );
    reply.onModuleInit();

    const engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);
    dispatch = jest.fn().mockResolvedValue(undefined);
    const messageRepository = {
      create: jest.fn((row: unknown) => row),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }], generatedMaps: [{}] }),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    projector = new MessageProjector(
      messageRepository as unknown as Repository<Message>,
      {
        update: jest.fn().mockResolvedValue(undefined),
        findOne: jest.fn().mockResolvedValue(null),
      } as unknown as Repository<Session>,
      engines,
      { emitMessage: jest.fn() } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      hooks,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  afterEach(async () => {
    reply.onModuleDestroy();
    await ds.destroy();
  });

  const incoming = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: `wamid.${++seq}`,
    chatId: RECIPIENT,
    from: RECIPIENT,
    to: 'me',
    body: 'Oi, tenho interesse',
    type: 'text',
    timestamp: 1_700_000_000 + seq,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    ...over,
  });

  /** The payloads dispatched as `message.received`, in order. */
  const received = (): Array<Record<string, unknown>> =>
    (dispatch.mock.calls as Array<[string, string, Record<string, unknown>]>)
      .filter(([sid, event]) => sid === sessionId && event === 'message.received')
      .map(([, , payload]) => payload);

  /** Feed one engine message and wait (real timers, bounded) until its webhook dispatch went out. */
  async function deliver(message: IncomingMessage): Promise<Record<string, unknown>> {
    const before = received().length;
    projector.handleInboundMessage(sessionId, engine, message);
    const deadline = Date.now() + 5000;
    while (received().length === before) {
      if (Date.now() > deadline) throw new Error(`message.received for ${message.id} was never dispatched`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const payload = received()[before];
    expect(payload.id).toBe(message.id);
    return payload;
  }

  async function sentCampaign() {
    const campaign = await seedCampaign(ds, sessionId, [RECIPIENT], { name: 'Outubro' });
    await ds
      .getRepository(CampaignRecipient)
      .update({ campaignId: campaign.id, chatId: RECIPIENT }, { status: 'sent', sentAt: new Date() });
    return campaign;
  }

  it('C33 the message.received dispatched for the reply carries campaign { id, name }; a second message and a non-recipient carry no campaign key', async () => {
    const campaign = await sentCampaign();

    const replyPayload = await deliver(incoming());
    expect(replyPayload.campaign).toEqual({ id: campaign.id, name: 'Outubro' });
    // The message itself is passed through intact alongside the new field.
    expect(replyPayload).toMatchObject({ chatId: RECIPIENT, from: RECIPIENT, body: 'Oi, tenho interesse' });

    const secondPayload = await deliver(incoming({ body: 'Pode me ligar?' }));
    expect(secondPayload).not.toHaveProperty('campaign');

    const stranger = '5511900001111@c.us';
    const strangerPayload = await deliver(incoming({ chatId: stranger, from: stranger }));
    expect(strangerPayload).not.toHaveProperty('campaign');

    expect((await recipientsOf(ds, campaign.id))[0].status).toBe('replied');
  });

  it('C34 a reply in a @lid chat the directory cannot resolve leaves the recipient sent and dispatches no campaign key', async () => {
    const campaign = await sentCampaign();
    const lid = '170000000000009@lid';

    const payload = await deliver(incoming({ chatId: lid, from: lid, isLidSender: true }));

    expect(payload).not.toHaveProperty('campaign');
    const [row] = await recipientsOf(ds, campaign.id);
    expect(row.status).toBe('sent');
    expect(row.repliedAt).toBeNull();
  });
});
