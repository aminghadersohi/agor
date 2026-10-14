import type { AgorClient, BranchID, TeammateSkillsReport } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';

export interface TeammateSkillsState {
  /** Null until the first answer lands, or when it failed. */
  report: TeammateSkillsReport | null;
  loading: boolean;
  /** The first answer is shown; the cross-teammate drift comparison is still running. */
  driftLoading: boolean;
  error: Error | null;
  reload: () => void;
}

function asReport(value: unknown): TeammateSkillsReport {
  const report = value as Partial<TeammateSkillsReport> | null;
  if (!report || !Array.isArray(report.skills) || !report.gaps || !report.sources) {
    throw new Error('The daemon returned an unexpected skills response');
  }
  return report as TeammateSkillsReport;
}

/**
 * A teammate's skills (`GET branches/:id/skills`), read-only.
 *
 * Asks twice: once without drift so the list appears quickly, then with
 * `include_drift=true`, which scans other teammates' worktrees and can take a
 * few seconds. A failed drift pass keeps the first answer. The route has no
 * realtime fan-out, so the view refreshes on mount and on `reload`.
 */
export function useTeammateSkills(
  client: AgorClient | null,
  branchId: BranchID | null | undefined,
  options: { includeDrift?: boolean } = {}
): TeammateSkillsState {
  const includeDrift = options.includeDrift ?? true;
  const { authGeneration } = useConnectionState();
  const [attempt, setAttempt] = useState(0);
  const scopeKey = client && branchId ? `${branchId}:${authGeneration}:${attempt}` : null;
  const [state, setState] = useState<{
    scopeKey: string | null;
    report: TeammateSkillsReport | null;
    drifted: boolean;
    error: Error | null;
  }>({ scopeKey: null, report: null, drifted: false, error: null });

  useEffect(() => {
    if (!client || !branchId || !scopeKey) return;
    let cancelled = false;
    const service = client.service(`branches/${branchId}/skills`);
    (async () => {
      try {
        const report = asReport(await service.find());
        if (cancelled) return;
        setState({ scopeKey, report, drifted: !includeDrift, error: null });
      } catch (error) {
        if (cancelled) return;
        setState({
          scopeKey,
          report: null,
          drifted: true,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }
      if (!includeDrift) return;
      try {
        const report = asReport(await service.find({ query: { include_drift: true } }));
        if (!cancelled) setState({ scopeKey, report, drifted: true, error: null });
      } catch {
        // Drift is an enrichment: keep the list that already loaded.
        if (!cancelled) setState((prev) => ({ ...prev, drifted: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, branchId, scopeKey, includeDrift]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // Never show an answer computed for a different branch or login.
  const current =
    state.scopeKey === scopeKey ? state : { report: null, drifted: false, error: null };
  const loading = scopeKey !== null && state.scopeKey !== scopeKey;
  return {
    report: current.report,
    error: current.error,
    loading,
    driftLoading: !loading && current.report !== null && !current.drifted,
    reload,
  };
}
