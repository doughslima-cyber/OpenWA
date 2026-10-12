import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineStatus, type EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import { MetaCloudAdapter } from './meta-cloud-adapter';
import type { MetaCloudAccountPort, MetaCloudCredentials, MetaCloudProfile } from './meta-cloud-account-store.service';
import { MetaGraphClient } from './meta-cloud-graph.client';
import { FakeGraph, graphError, refusedGraphUrl, startFakeGraph } from './__fixtures__/fake-graph-server';

const PHONE_NUMBER_ID = '106540352242922';
const WABA_ID = '102290129340398';
const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-adapter-spec-token';

/** The account rows in memory: one session, its token encrypted elsewhere and handed over in clear. */
class InMemoryAccounts implements MetaCloudAccountPort {
  credentials: MetaCloudCredentials | null = { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN };
  profile: MetaCloudProfile | null = null;

  loadCredentials(): Promise<MetaCloudCredentials | null> {
    return Promise.resolve(this.credentials && { ...this.credentials });
  }
  recordProfile(_sessionId: string, profile: MetaCloudProfile): Promise<void> {
    this.profile = profile;
    return Promise.resolve();
  }
  clearToken(): Promise<void> {
    if (this.credentials) this.credentials.accessToken = null;
    return Promise.resolve();
  }
}

function recordingCallbacks() {
  const calls = {
    onReady: jest.fn<void, [string, string]>(),
    onQRCode: jest.fn<void, [string]>(),
    onStateChanged: jest.fn<void, [EngineStatus]>(),
    onActionRequired: jest.fn<void, [string]>(),
  };
  return { calls, callbacks: calls as EngineEventCallbacks };
}

