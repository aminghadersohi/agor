/**
 * `branches/:id/skills` — read-only view of a teammate's skills (fork).
 *
 * Assembled on request from four places, none of which this route writes:
 *
 * - **Knowledge**: `kind: skill` documents assigned by folder (see
 *   `teammate-skills/assign.ts`): `skills/<teammate key>/…` in any namespace
 *   the caller can read, plus the teammate's own primary namespace minus other
 *   teammates' folders. Every read goes through `kb/documents` with the
 *   caller's params, so the normal namespace and visibility checks apply. A
 *   skill whose frontmatter or metadata carries `metadata.agor.origin` is
 *   shown as vendored.
 * - **In-repo**: skill files in the branch worktree, scanned by the executor
 *   (`branch.skills.scan`). The daemon never reads the worktree itself; the
 *   caller needs the same member role, branch view and filesystem read access
 *   as the Files tab.
 * - **Harness**: skill names the Claude SDK reported for the branch's most
 *   recent visible session (`custom_context.skills`).
 * - **Gaps**: optional `skills/<teammate key>/_gaps.md` documents in readable
 *   namespaces and `skills/_gaps.md` in the primary namespace, merged.
 *
 * `?include_drift=true` also scans up to {@link DRIFT_PEER_LIMIT} other
 * teammate branches the caller can read and reports, per in-repo skill name,
 * how many distinct versions exist. Each peer is one executor run, so it is
 * opt-in and bounded.
 *
 * A source the caller cannot read reports `unavailable` with a reason instead
 * of failing the whole view; only a missing branch or missing `branch.view`
 * fails, and both answer "not found".
 */

import {
  BranchRepository,
  CapabilityPolicyRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  SessionRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  BRANCH_SKILLS_SCAN_COMMAND,
  type Branch,
  type BranchID,
  type BranchSkillScan,
  getTeammateConfig,
  type HydratedKnowledgeDocument,
  hasMinimumRole,
  type KnowledgeDocument,
  type KnowledgeNamespace,
  type Params,
  ROLES,
  type SessionID,
  type SessionSkillsReceipt,
  type SkillPinStatus,
  type SkillSetEntryStatus,
  TEAMMATE_SKILL_GAPS_PATH,
  type TeammateSkill,
  type TeammateSkillRelease,
  type TeammateSkillSourceState,
  type TeammateSkillsReport,
  type UserID,
  type UserRole,
} from '@agor/core/types';
import { sessionSkillsReceipt } from '../skills/delivery.js';
import { KnowledgeSkillProvider } from '../skills/knowledge-skill-provider.js';
import { configuredProviderSlugs } from '../skills/skillset-governance.js';
import { SkillSets } from '../skills/skillsets.js';
import { skillTeammateOf } from '../skills/teammate.js';
import {
  assembleTeammateSkills,
  type GapsDocInput,
  type HarnessSkillsInput,
  type KnowledgeSkillInput,
  type PeerSkillsInput,
} from '../teammate-skills/assemble.js';
import {
  assignTeammateSkillDocs,
  teammateGapPaths,
  teammateSkillKeys,
} from '../teammate-skills/assign.js';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import { resolveBranchExecutorSandboxMounts } from '../utils/branch-executor-sandbox.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

/** Knowledge skill documents shown per teammate (each is one hydrated read). */
export const KNOWLEDGE_SKILL_LIMIT = 200;
/** `kind: skill` documents listed across readable namespaces when assigning by folder. */
export const KNOWLEDGE_LIST_LIMIT = 1000;
/** `kb/documents` page size; the service caps `$limit` at 500. */
const KNOWLEDGE_PAGE_SIZE = 500;
const KNOWLEDGE_HYDRATE_CONCURRENCY = 8;
/** Teammate branches read to learn other teammates' folder keys. */
const TEAMMATE_KEY_LIMIT = 500;
const GAP_DOCS_PER_PATH = 10;
/** Other teammate branches scanned for drift. */
export const DRIFT_PEER_LIMIT = 16;
/** Executor runs in flight at once while scanning peers. */
const DRIFT_CONCURRENCY = 4;
/** Recent sessions checked for a harness skill report. */
const HARNESS_SESSION_LOOKBACK = 10;

