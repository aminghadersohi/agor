import type {
  KnowledgeDocumentID,
  KnowledgeDocumentVersionID,
  KnowledgeNamespaceID,
} from './knowledge';
import type { TeammateSkillOrigin } from './teammate-skills';

/**
 * Skills provider: where shared, versioned skills come from.
 *
 * v1 has one provider, Knowledge. A Knowledge namespace is a provider only when
 * the daemon config lists it under `skills.providers`; nothing stored in
 * Knowledge can make a namespace one. Inside it, `kind: skill` documents are
 * assigned by path:
 *
 * - `skills/<teammate key>/…` belongs to that teammate (keys as in
 *   `teammate-skills`: slug tokens of the display name plus the full slug);
 * - `skills/_shared/…` belongs to every teammate.
 *
 * Other kinds and `README.md` files are never skills.
 */

/** Folder under which provider skills live. */
export const SKILLS_ROOT = 'skills' as const;

/** Folder whose skills go to every teammate. */
export const SKILLS_SHARED_FOLDER = '_shared' as const;

/** Provider id of the Knowledge provider. */
export const KNOWLEDGE_SKILL_PROVIDER_ID = 'knowledge' as const;

/** Agent Skills limits: `name` is kebab-case of at most 64, `description` at most 1024 characters. */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `metadata.version`: one token such as `1.2.0` or `2026.10-rc1`. */
export const SKILL_VERSION_MAX_LENGTH = 32;

/** Origin + id; never a bare name, since two providers may share one. */
export interface SkillRef {
  provider: string;
  /** Knowledge document id for the Knowledge provider. */
  id: string;
}

/** One immutable version of a skill, identified by version id and content hash. */
export interface PinnedSkill extends SkillRef {
  version_id: KnowledgeDocumentVersionID;
  version_number: number;
  sha256: string;
}

/** Fields an Agent Skills frontmatter block may carry, as Agor reads them. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** `metadata.version`: the author's human version, not the pin. */
  version?: string;
  license?: string;
  compatibility?: string;
  /** `metadata.agor.origin` (or `metadata.origin`) for vendored skills. */
  origin?: TeammateSkillOrigin;
}

/** Who a provider skill is for, read from its path. */
export type SkillAssignment = { kind: 'shared' } | { kind: 'teammate'; key: string };

export interface SkillSummary {
  ref: SkillRef;
  /** Frontmatter `name`, or the file stem when the frontmatter has none. */
  name: string;
  description?: string;
  /** Frontmatter `metadata.version`. */
  version?: string;
  license?: string;
  origin?: TeammateSkillOrigin;
  assignment: SkillAssignment;
  namespace_id: KnowledgeNamespaceID;
  namespace_slug: string;
  path: string;
  document_id: KnowledgeDocumentID;
  /** Current published version. */
  version_id: KnowledgeDocumentVersionID;
  version_number: number;
  sha256: string;
  /** Problems with the frontmatter; the skill still lists, by its file stem. */
  issues?: string[];
}

export interface SkillContent extends SkillSummary {
  /** Markdown after the frontmatter block. */
  body: string;
  /** Whole document, frontmatter included; `sha256` is its hash. */
  content: string;
  frontmatter: Record<string, unknown> | null;
}

export interface SkillVersion {
  version_id: KnowledgeDocumentVersionID;
  version_number: number;
  sha256: string;
  created_at?: string;
  change_summary?: string | null;
}

export interface SkillVerification {
  pinned: PinnedSkill;
  /** Hash of the stored content of the pinned version, recomputed now. */
  actual_sha256: string | null;
  /** `ok` when the recomputed hash equals the pin; `missing` when the version is gone or unreadable. */
  status: 'ok' | 'hash_mismatch' | 'missing';
  namespace_slug?: string;
  path?: string;
  license?: string;
  origin?: TeammateSkillOrigin;
}

export interface SkillListQuery {
  /**
   * Teammate folder keys. When set, only skills under `skills/<key>/` for one
   * of these keys plus `skills/_shared/` are listed; when omitted, every skill.
   */
  teammateKeys?: readonly string[];
}

