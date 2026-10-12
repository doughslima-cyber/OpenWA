// WhatsApp Cloud API sessions (OpenMsg, docs/32 F3): the account, the 24-hour service window and the
// approved message templates of a `meta-cloud` session. Kept apart from api.ts so upstream changes
// there merge without touching this fork's additions.
import type { TFunction } from 'i18next';
import { request, type Session } from './api';
import { META_CLOUD_ENGINE } from '../utils/sessionActions';

/** The Cloud API number behind a session, without its token (`GET /api/sessions/:id/meta/account`). */
export interface MetaCloudAccount {
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  accessTokenLast4: string | null;
  webhookUrl: string;
}

/** One of Meta's template components (HEADER, BODY, FOOTER, BUTTONS), as Meta sends it. */
export interface MetaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type: string; text?: string; url?: string }>;
  [key: string]: unknown;
}

export interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  /** POSITIONAL (`{{1}}`) or NAMED (`{{first_name}}`). */
  parameterFormat: string;
  components: MetaTemplateComponent[];
}

/** The 24-hour customer service window of a chat; times are ISO 8601 UTC. */
export interface MetaChatWindow {
  lastInboundAt: string | null;
  open: boolean;
  closesAt: string | null;
}

export interface SendMetaTemplateBody {
  chatId: string;
  name: string;
  language: string;
  parameters?: string[] | Record<string, string>;
}

export interface SessionCreateMetaCloud {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
}

const base = (sessionId: string) => `/sessions/${sessionId}/meta`;

export const metaCloudApi = {
  createSession: (name: string, metaCloud: SessionCreateMetaCloud) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, engine: META_CLOUD_ENGINE, metaCloud }),
    }),
  getAccount: (sessionId: string) => request<MetaCloudAccount>(`${base(sessionId)}/account`),
  updateToken: (sessionId: string, accessToken: string) =>
    request<MetaCloudAccount>(`${base(sessionId)}/account`, {
      method: 'PUT',
      body: JSON.stringify({ accessToken }),
    }),
  listTemplates: (sessionId: string, refresh = false) =>
    request<{ templates: MetaTemplate[] }>(`${base(sessionId)}/templates${refresh ? '?refresh=true' : ''}`),
  getWindow: (sessionId: string, chatId: string) =>
    request<MetaChatWindow>(`${base(sessionId)}/chats/${encodeURIComponent(chatId)}/window`),
  sendTemplate: (sessionId: string, body: SendMetaTemplateBody) =>
    request<{ messageId: string; timestamp: number }>(`${base(sessionId)}/send-template`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/** The gateway's Cloud API error codes the dashboard has its own text for. */
const META_ERROR_CODES = new Set([
  'META_CLOUD_DISABLED',
  'META_CLOUD_NOT_CONFIGURED',
  'META_PHONE_NUMBER_IN_USE',
  'META_OUTSIDE_SERVICE_WINDOW',
  'META_RECIPIENT_UNAVAILABLE',
  'META_LIMIT_REACHED',
  'META_RATE_LIMITED',
  'META_TOKEN_INVALID',
  'META_TOKEN_MISSING',
  'META_ACCOUNT_RESTRICTED',
  'META_TEMPLATE_INVALID',
]);

/** The translated text of a Cloud API error code, or undefined when the dashboard has none. */
export function metaCodeText(t: TFunction, code: string | null | undefined): string | undefined {
  return code && META_ERROR_CODES.has(code) ? t(`metaCloud.errors.${code}`) : undefined;
}

/** An error's text for the operator: its code's translation when there is one, else its message. */
export function metaErrorText(t: TFunction, err: unknown): string | undefined {
  const e = err as { code?: string; message?: string } | null | undefined;
  return metaCodeText(t, e?.code) ?? (e?.message || undefined);
}
