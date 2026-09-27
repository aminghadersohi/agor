import type { AgorClient, BranchID, TeammateAddressingPreview } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';

export interface TeammateAddressingPreviewState {
  /** Null until loaded, when disabled, or when the daemon could not answer. */
  preview: TeammateAddressingPreview | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Which session `agor_sessions_prompt { teammate }` would reach right now for
 * the signed-in user, and whether they can address the teammate by name — the
 * daemon's dry run (`GET branches/:id/front-desk?include_addressing=true`),
 * never a local guess at the precedence.
 *
 * The route has no realtime fan-out, so callers pass `refreshKey` built from
 * what changes the answer (the pinned desk, the branch's active sessions) to
 * ask again.
 */
export function useTeammateAddressingPreview(
  client: AgorClient | null,
  branchId: BranchID | null | undefined,
  refreshKey: string
): TeammateAddressingPreviewState {
  const { authGeneration } = useConnectionState();
  const scopeKey = client && branchId ? `${branchId}:${authGeneration}:${refreshKey}` : null;
  const [state, setState] = useState<{
    scopeKey: string | null;
    preview: TeammateAddressingPreview | null;
    error: Error | null;
  }>({ scopeKey: null, preview: null, error: null });

  useEffect(() => {
    if (!client || !branchId || !scopeKey) return;
    let cancelled = false;
    client
      .service(`branches/${branchId}/front-desk`)
      .find({ query: { include_addressing: true } })
      .then((view) => {
        if (cancelled) return;
        const preview = view.addressing ?? null;
        setState({
          scopeKey,
          preview,
          error: preview ? null : new Error('This daemon does not report addressing'),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          scopeKey,
          preview: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, branchId, scopeKey]);

  // Never show an answer computed for a different branch, desk, or login.
  const current = state.scopeKey === scopeKey ? state : { preview: null, error: null };
  return {
    preview: current.preview,
    error: current.error,
    loading: scopeKey !== null && state.scopeKey !== scopeKey,
  };
}
