import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';
import {
  EngineStatus,
  type ChatState,
  type ChatSummary,
  type Contact,
  type ContactCard,
  type CustomLinkPreview,
  type EngineEventCallbacks,
  type IncomingMessage,
  type IWhatsAppEngine,
  type LocationInput,
  type MediaInput,
  type MessageResult,
  type MessageType,
  type Quotable,
} from '../interfaces/whatsapp-engine.interface';
import type { MetaCloudAccountPort, MetaCloudCredentials } from './meta-cloud-account-store.service';
import { MetaGraphClient, MetaGraphError, isMetaTokenInvalid } from './meta-cloud-graph.client';
import type { MetaCloudContactPort } from './meta-cloud-chat-store.service';
import { mapCloudChange, type MetaWebhookChangeValue } from './meta-cloud-inbound.mapper';
import { fetchCloudMedia } from './meta-cloud-media';
import type { MetaCloudInboundTarget, MetaCloudNumberRegistry } from './meta-cloud-number-registry';

export interface MetaCloudAdapterOptions {
  sessionId: string;
  dbSessionId: string;
  accounts: MetaCloudAccountPort;
  graph?: MetaGraphClient;
  /** The session's egress proxy, which a media URL fetch leaves through (Graph calls go direct). */
  proxyUrl?: string;
  /** Where the webhook router finds this session by its number; absent, no inbound reaches it. */
  numbers?: Pick<MetaCloudNumberRegistry, 'register' | 'unregister'>;
  /** Where each inbound sender is recorded (`meta_cloud_contacts`), and the chat list and history are read. */
  contacts?: MetaCloudContactPort;
}

/** The reasons a Cloud session reports through `onActionRequired`. */
export const META_TOKEN_INVALID = 'META_TOKEN_INVALID';
export const META_TOKEN_MISSING = 'META_TOKEN_MISSING';

const PROFILE_FIELDS = 'display_phone_number,verified_name,quality_rating,messaging_limit_tier';

/** How many messages getChatHistory returns when the caller names no limit. */
const DEFAULT_HISTORY_LIMIT = 50;

/** The kinds sent as an uploaded media id, with the type a URL that names none is sent as. */
const MEDIA_FALLBACK_TYPE = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
} as const;
type MediaKind = keyof typeof MEDIA_FALLBACK_TYPE;

/** The Graph message types this adapter sends, and the neutral type of the own-send echo. */
const ECHO_TYPE: Record<string, MessageType> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  contacts: 'contact',
  // A template is stored and echoed as the text the customer received (its rendered body).
  template: 'text',
};

/**
 * An approved Meta template to send (F3 door 2): its body parameters as an array (positional
 * `{{1}}`, `{{2}}`, ...) or as an object keyed by placeholder name (named templates).
 */
export interface CloudTemplateInput {
  name: string;
  language: string;
  parameters?: string[] | Record<string, string>;
}

/** The one `body` component of a template send, or none when there is nothing to fill in. */
function templateComponents(parameters: CloudTemplateInput['parameters']): unknown[] | undefined {
  if (!parameters) return undefined;
  const values = Array.isArray(parameters)
    ? parameters.map(text => ({ type: 'text', text }))
    : Object.entries(parameters).map(([parameter_name, text]) => ({ type: 'text', parameter_name, text }));
  return values.length ? [{ type: 'body', parameters: values }] : undefined;
}

interface GraphSendAnswer {
  messages?: Array<{ id?: string }>;
}

/**
 * The Cloud API's `to`: the digits of a phone-number chat (docs/32 door 10). Groups, channels and
 * privacy ids have no Cloud API recipient.
 */
export function cloudRecipient(chatId: string): string {
  const match = /^(\d+)(?:@c\.us|@s\.whatsapp\.net)?$/.exec(chatId);
  if (!match) {
    throw new BadRequestException(
      `A Cloud API session sends only to a phone number chat (<digits>@c.us), not ${chatId}`,
    );
  }
  return match[1];
}

/** The digits of a phone-number contact id, or null for an id the Cloud API has no number for. */
function cloudPhone(contactId: string): string | null {
  return /^(\d+)(?:@c\.us|@s\.whatsapp\.net)?$/.exec(contactId)?.[1] ?? null;
}

/**
 * The refusal of a custom link preview, kept out of sendTextMessage's body: the method is supported
 * and refuses only that option (the conditional throw site the parity gate registers).
 */
function customPreviewRefused(): EngineNotSupportedError {
  return new EngineNotSupportedError('sendTextMessage(customPreview)');
}

