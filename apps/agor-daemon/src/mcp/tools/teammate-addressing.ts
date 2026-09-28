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
 *
 * `agor_teammates_list` discovers at `view`, so it can show teammates this
 * module will not resolve. `assessTeammateAddressability` answers, per listed
 * teammate, whether name addressing reaches it and why not — from the same
 * scan and the same name index `resolveTeammateName` uses, so the two cannot
 * disagree.
 */

import { BranchRepository } from '@agor/core/db';
import {
  type Branch,
  type BranchID,
  getTeammateConfig,
  type Session,
  type SessionID,
  type TeammateAddressability,
  type TeammateCandidate,
  type TeammateNotAddressableReason,
  type UserID,
  type UUID,
} from '@agor/core/types';
import {
  type FrontDeskTarget,
  resolveTargetSession,
} from '../../front-desk/resolve-target-session.js';
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

export type { TeammateAddressability, TeammateCandidate };

/**
 * What addressing reads from its caller. An MCP context satisfies it; the
 * `branches/:id/front-desk` route builds one from request params so the UI
 * preview runs this same code.
 */
export type TeammateAddressingContext = Pick<
  McpContext,
  'app' | 'db' | 'userId' | 'authenticatedUser' | 'baseServiceParams'
>;

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
 * Superadmins and service accounts discover and resolve across every teammate
 * in the tenant; everyone else is scoped to their own branch access. Shared by
 * `agor_teammates_list` and name addressing so they agree on who exists.
 */
export function shouldScopeTeammateDiscoveryToUser(ctx: TeammateAddressingContext): boolean {
  if (ctx.authenticatedUser?._isServiceAccount) return false;
  const config = ctx.app.get('config');
  const allowSuperadmin = config?.execution?.allow_superadmin === true;
  return !isSuperAdmin(ctx.authenticatedUser?.role, allowSuperadmin);
}

interface TeammateNameScan {
  /** Teammates the caller may prompt, in discovery order, capped at the scan limit. */
  scanned: Branch[];
  scanTruncated: boolean;
  /** Folded name → every scanned teammate answering to it, in scan order. */
  byName: Map<string, Branch[]>;
}

/** The folded names a teammate answers to: its slug and, if set, its display name. */
function foldedNamesOf(branch: Branch): string[] {
  const names = new Set([foldName(branch.name)]);
  const displayName = getTeammateConfig(branch)?.displayName;
  if (displayName !== undefined) names.add(foldName(displayName));
  return [...names];
}

/**
 * The candidate set name addressing matches against: non-archived teammates
 * the caller may prompt (`session` permission), bounded by
 * {@link TEAMMATE_NAME_SCAN_LIMIT}.
 */
