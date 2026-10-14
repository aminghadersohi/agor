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
 *   another teammate's folder.
 *
 * So a shared namespace that is also one teammate's primary namespace shows
 * that teammate only its own folder and its unfoldered skills.
 */

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
}

/** The documents that belong to the teammate, deduplicated by document id, input order kept. */
export function assignTeammateSkillDocs<T extends SkillDocRef>(
  docs: Iterable<T>,
  context: SkillAssignmentContext
): T[] {
  const own = new Set(context.ownKeys);
  // A key both teammates share stays assignable through the owner's own folder rule.
  const others = new Set([...context.otherKeys].filter((key) => !own.has(key)));
  const seen = new Set<string>();
  const assigned: T[] = [];
  for (const doc of docs) {
    if (seen.has(doc.document_id)) continue;
    const folder = skillFolder(doc.path);
    const inOwnFolder = folder !== undefined && own.has(folder);
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
