/**
 * WhatsApp Cloud API webhook bodies (OpenMsg, docs/32).
 *
 * Written from the payload examples in Meta's WhatsApp Cloud API webhooks reference (the `messages`
 * field: `object: "whatsapp_business_account"`, `entry[].changes[].value` with `messaging_product`,
 * `metadata`, `contacts[]`, `messages[]` and `statuses[]`), not captured from a live number. They are
 * to be replaced by bodies captured on a real number when the docs/32 F0 spike runs.
 */

export const FIXTURE_PHONE_NUMBER_ID = '106540352242924';
export const FIXTURE_DISPLAY_PHONE_NUMBER = '15550783881';
export const FIXTURE_WABA_ID = '102290129340399';
export const FIXTURE_WA_ID = '5511988887777';
export const FIXTURE_PROFILE_NAME = 'Kerry Fisher';

export interface CloudWebhookValue {
  messaging_product: 'whatsapp';
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
  messages?: Array<Record<string, unknown>>;
  statuses?: Array<Record<string, unknown>>;
}

const TIMESTAMP = '1760000000';

/** One inbound message of each type the Cloud API delivers, keyed by the fixture's name. */
export const INBOUND_MESSAGES: Record<string, Record<string, unknown>> = {
  text: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTMA',
    timestamp: TIMESTAMP,
    type: 'text',
    text: { body: 'Hello, is the order ready?' },
  },
  image: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTEA',
    timestamp: TIMESTAMP,
    type: 'image',
    image: {
      caption: 'the receipt',
      mime_type: 'image/jpeg',
      sha256: 'K3bY9oSZ5gRj4X2b1u4zq8D1W1u0kWw7c7gPGG0Q0aQ=',
      id: '1003383421387256',
    },
  },
  video: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTIA',
    timestamp: TIMESTAMP,
    type: 'video',
    video: {
      caption: 'unboxing',
      mime_type: 'video/mp4',
      sha256: 'Z7dbAnbaGq0yI8LmuKmyQ3W2RQLhR8gV1jYgYz7vYvU=',
      id: '1184614809346421',
    },
  },
  audio: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTQA',
    timestamp: TIMESTAMP,
    type: 'audio',
    audio: {
      mime_type: 'audio/ogg; codecs=opus',
      sha256: 'jWtjRtE7RVSzv5yZzPkgDd9dGm4o3B1hgGvLX6ZvhsQ=',
      id: '1462618324537291',
      voice: false,
    },
  },
  document: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTUA',
    timestamp: TIMESTAMP,
    type: 'document',
    document: {
      caption: 'invoice',
      filename: 'invoice-0042.pdf',
      mime_type: 'application/pdf',
      sha256: 'm3V6bQ7j3l5G0yQ0lYw4o0yRZr6p1b2iT7pFJq2y0nE=',
      id: '1286349875489123',
    },
  },
  sticker: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTYA',
    timestamp: TIMESTAMP,
    type: 'sticker',
    sticker: {
      mime_type: 'image/webp',
      sha256: 'pX0n3Z9J1Rk8tYp4m0aW9nT2cQ5vB7sH1dF3gJ6kL8o=',
      id: '1395726841023567',
      animated: false,
    },
  },
  location: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTcA',
    timestamp: TIMESTAMP,
    type: 'location',
    location: {
      latitude: -23.5613,
      longitude: -46.6565,
      name: 'Avenida Paulista',
      address: 'Av. Paulista, 1578 - Bela Vista, São Paulo',
    },
  },
  contacts: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTgA',
    timestamp: TIMESTAMP,
    type: 'contacts',
    contacts: [
      {
        name: { formatted_name: 'Barbara Johnson', first_name: 'Barbara', last_name: 'Johnson' },
        phones: [{ phone: '+1 (940) 555-1234', wa_id: '19405551234', type: 'MOBILE' }],
      },
    ],
  },
  reaction: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QTkA',
    timestamp: TIMESTAMP,
    type: 'reaction',
    reaction: { message_id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxURABIYEjAwMDAwMDAwMDAwMDAwMDA5OQA=', emoji: '👍' },
  },
  button_reply: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QjAA',
    timestamp: TIMESTAMP,
    context: {
      from: FIXTURE_DISPLAY_PHONE_NUMBER,
      id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxURABIYEjAwMDAwMDAwMDAwMDAwMDAxMQA=',
    },
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'confirm-order', title: 'Confirm' } },
  },
  list_reply: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QjEA',
    timestamp: TIMESTAMP,
    context: {
      from: FIXTURE_DISPLAY_PHONE_NUMBER,
      id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxURABIYEjAwMDAwMDAwMDAwMDAwMDAxMgA=',
    },
    type: 'interactive',
    interactive: {
      type: 'list_reply',
      list_reply: { id: 'slot-2', title: 'Tomorrow 10:00', description: 'Morning delivery' },
    },
  },
  button: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QjIA',
    timestamp: TIMESTAMP,
    context: {
      from: FIXTURE_DISPLAY_PHONE_NUMBER,
      id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxURABIYEjAwMDAwMDAwMDAwMDAwMDAxMwA=',
    },
    type: 'button',
    button: { payload: 'STOP_PROMOTIONS', text: 'Stop promotions' },
  },
  unsupported: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QjMA',
    timestamp: TIMESTAMP,
    type: 'unsupported',
    errors: [
      {
        code: 131051,
        title: 'Message type unknown',
        message: 'Message type unknown',
        error_data: { details: 'Message type is currently not supported.' },
      },
    ],
  },
  errors: {
    from: FIXTURE_WA_ID,
    id: 'wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABIYFjNFQjBDNzBBNjc4RkY4QzE0RkI0QjQA',
    timestamp: TIMESTAMP,
    type: 'unknown',
    errors: [
      {
        code: 131060,
        title: 'Message failed to be decrypted',
        message: 'Message failed to be decrypted',
        error_data: { details: 'The message could not be decrypted.' },
      },
    ],
  },
};

