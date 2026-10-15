/**
 * Governance of skill set manifests.
 *
 * In a configured skills provider namespace (`skills.providers` in
 * config.yaml), everything under `skillsets/` is written only by the release
 * code path: `SkillSets.commit`, reached from `agor_skillsets_release` (the
 * curator session) or the admin-only `skills/releases` route behind
 * `agor skills release`. Every other Knowledge write — put, edit, create,
 * patch, rename or move into or out of `skillsets/`, archive, restore,
 * import — is refused by `KnowledgeDocumentsService`, whoever the caller is.
 *
 * The release path proves itself with {@link SKILLSET_RELEASE_WRITE}, a
 * module-private symbol set on in-process service params. REST, Socket.IO
 * and MCP callers can only send JSON, so they cannot set it.
 */

import { isSkillSetPath } from '@agor/core/knowledge';

const SKILLSET_RELEASE_WRITE: unique symbol = Symbol('agor.skills.skillset-release-write');

type ReleaseWriteParams = { [SKILLSET_RELEASE_WRITE]?: true };

/** Params for the release write. Only `SkillSets.commit` may call this. */
export function withSkillsetReleaseWrite<P extends object>(params: P): P & ReleaseWriteParams {
  return { ...params, [SKILLSET_RELEASE_WRITE]: true as const };
}

export function hasSkillsetReleaseWrite(params: unknown): boolean {
  return (
    !!params &&
    typeof params === 'object' &&
    (params as ReleaseWriteParams)[SKILLSET_RELEASE_WRITE] === true
  );
}

/** Slugs of the configured provider namespaces. */
export function configuredProviderSlugs(config: unknown): Set<string> {
  const providers = (config as { skills?: { providers?: Array<{ namespace?: unknown }> } } | null)
    ?.skills?.providers;
  return new Set(
    (Array.isArray(providers) ? providers : [])
      .map((provider) => provider?.namespace)
      .filter((slug): slug is string => typeof slug === 'string')
  );
}

/** True when `path` in the namespace `slug` is release-only. */
export function isGovernedSkillSetLocation(
  providerSlugs: ReadonlySet<string>,
  slug: string | null | undefined,
  path: string | null | undefined
): boolean {
  return !!slug && providerSlugs.has(slug) && isSkillSetPath(path);
}

export const SKILLSET_GOVERNED_MESSAGE =
  'skillsets/ in a skills provider namespace is written only by skill set releases ' +
  '(agor_skillsets_release from the curator session, or `agor skills release` for an admin).';
