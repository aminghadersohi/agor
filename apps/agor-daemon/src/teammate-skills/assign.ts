/**
 * Which Knowledge skill documents belong to which teammate.
 *
 * Skills may live in one shared namespace under `skills/<teammate>/…`, or
 * unfoldered in a teammate's own primary namespace. A teammate's *keys* are
 * the slug tokens of its display name plus the full slug ("Professor Frink"
 * → `professor`, `frink`, `professor-frink`), and a folder named after any key
 * is that teammate's.
 *
 * A teammate gets:
 * - every skill under `skills/<own key>/` in any namespace the caller can
 *   read, and
 * - every other skill in its own primary namespace, except those filed under
 *   another teammate's folder, and
 * - every skill under `skills/_shared/` in a skills provider namespace.
 *
 * So a shared namespace that is also one teammate's primary namespace shows
 * that teammate only its own folder and its unfoldered skills.
 */

import { isSkillReadmePath } from '@agor/core/knowledge';
import { SKILLS_SHARED_FOLDER, type SkillAssignment } from '@agor/core/types';

/** Lowercase ASCII slug: accents folded, every other run of non-alphanumerics becomes `-`. */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Folder keys for a teammate name: each slug token plus the full slug. */
export function teammateSkillKeys(name: string): string[] {
  const slug = slugify(name);
  if (!slug) return [];
  return [...new Set([...slug.split('-').filter(Boolean), slug])];
}

/** `frink` for `skills/frink/x.md` or `skills/frink/x/SKILL.md`; undefined for unfoldered paths. */
export function skillFolder(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'skills') return undefined;
  return segments[1].toLowerCase();
}

export interface SkillDocRef {
  document_id: string;
  namespace_id: string;
  path: string;
}

export interface SkillAssignmentContext {
  /** Keys of the teammate whose skills are being listed. */
  ownKeys: Iterable<string>;
  /** Keys of the other teammates the caller can read. */
  otherKeys: Iterable<string>;
  /** The teammate's primary Knowledge namespace, when it has one. */
  primaryNamespaceId?: string | null;
  /** Skills provider namespaces, whose `skills/_shared/` skills go to every teammate. */
  sharedNamespaceIds?: Iterable<string>;
}

/** The documents that belong to the teammate, deduplicated by document id, input order kept. */
export function assignTeammateSkillDocs<T extends SkillDocRef>(
  docs: Iterable<T>,
  context: SkillAssignmentContext
): T[] {
  const own = new Set(context.ownKeys);
  // A key both teammates share stays assignable through the owner's own folder rule.
  const others = new Set([...context.otherKeys].filter((key) => !own.has(key)));
  const shared = new Set(context.sharedNamespaceIds ?? []);
  const seen = new Set<string>();
  const assigned: T[] = [];
  for (const doc of docs) {
    if (seen.has(doc.document_id)) continue;
    const folder = skillFolder(doc.path);
    const inSharedFolder = folder === SKILLS_SHARED_FOLDER && shared.has(doc.namespace_id);
    const inOwnFolder = (folder !== undefined && own.has(folder)) || inSharedFolder;
    const inOwnNamespace =
      !!context.primaryNamespaceId && doc.namespace_id === context.primaryNamespaceId;
    const inOtherFolder = folder !== undefined && others.has(folder);
    if (inOwnFolder || (inOwnNamespace && !inOtherFolder)) {
      seen.add(doc.document_id);
      assigned.push(doc);
    }
  }
  return assigned;
}

/** Gap documents to look for in readable namespaces, one per teammate key. */
export function teammateGapPaths(ownKeys: Iterable<string>): string[] {
  return [...new Set(ownKeys)].map((key) => `skills/${key}/_gaps.md`);
}

/**
 * Who a skill in a skills-provider namespace is for: `skills/_shared/…` →
 * every teammate, `skills/<key>/…` → the teammate with that key. Undefined
 * for unfoldered paths and `README.md` files, which are never provider skills.
 */
export function providerSkillAssignment(path: string): SkillAssignment | undefined {
  const folder = skillFolder(path);
  if (folder === undefined || isSkillReadmePath(path)) return undefined;
  return folder === SKILLS_SHARED_FOLDER ? { kind: 'shared' } : { kind: 'teammate', key: folder };
}

/** True when a provider skill at `path` goes to a teammate with one of `keys`. */
export function providerSkillIsFor(path: string, keys: Iterable<string>): boolean {
  const assignment = providerSkillAssignment(path);
  if (!assignment) return false;
  return assignment.kind === 'shared' || new Set(keys).has(assignment.key);
}
