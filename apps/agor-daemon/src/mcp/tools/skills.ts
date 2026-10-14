import type {
  Branch,
  BranchID,
  Params,
  SkillContent,
  SkillSetEntry,
  SkillSummary,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  KnowledgeSkillProvider,
  sha256Hex,
  summaryOf,
} from '../../skills/knowledge-skill-provider.js';
import { releaseAllTeammates, releaseNamespaces, runReleases } from '../../skills/release.js';
import { renderProvenanceHeader, skillIndexEntry, skillProvenance } from '../../skills/render.js';
import { curatorAuthorization, type SkillSetRecord, SkillSets } from '../../skills/skillsets.js';
import {
  resolveSkillTeammate,
  type SkillTeammate,
  skillTeammateOf,
} from '../../skills/teammate.js';
import { mcpOptionalId, mcpOptionalNonBlankString } from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

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
          'Teammate display name, folder key (e.g. "fritz"), or branch id. Defaults to the calling session\'s teammate.'
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
          // A pinned skill is served at its pin or not at all.
          try {
            skill = await provider.get({
              provider: provider.id,
              id,
              version_id: pin.entry.version_id,
              version_number: pin.entry.version_number,
              sha256: pin.entry.sha256,
            });
          } catch {
            throw new Error(
              `The version ${releaseLabel(pin.record)} pins is unavailable. Pass version: 'latest' to read the current one.`
            );
          }
          if (sha256Hex(skill.content) !== pin.entry.sha256) {
            throw new Error(
              `The content of the version ${releaseLabel(pin.record)} pins no longer matches its sha256; it was not returned.`
            );
          }
          selectedBy = releaseLabel(pin.record);
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
        const record = await sets.find(namespace, teammate);
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
        "Cut a new frozen skill set release: pin the current published version of every skill assigned to the teammate (or to every teammate with all:true) in a skills provider namespace, as release N+1 of skillsets/<teammate>.md. Only the curator session may call this: a session whose branch is the provider's configured curator_branch_id. Admins cut releases (including the first) with `agor skills release` outside any session. A release that would pin exactly what the current one pins is reported as unchanged. Concurrent releases conflict instead of overwriting.",
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
      const session = ctx.authenticatedSession;
      const callerTeammate = caller.branch ? skillTeammateOf(caller.branch) : null;
      const run = await runReleases({
        provider,
        namespaces,
        teammate: single,
        listAllTeammates: (namespace) =>
          runWithMcpTenantDatabaseScope(ctx, (db) =>
            releaseAllTeammates(db, ctx.userId, provider, namespace)
          ),
        authorize: (namespace) =>
          curatorAuthorization(
            provider.providerFor(namespace.slug),
            caller.branch?.branch_id,
            caller.verified
          ),
        actor: ctx.userId,
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        writeParams: session
          ? {
              knowledgeWriteAttribution: {
                sessionId: session.session_id,
                agenticTool: session.agentic_tool,
                ...(callerTeammate ? { teammateName: callerTeammate.name } : {}),
              },
            }
          : {},
      });
      return {
        ...textResult({ counts: run.counts, results: run.results }),
        ...(run.failed ? { isError: true } : {}),
      };
    }
  );
}