/** `latest` = current published version; otherwise a version number or version id. */
export type SkillVersionSelector = 'latest' | number | string;

export interface SkillProvider {
  /** `knowledge`; later `git:<owner/repo>`, `mcp:<server>`, … */
  readonly id: string;
  list(query?: SkillListQuery): Promise<SkillSummary[]>;
  /** The pinned version for a {@link PinnedSkill}, the current one for a bare ref. */
  get(ref: SkillRef | PinnedSkill): Promise<SkillContent>;
  versions(ref: SkillRef): Promise<SkillVersion[]>;
  pin(ref: SkillRef, selector?: SkillVersionSelector): Promise<PinnedSkill>;
  verify(pinned: PinnedSkill): Promise<SkillVerification>;
}

/**
 * Skill sets: a frozen, numbered release of one teammate's skills.
 *
 * Each teammate has one `kind: bundle` manifest per provider namespace, at
 * `skillsets/<teammate key>.md`. Its frontmatter pins every skill by document,
 * version and sha256. A new release is a new Knowledge version of the same
 * document with `release` + 1, written with `expected_version` so concurrent
 * releases conflict instead of overwriting each other. Editing a skill changes
 * nothing for sessions until the next release.
 */
export const SKILLSETS_ROOT = 'skillsets' as const;

/** Bounds shared by manifest reading and writing; a release that exceeds them is refused. */
export const MAX_SKILLSET_SKILLS = 150;
export const MAX_SKILLSET_MANIFEST_BYTES = 48 * 1024;

export interface SkillSetEntry {
  /** Frontmatter `name` at release time. */
  name: string;
  /** Frontmatter `metadata.version` at release time. */
  version?: string;
  document_id: KnowledgeDocumentID;
  path: string;
  version_id: KnowledgeDocumentVersionID;
  version_number: number;
  sha256: string;
}

export interface SkillSetManifest {
  /** Skill set name: the teammate key, e.g. `fritz`. */
  name: string;
  /** Teammate display name at release time. */
  teammate: string;
  /** Monotonic release number, starting at 1. */
  release: number;
  /** ISO timestamp of the release. */
  created_at: string;
  /** User who cut the release. */
  created_by: string;
  skills: SkillSetEntry[];
}

/**
 * - `current`: the pinned version is the skill's current version and its hash matches.
 * - `update_available`: a newer version of the skill exists.
 * - `missing`: the document or pinned version is gone, archived, or unreadable.
 * - `hash_mismatch`: the stored content of the pinned version no longer hashes to the pin.
 */
export const SKILL_PIN_STATUSES = [
  'current',
  'update_available',
  'missing',
  'hash_mismatch',
] as const;
export type SkillPinStatus = (typeof SKILL_PIN_STATUSES)[number];

export interface SkillSetEntryStatus extends SkillSetEntry {
  status: SkillPinStatus;
  /** Current version number of the skill, when it is still readable. */
  latest_version_number?: number;
  /** Frontmatter `metadata.version` of the current version. */
  latest_version?: string;
}

/** `session.custom_context` key of the skills receipt. Server-managed. */
export const SESSION_SKILLS_RECEIPT_KEY = 'skills_receipt' as const;

/**
 * What a session on a teammate branch was given at start: one skill set
 * release, by manifest version, with the exact pins. Written once by the
 * daemon on the first task that delivers an index; later tasks in the same
 * session keep this release even after a newer one is cut.
 */
export interface SessionSkillsReceipt {
  teammate: string;
  release: number;
  /** Provider namespace slug. */
  namespace: string;
  /** `skillsets/<key>.md`. */
  skillset_path: string;
  manifest_document_id: KnowledgeDocumentID;
  manifest_version_id: KnowledgeDocumentVersionID;
  skills: Array<{ name: string; version_id: KnowledgeDocumentVersionID; sha256: string }>;
  /** ISO timestamp of the first delivery. */
  delivered_at: string;
  /** Agentic tool that received the index (`claude-code`, `codex`, `gemini`, …). */
  harness: string;
  /** Pinned skills left out of the index because they were missing or failed verification. */
  omitted?: number;
}
