import { mapCloudChange, type CloudInboundEvent } from './meta-cloud-inbound.mapper';
import { MetaCloudAdapter } from './meta-cloud-adapter';
import type { MetaCloudAccountPort } from './meta-cloud-account-store.service';
import {
  FIXTURE_PROFILE_NAME,
  FIXTURE_WA_ID,
  INBOUND_MESSAGES,
  STATUSES,
  messagesValue,
} from './__fixtures__/meta-cloud-webhooks';

const CHAT = `${FIXTURE_WA_ID}@c.us`;

/** The single event the mapper makes of one fixture message. */
function mapOne(name: keyof typeof INBOUND_MESSAGES): CloudInboundEvent {
  const events = mapCloudChange(messagesValue({ messages: [INBOUND_MESSAGES[name]] }));
  expect(events).toHaveLength(1);
  return events[0];
}

function messageOf(event: CloudInboundEvent) {
  if (event.kind !== 'message') throw new Error(`expected a message, got ${event.kind}`);
  return event;
}

describe('mapCloudChange - messages', () => {
  it('C58 maps text to a text message from <wa_id>@c.us with the sender profile name', () => {
    const { message, contact } = messageOf(mapOne('text'));

    expect(message).toMatchObject({
      id: INBOUND_MESSAGES.text.id,
      type: 'text',
      body: 'Hello, is the order ready?',
      chatId: CHAT,
      from: CHAT,
      fromMe: false,
      isGroup: false,
      timestamp: 1760000000,
    });
    expect(message.contact?.pushName).toBe(FIXTURE_PROFILE_NAME);
    expect(contact).toEqual({
      waId: FIXTURE_WA_ID,
      profileName: FIXTURE_PROFILE_NAME,
      at: new Date(1760000000 * 1000),
      wamid: INBOUND_MESSAGES.text.id,
    });
  });

  it.each([
    ['image', 'image', '1003383421387256', 'image/jpeg', 'the receipt'],
    ['video', 'video', '1184614809346421', 'video/mp4', 'unboxing'],
    ['audio', 'audio', '1462618324537291', 'audio/ogg; codecs=opus', ''],
    ['document', 'document', '1286349875489123', 'application/pdf', 'invoice'],
    ['sticker', 'sticker', '1395726841023567', 'image/webp', ''],
  ])('C58 maps %s to the same type and keeps the media id for download', (name, type, mediaId, mimetype, caption) => {
    const event = messageOf(mapOne(name));

    expect(event.message).toMatchObject({ type, body: caption, chatId: CHAT });
    expect(event.message.media).toMatchObject({ mimetype });
    expect(event.message.media?.data).toBeUndefined();
    expect(event.media).toMatchObject({ id: mediaId, mimetype });
  });

  it('C58 keeps the filename of a document', () => {
    expect(messageOf(mapOne('document')).media?.filename).toBe('invoice-0042.pdf');
  });

  it('C58 maps location to a location message', () => {
    const { message } = messageOf(mapOne('location'));

    expect(message).toMatchObject({
      type: 'location',
      chatId: CHAT,
      location: {
        latitude: -23.5613,
        longitude: -46.6565,
        description: 'Avenida Paulista',
        address: 'Av. Paulista, 1578 - Bela Vista, São Paulo',
      },
    });
  });

  it('C58 maps contacts to a contact message whose body is the shared card', () => {
    const { message } = messageOf(mapOne('contacts'));

    expect(message.type).toBe('contact');
    expect(message.chatId).toBe(CHAT);
    expect(message.body).toContain('FN:Barbara Johnson');
    expect(message.body).toContain('19405551234');
  });

  it('C58 maps reaction to a reaction event on the reacted wamid', () => {
    const event = mapOne('reaction');

    expect(event).toMatchObject({
      kind: 'reaction',
      reaction: {
        messageId: (INBOUND_MESSAGES.reaction.reaction as { message_id: string }).message_id,
        reaction: '👍',
        chatId: CHAT,
        senderId: CHAT,
      },
    });
  });

  it.each([
    ['button_reply', 'confirm-order', 'Confirm'],
    ['list_reply', 'slot-2', 'Tomorrow 10:00'],
    ['button', 'STOP_PROMOTIONS', 'Stop promotions'],
  ])('C58 maps %s to button: { id, text }', (name, id, text) => {
    const { message } = messageOf(mapOne(name));

    expect(message.button).toEqual({ id, text });
    expect(message.body).toBe(text);
    expect(message.chatId).toBe(CHAT);
  });

  it.each([
    ['unsupported', 'Message type unknown', 131051],
    ['errors', 'Message failed to be decrypted', 131060],
  ])('C58 maps %s to type unknown with the reason in metadata', (name, reason, code) => {
    const { message } = messageOf(mapOne(name));

    expect(message.type).toBe('unknown');
    expect(message.chatId).toBe(CHAT);
    expect(message.metadata).toMatchObject({ reason, errors: [expect.objectContaining({ code })] });
  });

  it('C58 covers the 14 fixtures, and every chatId ends in @c.us', () => {
    const names = Object.keys(INBOUND_MESSAGES);
    expect(names).toHaveLength(14);
    const events = mapCloudChange(messagesValue({ messages: names.map(n => INBOUND_MESSAGES[n]) }));

    expect(events).toHaveLength(14);
    for (const event of events) {
      const chatId =
        event.kind === 'reaction'
          ? event.reaction.chatId
          : event.kind === 'message'
            ? event.message.chatId
            : event.chatId;
      expect(chatId).toMatch(/^\d+@c\.us$/);
    }
  });
});

describe('mapCloudChange - statuses', () => {
  const wamid = STATUSES.sent.id as string;

  it.each(['sent', 'delivered', 'read'] as const)('C61 maps a %s status to an ack for the wamid', status => {
    expect(mapCloudChange(messagesValue({ statuses: [STATUSES[status]] }))).toEqual([
      { kind: 'ack', messageId: wamid, status, chatId: CHAT },
    ]);
  });

  it('C61 maps a failed status to an ack carrying errors[0].code', () => {
    expect(mapCloudChange(messagesValue({ statuses: [STATUSES.failed] }))).toEqual([
      { kind: 'ack', messageId: wamid, status: 'failed', chatId: CHAT, errorCode: 131026 },
    ]);
  });

  it('C61 the adapter reports the 4 statuses through onMessageAck(wamid, status, "<recipient_id>@c.us")', async () => {
    const accounts: MetaCloudAccountPort = {
      loadCredentials: jest.fn(),
      recordProfile: jest.fn(),
      clearToken: jest.fn(),
    };
    const adapter = new MetaCloudAdapter({ sessionId: 's', dbSessionId: 'db-s', accounts });
    const onMessageAck = jest.fn();
    (adapter as unknown as { callbacks: object }).callbacks = { onMessageAck };

    await adapter.handleWebhookChange(
      messagesValue({ statuses: [STATUSES.sent, STATUSES.delivered, STATUSES.read, STATUSES.failed] }),
    );

    expect(onMessageAck.mock.calls).toEqual([
      [wamid, 'sent', CHAT, undefined],
      [wamid, 'delivered', CHAT, undefined],
      [wamid, 'read', CHAT, undefined],
      [wamid, 'failed', CHAT, 131026],
    ]);
  });
});