interface PhoneNumberProfile {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
}

/**
 * WhatsApp Cloud API engine (OpenMsg, docs/32 D3). There is no socket and no QR: starting the session
 * reads the number from Graph, subscribes the app to the WABA's webhooks and reports READY. A refused
 * token moves the session to ACTION_REQUIRED, which only a new token and a restart clear.
 *
 * Methods this adapter does not define answer 501 through EngineNotSupportedError (see asEngine).
 */
export class MetaCloudAdapter implements MetaCloudInboundTarget {
  readonly sessionId: string;
  readonly dbSessionId: string;
  private readonly accounts: MetaCloudAccountPort;
  private readonly graph: MetaGraphClient;
  private readonly proxyUrl: string | undefined;
  private readonly numbers: MetaCloudAdapterOptions['numbers'];
  private readonly contacts: MetaCloudContactPort | undefined;
  /** The number this adapter is registered under for inbound webhooks, while it is. */
  private registeredNumber: string | null = null;
  private readonly logger = createLogger('MetaCloudAdapter');
  private callbacks: EngineEventCallbacks = {};
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;

  constructor(options: MetaCloudAdapterOptions) {
    this.sessionId = options.sessionId;
    this.dbSessionId = options.dbSessionId;
    this.accounts = options.accounts;
    this.graph = options.graph ?? new MetaGraphClient();
    this.proxyUrl = options.proxyUrl;
    this.numbers = options.numbers;
    this.contacts = options.contacts;
  }

