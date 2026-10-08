// Campaigns (OpenMsg): one text to a list of numbers, paced over days. Kept apart from api.ts so upstream
// changes there merge without touching this fork's additions.
import { request } from './api';

export type CampaignStatus = 'running' | 'completed' | 'cancelled';
export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'replied' | 'cancelled';
export type CampaignWaitReason = 'pacing' | 'restricted' | 'disconnected';

export const RECIPIENT_STATUSES: RecipientStatus[] = ['pending', 'sending', 'sent', 'failed', 'replied', 'cancelled'];

/** Recipients by current status; the buckets sum to `total`. */
export interface CampaignCounts {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  replied: number;
  cancelled: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: CampaignStatus;
  counts: CampaignCounts;
  createdAt: string;
  completedAt: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  text: string;
  waiting: { reason: CampaignWaitReason; nextAttemptAt: string | null } | null;
}

export interface CampaignRecipient {
  chatId: string;
  status: RecipientStatus;
  sentAt: string | null;
  repliedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface RecipientPage {
  items: CampaignRecipient[];
  total: number;
}

export interface RecipientQuery {
  status?: RecipientStatus;
  limit: number;
  offset: number;
}

const base = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/campaigns`;

export const campaignsApi = {
  list: (sessionId: string) => request<CampaignSummary[]>(base(sessionId)),
  get: (sessionId: string, campaignId: string) =>
    request<CampaignDetail>(`${base(sessionId)}/${encodeURIComponent(campaignId)}`),
  recipients: (sessionId: string, campaignId: string, query: RecipientQuery) => {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.status) params.set('status', query.status);
    return request<RecipientPage>(`${base(sessionId)}/${encodeURIComponent(campaignId)}/recipients?${params}`);
  },
  create: (sessionId: string, data: { name: string; text: string; recipients: string[] }) =>
    request<{ id: string; name: string; status: CampaignStatus; total: number }>(base(sessionId), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  cancel: (sessionId: string, campaignId: string) =>
    request<{ id: string; status: CampaignStatus; counts: CampaignCounts }>(
      `${base(sessionId)}/${encodeURIComponent(campaignId)}/cancel`,
      { method: 'POST' },
    ),
};