type RouteParams = Params & { route?: { id?: string } };

interface RequestContext {
  userId: UserID;
  role: UserRole | undefined;
  /** Trusted service actor or enabled superadmin: branch checks are bypassed, as elsewhere. */
  bypass: boolean;
  allowSuperadmin: boolean;
  /** Params for in-process service calls that must apply the caller's own access checks. */
  serviceParams: Params;
}

export interface BranchSkillsRouteDeps {
  /** Scan one branch worktree through the executor. Overridable in tests. */
  scanBranch?: (
    app: Application,
    db: TenantScopeAwareDatabase,
    branch: Branch,
    ctx: RequestContext
  ) => Promise<BranchSkillScan>;
}

function routeBranchId(params: RouteParams): BranchID {
  const id = params.route?.id;
  if (!id) throw new BadRequest('Branch ID required');
  return id as BranchID;
}

function wantsDrift(params: RouteParams): boolean {
  const value = params.query?.include_drift;
  return value === true || value === 'true';
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : undefined;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function unavailable(reason: string): TeammateSkillSourceState {
  return { status: 'unavailable', reason };
}

function paginatedData<T>(result: unknown): { data: T[]; total: number } {
  if (Array.isArray(result)) return { data: result as T[], total: result.length };
  const page = result as { data?: T[]; total?: number } | null;
  const data = page?.data ?? [];
  return { data, total: page?.total ?? data.length };
}

/**
 * Run one short database unit in the caller's tenant scope.
 *
 * The route is registered with `transaction: false` (it awaits executor
 * scans), so the request carries tenant context but no database scope; every
 * direct repository read must open its own. Executor calls stay outside.
 */
function inTenantDb<T>(db: TenantScopeAwareDatabase, work: () => Promise<T>): Promise<T> {
  return runWithTenantDatabaseScope(
    db,
    requireCurrentTenantId('Missing active tenant context for teammate skills'),
    work
  );
}

/** Executor-backed scan with the Files tab's access rule: member role, branch view, fs read. */
async function scanBranchWithExecutor(
  app: Application,
  db: TenantScopeAwareDatabase,
  branch: Branch,
  ctx: RequestContext
): Promise<BranchSkillScan> {
  if (!ctx.bypass && !hasMinimumRole(ctx.role, ROLES.MEMBER)) {
    throw new Error('Reading branch files requires the member role');
  }
  const config = app.get('config');
  const { fsAccess, delegatedHomeKey, sandboxMounts } = await inTenantDb(db, async () => {
    const fsAccess = await ensureBranchWorkspaceAccess(
      new BranchRepository(db),
      branch,
      ctx.userId,
      ctx.role,
      'view',
      'read',
      ctx.allowSuperadmin
    );
    const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(db, ctx.userId, config);
    // The private executor home belongs to the caller, never the branch owner.
    const sandboxMounts = await resolveBranchExecutorSandboxMounts({
      config,
      tenantId: requireCurrentTenantId('Missing active tenant context for skill scan'),
      executionUserId: ctx.userId,
      branch,
      db,
    });
    return { fsAccess, delegatedHomeKey, sandboxMounts };
  });
  const sessionToken = await issueExecutorCommandToken(
    app,
    BRANCH_SKILLS_SCAN_COMMAND,
    ctx.userId,
    branch.branch_id
  );
  const result = await requestExecutor(
    {
      command: BRANCH_SKILLS_SCAN_COMMAND,
      sessionToken,
      daemonUrl: getDaemonUrl(),
      params: {
        branchId: branch.branch_id,
        cwd: branch.path,
        principalBranchAccess: fsAccess,
        ...sandboxMounts,
      },
    },
    {
      logPrefix: `[BranchSkills ${branch.branch_id}]`,
      delegatedHomeKey,
      templateVariables: {
        branch_id: branch.branch_id,
        user_id: ctx.userId,
        branch_fs_access: fsAccess,
      },
    }
  );
  if (!result.success) {
    throw new Error(result.error?.message ?? 'The executor could not scan the branch');
  }
  const scan = (result.data as { scan?: BranchSkillScan } | undefined)?.scan;
  if (!scan || !Array.isArray(scan.skills)) {
    throw new Error('The executor returned an invalid skill scan');
  }
  return scan;
}

/** Errors from the access checks above read as one stable sentence in the panel. */
function scanFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/member role/i.test(message)) return 'Reading branch files requires the member role.';
  if (/^Forbidden/i.test(message)) return 'You do not have file read access to this branch.';
  return `The worktree could not be scanned: ${message}`;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A Knowledge skill row with its release pin and whether the last receipt delivered it. */
