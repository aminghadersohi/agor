/**
 * Skills tools (knowledge domain): discover and fetch skills from skills
 * provider namespaces. See `skills/knowledge-skill-provider.ts`.
 */

import type { Branch, BranchID, Params, SkillContent, SkillSummary } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { KnowledgeSkillProvider, summaryOf } from '../../skills/knowledge-skill-provider.js';
import { renderProvenanceHeader, skillIndexEntry, skillProvenance } from '../../skills/render.js';
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

/** The calling session's branch id, preferring the authenticated session identity. */
async function callerBranchId(ctx: McpContext): Promise<BranchID | undefined> {
  if (ctx.authenticatedSession?.branch_id) return ctx.authenticatedSession.branch_id;
  if (!ctx.sessionId) return undefined;
  const session = (await ctx.app.service('sessions').get(ctx.sessionId, ctx.baseServiceParams)) as {
    branch_id?: BranchID;
  };
  return session.branch_id;
}

/** The calling session's teammate, or null for a non-teammate (or no) session. */
export async function callerSkillTeammate(ctx: McpContext): Promise<SkillTeammate | null> {
  const branchId = await callerBranchId(ctx);
  if (!branchId) return null;
  const branch = (await ctx.app.service('branches').get(branchId, ctx.baseServiceParams)) as Branch;
  return skillTeammateOf(branch);
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

export function registerSkillTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_skills_list',
    {
      description:
        "List a teammate's skills: the compact index (name, version, short description, provenance, documentId) of the Knowledge skills assigned to it in skills provider namespaces (`skills/<teammate>/…` plus `skills/_shared/…`). Defaults to the calling session's teammate; outside a teammate session with no `teammate`, lists every provider skill. Fetch a body with agor_skills_get.",
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
      const [namespaces, skills] = await Promise.all([
        provider.providerNamespaces(),
        provider.list(teammate ? { teammateKeys: teammate.keys } : undefined),
      ]);
      return textResult({
        teammate: teammate ? { name: teammate.name, keys: teammate.keys } : null,
        provider_namespaces: namespaces.map((ns) => ns.slug),
        count: skills.length,
        skills: skills.map(skillIndexEntry),
        ...(namespaces.length === 0
          ? {
              note: 'No readable Knowledge namespace has `skills_provider: true` in its metadata.',
            }
          : {}),
      });
    }
  );

  server.registerTool(
    'agor_skills_get',
    {
      description:
        'Get one skill from a skills provider namespace by name or documentId: the markdown body after its frontmatter, with a provenance header (namespace, path, version number, sha256, license/origin). Returns the current version unless `version` is given. Read the skill before doing the kind of task it covers.',
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
          .describe('Version number or version id. Omit for the current version.'),
      }),
    },
    async (args) => {
      const name = coerceString(args.name);
      const documentId = coerceString(args.documentId);
      if (!name && !documentId) throw new Error('Provide name or documentId.');
      const provider = providerFor(ctx);
      const id =
        documentId ??
        (await findSkillByName(provider, name as string, await callerSkillTeammate(ctx)))
          .document_id;
      const version = args.version;
      const skill: SkillContent = await provider.get(
        { provider: provider.id, id },
        version ?? 'latest'
      );
      const provenance = skillProvenance(
        skill,
        version === undefined ? 'current version' : 'requested version'
      );
      return textResult({
        ...summaryOf(skill),
        provenance,
        content: `${renderProvenanceHeader(skill.name, provenance)}\n\n${skill.body.replace(/^\s+/, '')}`,
      });
    }
  );
}
