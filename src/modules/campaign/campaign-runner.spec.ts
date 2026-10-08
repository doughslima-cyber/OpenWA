import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookManager } from '../../core/hooks';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { MessageService } from '../message/message.service';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { SendPacingService } from '../message/send-pacing.service';
import { computeSendPacingConfig } from '../message/send-pacing.config';
import type { SessionService } from '../session/session.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import type { SessionOwnershipService } from '../session/session-ownership.service';
import type { AccountRestriction } from '../../engine/interfaces/whatsapp-engine.interface';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignRunner, type CampaignTiming } from './campaign-runner.service';
import { CampaignsService } from './campaigns.service';
import { createCampaignDataSource, recipientsOf, seedCampaign, seedSession } from './__fixtures__/campaign-db';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const IDLE_MS = 15_000;

interface SessionState {
  status: SessionStatus;
  restriction: AccountRestriction | null;
}

interface Harness {
  runner: CampaignRunner;
  session: SessionState;
  /** Every engine call, in order, with the fake time it started at. */
  calls: Array<{ chatId: string; text: string; at: number }>;
  /** Every wait the runner asked for, in order. */
  waits: number[];
  hooks: HookManager;
}

interface HarnessOptions {
  pacing?: SendPacingService;
  random?: number;
  ownsSession?: () => boolean;
  /** Runs inside each wait, after the clock advanced by it; `index` counts from 0. */
  onSleep?: (ms: number, index: number) => void | Promise<void>;
  send?: (chatId: string, text: string) => Promise<{ id: string; timestamp: number }>;
}

/** A pacing service that never refuses, for the specs where pacing is not the subject. */
const permissivePacing = (): SendPacingService =>
  ({
    assertSendAllowed: () => Promise.resolve(undefined),
    recordSendSuccess: () => undefined,
    recordSendFailure: () => undefined,
  }) as unknown as SendPacingService;

