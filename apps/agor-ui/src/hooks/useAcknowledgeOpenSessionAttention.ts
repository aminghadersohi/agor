import type { AgorClient, Session } from '@agor-live/client';
import { sessionHasUnseenAttention } from '@agor-live/client';
import { useEffect } from 'react';
import { sessionAttentionAcknowledged } from '../store/agorRealtimeActions';

/**
 * Opening a session is the app-wide read boundary. A new generation that
 * arrives while the panel stays open is acknowledged as soon as it is rendered.
 */
export function useAcknowledgeOpenSessionAttention(
  client: AgorClient | null,
  session: Session | null | undefined
): void {
  useEffect(() => {
    if (!client || !session || !sessionHasUnseenAttention(session)) return;

    let cancelled = false;
    void client.sessions
      .acknowledgeAttention(session.session_id)
      .then((acknowledgement) => {
        if (!cancelled) sessionAttentionAcknowledged(acknowledgement);
      })
      .catch(() => {
        // Reading a session must remain available during a transient sync
        // failure. A later generation, reopen, or reconnect refetch retries.
      });

    return () => {
      cancelled = true;
    };
  }, [client, session]);
}
