import type {
  KnowledgeDocumentID,
  KnowledgeDocumentVersionID,
  KnowledgeNamespaceID,
} from './knowledge';
import type { TeammateSkillOrigin } from './teammate-skills';

/**
 * Skills provider: where shared, versioned skills come from.
 *
 * v1 has one provider, Knowledge. A Knowledge namespace is a provider when its
 * metadata has `skills_provider: true`. Inside it, `kind: skill` documents are
 * assigned by path:
 *
 * - `skills/<teammate key>/…` belongs to that teammate (keys as in
 *   `teammate-skills`: slug tokens of the display name plus the full slug);
 * - `skills/_shared/…` belongs to every teammate.
 *
 * Other kinds and `README.md` files are never skills.
 */

/** Namespace metadata flag that makes a Knowledge namespace a skills provider. */
export const SKILLS_PROVIDER_NAMESPACE_FLAG = 'skills_provider' as const;

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
