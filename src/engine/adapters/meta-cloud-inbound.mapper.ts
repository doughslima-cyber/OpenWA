import type {
  DeliveryStatus,
  IncomingMessage,
  MessageType,
  ReactionEvent,
} from '../interfaces/whatsapp-engine.interface';

/**
 * WhatsApp Cloud API webhook changes to the neutral engine events (OpenMsg, docs/32). Pure: no I/O,
 * no clock. Media is not fetched here; a media message carries the id the adapter downloads with.
 *
 * Every chat is a phone number, written `<wa_id>@c.us` (docs/32 door 10).
 */

/** The `value` of a `messages` change, as far as this mapper reads it. */
export interface MetaWebhookChangeValue {
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: unknown[];
  statuses?: unknown[];
}

/** Who wrote an inbound message, kept in `meta_cloud_contacts` (door 5). */
export interface CloudContactSeen {
  waId: string;
  profileName: string | null;
  at: Date;
  wamid: string;
}

/** A media message's Graph media id, and what the webhook says about the file. */
export interface CloudMediaRef {
  id: string;
  mimetype: string;
  filename?: string;
}

export type CloudInboundEvent =
  | { kind: 'message'; message: IncomingMessage; media?: CloudMediaRef; contact: CloudContactSeen }
  | { kind: 'reaction'; reaction: ReactionEvent; contact: CloudContactSeen }
  | { kind: 'ack'; messageId: string; status: DeliveryStatus; chatId: string; errorCode?: number };

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;

const ACK_STATUSES: ReadonlySet<string> = new Set(['sent', 'delivered', 'read', 'failed']);

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj => (value && typeof value === 'object' ? (value as Obj) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function cloudChatId(waId: string): string {
  return `${waId.replace(/\D/g, '')}@c.us`;
}

/** The messages, reactions and status updates of one change, in the order Meta listed them. */
export function mapCloudChange(value: MetaWebhookChangeValue): CloudInboundEvent[] {
  const events: CloudInboundEvent[] = [];
  const own = cloudChatId(str(value.metadata?.display_phone_number));
  for (const raw of value.messages ?? []) {
    const event = mapMessage(obj(raw), value.contacts ?? [], own);
    if (event) events.push(event);
  }
  for (const raw of value.statuses ?? []) {
    const event = mapStatus(obj(raw));
    if (event) events.push(event);
  }
  return events;
}

function mapStatus(status: Obj): CloudInboundEvent | null {
  const id = str(status.id);
  const value = str(status.status);
  if (!id || !ACK_STATUSES.has(value)) return null;
  const code = obj((status.errors as unknown[] | undefined)?.[0]).code;
  return {
    kind: 'ack',
    messageId: id,
    status: value as DeliveryStatus,
    chatId: cloudChatId(str(status.recipient_id)),
    ...(value === 'failed' && typeof code === 'number' ? { errorCode: code } : {}),
  };
}

function mapMessage(
  message: Obj,
  contacts: NonNullable<MetaWebhookChangeValue['contacts']>,
  own: string,
): CloudInboundEvent | null {
  const waId = str(message.from);
  const id = str(message.id);
  if (!waId || !id) return null;
  const chatId = cloudChatId(waId);
  const seconds = Number.parseInt(str(message.timestamp), 10);
  const timestamp = Number.isFinite(seconds) ? seconds : 0;
  const profileName = (contacts.find(c => c.wa_id === waId) ?? contacts[0])?.profile?.name ?? null;
  const contact: CloudContactSeen = { waId, profileName, at: new Date(timestamp * 1000), wamid: id };
  const type = str(message.type);

  if (type === 'reaction') {
    const reaction = obj(message.reaction);
    return {
      kind: 'reaction',
      reaction: {
        messageId: str(reaction.message_id),
        chatId,
        // Meta sends no emoji when the sender withdraws a reaction; '' is the neutral withdrawal.
        reaction: str(reaction.emoji),
        senderId: chatId,
      },
      contact,
    };
  }

  const base: IncomingMessage = {
    id,
    from: chatId,
    to: own,
    chatId,
    body: '',
    type: 'unknown',
    timestamp,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    contact: { id: chatId, number: waId, ...(profileName ? { pushName: profileName } : {}) },
  };
  const quoted = str(obj(message.context).id);
  if (quoted) base.quotedMessage = { id: quoted, body: '' };

  const errors = Array.isArray(message.errors) ? message.errors : [];
  if (type === 'unsupported' || errors.length > 0) {
    const reason = str(obj(errors[0]).title) || 'unsupported';
    return { kind: 'message', message: { ...base, metadata: { reason, errors } }, contact };
  }

  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const media = obj(message[type]);
    const mimetype = str(media.mime_type) || 'application/octet-stream';
    const filename = str(media.filename) || undefined;
    return {
      kind: 'message',
      message: {
        ...base,
        type: type as MessageType,
        body: str(media.caption),
        media: { mimetype, ...(filename ? { filename } : {}) },
      },
      media: { id: str(media.id), mimetype, ...(filename ? { filename } : {}) },
      contact,
    };
  }

  return { kind: 'message', message: { ...base, ...mapContent(type, message) }, contact };
}

/** The type, body and structured fields of a message that is neither media, a reaction nor an error. */
function mapContent(type: string, message: Obj): Partial<IncomingMessage> {
  switch (type) {
    case 'text':
      return { type: 'text', body: str(obj(message.text).body) };
    case 'location': {
      const location = obj(message.location);
      const name = str(location.name);
      const address = str(location.address);
      const url = str(location.url);
      return {
        type: 'location',
        body: name,
        location: {
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
          ...(name ? { description: name } : {}),
          ...(address ? { address } : {}),
          ...(url ? { url } : {}),
        },
      };
    }
    case 'contacts':
      return { type: 'contact', body: vcards(message.contacts) };
    case 'interactive': {
      const interactive = obj(message.interactive);
      const reply = obj(interactive.button_reply ?? interactive.list_reply);
      const text = str(reply.title);
      return { type: 'text', body: text, button: { id: str(reply.id), text } };
    }
    case 'button': {
      const button = obj(message.button);
      const text = str(button.text);
      return { type: 'text', body: text, button: { id: str(button.payload), text } };
    }
    default:
      return { type: 'unknown', metadata: { reason: `unhandled type ${type || '(none)'}` } };
  }
}

/** Shared contact cards as vCards, the `body` the other engines give a contact message. */
function vcards(contacts: unknown): string {
  return (Array.isArray(contacts) ? contacts : [])
    .map(raw => {
      const card = obj(raw);
      const name = str(obj(card.name).formatted_name);
      const phones = (Array.isArray(card.phones) ? card.phones : []).map(p => {
        const phone = obj(p);
        const waid = str(phone.wa_id);
        return `TEL;type=${str(phone.type) || 'CELL'}${waid ? `;waid=${waid}` : ''}:${str(phone.phone)}`;
      });
      return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, ...phones, 'END:VCARD'].join('\n');
    })
    .join('\n');
}