async function scanNameableTeammates(ctx: TeammateAddressingContext): Promise<TeammateNameScan> {
  const userScoped = shouldScopeTeammateDiscoveryToUser(ctx);

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
  const byName = new Map<string, Branch[]>();
  for (const branch of scanned) {
    for (const name of foldedNamesOf(branch)) {
      const bucket = byName.get(name);
      if (bucket) bucket.push(branch);
      else byName.set(name, [branch]);
    }
  }
  return { scanned, scanTruncated, byName };
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
  ctx: TeammateAddressingContext,
  rawName: string
): Promise<TeammateNameResolution> {
  const { scanned, scanTruncated, byName } = await scanNameableTeammates(ctx);
  const matches = byName.get(foldName(rawName)) ?? [];

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

function notAddressable(
  reason: Exclude<TeammateNotAddressableReason, 'ambiguous_name'>
): TeammateAddressability {
  const detail: Record<typeof reason, string> = {
    archived: 'The teammate is archived; name addressing only reaches active teammates.',
    not_a_teammate:
      'The branch is not a teammate (no teammate marker or enabled schedule), so name addressing does not consider it.',
    no_prompt_permission:
      'You can see this teammate but lack session permission on its branch, so name addressing will not resolve it for you.',
    beyond_scan_limit: `More than ${TEAMMATE_NAME_SCAN_LIMIT} teammates are addressable, and name addressing only checks the first ${TEAMMATE_NAME_SCAN_LIMIT}. Address one of its sessions by sessionId instead.`,
  };
  return { addressable: false, reason, detail: detail[reason] };
}

/**
 * Whether `agor_sessions_prompt { teammate }` would reach each branch for this
 * caller, and by which name.
 *
 * Name addressing succeeds exactly when the branch is in the scan
 * `resolveTeammateName` matches against and one of its names maps to it
 * alone, so this reads the same scan rather than restating the rule. Branches
 * outside the scan are classified with one bounded lookup each for
 * teammate-ness and prompt permission.
 */
export async function assessTeammateAddressability(
  ctx: TeammateAddressingContext,
  branches: Branch[]
): Promise<Map<BranchID, TeammateAddressability>> {
  const { scanned, byName } = await scanNameableTeammates(ctx);
  const scannedIds = new Set(scanned.map((branch) => branch.branch_id));
  const unscannedIds = branches
    .filter((branch) => !branch.archived && !scannedIds.has(branch.branch_id))
    .map((branch) => branch.branch_id);

  let teammateIds = new Set<BranchID>();
  let promptableIds = new Set<BranchID>();
  if (unscannedIds.length > 0) {
    const userScoped = shouldScopeTeammateDiscoveryToUser(ctx);
    const ids = (rows: Branch[]) => new Set(rows.map((row) => row.branch_id));
    [teammateIds, promptableIds] = await runWithMcpTenantDatabaseScope(ctx, async (db) => {
      const repo = new BranchRepository(db);
      const base = { archived: false, branchIds: unscannedIds, limit: unscannedIds.length };
      const teammates = ids(await repo.findTeammateBranches(base));
      const promptable = userScoped
        ? ids(
            await repo.findTeammateBranches({
              ...base,
              userId: ctx.userId as UUID,
              minimumPermission: 'session',
            })
          )
        : teammates;
      return [teammates, promptable];
    });
  }

  const unscannedReason = (branchId: BranchID) => {
    if (!teammateIds.has(branchId)) return 'not_a_teammate' as const;
    if (!promptableIds.has(branchId)) return 'no_prompt_permission' as const;
    // Promptable yet outside the scan: it fell past the cap.
    return 'beyond_scan_limit' as const;
  };

  const verdicts = new Map<BranchID, TeammateAddressability>();
  for (const branch of branches) {
    if (branch.archived) {
      verdicts.set(branch.branch_id, notAddressable('archived'));
    } else if (!scannedIds.has(branch.branch_id)) {
      verdicts.set(branch.branch_id, notAddressable(unscannedReason(branch.branch_id)));
    } else {
      verdicts.set(branch.branch_id, assessScannedName(branch, byName));
    }
  }
  return verdicts;
}

/** A scanned teammate is addressable by whichever of its names nobody else shares. */
function assessScannedName(
  branch: Branch,
  byName: TeammateNameScan['byName']
): TeammateAddressability {
  const displayName = getTeammateConfig(branch)?.displayName;
  for (const name of [branch.name, displayName]) {
    if (name !== undefined && byName.get(foldName(name))?.length === 1) {
      return { addressable: true, address: name };
    }
  }
  const others = new Map<BranchID, Branch>();
  for (const name of foldedNamesOf(branch)) {
    for (const other of byName.get(name) ?? []) {
      if (other.branch_id !== branch.branch_id) others.set(other.branch_id, other);
    }
  }
  return {
    addressable: false,
    reason: 'ambiguous_name',
    detail:
      'Every name this teammate answers to also matches another teammate you can address, so name addressing refuses to guess. Address one of its sessions by sessionId instead.',
    conflicts_with: [...others.values()].map(describeTeammateBranch),
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
  ctx: TeammateAddressingContext,
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
  ctx: TeammateAddressingContext,
  branch: Branch
): Promise<TeammateSessionResolution> {
  const target = await resolveTeammateTarget(ctx, branch);

  if (target.via === 'front_desk' || target.via === 'recency') {
    return { outcome: 'session', branch, session: target.session, via: target.via };
  }
  if (target.via === 'needs_session') return { outcome: 'no_session', branch };
  // Explicit and thread-mapping targets are not produced for teammate scope.
  throw new Error(`Unexpected teammate session resolution: ${target.via}`);
}

/**
 * The shared resolver, wired to this caller's tenant scope and access-scoped
 * recency read. `resolveTeammateSession` is the prompting path; the dry-run
 * preview (`agor_teammates_resolve`) calls this directly so it can also show
 * the explicit rule and a bypassed front desk without demoting it.
 */
export function resolveTeammateTarget(
  ctx: TeammateAddressingContext,
  branch: Branch,
  options: { explicitSessionId?: SessionID; dryRun?: boolean } = {}
): Promise<FrontDeskTarget> {
  return resolveTargetSession(
    {
      branchId: branch.branch_id,
      callerUserId: ctx.userId as UserID,
      scope: { kind: 'teammate' },
      ...options,
    },
    {
      read: (work) => runWithMcpTenantDatabaseScope(ctx, work),
      write: (work) => runWithMcpTenantDatabaseWrite(ctx, work),
      mostRecentSession: () => findMostRecentTeammateSession(ctx, branch),
    }
  );
}

/**
 * The dry run behind `agor_teammates_resolve` and the UI's Front desk preview:
 * whether the caller can address this teammate by name, and which session an
 * address would reach. Never writes — an unhealthy front desk is reported on
 * the target, not demoted.
 */
export async function previewTeammateAddress(
  ctx: TeammateAddressingContext,
  branch: Branch,
  options: { explicitSessionId?: SessionID } = {}
): Promise<{ nameAddressing: TeammateAddressability; target: FrontDeskTarget }> {
  const [addressability, target] = await Promise.all([
    assessTeammateAddressability(ctx, [branch]),
    resolveTeammateTarget(ctx, branch, { ...options, dryRun: true }),
  ]);
  return { nameAddressing: addressability.get(branch.branch_id)!, target };
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
