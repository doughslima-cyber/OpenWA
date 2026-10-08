import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { applyGlobalValidation } from '../../config/app-validation';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { AuthService } from '../auth/auth.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import { AuditService } from '../audit/audit.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { createCampaignDataSource, recipientsOf, seedCampaign, seedSession } from './__fixtures__/campaign-db';

// Over HTTP through the production validation contract (applyGlobalValidation) and the real ApiKeyGuard,
// so every status code and body asserted here is the one a client gets. No runner: nothing is sent.

/** The JSON body, typed loosely for the assertions below. */
interface Body {
  id: string;
  code?: string;
  total: number;
  text: string;
  waiting: unknown;
  items: Array<{ chatId: string }>;
}
const body = (res: { body: unknown }): Body => res.body as Body;
const list = (res: { body: unknown }) => res.body as Array<{ name: string; counts: unknown }>;

const KEYS: Record<string, Partial<ApiKey>> = {
  'operator-key': { role: ApiKeyRole.OPERATOR, allowedChats: null },
  'viewer-key': { role: ApiKeyRole.VIEWER, allowedChats: null },
  'chat-key': { role: ApiKeyRole.OPERATOR, allowedChats: ['5511988887777@c.us'] },
};

const ROLE_RANK: Record<ApiKeyRole, number> = {
  [ApiKeyRole.VIEWER]: 1,
  [ApiKeyRole.OPERATOR]: 2,
  [ApiKeyRole.ADMIN]: 3,
};

