// Queries of a WhatsApp Cloud API session (OpenMsg, docs/32 F3). Kept apart from queries.ts so upstream
// changes there merge without touching this fork's additions.
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { metaCloudApi } from '../services/metaCloud';

export const metaAccountKey = (sessionId: string) => ['meta-account', sessionId] as const;

/** The Cloud API number behind a session, read while its detail is open. */
export function useMetaAccount(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: metaAccountKey(sessionId),
    queryFn: () => metaCloudApi.getAccount(sessionId),
    enabled: enabled && !!sessionId,
    retry: false,
  });
}

/** The account's templates; `refresh()` asks the gateway to read Graph again instead of its cache. */
export function useMetaTemplates(sessionId: string) {
  const refreshNext = useRef(false);
  const query = useQuery({
    queryKey: ['meta-templates', sessionId],
    queryFn: () => {
      const refresh = refreshNext.current;
      refreshNext.current = false;
      return metaCloudApi.listTemplates(sessionId, refresh);
    },
    enabled: !!sessionId,
    retry: false,
  });
  const refresh = () => {
    refreshNext.current = true;
    return query.refetch();
  };
  return { ...query, refresh };
}

/** The 24-hour service window of a chat on a Cloud session; idle for any other session. */
export function useMetaChatWindow(sessionId: string, chatId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['meta-window', sessionId, chatId],
    queryFn: () => metaCloudApi.getWindow(sessionId, chatId!),
    enabled: enabled && !!sessionId && !!chatId,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
