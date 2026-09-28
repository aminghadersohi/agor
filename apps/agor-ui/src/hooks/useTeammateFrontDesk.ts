import type { AgorClient, Branch, SessionID, TeammateFrontDeskView } from '@agor-live/client';
import { isTeammate } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { useThemedMessage } from '../utils/message';

/**
 * A teammate's pinned front desk — the session `agor_sessions_prompt
 * { teammate }` reaches instead of the most recently active one.
 *
 * `view.can_manage` comes from the daemon, computed with the same rule the
 * pin/clear commands enforce (Branch Manager / `branch.policy.manage`), so
 * callers gate controls on it rather than on a local reading of the policy.
 *
 * The route has no realtime fan-out, so a successful pin/clear is broadcast to
 * every other mounted instance for the same branch in this tab (the session
 * header and the Teammate tab can be open together).
 */

type FrontDeskListener = (view: TeammateFrontDeskView) => void;
const listeners = new Set<FrontDeskListener>();

function announce(view: TeammateFrontDeskView) {
  for (const listener of listeners) listener(view);
}

function isConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 409;
}

export interface TeammateFrontDeskState {
  /** Null until loaded, when the branch is not an active teammate, or when the load failed. */
  view: TeammateFrontDeskView | null;
  loading: boolean;
  error: Error | null;
  saving: boolean;
  pin: (sessionId: SessionID) => Promise<boolean>;
  unpin: () => Promise<boolean>;
}

export function useTeammateFrontDesk(
  client: AgorClient | null,
  branch: Pick<Branch, 'branch_id' | 'custom_context' | 'archived'> | null | undefined
): TeammateFrontDeskState {
  const { showSuccess, showError, showWarning } = useThemedMessage();
  const { authGeneration } = useConnectionState();
  const branchId = branch?.branch_id;
  const enabled = Boolean(client && branch && isTeammate(branch) && !branch.archived);
  const scopeKey = enabled ? `${branchId}:${authGeneration}` : null;

  const [state, setState] = useState<{
    scopeKey: string | null;
    view: TeammateFrontDeskView | null;
    error: Error | null;
  }>({ scopeKey: null, view: null, error: null });
  const [saving, setSaving] = useState(false);
  // Every write to `state` takes a ticket; a load answers only if nothing
  // newer (a later load or a mutation result) has landed since it started.
  const ticketRef = useRef(0);

  const load = useCallback(async () => {
    if (!client || !branchId || !scopeKey) return;
    const ticket = ++ticketRef.current;
    try {
      const view = await client.service(`branches/${branchId}/front-desk`).find();
      if (ticket === ticketRef.current) setState({ scopeKey, view, error: null });
    } catch (error) {
      if (ticket !== ticketRef.current) return;
      setState({
        scopeKey,
        view: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }, [client, branchId, scopeKey]);

  useEffect(() => {
    if (!scopeKey) return;
    let cancelled = false;
    const listener: FrontDeskListener = (view) => {
      if (!cancelled && view.branch_id === branchId) {
        ticketRef.current++;
        setState({ scopeKey, view, error: null });
      }
    };
    listeners.add(listener);
    void load();
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, [scopeKey, branchId, load]);

  // Never expose a previous branch's or auth generation's answer.
  const current = state.scopeKey === scopeKey ? state : { view: null, error: null };
  const pinnedSessionId = current.view?.front_desk?.session_id ?? null;

  const mutate = useCallback(
    async (
      run: () => Promise<TeammateFrontDeskView>,
      success: string,
      failure: string
    ): Promise<boolean> => {
      setSaving(true);
      try {
        const view = await run();
        announce(view);
        showSuccess(success);
        return true;
      } catch (error) {
        if (isConflict(error)) {
          // The compare-and-swap lost: someone changed the desk since we loaded it.
          showWarning('The front desk changed since this view loaded. Showing the current pin.');
          await load();
        } else {
          showError(error instanceof Error ? error.message : failure);
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [load, showError, showSuccess, showWarning]
  );

  const pin = useCallback(
    (sessionId: SessionID) => {
      if (!client || !branchId) return Promise.resolve(false);
      return mutate(
        () =>
          client
            .service(`branches/${branchId}/front-desk`)
            .create({ session_id: sessionId, expected_session_id: pinnedSessionId }),
        'Pinned as front desk',
        'Failed to pin front desk'
      );
    },
    [client, branchId, mutate, pinnedSessionId]
  );

  const unpin = useCallback(() => {
    if (!client || !branchId) return Promise.resolve(false);
    return mutate(
      () =>
        client
          .service(`branches/${branchId}/front-desk`)
          .remove(null, pinnedSessionId ? { query: { expected_session_id: pinnedSessionId } } : {}),
      'Front desk unpinned',
      'Failed to unpin front desk'
    );
  }, [client, branchId, mutate, pinnedSessionId]);

  return {
    view: current.view,
    error: current.error,
    loading: enabled && state.scopeKey !== scopeKey,
    saving,
    pin,
    unpin,
  };
}
