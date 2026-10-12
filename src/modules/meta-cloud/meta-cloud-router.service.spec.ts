import { MetaCloudNumberRegistry, MetaCloudInboundTarget } from '../../engine/adapters/meta-cloud-number-registry';
import type { MetaWebhookChangeValue } from '../../engine/adapters/meta-cloud-inbound.mapper';
import { INBOUND_MESSAGES, messagesValue, webhookBody } from '../../engine/adapters/__fixtures__/meta-cloud-webhooks';
import { MetaCloudWebhookRouter } from './meta-cloud-router.service';

/** The `meta_cloud_accounts` rows the router may look a number up in: `find` answers the stored ones asked for. */
function accountsHolding(...stored: string[]) {
  return {
    find: jest.fn((options: { where: { phoneNumberId: { value: string[] } } }) =>
      Promise.resolve(
        options.where.phoneNumberId.value.filter(id => stored.includes(id)).map(phoneNumberId => ({ phoneNumberId })),
      ),
    ),
  };
}

describe('MetaCloudWebhookRouter', () => {
  const deliveries: Array<{ session: string; wamid: string }> = [];

  function liveTarget(session: string): MetaCloudInboundTarget {
    return {
      sessionId: session,
      handleWebhookChange: (value: MetaWebhookChangeValue) => {
        deliveries.push({ session, wamid: String((value.messages?.[0] as { id?: string })?.id) });
        return Promise.resolve();
      },
    };
  }

  /** A `messages` change for `phoneNumberId` carrying one text message with id `wamid`. */
  const change = (phoneNumberId: string, wamid: string) => ({
    field: 'messages',
    value: messagesValue({ messages: [{ ...INBOUND_MESSAGES.text, id: wamid }] }, phoneNumberId),
  });

  let registry: MetaCloudNumberRegistry;
  let accounts: ReturnType<typeof accountsHolding>;
  let router: MetaCloudWebhookRouter;
  let warn: jest.SpyInstance<void, unknown[]>;

  beforeEach(() => {
    deliveries.length = 0;
    registry = new MetaCloudNumberRegistry();
    // 111000111 and 222000222 are live below; 444000444 has an account but no live session here.
    accounts = accountsHolding('111000111', '222000222', '444000444');
    router = new MetaCloudWebhookRouter(registry, accounts as never);
    warn = jest
      .spyOn((router as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger, 'warn')
      .mockImplementation();
    registry.register('111000111', liveTarget('A'));
    registry.register('222000222', liveTarget('B'));
  });

  it('C66 a change whose phone_number_id matches no live session is dropped with a warning naming it', async () => {
    await router.handle(webhookBody([change('999888777666', 'wamid.unrouted')]));

    expect(deliveries).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('999888777666');
  });

  it('C66 a number unregistered by its session is no longer routed', async () => {
    const target = liveTarget('C');
    registry.register('333000333', target);
    registry.unregister('333000333', target);

    await router.handle(webhookBody([change('333000333', 'wamid.after-disconnect')]));

    expect(deliveries).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain('333000333');
  });

  it('C67 2 entry[] of 2 changes[] each, all for live sessions, lead to 4 deliveries in order', async () => {
    await router.handle(
      webhookBody(
        [change('111000111', 'wamid.1'), change('222000222', 'wamid.2')],
        [change('222000222', 'wamid.3'), change('111000111', 'wamid.4')],
      ),
    );

    expect(deliveries).toEqual([
      { session: 'A', wamid: 'wamid.1' },
      { session: 'B', wamid: 'wamid.2' },
      { session: 'B', wamid: 'wamid.3' },
      { session: 'A', wamid: 'wamid.4' },
    ]);
  });

  it('C67 an account_update change is skipped without stopping the rest', async () => {
    await router.handle(
      webhookBody(
        [
          change('111000111', 'wamid.1'),
          { field: 'account_update', value: { phone_number: '15550783881', event: 'VERIFIED_ACCOUNT' } },
        ],
        [change('222000222', 'wamid.2')],
      ),
    );

    expect(deliveries).toEqual([
      { session: 'A', wamid: 'wamid.1' },
      { session: 'B', wamid: 'wamid.2' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('knownNumbersNotLive: which numbers of a body make Meta retry it (Landing 16)', () => {
    it('C96 a number with a stored account and no live session here is reported, from one query', async () => {
      const body = webhookBody([change('444000444', 'wamid.not-live')]);

      expect(await router.knownNumbersNotLive(body)).toEqual(['444000444']);
      expect(accounts.find).toHaveBeenCalledTimes(1);
    });

    it('C97 a number with no stored account is not reported', async () => {
      const body = webhookBody([change('999888777666', 'wamid.unknown')]);

      expect(await router.knownNumbersNotLive(body)).toEqual([]);
    });

    it('C98 a body whose numbers are all live reports none and makes no query', async () => {
      const body = webhookBody([change('111000111', 'wamid.1')], [change('222000222', 'wamid.2')]);

      expect(await router.knownNumbersNotLive(body)).toEqual([]);
      expect(accounts.find).not.toHaveBeenCalled();
    });

    it('C98 a mixed body reports only the stored number that is not live, asking once for each distinct number', async () => {
      const body = webhookBody(
        [change('111000111', 'wamid.1'), change('444000444', 'wamid.2')],
        [
          change('444000444', 'wamid.3'),
          change('999888777666', 'wamid.4'),
          { field: 'account_update', value: { metadata: { phone_number_id: '555000555' } } },
        ],
      );

      expect(await router.knownNumbersNotLive(body)).toEqual(['444000444']);
      expect(accounts.find).toHaveBeenCalledTimes(1);
      expect(accounts.find.mock.calls[0][0].where.phoneNumberId.value).toEqual(['444000444', '999888777666']);
    });
  });

  it('C67 a session that fails on its change does not stop the next one', async () => {
    registry.register('111000111', {
      sessionId: 'A',
      handleWebhookChange: () => Promise.reject(new Error('adapter failed')),
    });
    jest.spyOn((router as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation();

    await router.handle(webhookBody([change('111000111', 'wamid.1'), change('222000222', 'wamid.2')]));

    expect(deliveries).toEqual([{ session: 'B', wamid: 'wamid.2' }]);
  });
});