const SENT_WAMID = 'wamid.HBgNNTUxMTk4ODg4Nzc3NxURABIYEjAwMDAwMDAwMDAwMDAwMDA5OQA=';

/** One `statuses[]` entry per status the Cloud API reports for a sent message. */
export const STATUSES: Record<'sent' | 'delivered' | 'read' | 'failed', Record<string, unknown>> = {
  sent: {
    id: SENT_WAMID,
    status: 'sent',
    timestamp: TIMESTAMP,
    recipient_id: FIXTURE_WA_ID,
    conversation: { id: 'CONVERSATION_ID', origin: { type: 'service' } },
    pricing: { billable: true, pricing_model: 'PMP', category: 'service' },
  },
  delivered: {
    id: SENT_WAMID,
    status: 'delivered',
    timestamp: TIMESTAMP,
    recipient_id: FIXTURE_WA_ID,
    conversation: { id: 'CONVERSATION_ID', origin: { type: 'service' } },
    pricing: { billable: true, pricing_model: 'PMP', category: 'service' },
  },
  read: { id: SENT_WAMID, status: 'read', timestamp: TIMESTAMP, recipient_id: FIXTURE_WA_ID },
  failed: {
    id: SENT_WAMID,
    status: 'failed',
    timestamp: TIMESTAMP,
    recipient_id: FIXTURE_WA_ID,
    errors: [
      {
        code: 131026,
        title: 'Message undeliverable',
        message: 'Message undeliverable',
        error_data: { details: 'Message Undeliverable.' },
      },
    ],
  },
};

/** The `value` of one `messages` change, for the fixture number. */
export function messagesValue(
  parts: { messages?: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>> },
  phoneNumberId: string = FIXTURE_PHONE_NUMBER_ID,
): CloudWebhookValue {
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: FIXTURE_DISPLAY_PHONE_NUMBER, phone_number_id: phoneNumberId },
    ...(parts.messages ? { contacts: [{ profile: { name: FIXTURE_PROFILE_NAME }, wa_id: FIXTURE_WA_ID }] } : {}),
    ...parts,
  };
}

/** A whole webhook body: one `entry` per WABA, each with its changes. */
export function webhookBody(...entries: Array<Array<{ field: string; value: unknown }>>): {
  object: 'whatsapp_business_account';
  entry: Array<{ id: string; changes: Array<{ field: string; value: unknown }> }>;
} {
  return {
    object: 'whatsapp_business_account',
    entry: entries.map(changes => ({ id: FIXTURE_WABA_ID, changes })),
  };
}

/** A body carrying one `messages` change. */
export function messagesBody(value: CloudWebhookValue) {
  return webhookBody([{ field: 'messages', value }]);
}
