import type { ScheduleID } from '@agor-live/client';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';

export interface ArtifactActionRunResult {
  session_id?: string;
  [key: string]: unknown;
}

/** Run a declared artifact action through the normal authenticated schedule route. */
export async function runArtifactScheduleAction(
  scheduleId: ScheduleID
): Promise<ArtifactActionRunResult> {
  const response = await fetch(
    `${getDaemonUrl()}/schedules/${encodeURIComponent(scheduleId)}/run-now`,
    { method: 'POST', headers: getAuthHeaders(), body: '{}' }
  );
  const result = (await response.json().catch(() => ({}))) as ArtifactActionRunResult & {
    message?: unknown;
  };
  if (!response.ok) {
    const message =
      typeof result.message === 'string' ? result.message : `Action failed (${response.status})`;
    throw new Error(message.slice(0, 300));
  }
  return result;
}
