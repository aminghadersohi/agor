import type { BranchID, SessionID } from './id';
import type { KnowledgeDocumentID, KnowledgeDocumentVersionID } from './knowledge';

/**
 * Read-only view of a teammate's skills (`branches/:id/skills`).
 *
 * Nothing here is stored: the daemon assembles it on request from the
 * teammate's Knowledge namespace, its branch worktree, and its latest
 * session's harness report. It is a mirror of what exists today, not an
 * equip/unequip surface.
 */

/** Where a skill was found. */
export const TEAMMATE_SKILL_SOURCES = ['knowledge', 'vendor', 'in-repo', 'harness'] as const;
export type TeammateSkillSource = (typeof TEAMMATE_SKILL_SOURCES)[number];

/**
 * - `drift`: an in-repo skill whose content differs across readable teammate branches.
 * - `same`: an in-repo skill that matches every other copy (or has none).
 * - `reviewed` / `unreviewed`: a vendored Knowledge skill with or without a recorded reviewer.
 * - `ok`: a first-party Knowledge skill.
 * - `synced`: a skill the harness loaded last run that Agor has no source for.
 */
export const TEAMMATE_SKILL_STATUSES = [
  'drift',
  'same',
  'reviewed',
  'unreviewed',
  'ok',
  'synced',
] as const;
export type TeammateSkillStatus = (typeof TEAMMATE_SKILL_STATUSES)[number];

/** `metadata.agor.origin` on a vendored Knowledge skill. */
export interface TeammateSkillOrigin {
  provider?: string;
  uri?: string;
  commit?: string;
  license?: string;
  reviewed_by?: string;
  reviewed_at?: string;
}

/** Copies of one in-repo skill name across the teammate branches the caller can read. */
export interface TeammateSkillDrift {
  /** Distinct sha256 values across every scanned copy, this branch included. */
  variants: number;
  /** Other teammate branches that carry a skill with this name. */
  shared_with: Array<{ branch_id: BranchID; name: string; sha256: string }>;
}

export interface TeammateSkill {
  name: string;
  source: TeammateSkillSource;
  status: TeammateSkillStatus;
  description?: string;
  /** Worktree-relative file for in-repo skills; Knowledge path for Knowledge/vendor skills. */
  path?: string;
  /** `agor://kb/...` reference for Knowledge/vendor skills. */
  uri?: string;
  /** Knowledge namespace a Knowledge/vendor skill lives in; may be shared by several teammates. */
  namespace_slug?: string;
  namespace_name?: string;
  /** Browser deep link for Knowledge/vendor skills, when the daemon knows its base URL. */
  url?: string;
  sha256?: string;
  /** Short human pin: `v3`, `sha d298b7e`, `owner/repo@1a2b3c4`, `loaded last run`. */
  version_label: string;
  document_id?: KnowledgeDocumentID;
  version_id?: KnowledgeDocumentVersionID;
  version_number?: number;
  /** ISO timestamp: doc update, file mtime, review date, or the harness session's start. */
  updated_at?: string;
  origin?: TeammateSkillOrigin;
  drift?: TeammateSkillDrift;
}

export const TEAMMATE_SKILL_GAP_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type TeammateSkillGapPriority = (typeof TEAMMATE_SKILL_GAP_PRIORITIES)[number];

export interface TeammateSkillGap {
  skill: string;
  priority: TeammateSkillGapPriority;
  source?: string;
  note?: string;
  /** True when an equipped skill has the same name. */
  closed: boolean;
}

/**
 * `skills/_gaps.md` in the teammate's primary Knowledge namespace. Gap lists
 * are also read from `skills/<teammate key>/_gaps.md` in any readable namespace.
 */
export const TEAMMATE_SKILL_GAPS_PATH = 'skills/_gaps.md';

export interface TeammateSkillGapList {
  /** `missing` when the doc does not exist; `invalid` when its frontmatter has no usable `gaps`. */
  status: 'ok' | 'missing' | 'invalid';
  items: TeammateSkillGap[];
  /** First readable gap document; see `documents` for all of them. */
  uri?: string;
  url?: string;
  error?: string;
  /** Every gap document merged into `items`, teammate folders first. */
  documents?: Array<{ uri: string; path: string; namespace_slug?: string }>;
}

/** Why a source contributed nothing, so the UI can say so instead of showing an empty list. */
export interface TeammateSkillSourceState {
  status: 'ok' | 'unavailable';
  reason?: string;
  /** A scan stopped at a bound (file count, file size, branch count). */
  truncated?: boolean;
}

export interface TeammateSkillsReport {
  branch_id: BranchID;
  skills: TeammateSkill[];
  gaps: TeammateSkillGapList;
  sources: {
    knowledge: TeammateSkillSourceState & { namespace_slug?: string };
    in_repo: TeammateSkillSourceState;
    harness: TeammateSkillSourceState & { session_id?: SessionID; session_at?: string };
    drift: TeammateSkillSourceState & { branches_scanned: number };
  };
}

/** Executor command that scans a branch worktree for skill files. */
export const BRANCH_SKILLS_SCAN_COMMAND = 'branch.skills.scan' as const;

/** One skill file found in a branch worktree by {@link BRANCH_SKILLS_SCAN_COMMAND}. */
export interface BranchSkillFile {
  name: string;
  description?: string;
  /** Worktree-relative POSIX path. */
  path: string;
  sha256: string;
  /** ISO timestamp of the file's mtime. */
  mtime: string;
}

export interface BranchSkillScanSkip {
  path: string;
  reason: 'outside-worktree' | 'too-large' | 'not-a-file' | 'unreadable';
}

export interface BranchSkillScan {
  skills: BranchSkillFile[];
  skipped: BranchSkillScanSkip[];
  /** True when a file-count or directory-entry bound cut the scan short. */
  truncated: boolean;
}