describe('MetaCloudAdapter', () => {
  let graph: FakeGraph;
  let accounts: InMemoryAccounts;

  const adapterAt = (baseUrl: string): MetaCloudAdapter =>
    new MetaCloudAdapter({
      sessionId: 'sess-cloud',
      dbSessionId: 'sess-cloud',
      accounts,
      graph: new MetaGraphClient(() => ({ baseUrl, version: 'v26.0', timeoutMs: 2000 })),
    });

  beforeEach(async () => {
    graph = await startFakeGraph();
    accounts = new InMemoryAccounts();
  });

  afterEach(async () => {
    await graph.close();
  });

  it('C22 reads the number, subscribes the app once, then reports ready with the digits and the verified name', async () => {
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();
    let requestsAtReady = -1;
    calls.onReady.mockImplementation(() => {
      requestsAtReady = graph.requests.length;
    });

    await adapter.initialize(callbacks);

    expect(graph.requests.map(r => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
      `GET /v26.0/${PHONE_NUMBER_ID}`,
      `POST /v26.0/${WABA_ID}/subscribed_apps`,
    ]);
    expect(graph.requests[0].path).toContain('fields=display_phone_number,verified_name');
    expect(graph.requests.every(r => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.onReady).toHaveBeenCalledTimes(1);
    expect(calls.onReady).toHaveBeenCalledWith('5511999990000', 'Acme');
    // Both calls, the subscription included, are made before the session is reported ready.
    expect(requestsAtReady).toBe(2);
    expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.READY);
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('5511999990000');
    expect(accounts.profile).toEqual({
      displayPhoneNumber: '+55 11 99999-0000',
      verifiedName: 'Acme',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
    });
  });

  it('C24 never calls onQRCode nor reports QR_READY while starting, and getQRCode() is null', async () => {
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();

    await adapter.initialize(callbacks);

    expect(calls.onQRCode).not.toHaveBeenCalled();
    expect(calls.onStateChanged.mock.calls.map(([s]) => s)).not.toContain(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBeNull();
  });

  const tokenRefusals: Array<[number, number, string]> = [
    [190, 401, 'Error validating access token: Session has expired on Tuesday, 07-Oct-26 10:00:00 PDT.'],
    [10, 403, '(#10) Application does not have permission for this action'],
    [200, 403, '(#200) Requires whatsapp_business_messaging permission to manage the object'],
  ];

  it.each(tokenRefusals)(
    'C25 Graph code %i on initialize() moves the session to ACTION_REQUIRED with META_TOKEN_INVALID',
    async (code, status, message) => {
      graph.script = () => graphError(status, code, message);
      const adapter = adapterAt(graph.url);
      const { calls, callbacks } = recordingCallbacks();

      await adapter.initialize(callbacks);

      expect(calls.onActionRequired).toHaveBeenCalledWith('META_TOKEN_INVALID');
      expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.ACTION_REQUIRED);
      expect(adapter.getStatus()).toBe(EngineStatus.ACTION_REQUIRED);
      expect(calls.onReady).not.toHaveBeenCalled();
    },
  );

  it.each(tokenRefusals)(
    'C25 Graph code %i on probeLiveness() moves the session to ACTION_REQUIRED with META_TOKEN_INVALID',
    async (code, status, message) => {
      const adapter = adapterAt(graph.url);
      const { calls, callbacks } = recordingCallbacks();
      await adapter.initialize(callbacks);
      calls.onReady.mockClear();
      graph.script = () => graphError(status, code, message);

      await adapter.probeLiveness();

      expect(calls.onActionRequired).toHaveBeenCalledWith('META_TOKEN_INVALID');
      expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.ACTION_REQUIRED);
      expect(adapter.getStatus()).toBe(EngineStatus.ACTION_REQUIRED);
      expect(calls.onReady).not.toHaveBeenCalled();
    },
  );

  it('C26 with no stored token reports ACTION_REQUIRED with META_TOKEN_MISSING and makes no Graph request', async () => {
    accounts.credentials = { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: null };
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();

    await adapter.initialize(callbacks);

    expect(calls.onActionRequired).toHaveBeenCalledWith('META_TOKEN_MISSING');
    expect(adapter.getStatus()).toBe(EngineStatus.ACTION_REQUIRED);
    expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.ACTION_REQUIRED);
    expect(graph.requests).toHaveLength(0);
    expect(calls.onReady).not.toHaveBeenCalled();
  });

  it('C27 rejects with an EngineTransportError and never reports ready when Graph refuses the connection', async () => {
    const adapter = adapterAt(await refusedGraphUrl());
    const { calls, callbacks } = recordingCallbacks();

    await expect(adapter.initialize(callbacks)).rejects.toBeInstanceOf(EngineTransportError);
    expect(calls.onReady).not.toHaveBeenCalled();
    expect(adapter.getStatus()).not.toBe(EngineStatus.READY);
  });

  it('C27 rejects with an EngineTransportError and never reports ready when Graph answers 500', async () => {
    graph.script = () => ({
      status: 500,
      body: { error: { message: 'An unknown error occurred', type: 'OAuthException', code: 1, fbtrace_id: 'AZx9' } },
    });
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();

    await expect(adapter.initialize(callbacks)).rejects.toBeInstanceOf(EngineTransportError);
    expect(calls.onReady).not.toHaveBeenCalled();
    expect(adapter.getStatus()).not.toBe(EngineStatus.READY);
  });

  it('C28 probeLiveness() is true for a 200', async () => {
    const adapter = adapterAt(graph.url);
    await adapter.initialize(recordingCallbacks().callbacks);

    await expect(adapter.probeLiveness()).resolves.toBe(true);
    expect(graph.requests.at(-1)).toEqual(
      expect.objectContaining({ method: 'GET', path: expect.stringMatching(`^/v26.0/${PHONE_NUMBER_ID}`) as unknown }),
    );
  });

  it('C28 probeLiveness() is false when Graph refuses the connection', async () => {
    const adapter = adapterAt(await refusedGraphUrl());
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it.each([500, 503])('C28 probeLiveness() is false when Graph answers %i', async status => {
    const adapter = adapterAt(graph.url);
    await adapter.initialize(recordingCallbacks().callbacks);
    graph.script = () => ({ status, body: { error: { message: 'Service temporarily unavailable', code: 2 } } });

    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('C34 logout() clears the stored token and reports DISCONNECTED', async () => {
    const adapter = adapterAt(graph.url);
    const { calls, callbacks } = recordingCallbacks();
    await adapter.initialize(callbacks);

    await adapter.logout();

    expect(accounts.credentials?.accessToken).toBeNull();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(calls.onStateChanged).toHaveBeenLastCalledWith(EngineStatus.DISCONNECTED);
  });

  it('answers 501 for a method the Cloud API does not offer, such as a pairing code', async () => {
    const engine = adapterAt(graph.url).asEngine();
    await expect(engine.requestPairingCode('5511999990000')).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
});
