/**
 * The teammate a skills request is about: its display name and folder keys
 * (`teammateSkillKeys`, shared with the Skills panel).
 */

import { BranchRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import {
  type Branch,
  type BranchID,
  getTeammateConfig,
  toShortId,
  type UserID,
} from '@agor/core/types';
import { slugify, teammateSkillKeys } from '../teammate-skills/assign.js';

/** Teammate branches read when resolving a teammate by name. */
const TEAMMATE_LOOKUP_LIMIT = 500;

export interface SkillTeammate {
  /** Display name, or the requested name when no teammate branch matched. */
  name: string;
  /** Folder keys: slug tokens of the name plus the full slug. */
  keys: string[];
  /** Teammate branch, when the request resolved to one. */
  branch_id?: BranchID;
}

export function skillTeammateOf(branch: Branch): SkillTeammate | null {
  const config = getTeammateConfig(branch);
  if (!config) return null;
  const name = config.displayName?.trim() || branch.name;
  return { name, keys: teammateSkillKeys(name), branch_id: branch.branch_id };
}

/**
 * A teammate by branch id (or short id), display name, or folder key, among
 * the teammate branches `userId` can view. Falls back to the slug of `query`
 * as a bare folder key, so a provider folder with no teammate branch yet
 * (or one the caller cannot see) is still addressable.
 */
export async function resolveSkillTeammate(
  db: TenantScopeAwareDatabase,
  query: string,
  userId: UserID
): Promise<SkillTeammate> {
  const trimmed = query.trim();
  const slug = slugify(trimmed);
  if (!slug) throw new Error('teammate must be a teammate name, folder key, or branch id');
  const branches = await new BranchRepository(db).findTeammateBranches({
    userId,
    minimumPermission: 'view',
    limit: TEAMMATE_LOOKUP_LIMIT,
  });
  const teammates = branches
    .map((branch) => skillTeammateOf(branch))
    .filter((teammate): teammate is SkillTeammate => teammate !== null);
  // Full or short (prefix) branch id; a prefix two teammates share is refused, not guessed.
  const idPrefix = /^[0-9a-f-]{8,}$/i.test(trimmed) ? toShortId(trimmed.toLowerCase(), 32) : null;
  if (idPrefix) {
    const byId = teammates.filter((teammate) =>
      toShortId(teammate.branch_id as string, 32).startsWith(idPrefix)
    );
    if (byId.length > 1) {
      throw new Error(`Branch id "${trimmed}" matches several teammates; use a longer id.`);
    }
    if (byId.length === 1) return byId[0];
  }
  const byName = teammates.find((teammate) => slugify(teammate.name) === slug);
  if (byName) return byName;
  const byKey = teammates.find((teammate) => teammate.keys.includes(slug));
  if (byKey) return byKey;
  return { name: trimmed, keys: [slug] };
}
