import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Session, SessionStatus } from '../../session/entities/session.entity';
import { Message } from '../../message/entities/message.entity';
import { LidMapping } from '../../../engine/identity/lid-mapping.entity';
import { Campaign } from '../entities/campaign.entity';
import { CampaignRecipient, type RecipientStatus } from '../entities/campaign-recipient.entity';

/**
 * A SQLite data connection with the tables the campaign code reads, for the campaign specs. Built by
 * synchronize from the entities; the migration-drift gate is what proves the migration builds the same.
 * `database` defaults to memory; pass a file path to open several connections onto one database.
 */
export async function createCampaignDataSource(database = ':memory:'): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database,
    entities: [Session, Message, LidMapping, Campaign, CampaignRecipient],
    synchronize: true,
  });
  await ds.initialize();
  await ds.query('PRAGMA foreign_keys = ON');
  if (database !== ':memory:') await ds.query('PRAGMA busy_timeout = 5000');
  return ds;
}

export async function seedSession(
  ds: DataSource,
  overrides: Partial<Pick<Session, 'id' | 'name' | 'status' | 'createdAt'>> = {},
): Promise<Session> {
  const repo = ds.getRepository(Session);
  return repo.save(
    repo.create({ id: randomUUID(), name: `s-${randomUUID().slice(0, 8)}`, status: SessionStatus.READY, ...overrides }),
  );
}

/** A campaign with its recipients, written straight to the tables (no service involved). */
export async function seedCampaign(
  ds: DataSource,
  sessionId: string,
  chatIds: string[],
  opts: { status?: Campaign['status']; name?: string; text?: string; recipientStatus?: RecipientStatus[] } = {},
): Promise<Campaign> {
  const campaign = await ds.getRepository(Campaign).save({
    id: randomUUID(),
    sessionId,
    name: opts.name ?? 'Campanha',
    text: opts.text ?? 'Olá!',
    status: opts.status ?? 'running',
    total: chatIds.length,
    waitReason: null,
    nextAttemptAt: null,
    completedAt: null,
  });
  await ds.getRepository(CampaignRecipient).insert(
    chatIds.map((chatId, position) => ({
      id: randomUUID(),
      campaignId: campaign.id,
      position,
      chatId,
      status: opts.recipientStatus?.[position] ?? 'pending',
    })),
  );
  return campaign;
}

export function recipientsOf(ds: DataSource, campaignId: string): Promise<CampaignRecipient[]> {
  return ds.getRepository(CampaignRecipient).find({ where: { campaignId }, order: { position: 'ASC' } });
}
