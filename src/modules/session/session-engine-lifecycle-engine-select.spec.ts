import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';

/**
 * OpenMsg (docs/32): the lifecycle hands the row's `engine` to the factory, which picks the plugin.
 * NULL in the row reaches the factory as `undefined`, so ENGINE_TYPE decides; `meta-cloud` reaches
 * it as is, whatever ENGINE_TYPE is.
 */
const ID = 'sess-uuid-engine';

const row = (engine: string | null): Session => ({
  id: ID,
  name: 'engine-select',
  status: SessionStatus.CREATED,
  phone: null,
  pushName: null,
  config: {},
  proxyUrl: null,
  proxyType: null,
  connectedAt: null,
  lastActiveAt: null,
  nodeId: null,
  claimedAt: null,
  leaseExpiresAt: null,
  desiredState: null,
  nodeUrl: null,
  engine,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeEngine = (): Record<string, jest.Mock> => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  forceDestroy: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  logout: jest.fn().mockResolvedValue(undefined),
  getQRCode: jest.fn().mockReturnValue(null),
});

describe('SessionEngineLifecycle engine selection', () => {
  let lifecycle: SessionEngineLifecycle;
  let repository: { findOne: jest.Mock; update: jest.Mock; exists: jest.Mock };
  let engineFactory: { create: jest.Mock; purgeSessionData: jest.Mock };
  const config: Record<string, unknown> = { 'engine.type': 'baileys' };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      exists: jest.fn().mockResolvedValue(false),
    };
    engineFactory = {
      create: jest.fn().mockImplementation(() => makeEngine()),
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        SessionService,
        SessionEngineLifecycle,
        SessionErrorStore,
        SessionRestrictionStore,
        PresenceStore,
        { provide: getRepositoryToken(Session, 'data'), useValue: repository },
        { provide: getRepositoryToken(Message, 'data'), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getDataSourceToken('data'), useValue: {} },
        { provide: EngineFactory, useValue: engineFactory },
        EngineRegistry,
        SessionLidResolver,
        SessionLivenessWatchdog,
        MessageProjector,
        {
          provide: EventsGateway,
          useValue: {
            emitSessionStatus: jest.fn(),
            emitSessionDisconnected: jest.fn(),
            emitQRCode: jest.fn(),
            emitSessionAuthenticated: jest.fn(),
          },
        },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: HookManager, useValue: { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(<T>(key: string, def?: T): T => (key in config ? (config[key] as T) : (def as T))) },
        },
        { provide: LidMappingStoreService, useValue: { remember: jest.fn() } },
        { provide: StatusStoreService, useValue: { ingest: jest.fn() } },
      ],
    }).compile();
    lifecycle = module.get(SessionEngineLifecycle);
  });

  it('C2 passes engine undefined to EngineFactory.create for a row whose engine is NULL', async () => {
    repository.findOne.mockResolvedValue(row(null));

    await lifecycle.start(ID);

    expect(engineFactory.create).toHaveBeenCalledTimes(1);
    const options = (engineFactory.create.mock.calls[0] as [Record<string, unknown>])[0];
    expect(options).toEqual(expect.objectContaining({ sessionId: ID, dbSessionId: ID }));
    expect(options.engine).toBeUndefined();
  });

  it('C3 passes engine meta-cloud to EngineFactory.create for a meta-cloud row under ENGINE_TYPE=baileys', async () => {
    repository.findOne.mockResolvedValue(row('meta-cloud'));

    await lifecycle.start(ID);

    expect(engineFactory.create).toHaveBeenCalledTimes(1);
    expect(engineFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ID, dbSessionId: ID, engine: 'meta-cloud' }),
    );
  });
});