describe('CampaignsController over HTTP', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let sessionId: string;

  const numbers = (n: number, from = 5511900000000): string[] => Array.from({ length: n }, (_, i) => String(from + i));
  const post = (path: string, body?: unknown, key = 'operator-key') =>
    request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/campaigns${path}`)
      .set('X-API-Key', key)
      .send(body as object);
  const get = (path: string, key = 'operator-key') =>
    request(app.getHttpServer()).get(`/api/sessions/${sessionId}/campaigns${path}`).set('X-API-Key', key);
  const campaignCount = () => ds.getRepository(Campaign).count();
  const valid = (overrides: Record<string, unknown> = {}) => ({
    name: 'Outubro',
    text: 'Olá! Temos novidades.',
    recipients: ['5511988887777'],
    ...overrides,
  });

  beforeAll(async () => {
    ds = await createCampaignDataSource();
    const mod = await Test.createTestingModule({
      controllers: [CampaignsController],
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign, 'data'), useValue: ds.getRepository(Campaign) },
        { provide: getRepositoryToken(CampaignRecipient, 'data'), useValue: ds.getRepository(CampaignRecipient) },
        { provide: getRepositoryToken(Session, 'data'), useValue: ds.getRepository(Session) },
        {
          provide: AuthService,
          useValue: {
            validateApiKey: (key: string) => Promise.resolve({ id: key, name: key, ...KEYS[key] }),
            hasPermission: (key: ApiKey, role: ApiKeyRole) => ROLE_RANK[key.role] >= ROLE_RANK[role],
          },
        },
        { provide: ConfigService, useValue: { get: () => [] } },
        { provide: AuditService, useValue: { logWarn: jest.fn().mockResolvedValue(null) } },
        ChatScopeService,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.getRepository(CampaignRecipient).clear();
    await ds.query('DELETE FROM "campaigns"');
    sessionId = (await seedSession(ds)).id;
  });

  it('C3 creates a running campaign whose total counts distinct accepted entries', async () => {
    const res = await post(
      '',
      valid({ recipients: ['+55 (11) 98888-7777', '5511988887777', '222222\n333333', 'abc', '12345'] }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String) as string, name: 'Outubro', status: 'running', total: 3 });
  });

  it('C6 stores the three spellings of one phone as a single @c.us recipient', async () => {
    const res = await post('', valid({ recipients: ['+55 (11) 98888-7777', '5511988887777', '5511988887777@c.us'] }));

    expect(res.status).toBe(201);
    const rows = await recipientsOf(ds, body(res).id);
    expect(rows.map(r => r.chatId)).toEqual(['5511988887777@c.us']);
  });

  it.each([[['abc', '12345', '120363000000000000@g.us', '55000111222333@lid']], [[]]])(
    'C7 refuses a list with no accepted entry (%j) with CAMPAIGN_NO_RECIPIENTS and creates nothing',
    async recipients => {
      const res = await post('', valid({ recipients }));

      expect(res.status).toBe(400);
      expect(body(res).code).toBe('CAMPAIGN_NO_RECIPIENTS');
      expect(await campaignCount()).toBe(0);
    },
  );

  it('C9 refuses 5001 accepted numbers with CAMPAIGN_TOO_MANY_RECIPIENTS and accepts 5000', async () => {
    const over = await post('', valid({ recipients: numbers(5001) }));
    expect(over.status).toBe(400);
    expect(body(over).code).toBe('CAMPAIGN_TOO_MANY_RECIPIENTS');
    expect(await campaignCount()).toBe(0);

    const atLimit = await post('', valid({ recipients: numbers(5000) }));
    expect(atLimit.status).toBe(201);
    expect(body(atLimit).total).toBe(5000);
    expect(await ds.getRepository(CampaignRecipient).count()).toBe(5000);
  });

  it.each([
    ['empty text', { text: '' }],
    ['text over 4096 characters', { text: 'a'.repeat(4097) }],
    ['whitespace-only text', { text: '   \n ' }],
    ['empty name', { name: '' }],
    ['whitespace-only name', { name: '   ' }],
    ['name over 100 characters', { name: 'n'.repeat(101) }],
  ])('C10 answers 400 and creates nothing for %s', async (_label, overrides) => {
    const res = await post('', valid(overrides));

    expect(res.status).toBe(400);
    expect(await campaignCount()).toBe(0);
  });

  it('C10 accepts a 4096-character text and a 100-character name', async () => {
    const res = await post('', valid({ text: 'a'.repeat(4096), name: 'n'.repeat(100) }));

    expect(res.status).toBe(201);
  });

  it('C11 refuses a second campaign while one runs, and accepts it once that one is cancelled', async () => {
    const first = await post('', valid());
    expect(first.status).toBe(201);

    const second = await post('', valid({ name: 'Outra' }));
    expect(second.status).toBe(409);
    expect(body(second).code).toBe('CAMPAIGN_ALREADY_RUNNING');

    expect((await post(`/${body(first).id}/cancel`)).status).toBe(200);
    expect((await post('', valid({ name: 'Outra' }))).status).toBe(201);
  });

  it('C12 lets exactly one of two concurrent creates through', async () => {
    const results = await Promise.all([post('', valid({ name: 'A' })), post('', valid({ name: 'B' }))]);

    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await ds.getRepository(Campaign).count({ where: { status: 'running' } })).toBe(1);
  });

  it('C13 refuses a viewer key on both POST routes', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['5511988887777@c.us']);

    const create = await post('', valid(), 'viewer-key');
    const cancel = await post(`/${campaign.id}/cancel`, undefined, 'viewer-key');

    expect(create.status).toBe(403);
    expect(cancel.status).toBe(403);
    expect((await ds.getRepository(Campaign).findOneByOrFail({ id: campaign.id })).status).toBe('running');
  });

  it('C14 refuses a chat-restricted key on both POST routes', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['5511988887777@c.us']);

    const create = await post('', valid(), 'chat-key');
    const cancel = await post(`/${campaign.id}/cancel`, undefined, 'chat-key');

    expect(create.status).toBe(403);
    expect(cancel.status).toBe(403);
    expect(await campaignCount()).toBe(1);
  });

  it("C35 lists only this session's campaigns, newest first, with counts", async () => {
    const older = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us'], {
      status: 'completed',
      name: 'Antiga',
      recipientStatus: ['sent', 'replied'],
    });
    const newer = await seedCampaign(ds, sessionId, ['333333@c.us', '444444@c.us', '555555@c.us'], {
      name: 'Nova',
      recipientStatus: ['failed', 'pending', 'sending'],
    });
    await ds.getRepository(Campaign).update(older.id, { createdAt: new Date('2026-10-01T10:00:00Z') });
    await ds.getRepository(Campaign).update(newer.id, { createdAt: new Date('2026-10-02T10:00:00Z') });
    const other = await seedSession(ds);
    await seedCampaign(ds, other.id, ['666666@c.us']);

    const res = await get('', 'viewer-key');

    expect(res.status).toBe(200);
    expect(list(res).map(c => c.name)).toEqual(['Nova', 'Antiga']);
    expect(list(res)[0]).toEqual({
      id: newer.id,
      name: 'Nova',
      status: 'running',
      counts: { total: 3, pending: 1, sending: 1, sent: 0, failed: 1, replied: 0, cancelled: 0 },
      createdAt: expect.any(String) as string,
      completedAt: null,
    });
    expect(list(res)[1].counts).toEqual({
      total: 2,
      pending: 0,
      sending: 0,
      sent: 1,
      failed: 0,
      replied: 1,
      cancelled: 0,
    });
  });

  it('C38 filters, pages and bounds the recipient list', async () => {
    const chatIds = numbers(120).map(n => `${n}@c.us`);
    const campaign = await seedCampaign(ds, sessionId, chatIds, {
      recipientStatus: chatIds.map((_, i) => (i % 3 === 0 ? 'failed' : 'pending')),
    });
    await ds
      .getRepository(CampaignRecipient)
      .update({ campaignId: campaign.id, status: 'failed' }, { errorCode: 'SEND_FAILED', errorMessage: 'nope' });

    const firstPage = await get(`/${campaign.id}/recipients`);
    expect(firstPage.status).toBe(200);
    expect(body(firstPage).total).toBe(120);
    expect(body(firstPage).items).toHaveLength(50);
    expect(body(firstPage).items[0]).toEqual({
      chatId: chatIds[0],
      status: 'failed',
      sentAt: null,
      repliedAt: null,
      error: { code: 'SEND_FAILED', message: 'nope' },
    });

    const failed = await get(`/${campaign.id}/recipients?status=failed&limit=10&offset=10`);
    expect(failed.status).toBe(200);
    expect(body(failed).total).toBe(40);
    expect(body(failed).items.map((i: { chatId: string }) => i.chatId)).toEqual(
      chatIds.filter((_, i) => i % 3 === 0).slice(10, 20),
    );

    expect(body(await get(`/${campaign.id}/recipients?limit=100`)).items).toHaveLength(100);
    expect((await get(`/${campaign.id}/recipients?limit=101`)).status).toBe(400);
    expect((await get(`/${campaign.id}/recipients?status=lost`)).status).toBe(400);
  });

  it('C41 answers the wait reason of a running campaign, and none once it ended', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['5511988887777@c.us']);
    const at = new Date('2026-10-09T00:00:01.000Z');
    await ds.getRepository(Campaign).update(campaign.id, { waitReason: 'pacing', nextAttemptAt: at });

    const waiting = await get(`/${campaign.id}`);
    expect(waiting.status).toBe(200);
    expect(body(waiting).waiting).toEqual({ reason: 'pacing', nextAttemptAt: at.toISOString() });
    expect(body(waiting).text).toBe('Olá!');

    await ds.getRepository(Campaign).update(campaign.id, { waitReason: 'restricted', nextAttemptAt: null });
    expect(body(await get(`/${campaign.id}`)).waiting).toEqual({ reason: 'restricted', nextAttemptAt: null });

    await ds.getRepository(Campaign).update(campaign.id, { waitReason: 'disconnected' });
    expect(body(await get(`/${campaign.id}`)).waiting).toEqual({ reason: 'disconnected', nextAttemptAt: null });

    await ds.getRepository(Campaign).update(campaign.id, { waitReason: null });
    expect(body(await get(`/${campaign.id}`)).waiting).toBeNull();
  });

  it.each(['completed', 'cancelled'] as const)(
    'C45 refuses to cancel a %s campaign with CAMPAIGN_NOT_RUNNING',
    async status => {
      const campaign = await seedCampaign(ds, sessionId, ['5511988887777@c.us'], { status });

      const res = await post(`/${campaign.id}/cancel`);

      expect(res.status).toBe(409);
      expect(body(res).code).toBe('CAMPAIGN_NOT_RUNNING');
    },
  );

  it('C45 answers 404 for a campaign id this session does not have', async () => {
    const other = await seedSession(ds);
    const elsewhere = await seedCampaign(ds, other.id, ['5511988887777@c.us']);

    expect((await post(`/${elsewhere.id}/cancel`)).status).toBe(404);
    expect((await post('/00000000-0000-4000-8000-000000000000/cancel')).status).toBe(404);
  });

  it('C43 cancels the campaign and every pending recipient', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us'], {
      recipientStatus: ['sent', 'pending', 'pending'],
    });

    const res = await post(`/${campaign.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: campaign.id,
      status: 'cancelled',
      counts: { total: 3, pending: 0, sending: 0, sent: 1, failed: 0, replied: 0, cancelled: 2 },
    });
  });
});
