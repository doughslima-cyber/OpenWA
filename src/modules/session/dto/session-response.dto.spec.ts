import { Session, SessionStatus } from '../entities/session.entity';
import { SessionResponseDto } from './session-response.dto';

describe('SessionResponseDto engine', () => {
  const prevEngineType = process.env.ENGINE_TYPE;

  afterEach(() => {
    if (prevEngineType === undefined) delete process.env.ENGINE_TYPE;
    else process.env.ENGINE_TYPE = prevEngineType;
  });

  const row = (engine: string | null | undefined): Session =>
    ({
      id: '0a941dac-a965-45e7-b318-74ae8be134f0',
      name: 'my-bot',
      status: SessionStatus.READY,
      phone: null,
      pushName: null,
      config: {},
      proxyUrl: null,
      proxyType: null,
      connectedAt: null,
      lastActiveAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      engine,
    }) as Session;

  it('C1 reports the deployment engine for a row whose engine is NULL under ENGINE_TYPE=baileys', () => {
    process.env.ENGINE_TYPE = 'baileys';
    expect(SessionResponseDto.fromEntity(row(null), false).engine).toBe('baileys');
  });

  it('C1 reports meta-cloud for a meta-cloud row under ENGINE_TYPE=baileys', () => {
    process.env.ENGINE_TYPE = 'baileys';
    expect(SessionResponseDto.fromEntity(row('meta-cloud'), false).engine).toBe('meta-cloud');
  });

  it('reports the whatsapp-web.js default when ENGINE_TYPE is unset and the row has no engine', () => {
    delete process.env.ENGINE_TYPE;
    expect(SessionResponseDto.fromEntity(row(undefined), true).engine).toBe('whatsapp-web.js');
  });
});
