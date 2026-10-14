/**
 * `branches/:id/skills` — read-only view of a teammate's skills (fork).
 *
 * Assembled on request from four places, none of which this route writes:
 *
 * - **Knowledge**: `kind: skill` documents in the teammate's primary
 *   namespace, read through `kb/documents` with the caller's params, so the
 *   normal namespace and visibility checks apply. A skill whose frontmatter
 *   or metadata carries `metadata.agor.origin` is shown as vendored.
 * - **In-repo**: skill files in the branch worktree, scanned by the executor
 *   (`branch.skills.scan`). The daemon never reads the worktree itself; the
 *   caller needs the same member role, branch view and filesystem read access
 *   as the Files tab.
 * - **Harness**: skill names the Claude SDK reported for the branch's most
 *   recent visible session (`custom_context.skills`).
 * - **Gaps**: the optional `skills/_gaps.md` document in the same namespace.
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
  type KnowledgeNamespace,
  type Params,
  ROLES,
  TEAMMATE_SKILL_GAPS_PATH,
  type TeammateSkillSourceState,
  type TeammateSkillsReport,
  type UserID,
  type UserRole,
} from '@agor/core/types';
import {
  assembleTeammateSkills,
  type GapsDocInput,
  type HarnessSkillsInput,
  type KnowledgeSkillInput,
  type PeerSkillsInput,
} from '../teammate-skills/assemble.js';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import { resolveBranchExecutorSandboxMounts } from '../utils/branch-executor-sandbox.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

/** Knowledge skill documents read per teammate. */
export const KNOWLEDGE_SKILL_LIMIT = 200;
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
  }

  async function loadKnowledge(
    featherApp: Application,
    branch: Branch,
    ctx: RequestContext
  ): Promise<{
    state: TeammateSkillsReport['sources']['knowledge'];
    docs: KnowledgeSkillInput[];
    gapsDoc: GapsDocInput | null;
  }> {
    const namespaceId = getTeammateConfig(branch)?.kb?.primary_namespace_id;
    if (!namespaceId) {
      return {
        state: unavailable('This teammate has no Knowledge namespace yet.'),
        docs: [],
        gapsDoc: null,
      };
    }
    let namespace: KnowledgeNamespace;
    try {
      namespace = (await featherApp
        .service('kb/namespaces')
        .get(namespaceId, ctx.serviceParams)) as KnowledgeNamespace;
    } catch (error) {
      const code = errorCode(error);
      if (code === 403 || code === 404) {
        return {
          state: unavailable("You can't read this teammate's Knowledge namespace."),
          docs: [],
          gapsDoc: null,
        };
      }
      throw error;
    }
    if (namespace.archived) {
      return {
        state: unavailable("This teammate's Knowledge namespace is archived."),
        docs: [],
        gapsDoc: null,
      };
    }

    const documents = featherApp.service('kb/documents');
    const [skillPage, gapsPage] = await Promise.all([
      documents.find({
        ...ctx.serviceParams,
        query: {
          namespace_id: namespaceId,
          kind: 'skill',
          archived: false,
          include_content: true,
          $limit: KNOWLEDGE_SKILL_LIMIT,
          $sort: { path: 1 },
        },
      }),
      documents.find({
        ...ctx.serviceParams,
        query: {
          namespace_id: namespaceId,
          path: TEAMMATE_SKILL_GAPS_PATH,
          archived: false,
          include_content: true,
          $limit: 1,
        },
      }),
    ]);

    const skills = paginatedData<HydratedKnowledgeDocument>(skillPage);
    const docs = skills.data
      // Drafts are imports under review, not equipped skills.
      .filter((doc) => doc.status !== 'draft' && typeof doc.content === 'string')
      .map(
        (doc): KnowledgeSkillInput => ({
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
        })
      );
    const gaps = paginatedData<HydratedKnowledgeDocument>(gapsPage).data[0];
    return {
      state: {
        status: 'ok',
        namespace_slug: namespace.slug,
        ...(skills.total > skills.data.length ? { truncated: true } : {}),
      },
      docs,
      gapsDoc:
        gaps && typeof gaps.content === 'string'
          ? { uri: gaps.uri, url: gaps.url, content: gaps.content }
          : null,
    };
  }

  async function loadHarness(
    branch: Branch,
    ctx: RequestContext
  ): Promise<{
    state: TeammateSkillsReport['sources']['harness'];
    harness: HarnessSkillsInput | null;
  }> {
    const { data } = await new SessionRepository(db).findPage({
      branchId: branch.branch_id,
      sortUpdatedAt: -1,
      limit: HARNESS_SESSION_LOOKBACK,
      includeTotal: false,
      ...(ctx.bypass ? {} : { visibleToUserId: ctx.userId }),
    });
    for (const session of data) {
      const skills = (session.custom_context as Record<string, unknown> | undefined)?.skills;
      if (!Array.isArray(skills)) continue;
      const at = toIso(session.last_updated) ?? toIso(session.created_at);
      return {
        state: { status: 'ok', session_id: session.session_id, session_at: at },
        harness: { skills: skills.filter((name): name is string => typeof name === 'string'), at },
      };
    }
    return {
      state: unavailable('No recent session has reported its loaded skills.'),
      harness: null,
    };
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
    const candidates = await new BranchRepository(db).findTeammateBranches({
      archived: false,
      ...(ctx.bypass ? {} : { userId: ctx.userId, minimumPermission: 'view' as const }),
      // One extra row tells us whether the bound cut the list short.
      limit: DRIFT_PEER_LIMIT + 2,
    });
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

      const [knowledge, own, harness] = await Promise.all([
        loadKnowledge(featherApp, branch, ctx),
        scanOwn(featherApp, branch, ctx),
        loadHarness(branch, ctx),
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
        gapsDoc: knowledge.gapsDoc,
      });

      return {
        branch_id: branch.branch_id,
        skills,
        gaps,
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
