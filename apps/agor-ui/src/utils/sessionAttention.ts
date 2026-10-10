import type { AgorClient } from '@agor-live/client';
import { agorStore } from '../store/agorStore';

/**
 * Opening a session clears its branch's attention flag, in both shells.
 * Best-effort and silent: read-only callers (RBAC) may not patch the branch,
 * and a toast would be noise.
 *
 * The session's own unread result is acknowledged per viewer by
 * `useAcknowledgeOpenSessionAttention` once the session is shown. The shared
 * `ready_for_prompt` flag is runtime promptability (failed and timed-out
 * sessions only accept a follow-up while it is set), so opening never clears it.
 */
export function clearOpenedSessionFlags(client: AgorClient | null, sessionId: string) {
  if (!client) return;
  // Call-time store read: callers keep a stable identity and never subscribe to these maps.
  const { sessionById, branchById } = agorStore.getState();
  const session = sessionById.get(sessionId);
  const branch = session?.branch_id ? branchById.get(session.branch_id) : undefined;
  if (branch?.needs_attention) {
    client
      .service('branches')
      .patch(branch.branch_id, { needs_attention: false })
      .catch(() => {});
  }
}
