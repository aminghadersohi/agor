/**
 * Pure assembly of a teammate's skills view from already-loaded inputs.
 *
 * The route gathers Knowledge documents, the worktree scan, peer scans and
 * the last harness report; this module only merges them, so every rule the
 * panel shows (source, pin, drift, gap closure) is unit-testable without a
 * database or filesystem.
 */

import { frontmatterString, parseMarkdownFrontmatter } from '@agor/core/knowledge';
import type {
  BranchID,
  BranchSkillFile,
  KnowledgeDocumentID,
  KnowledgeDocumentVersionID,
  TeammateSkill,
  TeammateSkillGap,
  TeammateSkillGapList,
  TeammateSkillGapPriority,
  TeammateSkillOrigin,
} from '@agor/core/types';
import { TEAMMATE_SKILL_GAP_PRIORITIES } from '@agor/core/types';

export interface KnowledgeSkillInput {
  document_id: KnowledgeDocumentID;
  path: string;
  uri: string;
  url?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
  version_id?: KnowledgeDocumentVersionID | null;
  version_number?: number | null;
  content_sha256?: string | null;
  content: string;
}

export interface PeerSkillsInput {
  branch_id: BranchID;
  name: string;
  skills: Array<Pick<BranchSkillFile, 'name' | 'sha256'>>;
}

export interface HarnessSkillsInput {
  skills: string[];
  at?: string;
}

export interface GapsDocInput {
  uri: string;
  url?: string | null;
  content: string;
}

export interface AssembleTeammateSkillsInput {
  knowledge: KnowledgeSkillInput[];
  inRepo: BranchSkillFile[];
  /** `null` when drift was not computed; an empty array means no other readable teammate. */
  peers: PeerSkillsInput[] | null;
  harness: HarnessSkillsInput | null;
  gapsDoc: GapsDocInput | null;
}

export interface AssembledTeammateSkills {
  skills: TeammateSkill[];
  gaps: TeammateSkillGapList;
}

