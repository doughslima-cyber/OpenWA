import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InfraDataService } from './infra-data.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { MetaCloudAccount } from '../../engine/adapters/meta-cloud-account.entity';
import { encryptMetaToken } from '../../engine/adapters/meta-cloud-crypto';
import type { MigrationTables } from './migration-tables.types';

/**
 * OpenMsg (docs/32, Landing 15, AD-005): a Cloud session's account row travels in the `/infra` backup
 * without its token, so a restored session keeps its number and can be given its token again through
 * `PUT .../meta/account`. Proven here against a real SQLite data connection, through the same export
 * and import the HTTP routes call.
 */
describe('meta_cloud_accounts in the /infra backup', () => {
  const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-q7Lw2xVt9Rk3f';
  const PHONE_NUMBER_ID = '106540352249301';
  const WABA_ID = '102290129349301';
  const SESSION_ID = 'cloud-backup-1';
  const key = randomBytes(32);
  const cfg = { get: (k: string, def?: unknown) => (k === 'dataDatabase.type' ? 'sqlite' : def) };
  // Every column the export lists (export-tables.ts), each with a distinctive non-null value, so a
  // column dropped from the export or from the importer turns the comparison red.
  const SEEDED = {
    sessionId: SESSION_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    wabaId: WABA_ID,
    displayPhoneNumber: '+55 11 99999-0000',
    verifiedName: 'Acme',
    qualityRating: 'YELLOW',
    messagingLimitTier: 'TIER_10K',
    lastCheckedAt: new Date('2026-03-04T05:06:07.890Z'),
    createdAt: new Date('2025-01-02T03:04:05.000Z'),
    updatedAt: new Date('2025-06-07T08:09:10.000Z'),
  };
  const DATE_COLUMNS = new Set(['lastCheckedAt', 'createdAt', 'updatedAt']);
  /** The ten exported columns of `row`, dates as ISO instants (SQLite stores UTC text without a zone). */
  const exportedColumnsOf = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.keys(SEEDED).map(column => {
        const value = row[column];
        if (!DATE_COLUMNS.has(column) || value === undefined || value === null) return [column, value];
        if (value instanceof Date) return [column, value.toISOString()];
        if (typeof value !== 'string') return [column, value];
        const text = value;
        const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
        return [column, new Date(zoned).toISOString()];
      }),
    );

  let ds: DataSource;
  let service: InfraDataService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      // The data-connection entities the export registry names, plus the Cloud account table.
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        ChatState,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        WebhookOutboxEvent,
        IntegrationDeliveryFailure,
        StatusUpdate,
        AutomationRule,
        MetaCloudAccount,
      ],
      synchronize: true,
    });
    await ds.initialize();
    service = new InfraDataService(cfg as never, ds);

    const sessions = ds.getRepository(Session);
    await sessions.save(
      sessions.create({
        id: SESSION_ID,
        name: 'cloud-backup',
        status: SessionStatus.DISCONNECTED,
        engine: 'meta-cloud',
        config: {},
      }),
    );
    await ds.getRepository(MetaCloudAccount).insert({
      ...SEEDED,
      accessTokenEnc: encryptMetaToken(TOKEN, key),
      accessTokenLast4: TOKEN.slice(-4),
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const accountRows = (tables: MigrationTables): Array<Record<string, unknown>> =>
    ((tables as unknown as Record<string, unknown>).metaCloudAccounts ?? []) as Array<Record<string, unknown>>;

  /** Every 8-character run of the token found in `text`. */
  const tokenRunsIn = (text: string): string[] => {
    const found: string[] = [];
    for (let i = 0; i + 8 <= TOKEN.length; i++) {
      if (text.includes(TOKEN.slice(i, i + 8))) found.push(TOKEN.slice(i, i + 8));
    }
    return found;
  };

  it('C93 the export carries the account row with its number and WABA, and no token in any form', async () => {
    const dump = await service.exportData();

    const rows = accountRows(dump.tables);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: SESSION_ID, phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID });
    expect(rows[0].accessTokenEnc ?? null).toBeNull();
    expect(rows[0].accessTokenLast4 ?? null).toBeNull();
    expect(tokenRunsIn(JSON.stringify(dump))).toEqual([]);
  });

  it('C93 the exported row carries each of the ten exported columns with its seeded value', async () => {
    const dump = await service.exportData();

    const rows = accountRows(dump.tables);
    expect(rows).toHaveLength(1);
    expect(exportedColumnsOf(rows[0])).toEqual(exportedColumnsOf(SEEDED));
  });

  it('C94 restoring the export recreates the account row with a NULL token', async () => {
    const dump = await service.exportData();

    const res = await service.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    const restored = await ds.getRepository(MetaCloudAccount).findOneByOrFail({ sessionId: SESSION_ID });
    expect(restored).toMatchObject({
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      verifiedName: 'Acme',
      accessTokenEnc: null,
      accessTokenLast4: null,
    });
    expect((await ds.getRepository(Session).findOneByOrFail({ id: SESSION_ID })).engine).toBe('meta-cloud');
  });

  it('C94 the restored row holds each of the ten exported columns with its seeded value', async () => {
    const dump = await service.exportData();
    await ds.getRepository(MetaCloudAccount).clear();

    const res = await service.importData({ tables: dump.tables });

    expect(res.imported).toBe(true);
    const restored = await ds.getRepository(MetaCloudAccount).findOneByOrFail({ sessionId: SESSION_ID });
    expect(exportedColumnsOf(restored as unknown as Record<string, unknown>)).toEqual(exportedColumnsOf(SEEDED));
    expect(restored.accessTokenEnc).toBeNull();
    expect(restored.accessTokenLast4).toBeNull();
  });

  it('C94 a hand-edited archive carrying both token columns still restores them as NULL', async () => {
    const dump = await service.exportData();
    const rows = accountRows(dump.tables);
    expect(rows).toHaveLength(1);
    rows[0].accessTokenEnc = encryptMetaToken(TOKEN, key);
    rows[0].accessTokenLast4 = TOKEN.slice(-4);

    const res = await service.importData({ tables: dump.tables });

    expect(res.imported).toBe(true);
    const restored = await ds.getRepository(MetaCloudAccount).findOneByOrFail({ sessionId: SESSION_ID });
    expect(restored.accessTokenEnc).toBeNull();
    expect(restored.accessTokenLast4).toBeNull();
  });

  it('C95 the export counts carry metaCloudAccounts equal to the exported rows', async () => {
    const dump = await service.exportData();

    expect((dump.counts as unknown as Record<string, number>).metaCloudAccounts).toBe(1);
    expect(accountRows(dump.tables)).toHaveLength(1);
  });
});
