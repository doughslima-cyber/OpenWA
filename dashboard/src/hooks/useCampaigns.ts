import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { campaignsApi, type CampaignSummary, type RecipientQuery } from '../services/campaigns';

/** How often a running campaign is read again, so its progress shows without a reload. */
export const CAMPAIGN_REFRESH_MS = 5000;

const listKey = (sessionId: string) => ['campaigns', sessionId] as const;

const refreshWhileRunning = (running: boolean) => (running ? CAMPAIGN_REFRESH_MS : false);

export function useCampaignsQuery(sessionId: string) {
  return useQuery({
    queryKey: listKey(sessionId),
    queryFn: () => campaignsApi.list(sessionId),
    enabled: !!sessionId,
    refetchInterval: query =>
      refreshWhileRunning(
        (query.state.data as CampaignSummary[] | undefined)?.some(c => c.status === 'running') ?? false,
      ),
  });
}

export function useCampaignQuery(sessionId: string, campaignId: string | null) {
  return useQuery({
    queryKey: ['campaigns', sessionId, campaignId],
    queryFn: () => campaignsApi.get(sessionId, campaignId!),
    enabled: !!sessionId && !!campaignId,
    refetchInterval: query => refreshWhileRunning(query.state.data?.status === 'running'),
  });
}

export function useCampaignRecipientsQuery(
  sessionId: string,
  campaignId: string | null,
  query: RecipientQuery,
  running: boolean,
) {
  return useQuery({
    queryKey: ['campaigns', sessionId, campaignId, 'recipients', query],
    queryFn: () => campaignsApi.recipients(sessionId, campaignId!, query),
    enabled: !!sessionId && !!campaignId,
    refetchInterval: refreshWhileRunning(running),
  });
}

export function useCreateCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; text: string; recipients: string[] }) => campaignsApi.create(sessionId, data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey(sessionId) }),
  });
}

export function useCancelCampaignMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (campaignId: string) => campaignsApi.cancel(sessionId, campaignId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['campaigns', sessionId] }),
  });
}
