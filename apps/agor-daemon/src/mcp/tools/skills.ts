/**
 * Skills tools (knowledge domain): discover and fetch skills from skills
 * provider namespaces, and read or cut skill set releases. See
 * `skills/knowledge-skill-provider.ts` and `skills/skillsets.ts`.
 */

import { BranchRepository } from '@agor/core/db';
import type {
  Branch,
  BranchID,
  KnowledgeNamespace,
  Params,
  SkillContent,
  SkillSetEntry,
  SkillSummary,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { KnowledgeSkillProvider, summaryOf } from '../../skills/knowledge-skill-provider.js';
import { renderProvenanceHeader, skillIndexEntry, skillProvenance } from '../../skills/render.js';
import {
  type ReleaseOutcome,
  releaseAuthorization,
  type SkillSetRecord,
  SkillSets,
} from '../../skills/skillsets.js';
import {
  resolveSkillTeammate,
  type SkillTeammate,
  skillTeammateOf,
} from '../../skills/teammate.js';
import { mcpOptionalId, mcpOptionalNonBlankString } from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

/** Teammate branches read when releasing for every teammate. */
const RELEASE_ALL_TEAMMATE_LIMIT = 500;

function providerFor(ctx: McpContext): KnowledgeSkillProvider {
  return new KnowledgeSkillProvider(ctx.app, ctx.baseServiceParams as Params);
}

/**
 * The calling session's branch. `verified` is true only for the
 * authenticated session identity; a claimed `sessionId` is not.
 */
async function callerBranch(
  ctx: McpContext
): Promise<{ branch: Branch | null; verified: boolean }> {
  const verifiedId = ctx.authenticatedSession?.branch_id;
  let branchId: BranchID | undefined = verifiedId;
  if (!branchId && ctx.sessionId) {
    const session = (await ctx.app
      .service('sessions')
      .get(ctx.sessionId, ctx.baseServiceParams)) as { branch_id?: BranchID };
    branchId = session.branch_id;
  }
  if (!branchId) return { branch: null, verified: false };
  const branch = (await ctx.app.service('branches').get(branchId, ctx.baseServiceParams)) as Branch;
  return { branch, verified: !!verifiedId };
}

/** The calling session's teammate, or null for a non-teammate (or no) session. */
export async function callerSkillTeammate(ctx: McpContext): Promise<SkillTeammate | null> {
  const { branch } = await callerBranch(ctx);
  return branch ? skillTeammateOf(branch) : null;
}

/** `teammate` when given, else the caller's teammate (null when neither). */
async function requestedTeammate(
  ctx: McpContext,
  teammate: string | undefined
): Promise<SkillTeammate | null> {
  if (teammate) {
    return runWithMcpTenantDatabaseScope(ctx, (db) =>
      resolveSkillTeammate(db, teammate, ctx.userId)
    );
  }
  return callerSkillTeammate(ctx);
}

/**
 * The one skill named `name`: among the teammate's skills first, then every
 * provider skill. Several matches is an error that lists them.
 */
async function findSkillByName(
  provider: KnowledgeSkillProvider,
  name: string,
  teammate: SkillTeammate | null
): Promise<SkillSummary> {
  const wanted = name.trim().toLowerCase();
  const scopes = teammate ? [{ teammateKeys: teammate.keys }, undefined] : [undefined];
  for (const scope of scopes) {
    const matches = (await provider.list(scope)).filter(
      (skill) => skill.name.toLowerCase() === wanted
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const where = matches.map((skill) => `${skill.namespace_slug}/${skill.path}`).join(', ');
      throw new Error(
        `Several skills are named "${name}" (${where}); pass documentId to pick one.`
      );
    }
  }
  throw new Error(
    `No skill named "${name}"${teammate ? ` for ${teammate.name}` : ''} in a skills provider namespace you can read. Use agor_skills_list to see what exists.`
  );
}

/** The teammate's skill set record in every readable provider namespace. */
async function teammateSkillSets(
  provider: KnowledgeSkillProvider,
  teammate: SkillTeammate
): Promise<SkillSetRecord[]> {
  const sets = new SkillSets(provider);
  const records: SkillSetRecord[] = [];
  for (const namespace of await provider.providerNamespaces()) {
    records.push(await sets.find(namespace, teammate));
  }
  return records;
}

/** Pins of every release in `records`, by document id. */
function pinsByDocument(
  records: SkillSetRecord[]
): Map<string, { entry: SkillSetEntry; record: SkillSetRecord }> {
  const pins = new Map<string, { entry: SkillSetEntry; record: SkillSetRecord }>();
  for (const record of records) {
    for (const entry of record.manifest?.skills ?? []) {
      pins.set(entry.document_id, { entry, record });
    }
  }
  return pins;
}

function releaseLabel(record: SkillSetRecord): string {
  return `release r${record.manifest?.release} (${record.namespace.slug}/${record.path})`;
}

function releaseSummary(record: SkillSetRecord) {
  return {
    namespace: record.namespace.slug,
    path: record.path,
    release: record.manifest?.release ?? null,
    ...(record.document
      ? {
          document_id: record.document.document_id,
          manifest_version_number: record.document.current_version?.version_number,
          manifest_version_id: record.document.current_version?.version_id,
        }
      : {}),
    ...(record.manifest
      ? { created_at: record.manifest.created_at, created_by: record.manifest.created_by }
      : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

/** Provider namespaces to release in: all readable ones, or the one named. */
async function releaseNamespaces(
  provider: KnowledgeSkillProvider,
  slug: string | undefined
): Promise<KnowledgeNamespace[]> {
  const namespaces = await provider.providerNamespaces();
  if (!slug) return namespaces;
  const match = namespaces.filter((ns) => ns.slug === slug);
  if (match.length === 0) {
    throw new Error(`${slug} is not a skills provider namespace you can read.`);
  }
  return match;
}

/**
 * Everyone a release-all covers in one namespace: each visible teammate
 * (teammates sharing the same keys count once) plus each skill folder no
 * visible teammate claims, addressed by its folder key.
 */
async function releaseAllTeammates(
  ctx: McpContext,
  provider: KnowledgeSkillProvider,
  namespace: KnowledgeNamespace
): Promise<SkillTeammate[]> {
  const branches = await runWithMcpTenantDatabaseScope(ctx, (db) =>
    new BranchRepository(db).findTeammateBranches({
      archived: false,
      userId: ctx.userId,
      minimumPermission: 'view',
      limit: RELEASE_ALL_TEAMMATE_LIMIT,
    })
  );
  const teammates = new Map<string, SkillTeammate>();
  for (const branch of branches) {
    const teammate = skillTeammateOf(branch);
    if (teammate) teammates.set([...teammate.keys].sort().join('|'), teammate);
  }
  const claimed = new Set([...teammates.values()].flatMap((teammate) => teammate.keys));
  const folders = new Set(
    (await provider.list())
      .filter((skill) => skill.namespace_id === namespace.namespace_id)
      .flatMap((skill) => (skill.assignment.kind === 'teammate' ? [skill.assignment.key] : []))
  );
  for (const folder of folders) {
    if (!claimed.has(folder)) teammates.set(folder, { name: folder, keys: [folder] });
  }
  return [...teammates.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface ReleaseResult {
  namespace: string;
  teammate: string;
  path?: string;
  status: 'released' | 'unchanged' | 'skipped' | 'denied' | 'conflict' | 'error';
  release?: number;
  previous_release?: number | null;
  skills?: number;
  authorized_as?: 'curator' | 'bootstrap';
  manifest_version_number?: number;
  reason?: string;
}

function outcomeResult(
  outcome: ReleaseOutcome,
  teammate: SkillTeammate,
  authorizedAs: 'curator' | 'bootstrap'
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

export function registerSkillTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_skills_list',
    {
      description:
        "List a teammate's skills: the compact index (name, version, short description, provenance, documentId) of the Knowledge skills assigned to it in skills provider namespaces (`skills/<teammate>/…` plus `skills/_shared/…`), with the version its latest skill set release pins. Defaults to the calling session's teammate; outside a teammate session with no `teammate`, lists every provider skill. Fetch a body with agor_skills_get.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        teammate: mcpOptionalNonBlankString(
          'teammate',
          'Teammate display name, folder key (e.g. "frink"), or branch id. Defaults to the calling session\'s teammate.'
        ),
      }),
    },
    async (args) => {
      const teammate = await requestedTeammate(ctx, coerceString(args.teammate));
      const provider = providerFor(ctx);
      const [namespaces, skills, records] = await Promise.all([
        provider.providerNamespaces(),
        provider.list(teammate ? { teammateKeys: teammate.keys } : undefined),
        teammate ? teammateSkillSets(provider, teammate) : Promise.resolve([]),
      ]);
      const pins = pinsByDocument(records);
      return textResult({
        teammate: teammate ? { name: teammate.name, keys: teammate.keys } : null,
        provider_namespaces: namespaces.map((ns) => ns.slug),
        releases: records.filter((record) => record.manifest).map(releaseSummary),
        count: skills.length,
        skills: skills.map((skill) => {
          const pin = pins.get(skill.document_id);
          return {
            ...skillIndexEntry(skill),
            pinned_version_number: pin?.entry.version_number ?? null,
          };
        }),
        ...(namespaces.length === 0
          ? {
              note: 'No skills provider is configured that you can read. An operator lists trusted provider namespaces under `skills.providers` in config.yaml.',
            }
          : {}),
      });
    }
  );

  server.registerTool(
    'agor_skills_get',
    {
      description:
        "Get one skill from a skills provider namespace by name or documentId: the markdown body after its frontmatter, with a provenance header (namespace, path, version number, sha256, license/origin). Returns the version the calling teammate's latest skill set release pins, else the current version, unless `version` is given. Read the skill before doing the kind of task it covers.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        name: mcpOptionalNonBlankString(
          'name',
          "Skill name from agor_skills_list. Matched among the calling teammate's skills first."
        ),
        documentId: mcpOptionalId('documentId', 'Knowledge skill document'),
        version: z
          .union([z.number().int().positive(), z.string().min(1)])
          .optional()
          .describe('Version number or version id. Omit for the pinned (or current) version.'),
      }),
    },
    async (args) => {
      const name = coerceString(args.name);
      const documentId = coerceString(args.documentId);
      if (!name && !documentId) throw new Error('Provide name or documentId.');
      const provider = providerFor(ctx);
      const teammate = await callerSkillTeammate(ctx);
      const id =
        documentId ?? (await findSkillByName(provider, name as string, teammate)).document_id;
      const version = args.version;

      let skill: SkillContent | undefined;
      let selectedBy = version === undefined ? 'current version' : 'requested version';
      if (version === undefined && teammate) {
        const pin = pinsByDocument(await teammateSkillSets(provider, teammate)).get(id);
        if (pin) {
          try {
            skill = await provider.get({
              provider: provider.id,
              id,
              version_id: pin.entry.version_id,
              version_number: pin.entry.version_number,
              sha256: pin.entry.sha256,
            });
            selectedBy = releaseLabel(pin.record);
          } catch {
            selectedBy = `current version (the version ${releaseLabel(pin.record)} pins is unavailable)`;
          }
        }
      }
      skill ??= await provider.get({ provider: provider.id, id }, version ?? 'latest');
      const provenance = skillProvenance(skill, selectedBy);
      return textResult({
        ...summaryOf(skill),
        provenance,
        content: `${renderProvenanceHeader(skill.name, provenance)}\n\n${skill.body.replace(/^\s+/, '')}`,
      });
    }
  );

  server.registerTool(
    'agor_skillsets_get',
    {
      description:
        "Show a teammate's skill set: the latest frozen release (skillsets/<teammate>.md, kind bundle) in each skills provider namespace, with each pinned skill's status — current, update_available (a newer version exists), missing, or hash_mismatch (the pinned content no longer hashes to the pin) — and the assigned skills no release includes yet. Defaults to the calling session's teammate.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        teammate: mcpOptionalNonBlankString(
          'teammate',
          "Teammate display name, folder key, or branch id. Defaults to the calling session's teammate."
        ),
        namespace: mcpOptionalNonBlankString('namespace', 'Only this provider namespace (slug).'),
      }),
    },
    async (args) => {
      const teammate = await requestedTeammate(ctx, coerceString(args.teammate));
      if (!teammate) throw new Error('Pass teammate, or call from a teammate session.');
      const provider = providerFor(ctx);
      const sets = new SkillSets(provider);
      const skillsets = [];
      for (const namespace of await releaseNamespaces(provider, coerceString(args.namespace))) {
        const assigned = await sets.namespaceSkills(namespace, teammate);
        const record = await sets.find(namespace, teammate, assigned);
        const pinned = new Set(record.manifest?.skills.map((entry) => entry.document_id));
        skillsets.push({
          ...releaseSummary(record),
          skills: record.manifest ? await sets.status(record.manifest) : [],
          unreleased: assigned
            .filter((skill) => !pinned.has(skill.document_id))
            .map((skill) => ({
              name: skill.name,
              path: skill.path,
              document_id: skill.document_id,
              version_number: skill.version_number,
            })),
        });
      }
      return textResult({ teammate: { name: teammate.name, keys: teammate.keys }, skillsets });
    }
  );

  server.registerTool(
    'agor_skillsets_release',
    {
      description:
        'Cut a new frozen skill set release: pin the current published version of every skill assigned to the teammate (or to every teammate with all:true) in each skills provider namespace, as release N+1 of skillsets/<teammate>.md. Curator only: a session on the teammate that owns the provider namespace, or a caller outside a teammate session with own access. While a teammate has no release yet, anyone with write access may cut its r1. A release that would pin exactly what the current one pins is skipped as unchanged. Concurrent releases conflict instead of overwriting.',
      annotations: { idempotentHint: false },
      inputSchema: z.object({
        teammate: mcpOptionalNonBlankString(
          'teammate',
          'Teammate display name, folder key, or branch id.'
        ),
        all: z
          .boolean()
          .optional()
          .describe('Release every teammate with skills in the namespace.'),
        expectedVersion: z
          .union([z.number().int().nonnegative(), z.string().min(1)])
          .optional()
          .describe(
            'Manifest version number (or version id) you last read; 0 = no release may exist yet. Single teammate only.'
          ),
        namespace: mcpOptionalNonBlankString('namespace', 'Only this provider namespace (slug).'),
      }),
    },
    async (args) => {
      const teammateArg = coerceString(args.teammate);
      if (!teammateArg === !args.all) throw new Error('Pass exactly one of teammate or all:true.');
      if (args.all && args.expectedVersion !== undefined) {
        throw new Error('expectedVersion applies to a single teammate, not all:true.');
      }
      const provider = providerFor(ctx);
      const sets = new SkillSets(provider);
      const namespaces = await releaseNamespaces(provider, coerceString(args.namespace));
      if (args.expectedVersion !== undefined && namespaces.length > 1) {
        throw new Error('expectedVersion needs namespace when several provider namespaces exist.');
      }
      const caller = await callerBranch(ctx);
      const single = teammateArg
        ? await runWithMcpTenantDatabaseScope(ctx, (db) =>
            resolveSkillTeammate(db, teammateArg, ctx.userId)
          )
        : null;

      const results: ReleaseResult[] = [];
      for (const namespace of namespaces) {
        const teammates = single ? [single] : await releaseAllTeammates(ctx, provider, namespace);
        for (const teammate of teammates) {
          try {
            const plan = await sets.plan(namespace, teammate, {
              actor: ctx.userId,
              ...(args.expectedVersion !== undefined
                ? { expectedVersion: args.expectedVersion }
                : {}),
            });
            const auth = releaseAuthorization(
              namespace,
              caller.branch,
              !!plan.record.document,
              caller.verified
            );
            if (!auth.allowed) {
              results.push({
                namespace: namespace.slug,
                teammate: teammate.name,
                path: plan.record.path,
                status: 'denied',
                reason: auth.reason,
              });
              continue;
            }
            results.push(outcomeResult(await sets.commit(plan), teammate, auth.as));
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
      const failed = results.some((result) =>
        ['denied', 'conflict', 'error'].includes(result.status)
      );
      const counts = results.reduce<Record<string, number>>((acc, result) => {
        acc[result.status] = (acc[result.status] ?? 0) + 1;
        return acc;
      }, {});
      return {
        ...textResult({ counts, results }),
        ...(failed ? { isError: true } : {}),
      };
    }
  );
}
