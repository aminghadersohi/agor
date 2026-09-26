/**
 * Name-based teammate addressing for teammate-to-teammate messaging.
 *
 * Today `agor_sessions_prompt` only accepts a `sessionId`. An agent that wants
 * to ask another teammate a question has to already know that teammate's
 * current session ID; without one the only alternative is to create a fresh
 * session, which starts cold — it re-reads BOOT.md, identity and memory and
 * knows nothing about what the teammate is presently working on.
 *
 * This module turns a human name ("Front Desk", "front-desk") into the session
 * that is actually warm, so the caller can address a teammate the way a person
 * would. It deliberately does NOT create anything: resolution either names one
 * session, reports that the teammate has no session to talk to, or refuses
 * because the name was ambiguous. The only write it can cause is the shared
 * resolver demoting an unhealthy front-desk slot before falling back to
 * recency (see `front-desk/resolve-target-session.ts`).
 *
 * Authorization: candidates come from `findTeammateBranches` with
 * `minimumPermission: 'session'`, so a caller can only resolve — and only sees
 * listed in an ambiguity error — teammates they are allowed to prompt. The
 * prompt itself is authorized again downstream by the `/sessions/:id/prompt`
 * route's branch-RBAC check; nothing here is a substitute for that.
 */

import { BranchRepository } from '@agor/core/db';
import {
  type Branch,
  type BranchID,
  getTeammateConfig,
  type Session,
  type UserID,
  type UUID,
} from '@agor/core/types';
import { resolveTargetSession } from '../../front-desk/resolve-target-session.js';
import { isSuperAdmin } from '../../utils/branch-authorization.js';
import type { McpContext } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';

/**
 * Upper bound on the teammate branches scanned for one name resolution.
 *
 * Resolution has to compare against `displayName`, which lives inside the
 * branch's `custom_context` JSON rather than in an indexed column, so matching
 * happens in memory over a bounded page. When the scan hits this cap we say so
 * instead of reporting a confident "no such teammate" we cannot actually back.
 */
export const TEAMMATE_NAME_SCAN_LIMIT = 500;

/** How many candidate names an error message is willing to list. */
const MAX_LISTED_CANDIDATES = 25;

export interface TeammateCandidate {
  branch_id: BranchID;
  /** Branch slug, e.g. "front-desk". */
  name: string;
  /** Teammate display name when configured, else the slug. */
  display_name: string;
}

export type TeammateNameResolution =
  | { outcome: 'matched'; branch: Branch }
  | { outcome: 'not_found'; scanTruncated: boolean; known: TeammateCandidate[] }
  | { outcome: 'ambiguous'; candidates: TeammateCandidate[] };

/** Whether a name reached a declared front desk or Part 1's recency pick. */
export type TeammateSessionVia = 'front_desk' | 'recency';

export type TeammateSessionResolution =
  | { outcome: 'session'; branch: Branch; session: Session; via: TeammateSessionVia }
  | { outcome: 'no_session'; branch: Branch };

/** Project a teammate branch to the compact identity echoed back to callers. */
export function describeTeammateBranch(branch: Branch): TeammateCandidate {
  const config = getTeammateConfig(branch);
  return {
    branch_id: branch.branch_id,
    name: branch.name,
    display_name: config?.displayName ?? branch.name,
  };
}

/**
 * Case-insensitive, whitespace-insensitive comparison key.
 *
 * `toLocaleLowerCase` rather than `toLowerCase` because teammate display names
 * are free text a human typed and may be non-ASCII.
 */
function foldName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Superadmins and service accounts resolve across every teammate in the
 * tenant; everyone else resolves only teammates they may prompt.
 *
 * Mirrors `shouldScopeTeammateDiscoveryToUser` in branches.ts — kept in step
 * with it so `agor_teammates_list` and name addressing agree on who exists.
 */
function shouldScopeToUser(ctx: McpContext): boolean {
  if (ctx.authenticatedUser?._isServiceAccount) return false;
  const config = ctx.app.get('config');
  const allowSuperadmin = config?.execution?.allow_superadmin === true;
  return !isSuperAdmin(ctx.authenticatedUser?.role, allowSuperadmin);
}

/**
 * Resolve a teammate name to exactly one teammate branch.
 *
 * Matches `branch.name` (the slug) or `custom_context.teammate.displayName`,
 * case-insensitively. A slug match and a displayName match are equally valid —
 * neither is preferred — because the two namespaces are independent and
 * silently preferring one would make the other name mean something different
 * depending on who else exists.
 *
 * Two teammates can genuinely share a name: `branches_repo_name_unique` is a
 * plain index (not a unique index) and is scoped per-repo anyway, and
 * `displayName` is unconstrained free text. So ambiguity is a real state, and
 * this returns it rather than guessing.
 */