function buildRunner(ds: DataSource, opts: HarnessOptions = {}): Harness {
  const session: SessionState = { status: SessionStatus.READY, restriction: null };
  const calls: Harness['calls'] = [];
  const waits: number[] = [];
  let inFlight = 0;
  const engine = {
    sendTextMessage: async (chatId: string, text: string) => {
      inFlight++;
      if (inFlight > 1) throw new Error('two engine calls overlapped');
      calls.push({ chatId, text, at: Date.now() });
      try {
        return await (opts.send ?? (() => Promise.resolve({ id: `wa-${chatId}-${calls.length}`, timestamp: 1 })))(
          chatId,
          text,
        );
      } finally {
        inFlight--;
      }
    },
  };
  const engines = { get: () => engine } as unknown as EngineRegistry;
  const sessions = {
    findOne: () => Promise.resolve({ status: session.status, restriction: session.restriction }),
  } as unknown as SessionService;
  // Writes the OUTGOING row a real send writes, at the fake time, so pacing counts it.
  const messages = {
    saveOutgoingMessage: (sessionId: string, data: { waMessageId: string; chatId: string }) =>
      ds.query(
        `INSERT INTO "messages" ("id","sessionId","waMessageId","chatId","from","to","type","direction","createdAt") VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          `${data.waMessageId}`,
          sessionId,
          data.waMessageId,
          data.chatId,
          'me',
          data.chatId,
          'text',
          MessageDirection.OUTGOING,
          new Date().toISOString(),
        ],
      ),
  } as unknown as MessageService;
  const timing: CampaignTiming = {
    sleep: async ms => {
      const index = waits.length;
      waits.push(ms);
      jest.setSystemTime(Date.now() + ms);
      await opts.onSleep?.(ms, index);
    },
    random: () => opts.random ?? 0,
    idlePollMs: IDLE_MS,
    sweepMs: 60_000,
  };
  const ownership = opts.ownsSession
    ? ({ owns: () => opts.ownsSession!() } as unknown as SessionOwnershipService)
    : undefined;
  const hooks = new HookManager();
  const runner = new CampaignRunner(
    ds.getRepository(Campaign),
    ds.getRepository(CampaignRecipient),
    engines,
    sessions,
    opts.pacing ?? permissivePacing(),
    messages,
    hooks,
    ownership,
    timing,
  );
  return { runner, session, calls, waits, hooks };
}

async function run(h: Harness, campaignId: string): Promise<void> {
  h.runner.start(campaignId);
  await h.runner.whenStopped(campaignId);
}

/** End a loop from inside a wait: the next pass reads the campaign as not running and stops. */
const stopCampaign = (ds: DataSource, id: string) => ds.getRepository(Campaign).update({ id }, { status: 'cancelled' });

const statusesOf = async (ds: DataSource, id: string) => (await recipientsOf(ds, id)).map(r => r.status);

describe('CampaignRunner', () => {
  let ds: DataSource;
  let sessionId: string;

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    ds = await createCampaignDataSource();
    sessionId = (await seedSession(ds, { createdAt: NOW })).id;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await ds.destroy();
  });

  it('C17 sends the text once to each recipient, in list order, one engine call at a time', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us'], {
      text: 'Novidades!',
    });
    const h = buildRunner(ds);

    await run(h, campaign.id);

    expect(h.calls.map(c => [c.chatId, c.text])).toEqual([
      ['111111@c.us', 'Novidades!'],
      ['222222@c.us', 'Novidades!'],
      ['333333@c.us', 'Novidades!'],
    ]);
    expect(await statusesOf(ds, campaign.id)).toEqual(['sent', 'sent', 'sent']);
  });

  it.each([
    [0, 3000],
    [0.999, 4998],
  ])('C18 waits 3000 ms plus random × 2000 between sends (random %p → %p ms)', async (random, gap) => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us']);
    const h = buildRunner(ds, { random });

    await run(h, campaign.id);

    expect(h.waits).toEqual([gap, gap, gap]);
    expect(h.calls[1].at - h.calls[0].at).toBe(gap);
    expect(h.calls[2].at - h.calls[1].at).toBe(gap);
  });

  describe('with send pacing on and a cold cap of 5', () => {
    const pacingConfig = {
      get: (key: string) =>
        key === 'sendPacing'
          ? computeSendPacingConfig({ SEND_PACING_ENABLED: 'true', SEND_PACING_COLD_DAILY_CAP: '5' })
          : undefined,
    } as unknown as ConfigService;
    const realPacing = () => new SendPacingService(ds.getRepository(Message), ds.getRepository(Session), pacingConfig);
    const twelve = Array.from({ length: 12 }, (_, i) => `55119000000${String(i).padStart(2, '0')}@c.us`);

    it('C19 ends the UTC day with 5 sent, 7 pending and none failed', async () => {
      const campaign = await seedCampaign(ds, sessionId, twelve);
      let atRefusal: string[] = [];
      const h = buildRunner(ds, {
        pacing: realPacing(),
        onSleep: async ms => {
          if (ms <= 5000) return;
          // The first wait longer than a send gap is the spent allowance; read the day's outcome there.
          atRefusal = await statusesOf(ds, campaign.id);
          await stopCampaign(ds, campaign.id);
        },
      });

      await run(h, campaign.id);

      expect(atRefusal.filter(s => s === 'sent')).toHaveLength(5);
      expect(atRefusal.filter(s => s === 'pending')).toHaveLength(7);
      expect(atRefusal.filter(s => s === 'failed')).toHaveLength(0);
      expect(h.calls).toHaveLength(5);
    });

    it('C20 waits exactly retryAfterSeconds, then sends again after 00:00 UTC on its own', async () => {
      const campaign = await seedCampaign(ds, sessionId, twelve);
      const pacing = realPacing();
      const refusals: Array<{ at: number; retryAfterSeconds: number }> = [];
      const assertSendAllowed = pacing.assertSendAllowed.bind(pacing);
      jest.spyOn(pacing, 'assertSendAllowed').mockImplementation(async (...args) => {
        try {
          return await assertSendAllowed(...args);
        } catch (error) {
          const body = (error as HttpException).getResponse() as { retryAfterSeconds: number };
          refusals.push({ at: Date.now(), retryAfterSeconds: body.retryAfterSeconds });
          throw error;
        }
      });
      const callsAtLongWait: number[] = [];
      const h = buildRunner(ds, {
        pacing,
        onSleep: async ms => {
          if (ms <= 5000) return;
          callsAtLongWait.push(h.calls.length);
          if (callsAtLongWait.length === 2) await stopCampaign(ds, campaign.id);
        },
      });

      await run(h, campaign.id);

      const first = refusals[0];
      expect(first.retryAfterSeconds).toBeGreaterThan(0);
      expect(h.waits).toContain(first.retryAfterSeconds * 1000);
      // Nothing went to the engine during the wait: the 6th send starts once the refusal said it lifts.
      expect(callsAtLongWait).toEqual([5, 10]);
      expect(h.calls[5].at).toBeGreaterThanOrEqual(first.at + first.retryAfterSeconds * 1000);
      expect(new Date(h.calls[5].at).toISOString().slice(0, 10)).toBe('2026-10-09');
      expect(new Date(h.calls[4].at).toISOString().slice(0, 10)).toBe('2026-10-08');
    });
  });

  it('C21 sends nothing while the session is restricted, and resumes once the restriction lifts', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us']);
    let pendingWhileRestricted: string[] = [];
    const h = buildRunner(ds, {
      onSleep: async (_ms, index) => {
        if (index !== 2) return;
        pendingWhileRestricted = await statusesOf(ds, campaign.id);
        expect(h.calls).toHaveLength(0);
        h.session.restriction = null;
      },
    });
    h.session.restriction = { kind: 'reachout_timelock', code: 'REACHOUT_TIMELOCK' };

    await run(h, campaign.id);

    expect(pendingWhileRestricted).toEqual(['pending', 'pending']);
    expect(h.waits.slice(0, 3)).toEqual([IDLE_MS, IDLE_MS, IDLE_MS]);
    expect(h.calls.map(c => c.chatId)).toEqual(['111111@c.us', '222222@c.us']);
  });

  it('C22 sends nothing while the session is not ready, and resumes once it is', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us']);
    let pendingWhileDown: string[] = [];
    const h = buildRunner(ds, {
      onSleep: async (_ms, index) => {
        if (index !== 2) return;
        pendingWhileDown = await statusesOf(ds, campaign.id);
        expect(h.calls).toHaveLength(0);
        h.session.status = SessionStatus.READY;
      },
    });
    h.session.status = SessionStatus.DISCONNECTED;

    await run(h, campaign.id);

    expect(pendingWhileDown).toEqual(['pending', 'pending']);
    expect(h.calls.map(c => c.chatId)).toEqual(['111111@c.us', '222222@c.us']);
  });

  it('C23 fails only the recipient the engine refuses, with SEND_FAILED, and sends the next', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us']);
    const h = buildRunner(ds, {
      send: chatId =>
        chatId === '222222@c.us'
          ? Promise.reject(new EngineRefusedError('not on WhatsApp'))
          : Promise.resolve({ id: `wa-${chatId}`, timestamp: 1 }),
    });

    await run(h, campaign.id);

    const rows = await recipientsOf(ds, campaign.id);
    expect(rows.map(r => r.status)).toEqual(['sent', 'failed', 'sent']);
    expect(rows[1].errorCode).toBe('SEND_FAILED');
    expect(rows[1].errorMessage).toBe('not on WhatsApp');
  });

  it('C24 fails a recipient the message:sending gate blocks, with SEND_BLOCKED, without asking the engine', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us']);
    const h = buildRunner(ds);
    h.hooks.register('moderation', 'message:sending', ctx => {
      const { input } = ctx.data as { input: { chatId: string } };
      return Promise.resolve({ continue: input.chatId !== '222222@c.us' });
    });

    await run(h, campaign.id);

    const rows = await recipientsOf(ds, campaign.id);
    expect(rows.map(r => r.status)).toEqual(['sent', 'failed', 'sent']);
    expect(rows[1].errorCode).toBe('SEND_BLOCKED');
    expect(h.calls.map(c => c.chatId)).toEqual(['111111@c.us', '333333@c.us']);
  });

  it('C25 completes the campaign once nothing is pending or sending', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us']);
    const h = buildRunner(ds);

    await run(h, campaign.id);

    const row = await ds.getRepository(Campaign).findOneByOrFail({ id: campaign.id });
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it('C26 after a restart keeps the campaign running, fails the interrupted send and resumes from the next pending', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us', '444444@c.us'], {
      recipientStatus: ['sent', 'sending', 'pending', 'pending'],
    });
    let afterFirstSend: { campaign: string; statuses: string[] } | undefined;
    const h = buildRunner(ds, {
      onSleep: async (_ms, index) => {
        if (index !== 0) return;
        afterFirstSend = {
          campaign: (await ds.getRepository(Campaign).findOneByOrFail({ id: campaign.id })).status,
          statuses: await statusesOf(ds, campaign.id),
        };
      },
    });

    await h.runner.onApplicationBootstrap();
    await h.runner.whenStopped(campaign.id);
    await h.runner.onModuleDestroy();

    expect(afterFirstSend).toEqual({ campaign: 'running', statuses: ['sent', 'failed', 'sent', 'pending'] });
    const rows = await recipientsOf(ds, campaign.id);
    expect(rows[1].errorCode).toBe('SEND_INTERRUPTED');
    expect(h.calls.map(c => c.chatId)).toEqual(['333333@c.us', '444444@c.us']);
  });

  it('C27 two runners on one database send to each recipient exactly once', async () => {
    jest.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), 'campaign-'));
    const file = join(dir, 'data.sqlite');
    const first = await createCampaignDataSource(file);
    const second = new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: [Session, Message, Campaign, CampaignRecipient],
    });
    await second.initialize();
    await second.query('PRAGMA busy_timeout = 5000');
    try {
      const session = await seedSession(first);
      const chatIds = Array.from({ length: 10 }, (_, i) => `55119000000${String(i).padStart(2, '0')}@c.us`);
      const campaign = await seedCampaign(first, session.id, chatIds);
      // Yields a macrotask, as a real wait does: better-sqlite3 answers synchronously, so a wait that
      // resolved at once would keep the event loop from ever running the engine's timer.
      const noWait = { sleep: () => new Promise<void>(resolve => setImmediate(resolve)) };
      const a = buildRunner(first, { send: slowSend });
      const b = buildRunner(second, { send: slowSend });
      Object.assign((a.runner as unknown as { timing: CampaignTiming }).timing, noWait);
      Object.assign((b.runner as unknown as { timing: CampaignTiming }).timing, noWait);

      a.runner.start(campaign.id);
      b.runner.start(campaign.id);
      await Promise.all([a.runner.whenStopped(campaign.id), b.runner.whenStopped(campaign.id)]);

      const sent = [...a.calls, ...b.calls].map(c => c.chatId).sort();
      expect(sent).toEqual([...chatIds].sort());
      expect(a.calls.length).toBeGreaterThan(0);
      expect(b.calls.length).toBeGreaterThan(0);
    } finally {
      await second.destroy();
      await first.destroy();
      rmSync(dir, { recursive: true, force: true });
    }

    function slowSend(chatId: string): Promise<{ id: string; timestamp: number }> {
      return new Promise(resolve =>
        setTimeout(() => resolve({ id: `wa-${chatId}-${Math.random()}`, timestamp: 1 }), 5),
      );
    }
  });

  it('C28 sends nothing and writes no wait state for a session another node owns', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us']);
    const h = buildRunner(ds, {
      ownsSession: () => false,
      onSleep: async (_ms, index) => {
        if (index === 2) await stopCampaign(ds, campaign.id);
      },
    });
    h.session.status = SessionStatus.DISCONNECTED;

    await run(h, campaign.id);

    expect(h.calls).toHaveLength(0);
    expect(h.waits).toEqual([IDLE_MS, IDLE_MS, IDLE_MS]);
    const row = await ds.getRepository(Campaign).findOneByOrFail({ id: campaign.id });
    expect(row.waitReason).toBeNull();
    expect(await statusesOf(ds, campaign.id)).toEqual(['pending']);
  });

  it('C41 records why it waits — pacing with its retry time, restricted, disconnected — and clears it on the next send', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us']);
    const seen: Array<{ reason: string | null; nextAttemptAt: string | null }> = [];
    const read = async () => {
      const row = await ds.getRepository(Campaign).findOneByOrFail({ id: campaign.id });
      seen.push({ reason: row.waitReason, nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null });
    };
    let refusedOnce = false;
    const pacing = {
      ...permissivePacing(),
      assertSendAllowed: () => {
        if (refusedOnce) return Promise.resolve(undefined);
        refusedOnce = true;
        return Promise.reject(
          new HttpException({ statusCode: 429, code: 'SEND_PACING_LIMITED', retryAfterSeconds: 600 }, 429),
        );
      },
    } as unknown as SendPacingService;
    const h = buildRunner(ds, {
      pacing,
      onSleep: async (_ms, index) => {
        await read();
        if (index === 0) h.session.restriction = { kind: 'reachout_timelock', code: 'X' };
        if (index === 1) {
          h.session.restriction = null;
          h.session.status = SessionStatus.DISCONNECTED;
        }
        if (index === 2) h.session.status = SessionStatus.READY;
      },
    });

    await run(h, campaign.id);

    // Each wait is read after the clock advanced by it, so the pacing entry's retry time is in the past.
    expect(seen.slice(0, 4)).toEqual([
      { reason: 'pacing', nextAttemptAt: new Date(NOW.getTime() + 600_000).toISOString() },
      { reason: 'restricted', nextAttemptAt: null },
      { reason: 'disconnected', nextAttemptAt: null },
      { reason: null, nextAttemptAt: null },
    ]);
    expect(h.waits[0]).toBe(600_000);
  });

  it('C43 starts no send after a cancel resolves, and lets the send in the engine finish as sent', async () => {
    const campaign = await seedCampaign(ds, sessionId, ['111111@c.us', '222222@c.us', '333333@c.us']);
    let release!: () => void;
    let entered!: () => void;
    const inEngine = new Promise<void>(resolve => (entered = resolve));
    const h = buildRunner(ds, {
      send: chatId =>
        new Promise(resolve => {
          release = () => resolve({ id: `wa-${chatId}`, timestamp: 1 });
          entered();
        }),
    });
    const service = new CampaignsService(
      ds.getRepository(Campaign),
      ds.getRepository(CampaignRecipient),
      ds.getRepository(Session),
      h.runner,
    );

    h.runner.start(campaign.id);
    await inEngine;
    await service.cancel(sessionId, campaign.id);
    const callsAtCancel = h.calls.length;
    release();
    await h.runner.whenStopped(campaign.id);

    expect(callsAtCancel).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(await statusesOf(ds, campaign.id)).toEqual(['sent', 'cancelled', 'cancelled']);
    expect((await ds.getRepository(Campaign).findOneByOrFail({ id: campaign.id })).status).toBe('cancelled');
  });
});
