/**
 * Agent Skills documents stored in Knowledge: frontmatter parsing, the
 * provider path layout, and write-time validation.
 *
 * Frontmatter is inline in the markdown (`---\nname: …\ndescription: …\n---`);
 * the version row's `frontmatter` column is not used.
 */

import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SKILL_VERSION_MAX_LENGTH,
  type SkillFrontmatter,
} from '../types/skills';
import type { TeammateSkillOrigin } from '../types/teammate-skills';
import { splitMarkdownFrontmatter } from './frontmatter';

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

/** The Agor-relevant fields of a parsed Agent Skills frontmatter block. */
export function readSkillFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined
): SkillFrontmatter {
  if (!frontmatter) return {};
  const metadata = asRecord(frontmatter.metadata);
  const origin = readSkillOrigin(frontmatter);
  const read: SkillFrontmatter = {
    name: nonEmptyString(frontmatter.name),
    description: nonEmptyString(frontmatter.description),
    version: nonEmptyString(metadata?.version),
    license: nonEmptyString(frontmatter.license) ?? origin?.license,
    compatibility: nonEmptyString(frontmatter.compatibility),
    origin,
  };
  return Object.fromEntries(
    Object.entries(read).filter(([, value]) => value !== undefined)
  ) as SkillFrontmatter;
}

export interface ParsedSkillDocument {
  /** Parsed YAML mapping, or `null` when there is no usable block. */
  frontmatter: Record<string, unknown> | null;
  fields: SkillFrontmatter;
  /** Markdown after the frontmatter block (the whole document when there is none). */
  body: string;
}

export function parseSkillDocument(content: string): ParsedSkillDocument {
  const { frontmatter, body } = splitMarkdownFrontmatter(content);
  return { frontmatter, fields: readSkillFrontmatter(frontmatter), body };
}

const SKILL_VERSION_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9.+_-]{0,${SKILL_VERSION_MAX_LENGTH - 1}}$`
);

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** `README.md` files document a folder; they are never skills. */
export function isSkillReadmePath(path: string): boolean {
  return pathSegments(path).at(-1)?.toLowerCase() === 'readme.md';
}

/**
 * The name a skill at `path` must declare: the folder for `…/SKILL.md`,
 * otherwise the file stem. `undefined` for a path with no usable segment.
 */
export function expectedSkillName(path: string): string | undefined {
  const segments = pathSegments(path);
  const last = segments.at(-1);
  if (!last) return undefined;
  if (last.toLowerCase() === 'skill.md') return segments.at(-2);
  return last.replace(/\.md$/i, '') || undefined;
}

/** Markdown that changes a line's structure when it starts it: headings, quotes, lists, rules, fences, tables. */
const LEADING_MARKDOWN = /^(?:[#>*+=|~`_-]+|\d+[.)](?=\s|$))+\s*/;

/**
 * Knowledge-authored text made safe to interpolate into model-visible text:
 * one line (control characters and line breaks become spaces), no leading
 * markdown structure, backticks and brackets neutralized, cut to `max`
 * characters with an ellipsis. Returns '' for anything that is not a string
 * or number.
 */
export function skillTextField(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = String(value)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let previous: string;
  do {
    previous = text;
    text = text.replace(LEADING_MARKDOWN, '').trim();
  } while (text !== previous);
  text = text.replace(/[`[\]]/g, "'");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface SkillValidationInput {
  path: string;
  content: string;
}

/**
 * Agent Skills frontmatter rules for a `kind: skill` document:
 * - a frontmatter block exists and parses;
 * - `name` is kebab-case, at most 64 characters, and equals the file stem
 *   (or the folder for `SKILL.md`);
 * - `description` is non-empty and at most 1024 characters;
 * - `metadata.version`, when present, is a single short token such as `1.2.0`.
 *
 * Returns human-readable problems; an empty list means valid.
 */
export function validateSkillDocument({ path, content }: SkillValidationInput): string[] {
  const { frontmatter } = splitMarkdownFrontmatter(content);
  if (!frontmatter) {
    return [
      'a skill must start with a YAML frontmatter block (`---`) that declares `name` and `description`',
    ];
  }
  const issues: string[] = [];
  const expected = expectedSkillName(path);
  const rawName = frontmatter.name;
  if (typeof rawName !== 'string' || !rawName.trim()) {
    issues.push('frontmatter `name` is required');
  } else {
    const name = rawName.trim();
    if (name.length > SKILL_NAME_MAX_LENGTH) {
      issues.push(`\`name\` is ${name.length} characters; the limit is ${SKILL_NAME_MAX_LENGTH}`);
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      issues.push(
        `\`name\` "${name}" must be kebab-case: lowercase letters, digits and single hyphens`
      );
    }
    if (expected && name !== expected) {
      const what = /\/skill\.md$/i.test(path) ? 'folder' : 'file name';
      issues.push(`\`name\` "${name}" must match the ${what} "${expected}"`);
    }
  }
  const rawDescription = frontmatter.description;
  if (typeof rawDescription !== 'string' || !rawDescription.trim()) {
    issues.push('frontmatter `description` is required');
  } else if (rawDescription.trim().length > SKILL_DESCRIPTION_MAX_LENGTH) {
    issues.push(
      `\`description\` is ${rawDescription.trim().length} characters; the limit is ${SKILL_DESCRIPTION_MAX_LENGTH}`
    );
  }
  const metadata = asRecord(frontmatter.metadata);
  const rawVersion = metadata?.version;
  if (rawVersion !== undefined && rawVersion !== null) {
    const version = typeof rawVersion === 'number' ? String(rawVersion) : rawVersion;
    if (typeof version !== 'string' || !SKILL_VERSION_PATTERN.test(version)) {
      issues.push(
        `\`metadata.version\` must be one line of at most ${SKILL_VERSION_MAX_LENGTH} letters, digits, dots, hyphens, plus signs or underscores`
      );
    }
  }
  return issues;
}
