/**
 * Cutting skill set releases, shared by the curator tool
 * (`agor_skillsets_release`) and the admin route behind `agor skills release`.
 * Authorization is decided by the caller and passed in per namespace; this
 * module only plans and commits.
 */

import { BranchRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { KnowledgeNamespace, UserID } from '@agor/core/types';
import type { KnowledgeSkillProvider } from './knowledge-skill-provider.js';
import { type ReleaseAuthorization, type ReleaseOutcome, SkillSets } from './skillsets.js';
import { type SkillTeammate, skillTeammateOf } from './teammate.js';

/** Teammate branches read when releasing for every teammate. */
const RELEASE_ALL_TEAMMATE_LIMIT = 500;

export interface ReleaseResult {
  namespace: string;
  teammate: string;
  path?: string;
  status: 'released' | 'unchanged' | 'skipped' | 'denied' | 'conflict' | 'error';
  release?: number;
  previous_release?: number | null;
  skills?: number;
  authorized_as?: 'curator' | 'admin';
  manifest_version_number?: number;
  reason?: string;
}

export interface ReleaseRunResult {
  counts: Record<string, number>;
  results: ReleaseResult[];
  failed: boolean;
}

/** Provider namespaces to release in: all readable configured ones, or the one named. */
export async function releaseNamespaces(
  provider: KnowledgeSkillProvider,
  slug: string | undefined
): Promise<KnowledgeNamespace[]> {
  const namespaces = await provider.providerNamespaces();
  if (!slug) return namespaces;
  const match = namespaces.filter((ns) => ns.slug === slug);
  if (match.length === 0) {
    throw new Error(`${slug} is not a configured skills provider namespace you can read.`);
  }
  return match;
}

/**
 * Everyone a release-all covers in one namespace: each visible teammate
 * (teammates sharing the same keys count once) plus each skill folder no
 * visible teammate claims, addressed by its folder key.
 */
export async function releaseAllTeammates(
  db: TenantScopeAwareDatabase,
  userId: UserID,
  provider: KnowledgeSkillProvider,
  namespace: KnowledgeNamespace
): Promise<SkillTeammate[]> {
  const branches = await new BranchRepository(db).findTeammateBranches({
    archived: false,
    userId,
    minimumPermission: 'view',
    limit: RELEASE_ALL_TEAMMATE_LIMIT,
  });
  const teammates = new Map<string, SkillTeammate>();
  for (const branch of branches) {
    const teammate = skillTeammateOf(branch);
    if (teammate) teammates.set([...teammate.keys].sort().join('|'), teammate);
  }
  const claimed = new Set([...teammates.values()].flatMap((teammate) => teammate.keys));
  const folders = new Set(
    (await provider.listNamespace(namespace)).flatMap((skill) =>
      skill.assignment.kind === 'teammate' ? [skill.assignment.key] : []
    )
  );
  for (const folder of folders) {
    if (!claimed.has(folder)) teammates.set(folder, { name: folder, keys: [folder] });
  }
  return [...teammates.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function outcomeResult(
  outcome: ReleaseOutcome,
  teammate: SkillTeammate,
  authorizedAs: 'curator' | 'admin'
): ReleaseResult {
  const base = {
    namespace: outcome.record.namespace.slug,
    teammate: teammate.name,
    path: outcome.record.path,
    authorized_as: authorizedAs,
  };
  if (outcome.status === 'released') {
    return {
      ...base,
      status: 'released',
      release: outcome.manifest.release,
      previous_release: outcome.manifest.release > 1 ? outcome.manifest.release - 1 : null,
      skills: outcome.manifest.skills.length,
      manifest_version_number: outcome.record.document?.current_version?.version_number,
    };
  }
  if (outcome.status === 'unchanged') {
    return {
      ...base,
      status: 'unchanged',
      release: outcome.record.manifest?.release,
      skills: outcome.record.manifest?.skills.length,
      reason: 'every pinned skill is already at its current version',
    };
  }
  return { ...base, status: 'skipped', reason: outcome.reason };
}

export async function runReleases(input: {
  provider: KnowledgeSkillProvider;
  namespaces: KnowledgeNamespace[];
  /** One teammate, or every teammate per namespace when null. */
  teammate: SkillTeammate | null;
  listAllTeammates: (namespace: KnowledgeNamespace) => Promise<SkillTeammate[]>;
  authorize: (namespace: KnowledgeNamespace) => ReleaseAuthorization;
  actor: string;
  expectedVersion?: number | string;
  /** Attribution for the manifest write (session, teammate). */
  writeParams?: Record<string, unknown>;
}): Promise<ReleaseRunResult> {
  const sets = new SkillSets(input.provider);
  const results: ReleaseResult[] = [];
  for (const namespace of input.namespaces) {
    const auth = input.authorize(namespace);
    if (!auth.allowed) {
      results.push({
        namespace: namespace.slug,
        teammate: input.teammate?.name ?? '*',
        status: 'denied',
        reason: auth.reason,
      });
      continue;
    }
    const teammates = input.teammate ? [input.teammate] : await input.listAllTeammates(namespace);
    for (const teammate of teammates) {
      try {
        const plan = await sets.plan(namespace, teammate, {
          actor: input.actor,
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
        });
        results.push(outcomeResult(await sets.commit(plan, input.writeParams), teammate, auth.as));
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        results.push({
          namespace: namespace.slug,
          teammate: teammate.name,
          status: code === 409 ? 'conflict' : code === 403 ? 'denied' : 'error',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const counts = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  const failed = results.some((result) => ['denied', 'conflict', 'error'].includes(result.status));
  return { counts, results, failed };
}