export function withReleaseInfo(
  skill: TeammateSkill,
  pins: Map<string, SkillSetEntryStatus>,
  deliveredVersions: Set<string>,
  release: number | undefined
): TeammateSkill {
  const pin = skill.document_id && release !== undefined ? pins.get(skill.document_id) : undefined;
  const delivered =
    (pin && deliveredVersions.has(pin.version_id)) ||
    (!!skill.version_id && deliveredVersions.has(skill.version_id));
  if (!pin && !delivered) return skill;
  return {
    ...skill,
    ...(pin
      ? {
          pin: {
            release: release as number,
            version_number: pin.version_number,
            status: pin.status,
            ...(pin.latest_version_number !== undefined
              ? { latest_version_number: pin.latest_version_number }
              : {}),
          },
        }
      : {}),
    ...(delivered ? { delivered: true } : {}),
  };
}

export function createBranchSkillsRoute(options: {
  db: TenantScopeAwareDatabase;
  /** Read per request, like every other route's superadmin check. */
  allowSuperadmin: () => boolean;
  deps?: BranchSkillsRouteDeps;
}) {
  const { db, allowSuperadmin } = options;
  const scanBranch = options.deps?.scanBranch ?? scanBranchWithExecutor;
  let app: Application | undefined;

  function requestContext(params: RouteParams): RequestContext {
    const { user, provider, tenant } = params as AuthenticatedParams;
    if (!user?.user_id) throw new NotAuthenticated('Authentication required');
    const allow = allowSuperadmin();
    return {
      userId: user.user_id as UserID,
      role: user.role as UserRole | undefined,
      bypass: user._isServiceAccount === true || isSuperAdmin(user.role, allow),
      allowSuperadmin: allow,
      serviceParams: { user, authenticated: true, provider, tenant } as Params,
    };
  }

  /** The teammate branch, or "not found" for a missing branch, a plain branch, or no `branch.view`. */
  async function loadViewableTeammate(branchId: BranchID, ctx: RequestContext): Promise<Branch> {
    return inTenantDb(db, async () => {
      const branch = await new BranchRepository(db).findById(branchId);
      if (!branch || !getTeammateConfig(branch)) throw new NotFound('Teammate not found');
      if (!ctx.bypass) {
        const access = await new CapabilityPolicyRepository(db).resolveBranchAccess(
          branchId,
          ctx.userId
        );
        if (!access.capabilities.includes('branch.view')) throw new NotFound('Teammate not found');
      }
      return branch;
    });
  }

  /** Folder keys of every other teammate the caller can see, archived ones included. */
  async function otherTeammateKeys(branch: Branch, ctx: RequestContext): Promise<string[]> {
    const teammates = await inTenantDb(db, () =>
      new BranchRepository(db).findTeammateBranches({
        ...(ctx.bypass ? {} : { userId: ctx.userId, minimumPermission: 'view' as const }),
        limit: TEAMMATE_KEY_LIMIT,
      })
    );
    return teammates
      .filter((peer) => peer.branch_id !== branch.branch_id && getTeammateConfig(peer))
      .flatMap((peer) => teammateSkillKeys(getTeammateConfig(peer)?.displayName ?? peer.name));
  }

  /** Up to `cap` `kind: skill` documents the caller can read, optionally in one namespace. */
  async function listSkillDocs(
    featherApp: Application,
    ctx: RequestContext,
    cap: number,
    namespaceId?: string
  ): Promise<{ docs: KnowledgeDocument[]; truncated: boolean }> {
    const docs: KnowledgeDocument[] = [];
    let total = 0;
    while (docs.length < cap) {
      const page = paginatedData<KnowledgeDocument>(
        await featherApp.service('kb/documents').find({
          ...ctx.serviceParams,
          query: {
            ...(namespaceId ? { namespace_id: namespaceId } : {}),
            kind: 'skill',
            archived: false,
            $limit: Math.min(KNOWLEDGE_PAGE_SIZE, cap - docs.length),
            $skip: docs.length,
            $sort: { path: 1 },
          },
        })
      );
      docs.push(...page.data);
      total = page.total;
      if (page.data.length === 0 || docs.length >= total) break;
    }
    return { docs, truncated: total > docs.length };
  }

  async function loadKnowledge(
    featherApp: Application,
    branch: Branch,
    ctx: RequestContext
  ): Promise<{
    state: TeammateSkillsReport['sources']['knowledge'];
    docs: KnowledgeSkillInput[];
    gapsDocs: GapsDocInput[];
  }> {
    const config = getTeammateConfig(branch);
    const ownKeys = teammateSkillKeys(config?.displayName ?? branch.name);
    const primaryNamespaceId = config?.kb?.primary_namespace_id ?? null;

    // The primary namespace may be unreadable or missing; folder skills elsewhere still count.
    let primary: KnowledgeNamespace | null = null;
    let primaryProblem: string | undefined;
    if (!primaryNamespaceId) {
      primaryProblem = 'This teammate has no Knowledge namespace yet.';
    } else {
      try {
        primary = (await featherApp
          .service('kb/namespaces')
          .get(primaryNamespaceId, ctx.serviceParams)) as KnowledgeNamespace;
        if (primary.archived) {
          primary = null;
          primaryProblem = "This teammate's Knowledge namespace is archived.";
        }
      } catch (error) {
        const code = errorCode(error);
        if (code !== 403 && code !== 404) throw error;
        primaryProblem = "You can't read this teammate's Knowledge namespace.";
      }
    }

    const [namespaceList, otherKeys, shared, own] = await Promise.all([
      featherApp
        .service('kb/namespaces')
        .find({ ...ctx.serviceParams, query: { archived: false, $limit: 1000 } }),
      otherTeammateKeys(branch, ctx),
      listSkillDocs(featherApp, ctx, KNOWLEDGE_LIST_LIMIT),
      primary
        ? listSkillDocs(featherApp, ctx, KNOWLEDGE_PAGE_SIZE, primary.namespace_id)
        : Promise.resolve({ docs: [], truncated: false }),
    ]);
    const namespaces = new Map(
      paginatedData<KnowledgeNamespace>(namespaceList).data.map((ns) => [ns.namespace_id, ns])
    );
    if (primary) namespaces.set(primary.namespace_id, primary);

    const providerSlugs = configuredProviderSlugs(featherApp.get('config'));
    const assigned = assignTeammateSkillDocs(
      // Drafts are imports under review, not equipped skills.
      [...own.docs, ...shared.docs].filter((doc) => doc.status !== 'draft'),
      {
        ownKeys,
        otherKeys,
        primaryNamespaceId: primary?.namespace_id,
        sharedNamespaceIds: [...namespaces.values()]
          .filter((ns) => providerSlugs.has(ns.slug))
          .map((ns) => ns.namespace_id),
      }
    );
    const selected = assigned.slice(0, KNOWLEDGE_SKILL_LIMIT);
    const hydrated = await mapLimited(selected, KNOWLEDGE_HYDRATE_CONCURRENCY, async (doc) => {
      try {
        return (await featherApp.service('kb/documents').get(doc.document_id, {
          ...ctx.serviceParams,
          query: { include_content: true },
        })) as HydratedKnowledgeDocument;
      } catch {
        // Archived or no longer readable since it was listed.
        return null;
      }
    });
    const docs = hydrated
      .filter((doc): doc is HydratedKnowledgeDocument => !!doc && typeof doc.content === 'string')
      .map((doc): KnowledgeSkillInput => {
        const namespace = namespaces.get(doc.namespace_id);
        return {
          document_id: doc.document_id,
          path: doc.path,
          uri: doc.uri,
          url: doc.url,
          updated_at: toIso(doc.updated_at),
          metadata: doc.metadata,
          version_id: doc.current_version?.version_id ?? doc.current_version_id,
          version_number: doc.current_version?.version_number,
          content_sha256: doc.current_version?.content_sha256,
          content: doc.content ?? '',
          namespace_slug: namespace?.slug,
          namespace_name: namespace?.display_name,
        };
      });

    const gapsDocs = await loadGapDocs(featherApp, ctx, ownKeys, primary, namespaces);
    const truncated = shared.truncated || own.truncated || assigned.length > KNOWLEDGE_SKILL_LIMIT;
    const state: TeammateSkillsReport['sources']['knowledge'] =
      primaryProblem && docs.length === 0 && gapsDocs.length === 0
        ? unavailable(primaryProblem)
        : {
            status: 'ok',
            ...(primary ? { namespace_slug: primary.slug } : {}),
            ...(truncated ? { truncated: true } : {}),
          };
    return { state, docs, gapsDocs };
  }

  /**
   * Gap lists: `skills/<key>/_gaps.md` in any readable namespace, then
   * `skills/_gaps.md` in the primary namespace.
   */
  async function loadGapDocs(
    featherApp: Application,
    ctx: RequestContext,
    ownKeys: string[],
    primary: KnowledgeNamespace | null,
    namespaces: Map<string, KnowledgeNamespace>
  ): Promise<GapsDocInput[]> {
    const lookups = [
      ...teammateGapPaths(ownKeys).map((path) => ({ path, namespace_id: undefined })),
      ...(primary ? [{ path: TEAMMATE_SKILL_GAPS_PATH, namespace_id: primary.namespace_id }] : []),
    ];
    const pages = await Promise.all(
      lookups.map(({ path, namespace_id }) =>
        featherApp.service('kb/documents').find({
          ...ctx.serviceParams,
          query: {
            ...(namespace_id ? { namespace_id } : {}),
            path,
            archived: false,
            include_content: true,
            $limit: GAP_DOCS_PER_PATH,
          },
        })
      )
    );
    const seen = new Set<string>();
    const docs: GapsDocInput[] = [];
    for (const page of pages) {
      for (const doc of paginatedData<HydratedKnowledgeDocument>(page).data) {
        if (seen.has(doc.document_id) || typeof doc.content !== 'string') continue;
        seen.add(doc.document_id);
        docs.push({
          uri: doc.uri,
          url: doc.url,
          path: doc.path,
          namespace_slug: namespaces.get(doc.namespace_id)?.slug,
          content: doc.content,
        });
      }
    }
    return docs;
  }

  async function loadHarness(
    branch: Branch,
    ctx: RequestContext
  ): Promise<{
    state: TeammateSkillsReport['sources']['harness'];
    harness: HarnessSkillsInput | null;
    receipt: { session_id: SessionID; receipt: SessionSkillsReceipt } | null;
  }> {
    const { data } = await inTenantDb(db, () =>
      new SessionRepository(db).findPage({
        branchId: branch.branch_id,
        sortUpdatedAt: -1,
        limit: HARNESS_SESSION_LOOKBACK,
        includeTotal: false,
        ...(ctx.bypass ? {} : { visibleToUserId: ctx.userId }),
      })
    );
    const receiptSession = data.find((session) => sessionSkillsReceipt(session));
    const receipt = receiptSession
      ? {
          session_id: receiptSession.session_id,
          receipt: sessionSkillsReceipt(receiptSession) as SessionSkillsReceipt,
        }
      : null;
    for (const session of data) {
      const skills = (session.custom_context as Record<string, unknown> | undefined)?.skills;
      if (!Array.isArray(skills)) continue;
      const at = toIso(session.last_updated) ?? toIso(session.created_at);
      return {
        state: { status: 'ok', session_id: session.session_id, session_at: at },
        harness: { skills: skills.filter((name): name is string => typeof name === 'string'), at },
        receipt,
      };
    }
    return {
      state: unavailable('No recent session has reported its loaded skills.'),
      harness: null,
      receipt,
    };
  }

  /** The teammate's latest skill set release and the pin of each released skill. */
  async function loadRelease(
    featherApp: Application,
    branch: Branch,
    ctx: RequestContext
  ): Promise<{ release: TeammateSkillRelease; pins: Map<string, SkillSetEntryStatus> }> {
    const enabled = getTeammateConfig(branch)?.skills?.enabled !== false;
    const teammate = skillTeammateOf(branch);
    const pins = new Map<string, SkillSetEntryStatus>();
    if (!teammate) return { release: { status: 'none', enabled }, pins };
    try {
      const provider = new KnowledgeSkillProvider(featherApp, ctx.serviceParams);
      const sets = new SkillSets(provider);
      for (const namespace of await provider.providerNamespaces()) {
        const assigned = await sets.namespaceSkills(namespace, teammate);
        const record = await sets.find(namespace, teammate);
        if (record.document && !record.manifest) {
          return {
            release: {
              status: 'unavailable',
              enabled,
              namespace_slug: namespace.slug,
              path: record.path,
              reason: `The skill set manifest could not be read: ${record.error}`,
            },
            pins,
          };
        }
        if (!record.manifest) continue;
        const statuses = await sets.status(record.manifest);
        const counts: Partial<Record<SkillPinStatus, number>> = {};
        for (const status of statuses) {
          pins.set(status.document_id, status);
          counts[status.status] = (counts[status.status] ?? 0) + 1;
        }
        const released = new Set(statuses.map((status) => status.document_id));
        return {
          release: {
            status: 'ok',
            enabled,
            namespace_slug: namespace.slug,
            path: record.path,
            release: record.manifest.release,
            created_at: record.manifest.created_at,
            manifest_version_number: record.document?.current_version?.version_number,
            counts,
            unreleased: assigned.filter((skill) => !released.has(skill.document_id)).length,
          },
          pins,
        };
      }
      return { release: { status: 'none', enabled }, pins };
    } catch (error) {
      const code = errorCode(error);
      if (code !== 403 && code !== 404) throw error;
      return {
        release: {
          status: 'unavailable',
          enabled,
          reason: "You can't read this teammate's skill set.",
        },
        pins,
      };
    }
  }

  async function scanOwn(
    featherApp: Application,
    branch: Branch,
    ctx: RequestContext
  ): Promise<{ state: TeammateSkillSourceState; scan: BranchSkillScan | null }> {
    try {
      const scan = await scanBranch(featherApp, db, branch, ctx);
      return { state: { status: 'ok', ...(scan.truncated ? { truncated: true } : {}) }, scan };
    } catch (error) {
      return { state: unavailable(scanFailureReason(error)), scan: null };
    }
  }

  async function scanPeers(
    featherApp: Application,
    branch: Branch,
    ctx: RequestContext
  ): Promise<{ state: TeammateSkillsReport['sources']['drift']; peers: PeerSkillsInput[] | null }> {
    const candidates = await inTenantDb(db, () =>
      new BranchRepository(db).findTeammateBranches({
        archived: false,
        ...(ctx.bypass ? {} : { userId: ctx.userId, minimumPermission: 'view' as const }),
        // One extra row tells us whether the bound cut the list short.
        limit: DRIFT_PEER_LIMIT + 2,
      })
    );
    const others = candidates.filter(
      (peer) => peer.branch_id !== branch.branch_id && getTeammateConfig(peer)
    );
    const truncated = others.length > DRIFT_PEER_LIMIT;
    const peers = others.slice(0, DRIFT_PEER_LIMIT);
    const scans = await mapLimited(peers, DRIFT_CONCURRENCY, async (peer) => {
      try {
        return await scanBranch(featherApp, db, peer, ctx);
      } catch {
        // A teammate whose files the caller cannot read is simply not compared.
        return null;
      }
    });
    const readable: PeerSkillsInput[] = [];
    scans.forEach((scan, index) => {
      if (!scan) return;
      const peer = peers[index];
      readable.push({
        branch_id: peer.branch_id,
        name: getTeammateConfig(peer)?.displayName ?? peer.name,
        skills: scan.skills.map(({ name, sha256 }) => ({ name, sha256 })),
      });
    });
    return {
      state: {
        status: 'ok',
        branches_scanned: readable.length,
        ...(truncated || scans.some((scan) => scan?.truncated) ? { truncated: true } : {}),
      },
      peers: readable,
    };
  }

  return {
    async setup(featherApp: Application): Promise<void> {
      app = featherApp;
    },

    async find(params: RouteParams): Promise<TeammateSkillsReport> {
      if (!app) throw new Error('branches/:id/skills used before setup');
      const featherApp = app;
      const ctx = requestContext(params);
      const branch = await loadViewableTeammate(routeBranchId(params), ctx);

      const [knowledge, own, harness, release] = await Promise.all([
        loadKnowledge(featherApp, branch, ctx),
        scanOwn(featherApp, branch, ctx),
        loadHarness(branch, ctx),
        loadRelease(featherApp, branch, ctx),
      ]);

      let drift: Awaited<ReturnType<typeof scanPeers>> = {
        state: { ...unavailable('Drift was not requested.'), branches_scanned: 0 },
        peers: null,
      };
      if (own.scan && wantsDrift(params)) {
        drift = own.scan.skills.length
          ? await scanPeers(featherApp, branch, ctx)
          : { state: { status: 'ok', branches_scanned: 0 }, peers: [] };
      } else if (!own.scan && wantsDrift(params)) {
        drift.state = { ...unavailable('This branch could not be scanned.'), branches_scanned: 0 };
      }

      const { skills, gaps } = assembleTeammateSkills({
        knowledge: knowledge.docs,
        inRepo: own.scan?.skills ?? [],
        peers: drift.peers,
        harness: harness.harness,
        gapsDocs: knowledge.gapsDocs,
      });

      const delivered = harness.receipt;
      const deliveredVersions = new Set(
        delivered?.receipt.skills.map((skill) => skill.version_id) ?? []
      );
      return {
        branch_id: branch.branch_id,
        skills: skills.map((skill) =>
          withReleaseInfo(skill, release.pins, deliveredVersions, release.release.release)
        ),
        gaps,
        release: {
          ...release.release,
          ...(delivered
            ? {
                delivered: {
                  session_id: delivered.session_id,
                  release: delivered.receipt.release,
                  delivered_at: delivered.receipt.delivered_at,
                  harness: delivered.receipt.harness,
                  skills: delivered.receipt.skills.length,
                },
              }
            : {}),
        },
        sources: {
          knowledge: knowledge.state,
          in_repo: own.state,
          harness: harness.state,
          drift: drift.state,
        },
      };
    },
  };
}