/** Skill names compare case-insensitively; a harness name may carry a `plugin:` prefix. */
export function skillKey(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const colon = trimmed.lastIndexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * `metadata.agor.origin`, also accepted as `metadata.origin`, from the skill's
 * frontmatter first and then the Knowledge document's metadata column.
 */
export function readSkillOrigin(
  ...sources: Array<Record<string, unknown> | null | undefined>
): TeammateSkillOrigin | undefined {
  for (const source of sources) {
    const metadata = asRecord(source?.metadata) ?? undefined;
    const candidates = [asRecord(asRecord(metadata?.agor)?.origin), asRecord(metadata?.origin)];
    // The document metadata column may hold the `agor` block at its top level.
    candidates.push(asRecord(asRecord(source?.agor)?.origin));
    for (const raw of candidates) {
      if (!raw) continue;
      const origin: TeammateSkillOrigin = {
        provider: nonEmptyString(raw.provider),
        uri: nonEmptyString(raw.uri),
        commit: nonEmptyString(raw.commit),
        license: nonEmptyString(raw.license),
        reviewed_by: nonEmptyString(raw.reviewed_by),
        reviewed_at: nonEmptyString(raw.reviewed_at),
      };
      if (Object.values(origin).some(Boolean)) return origin;
    }
  }
  return undefined;
}

/** `owner/repo@1a2b3c4` for a GitHub origin, otherwise the best short label available. */
export function vendorPinLabel(origin: TeammateSkillOrigin): string {
  const shortCommit = origin.commit?.slice(0, 7);
  const repo = origin.uri?.match(/github\.com\/([^/\s]+\/[^/\s#?]+)/i)?.[1]?.replace(/\.git$/, '');
  if (repo) return shortCommit ? `${repo}@${shortCommit}` : repo;
  if (shortCommit) return `${origin.provider ?? 'commit'}@${shortCommit}`;
  return origin.provider ?? 'vendored';
}

function nameFromKnowledgePath(docPath: string): string {
  const segments = docPath.split('/').filter(Boolean);
  const last = segments.at(-1) ?? docPath;
  if (last.toLowerCase() === 'skill.md' && segments.length > 1) return segments.at(-2) as string;
  return last.replace(/\.md$/i, '');
}

function knowledgeSkill(doc: KnowledgeSkillInput): TeammateSkill {
  const frontmatter = parseMarkdownFrontmatter(doc.content);
  const name = frontmatterString(frontmatter, 'name', 200) ?? nameFromKnowledgePath(doc.path);
  const origin = readSkillOrigin(frontmatter, doc.metadata);
  const common = {
    name,
    description: frontmatterString(frontmatter, 'description'),
    path: doc.path,
    uri: doc.uri,
    url: doc.url ?? undefined,
    sha256: doc.content_sha256 ?? undefined,
    document_id: doc.document_id,
    version_id: doc.version_id ?? undefined,
    version_number: doc.version_number ?? undefined,
  };
  if (origin) {
    return {
      ...common,
      source: 'vendor',
      status: origin.reviewed_by ? 'reviewed' : 'unreviewed',
      version_label: vendorPinLabel(origin),
      updated_at: origin.reviewed_at ?? doc.updated_at ?? undefined,
      origin,
    };
  }
  return {
    ...common,
    source: 'knowledge',
    status: 'ok',
    version_label: doc.version_number ? `v${doc.version_number}` : 'unversioned',
    updated_at: doc.updated_at ?? undefined,
  };
}

function inRepoSkill(file: BranchSkillFile, peers: PeerSkillsInput[] | null): TeammateSkill {
  const skill: TeammateSkill = {
    name: file.name,
    source: 'in-repo',
    status: 'ok',
    description: file.description,
    path: file.path,
    sha256: file.sha256,
    version_label: `sha ${file.sha256.slice(0, 7)}`,
    updated_at: file.mtime,
  };
  if (!peers) return skill;

  const key = skillKey(file.name);
  const shas = new Set([file.sha256]);
  const sharedWith: NonNullable<TeammateSkill['drift']>['shared_with'] = [];
  for (const peer of peers) {
    for (const peerSkill of peer.skills) {
      if (skillKey(peerSkill.name) !== key) continue;
      shas.add(peerSkill.sha256);
      sharedWith.push({ branch_id: peer.branch_id, name: peer.name, sha256: peerSkill.sha256 });
    }
  }
  return {
    ...skill,
    status: shas.size > 1 ? 'drift' : 'same',
    drift: { variants: shas.size, shared_with: sharedWith },
  };
}

function parsePriority(value: unknown): TeammateSkillGapPriority {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return (TEAMMATE_SKILL_GAP_PRIORITIES as readonly string[]).includes(upper)
    ? (upper as TeammateSkillGapPriority)
    : 'P2';
}

/** Parse `skills/_gaps.md` and mark each gap closed when an equipped skill has its name. */
export function parseSkillGaps(
  doc: GapsDocInput | null,
  equippedNames: Iterable<string>
): TeammateSkillGapList {
  if (!doc) return { status: 'missing', items: [] };
  const base = { uri: doc.uri, url: doc.url ?? undefined };
  const frontmatter = parseMarkdownFrontmatter(doc.content);
  const raw = frontmatter?.gaps;
  if (!Array.isArray(raw)) {
    return {
      ...base,
      status: 'invalid',
      items: [],
      error: frontmatter
        ? 'The frontmatter has no `gaps` list.'
        : 'The document has no YAML frontmatter.',
    };
  }

  const equipped = new Set([...equippedNames].map(skillKey));
  const items: TeammateSkillGap[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const skill = nonEmptyString(record?.skill);
    if (!record || !skill) continue;
    items.push({
      skill,
      priority: parsePriority(record.priority),
      source: nonEmptyString(record.source),
      note: nonEmptyString(record.note),
      closed: equipped.has(skillKey(skill)),
    });
  }
  items.sort(
    (a, b) =>
      Number(a.closed) - Number(b.closed) ||
      a.priority.localeCompare(b.priority) ||
      a.skill.localeCompare(b.skill)
  );
  return { ...base, status: 'ok', items };
}

export function assembleTeammateSkills(
  input: AssembleTeammateSkillsInput
): AssembledTeammateSkills {
  const skills: TeammateSkill[] = [
    ...input.knowledge.map(knowledgeSkill),
    ...input.inRepo.map((file) => inRepoSkill(file, input.peers)),
  ];

  // The harness reports names only; list the ones no other source explains.
  const known = new Set(skills.map((skill) => skillKey(skill.name)));
  for (const name of input.harness?.skills ?? []) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = skillKey(name);
    if (known.has(key)) continue;
    known.add(key);
    skills.push({
      name: name.trim(),
      source: 'harness',
      status: 'synced',
      version_label: 'loaded last run',
      updated_at: input.harness?.at,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  return {
    skills,
    gaps: parseSkillGaps(
      input.gapsDoc,
      skills.map((skill) => skill.name)
    ),
  };
}
