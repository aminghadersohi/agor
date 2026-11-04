import { resolveUserEnvironment } from '@agor/core/config';
import { runWithTenantDatabaseScope, type TenantScopeAwareDatabase } from '@agor/core/db';
import { filterUserGitEnvironment, isLikelyGitToken } from '@agor/core/git/pure';
import type { SessionID, SessionReminderWakeCondition, TenantID, UserID } from '@agor/core/types';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const READ_TIMEOUT_MS = 15_000;

/** The pull request facts a wake condition needs; never titles or bodies. */
export interface GitHubPullRequestObservation {
  state: 'open' | 'closed';
  merged: boolean;
  merged_at?: string;
  closed_at?: string;
}

/** A failed read, classified without response bodies or credentials. */
export class GitHubPullRequestReadError extends Error {
  constructor(readonly code: string) {
    super(`GitHub pull request read failed: ${code}`);
    this.name = 'GitHubPullRequestReadError';
  }
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * Read one pull request's state from the GitHub REST API. Without a token only
 * public repositories are readable.
 */
export async function readGitHubPullRequest(
  target: Pick<SessionReminderWakeCondition, 'repo' | 'number'>,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<GitHubPullRequestObservation> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agor-session-reminders',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const [owner, name] = target.repo.split('/');
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/pulls/${target.number}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (error) {
    throw new GitHubPullRequestReadError(
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'
    );
  }
  if (!response.ok) throw new GitHubPullRequestReadError(`http_${response.status}`);
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new GitHubPullRequestReadError('invalid_response');
  }
  if (body.state !== 'open' && body.state !== 'closed') {
    throw new GitHubPullRequestReadError('invalid_response');
  }
  return {
    state: body.state,
    merged: body.merged === true || isoOrUndefined(body.merged_at) !== undefined,
    merged_at: isoOrUndefined(body.merged_at),
    closed_at: isoOrUndefined(body.closed_at),
  };
}

/**
 * The reminder creator's own stored GitHub token (`GITHUB_TOKEN`, else
 * `GH_TOKEN`), resolved in the reminder's tenant — the same per-user Agor
 * environment variable managed Git uses for clones.
 */
export async function resolveReminderGitHubToken(
  db: TenantScopeAwareDatabase,
  tenantId: TenantID | string,
  userId: UserID,
  sessionId: SessionID
): Promise<string | undefined> {
  const resolved = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
    resolveUserEnvironment(userId, tenantDb, { sessionId })
  );
  const { env } = filterUserGitEnvironment(resolved);
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return token && isLikelyGitToken(token) ? token : undefined;
}