export async function resolveTeammateName(
  ctx: McpContext,
  rawName: string
): Promise<TeammateNameResolution> {
  const wanted = foldName(rawName);
  const userScoped = shouldScopeToUser(ctx);

  const branches = await runWithMcpTenantDatabaseScope(ctx, (db) =>
    new BranchRepository(db).findTeammateBranches({
      archived: false,
      ...(userScoped ? { userId: ctx.userId as UUID, minimumPermission: 'session' as const } : {}),
      // One-row look-ahead distinguishes "scanned everything and found
      // nothing" from "stopped looking at the cap".
      limit: TEAMMATE_NAME_SCAN_LIMIT + 1,
    })
  );

  const scanTruncated = branches.length > TEAMMATE_NAME_SCAN_LIMIT;
  const scanned = scanTruncated ? branches.slice(0, TEAMMATE_NAME_SCAN_LIMIT) : branches;

  const matches = scanned.filter((branch) => {
    if (foldName(branch.name) === wanted) return true;
    const displayName = getTeammateConfig(branch)?.displayName;
    return displayName !== undefined && foldName(displayName) === wanted;
  });

  if (matches.length === 1) return { outcome: 'matched', branch: matches[0] };
  if (matches.length > 1) {
    return { outcome: 'ambiguous', candidates: matches.map(describeTeammateBranch) };
  }
  return {
    outcome: 'not_found',
    scanTruncated,
    known: scanned.slice(0, MAX_LISTED_CANDIDATES).map(describeTeammateBranch),
  };
}

/**
 * Part 1's recency rule: the most recently active non-archived session in the
 * branch, i.e. the greatest `updated_at`. That is the branch's warm context —
 * the conversation the teammate was last actually working in.
 *
 * Routed through the `sessions` service rather than the repository so the
 * service's own access scoping applies. `$sort: { updated_at: -1 }` selects the
 * SQL `findPage` path, which supplies a `session_id` tie-breaker, so equal
 * timestamps resolve deterministically instead of by physical row order.
 */
async function findMostRecentTeammateSession(
  ctx: McpContext,
  branch: Branch
): Promise<Session | null> {
  const result = await ctx.app.service('sessions').find({
    query: {
      branch_id: branch.branch_id,
      archived: false,
      $sort: { updated_at: -1 },
      $limit: 1,
    },
    ...ctx.baseServiceParams,
  });

  const data: Session[] = Array.isArray(result) ? result : (result?.data ?? []);
  const session = data[0];
  if (!session) return null;

  // A session outside the branch we asked for means an adapter or
  // authorization contract broke. Prompting it would send the caller's message
  // to an unrelated teammate, so fail instead of delivering it.
  if (session.branch_id !== branch.branch_id) {
    throw new Error('Teammate session lookup returned a session outside the requested branch.');
  }
  return session;
}

/**
 * Pick the session to talk to inside an already-resolved teammate branch.
 *
 * A declared front desk (`agor_teammates_front_desk_set`) wins whenever it
 * passes the health gate — even over a session with a later `updated_at`,
 * which is what makes addressing deterministic. Without one, or when the
 * pinned session is unusable, this is exactly Part 1's recency pick. Both
 * rules live in the shared resolver so gateway routing cannot drift from it.
 */
export async function resolveTeammateSession(
  ctx: McpContext,
  branch: Branch
): Promise<TeammateSessionResolution> {
  const target = await resolveTargetSession(
    {
      branchId: branch.branch_id,
      callerUserId: ctx.userId as UserID,
      scope: { kind: 'teammate' },
    },
    {
      read: (work) => runWithMcpTenantDatabaseScope(ctx, work),
      write: (work) => runWithMcpTenantDatabaseWrite(ctx, work),
      mostRecentSession: () => findMostRecentTeammateSession(ctx, branch),
    }
  );

  if (target.via === 'front_desk' || target.via === 'recency') {
    return { outcome: 'session', branch, session: target.session, via: target.via };
  }
  if (target.via === 'needs_session') return { outcome: 'no_session', branch };
  // Explicit and thread-mapping targets are not produced for teammate scope.
  throw new Error(`Unexpected teammate session resolution: ${target.via}`);
}

/** Render `not_found` as a caller-facing MCP error payload. */
export function teammateNotFoundPayload(
  name: string,
  resolution: Extract<TeammateNameResolution, { outcome: 'not_found' }>
): Record<string, unknown> {
  return {
    error: `No teammate matches "${name}".`,
    how_to_fix:
      'Call agor_teammates_list to see the teammates you can address, or pass an explicit sessionId.',
    ...(resolution.scanTruncated
      ? {
          scan_truncated: true,
          note: `More than ${TEAMMATE_NAME_SCAN_LIMIT} teammates are visible, so this name was only checked against the first ${TEAMMATE_NAME_SCAN_LIMIT}. Pass an explicit sessionId to address a teammate beyond that bound.`,
        }
      : {}),
    known_teammates: resolution.known,
  };
}

/** Render `ambiguous` as a caller-facing MCP error payload. */
export function teammateAmbiguousPayload(
  name: string,
  resolution: Extract<TeammateNameResolution, { outcome: 'ambiguous' }>
): Record<string, unknown> {
  return {
    error: `"${name}" matches ${resolution.candidates.length} teammates. Refusing to guess which one you meant.`,
    how_to_fix:
      'Re-send addressed by the exact branch slug if that is unique, or pass the sessionId of the teammate session you mean.',
    candidates: resolution.candidates,
  };
}
