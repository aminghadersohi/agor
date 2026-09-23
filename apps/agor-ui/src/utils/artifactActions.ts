import type { ArtifactDataResult } from '@agor-live/client';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';

export interface ArtifactActionRunResult {
  artifact_id?: string;
  action_id?: string;
  effect?: string;
  result?: unknown;
  [key: string]: unknown;
}

/**
 * Read the daemon's error message without letting an arbitrarily long body
 * through to the iframe.
 */
async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === 'string' ? body.message : fallback;
  return message.slice(0, 300);
}

/**
 * Invoke a declared action binding.
 *
 * The artifact-local `actionId` is all that travels; the daemon re-reads the
 * persisted binding, re-checks that its target is still on the artifact's
 * branch, and dispatches through the ordinary schedule route with this user's
 * credentials. The iframe never names a schedule and never supplies an
 * argument.
 */
export async function runArtifactActionBinding(
  artifactId: string,
  actionId: string
): Promise<ArtifactActionRunResult> {
  const response = await fetch(
    `${getDaemonUrl()}/artifacts/${encodeURIComponent(artifactId)}/actions/${encodeURIComponent(actionId)}`,
    { method: 'POST', headers: getAuthHeaders(), body: '{}' }
  );
  if (!response.ok) {
    throw new Error(await readError(response, `Action failed (${response.status})`));
  }
  return (await response.json().catch(() => ({}))) as ArtifactActionRunResult;
}

/**
 * Read a declared data binding.
 *
 * Returns the daemon's fixed projection for the binding's kind — never the
 * underlying schedule or session row.
 */
export async function fetchArtifactDataBinding(
  artifactId: string,
  dataId: string
): Promise<ArtifactDataResult> {
  const response = await fetch(
    `${getDaemonUrl()}/artifacts/${encodeURIComponent(artifactId)}/data/${encodeURIComponent(dataId)}`,
    { method: 'GET', headers: getAuthHeaders() }
  );
  if (!response.ok) {
    throw new Error(await readError(response, `Data binding failed (${response.status})`));
  }
  return (await response.json()) as ArtifactDataResult;
}