  /** The adapter as an engine: any method it does not define rejects with a 501. */
  asEngine(): IWhatsAppEngine {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        // `then` stays undefined so the engine is never mistaken for a promise when awaited.
        if (typeof prop !== 'string' || prop === 'then' || prop in target) {
          return Reflect.get(target, prop, receiver) as unknown;
        }
        return () => target.unsupported(prop);
      },
    }) as unknown as IWhatsAppEngine;
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    const credentials = await this.accounts.loadCredentials(this.dbSessionId);
    if (!credentials?.accessToken) {
      this.requireAction(META_TOKEN_MISSING);
      return;
    }
    const token = credentials.accessToken;

    let profile: PhoneNumberProfile;
    try {
      profile = await this.graph.request<PhoneNumberProfile>(
        'GET',
        `/${encodeURIComponent(credentials.phoneNumberId)}?fields=${PROFILE_FIELDS}`,
        token,
      );
      await this.graph.request('POST', `/${encodeURIComponent(credentials.wabaId)}/subscribed_apps`, token);
    } catch (error) {
      if (isMetaTokenInvalid(error)) {
        this.requireAction(META_TOKEN_INVALID);
        return;
      }
      // No callback: start() records the failure in lastError and lands the session in FAILED.
      this.status = EngineStatus.FAILED;
      throw this.startFailure(error);
    }

    await this.recordProfile(credentials, profile);
    this.phoneNumber = (profile.display_phone_number ?? '').replace(/\D/g, '');
    this.pushName = profile.verified_name ?? '';
    this.setStatus(EngineStatus.READY);
    this.registerNumber(credentials.phoneNumberId);
    this.callbacks.onReady?.(this.phoneNumber, this.pushName);
  }

  /**
   * One `messages` change the webhook router matched to this number: each message is recorded as its
   * sender's last inbound, its media fetched, and every event handed to the session's callbacks in
   * the order Meta listed them. Dedup and forward-only acks are the projector's, downstream.
   */
  async handleWebhookChange(value: MetaWebhookChangeValue): Promise<void> {
    let token: string | null | undefined;
    for (const event of mapCloudChange(value)) {
      if (event.kind === 'ack') {
        this.callbacks.onMessageAck?.(event.messageId, event.status, event.chatId, event.errorCode);
        continue;
      }
      await this.recordContact(event.contact);
      if (event.kind === 'reaction') {
        this.callbacks.onMessageReaction?.(event.reaction);
        continue;
      }
      let message = event.message;
      if (event.media) {
        token ??= (await this.accounts.loadCredentials(this.dbSessionId))?.accessToken ?? null;
        const { media, error } = await fetchCloudMedia(this.graph, token, event.media);
        if (error) {
          this.logger.warn('Could not download the media of an inbound Cloud API message', {
            sessionId: this.sessionId,
            messageId: message.id,
            error,
            action: 'meta_media_download_failed',
          });
        }
        message = { ...message, media };
      }
      this.callbacks.onMessage?.(message);
    }
  }

  /**
   * One `GET /<PHONE_NUMBER_ID>` per probe. A refused token is not a dead connection: it moves the
   * session to ACTION_REQUIRED and answers true, so the watchdog does not restart into the same refusal.
   */
  async probeLiveness(): Promise<boolean> {
    const credentials = await this.accounts.loadCredentials(this.dbSessionId);
    if (!credentials?.accessToken) return false;
    try {
      await this.graph.request(
        'GET',
        `/${encodeURIComponent(credentials.phoneNumberId)}?fields=id`,
        credentials.accessToken,
      );
      return true;
    } catch (error) {
      if (isMetaTokenInvalid(error)) {
        this.requireAction(META_TOKEN_INVALID);
        return true;
      }
      return false;
    }
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    _mentions?: string[],
    options: { linkPreview?: boolean; customPreview?: CustomLinkPreview } & Quotable = {},
  ): Promise<MessageResult> {
    if (options.customPreview) throw customPreviewRefused();
    return this.sendMessage(
      chatId,
      'text',
      { body: text, preview_url: options.linkPreview ?? false },
      text,
      options.quotedMessageId,
    );
  }

  sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, 'image', media);
  }

  sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, 'video', media);
  }

  /** A voice note (PTT) goes as `audio` too: the Cloud API has one audio type. */
  sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, 'audio', media);
  }

  sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, 'document', media);
  }

  sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, 'sticker', media);
  }

  sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    return this.sendMessage(
      chatId,
      'location',
      {
        latitude: location.latitude,
        longitude: location.longitude,
        ...(location.description ? { name: location.description } : {}),
        ...(location.address ? { address: location.address } : {}),
      },
      location.description ?? '',
      location.quotedMessageId,
    );
  }

  sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    const digits = contact.number.replace(/\D/g, '');
    return this.sendMessage(
      chatId,
      'contacts',
      [
        {
          name: { formatted_name: contact.name, first_name: contact.name },
          phones: [{ phone: `+${digits}`, wa_id: digits, type: 'CELL' }],
        },
      ],
      contact.name,
      contact.quotedMessageId,
    );
  }

  replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    return this.sendMessage(chatId, 'text', { body: text, preview_url: false }, text, quotedMsgId);
  }

  /**
   * Sends an approved template (`type: "template"`), the only message Meta accepts outside the 24-hour
   * service window. `body` is the template text with its parameters filled in: the own-send echo
   * carries it, so the stored row and `message.sent` show what the customer received.
   */
  sendTemplateMessage(chatId: string, template: CloudTemplateInput, body: string): Promise<MessageResult> {
    const components = templateComponents(template.parameters);
    return this.sendMessage(
      chatId,
      'template',
      { name: template.name, language: { code: template.language }, ...(components ? { components } : {}) },
      body,
    );
  }

  /** A reaction is not a message of its own: no `message.sent` follows it, as on Baileys. */
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.postMessage(chatId, 'reaction', { message_id: messageId, emoji });
  }

  /** The chats found in the session's stored messages: the Cloud API keeps no chat list (docs/32 D6). */
  getChats(): Promise<ChatSummary[]> {
    return this.chatStore().getChats(this.dbSessionId);
  }

  /** The chat's most recent `limit` stored messages, oldest first; media is not re-downloaded. */
  getChatHistory(chatId: string, limit = DEFAULT_HISTORY_LIMIT): Promise<IncomingMessage[]> {
    return this.chatStore().getChatHistory(this.dbSessionId, chatId, limit);
  }

  /** A contact this session learned from an inbound message; null for a number it never heard from. */
  getContactById(contactId: string): Promise<Contact | null> {
    return this.chatStore().getContactById(this.dbSessionId, contactId);
  }

  /** A Cloud contact id is the number itself (docs/32 door 10). */
  resolveContactPhone(contactId: string): Promise<string | null> {
    return Promise.resolve(cloudPhone(contactId));
  }

  /**
   * Marks the chat's last inbound message read (`status: "read"`), which Meta extends to every earlier
   * one, and records the chat as seen. Resolves false, with no Graph call, for a chat that never wrote.
   */
  async sendSeen(chatId: string): Promise<boolean> {
    const waId = cloudRecipient(chatId);
    const store = this.chatStore();
    const wamid = await store.lastInboundWamid(this.dbSessionId, waId);
    if (!wamid) return false;
    await this.postStatus({ status: 'read', message_id: wamid });
    await store.markSeen(this.dbSessionId, waId, new Date());
    return true;
  }

  /**
   * The Cloud API's only presence is a typing indicator, sent against the chat's last inbound message
   * (which it also marks read) and cleared by the reply or after 25 s. Without an inbound message to
   * answer, and for `recording` or `paused`, there is nothing to send: it resolves without a call.
   */
  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    const waId = cloudPhone(chatId);
    if (state !== 'typing' || !waId) return;
    const wamid = await this.chatStore().lastInboundWamid(this.dbSessionId, waId);
    if (!wamid) {
      this.logger.debug('No inbound message to show typing against', { sessionId: this.sessionId, chatId });
      return;
    }
    await this.postStatus({ status: 'read', message_id: wamid, typing_indicator: { type: 'text' } });
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return null;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  disconnect(): Promise<void> {
    this.unregisterNumber();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  /** As disconnect, and the stored token is cleared: starting again needs a new token. */
  async logout(): Promise<void> {
    this.unregisterNumber();
    await this.accounts.clearToken(this.dbSessionId);
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  destroy(): Promise<void> {
    this.unregisterNumber();
    this.setStatus(EngineStatus.DISCONNECTED);
    this.callbacks = {};
    return Promise.resolve();
  }

  forceDestroy(): Promise<void> {
    return this.destroy();
  }

  /** Loads the media through the SSRF-guarded loader, uploads it, and sends it by the returned id. */
  private async sendMedia(chatId: string, kind: MediaKind, media: MediaInput): Promise<MessageResult> {
    const account = await this.sendingAccount();
    cloudRecipient(chatId);
    const { data, mimetype } = await mediaBytes(media, this.proxyUrl, MEDIA_FALLBACK_TYPE[kind]);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimetype.split(';')[0].trim());
    form.append('file', new Blob([new Uint8Array(data)], { type: mimetype }), media.filename || 'file');
    const uploaded = await this.graph.send<{ id?: string }>(
      account.phoneNumberId,
      `/${encodeURIComponent(account.phoneNumberId)}/media`,
      account.token,
      form,
    );
    const caption = kind === 'image' || kind === 'video' || kind === 'document' ? media.caption : undefined;
    return this.sendMessage(
      chatId,
      kind,
      {
        id: uploaded.id,
        ...(caption ? { caption } : {}),
        ...(kind === 'document' ? { filename: media.filename || 'file' } : {}),
      },
      media.caption ?? '',
      media.quotedMessageId,
    );
  }

  /** Posts one message and reports it through `onMessageCreate`: the Cloud API echoes no own send. */
  private async sendMessage(
    chatId: string,
    type: string,
    content: unknown,
    body: string,
    quotedMessageId?: string,
  ): Promise<MessageResult> {
    const id = await this.postMessage(chatId, type, content, quotedMessageId);
    const timestamp = Math.floor(Date.now() / 1000);
    const to = `${cloudRecipient(chatId)}@c.us`;
    if (id) {
      this.callbacks.onMessageCreate?.({
        id,
        from: `${this.phoneNumber ?? ''}@c.us`,
        to,
        chatId: to,
        body,
        type: ECHO_TYPE[type] ?? 'unknown',
        timestamp,
        fromMe: true,
        isGroup: false,
        kind: 'individual',
      });
    }
    return { id, timestamp };
  }

  /** `POST /<PHONE_NUMBER_ID>/messages`; answers the `wamid`, or '' when Graph returned none. */
  private async postMessage(chatId: string, type: string, content: unknown, quotedMessageId?: string): Promise<string> {
    const account = await this.sendingAccount();
    const answer = await this.graph.send<GraphSendAnswer>(
      account.phoneNumberId,
      `/${encodeURIComponent(account.phoneNumberId)}/messages`,
      account.token,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cloudRecipient(chatId),
        type,
        [type]: content,
        ...(quotedMessageId ? { context: { message_id: quotedMessageId } } : {}),
      },
    );
    return answer.messages?.[0]?.id ?? '';
  }

  /** `POST /<PHONE_NUMBER_ID>/messages` with a status update (a read receipt, the typing indicator). */
  private async postStatus(body: Record<string, unknown>): Promise<void> {
    const account = await this.sendingAccount();
    await this.graph.send(
      account.phoneNumberId,
      `/${encodeURIComponent(account.phoneNumberId)}/messages`,
      account.token,
      { messaging_product: 'whatsapp', ...body },
    );
  }

  private chatStore(): MetaCloudContactPort {
    if (!this.contacts) throw new Error('The Cloud API adapter was built without its chat store.');
    return this.contacts;
  }

  /** The number and token a send goes out with; a session that is not `ready` sends nothing. */
  private async sendingAccount(): Promise<{ phoneNumberId: string; token: string }> {
    if (this.status !== EngineStatus.READY) throw new EngineNotReadyError();
    const credentials = await this.accounts.loadCredentials(this.dbSessionId);
    if (!credentials?.accessToken) {
      throw new EngineNotReadyError('The Cloud API session has no usable access token. Set one and restart it.');
    }
    return { phoneNumberId: credentials.phoneNumberId, token: credentials.accessToken };
  }

  private registerNumber(phoneNumberId: string): void {
    if (!this.numbers) return;
    this.unregisterNumber();
    this.numbers.register(phoneNumberId, this);
    this.registeredNumber = phoneNumberId;
  }

  private unregisterNumber(): void {
    if (!this.numbers || this.registeredNumber === null) return;
    this.numbers.unregister(this.registeredNumber, this);
    this.registeredNumber = null;
  }

  /** Best effort: a failed write costs the read receipt of this chat, never the message. */
  private async recordContact(seen: Parameters<MetaCloudContactPort['recordInbound']>[1]): Promise<void> {
    try {
      await this.contacts?.recordInbound(this.dbSessionId, seen);
    } catch (error) {
      this.logger.warn('Could not record the sender of an inbound Cloud API message', {
        sessionId: this.sessionId,
        messageId: seen.wamid,
        error: error instanceof Error ? error.message : String(error),
        action: 'meta_contact_record_failed',
      });
    }
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  private requireAction(reason: string): void {
    this.logger.warn('Cloud API session needs a new access token', {
      sessionId: this.sessionId,
      reason,
      action: 'meta_action_required',
    });
    this.setStatus(EngineStatus.ACTION_REQUIRED);
    this.callbacks.onActionRequired?.(reason);
  }

  /** Graph unreachable or 5xx is a transport failure (503); any other Graph refusal is a 502. */
  private startFailure(error: unknown): Error {
    if (error instanceof MetaGraphError) {
      if (error.httpStatus >= 500) return new EngineTransportError(error.message);
      return new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: error.message,
        code: 'META_UPSTREAM_ERROR',
        metaCode: error.metaCode,
        fbtraceId: error.fbtraceId,
      });
    }
    return error instanceof Error ? error : new EngineTransportError(String(error));
  }

  /** Best effort: a failed write leaves GET .../meta/account one start behind, never the session down. */
  private async recordProfile(credentials: MetaCloudCredentials, profile: PhoneNumberProfile): Promise<void> {
    try {
      await this.accounts.recordProfile(this.dbSessionId, {
        displayPhoneNumber: profile.display_phone_number ?? null,
        verifiedName: profile.verified_name ?? null,
        qualityRating: profile.quality_rating ?? null,
        messagingLimitTier: profile.messaging_limit_tier ?? null,
      });
    } catch (error) {
      this.logger.warn('Could not record the Cloud API number profile', {
        sessionId: this.sessionId,
        phoneNumberId: credentials.phoneNumberId,
        error: error instanceof Error ? error.message : String(error),
        action: 'meta_profile_record_failed',
      });
    }
  }

  private unsupported(method: string): Promise<never> {
    return Promise.reject(new EngineNotSupportedError(method));
  }
}

/**
 * The bytes and type of a MediaInput: a Buffer as is, an http(s) URL through the SSRF-guarded loader
 * (capped at MEDIA_DOWNLOAD_MAX_BYTES), anything else as base64. The caller's type wins over a fetched
 * one, unless it is the generic placeholder.
 */
async function mediaBytes(
  media: MediaInput,
  proxyUrl: string | undefined,
  fallbackType: string,
): Promise<{ data: Buffer; mimetype: string }> {
  const callerType = media.mimetype && media.mimetype !== 'application/octet-stream' ? media.mimetype : null;
  if (Buffer.isBuffer(media.data)) return { data: media.data, mimetype: callerType ?? fallbackType };
  if (/^https?:\/\//i.test(media.data)) {
    const fetched = await loadRemoteMediaBuffer(media.data, proxyUrl);
    const fetchedType = fetched.mimetype && fetched.mimetype !== 'application/octet-stream' ? fetched.mimetype : null;
    return { data: fetched.data, mimetype: callerType ?? fetchedType ?? fallbackType };
  }
  return { data: Buffer.from(media.data, 'base64'), mimetype: callerType ?? fallbackType };
}
