/**
 * Skill set manifests (`skillsets/<teammate key>.md`, `kind: bundle`):
 * frontmatter parsing and rendering. See `SkillSetManifest`.
 */

import { SKILLSETS_ROOT, type SkillSetEntry, type SkillSetManifest } from '../types/skills';
import { splitMarkdownFrontmatter } from './frontmatter';
import { serializeKnowledgeYaml } from './repository';

export function skillSetPath(key: string): string {
  return `${SKILLSETS_ROOT}/${key}.md`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseEntry(value: unknown): SkillSetEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const documentId = str(raw.document_id);
  const path = str(raw.path);
  const versionId = str(raw.version_id);
  const versionNumber = positiveInt(raw.version_number);
  const sha256 = str(raw.sha256);
  if (!documentId || !path || !versionId || !versionNumber || !sha256) return null;
  const version = str(raw.version);
  return {
    name: str(raw.name) ?? path,
    ...(version ? { version } : {}),
    document_id: documentId as SkillSetEntry['document_id'],
    path,
    version_id: versionId as SkillSetEntry['version_id'],
    version_number: versionNumber,
    sha256,
  };
}

/**
 * The manifest in a skill set document, or an error saying what is wrong.
 * Entries missing a pin field make the whole manifest invalid: a release
 * must never be delivered partly.
 */
export function parseSkillSetManifest(
  content: string
): { manifest: SkillSetManifest } | { error: string } {
  const { frontmatter } = splitMarkdownFrontmatter(content);
  if (!frontmatter) return { error: 'the manifest has no YAML frontmatter' };
  const release = positiveInt(frontmatter.release);
  if (!release) return { error: '`release` must be a positive integer' };
  if (!Array.isArray(frontmatter.skills)) return { error: '`skills` must be a list' };
  const skills: SkillSetEntry[] = [];
  for (const [index, raw] of frontmatter.skills.entries()) {
    const entry = parseEntry(raw);
    if (!entry) {
      return {
        error: `skills[${index}] needs document_id, path, version_id, version_number and sha256`,
      };
    }
    skills.push(entry);
  }
  const name = str(frontmatter.name);
  if (!name) return { error: '`name` is required' };
  return {
    manifest: {
      name,
      teammate: str(frontmatter.teammate) ?? name,
      release,
      created_at: str(frontmatter.created_at) ?? '',
      created_by: str(frontmatter.created_by) ?? '',
      skills,
    },
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** Manifest document: YAML frontmatter plus a readable table of the pins. */
export function renderSkillSetManifest(manifest: SkillSetManifest): string {
  const rows = manifest.skills.map(
    (skill) =>
      `| ${cell(skill.name)} | ${cell(skill.version ?? '')} | ${skill.version_number} | \`${cell(skill.path)}\` | \`${skill.sha256.slice(0, 12)}\` |`
  );
  return [
    '---',
    serializeKnowledgeYaml(manifest).trimEnd(),
    '---',
    `# Skill set ${manifest.name}: release ${manifest.release}`,
    '',
    `Frozen release ${manifest.release} of ${manifest.teammate}'s skills, cut ${manifest.created_at}. ` +
      'Edit the frontmatter only through `agor_skillsets_release`: each release pins a document version and its sha256.',
    '',
    '| Skill | Version | KB version | Path | sha256 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Same documents at the same versions and hashes, ignoring order. */
export function sameSkillPins(a: readonly SkillSetEntry[], b: readonly SkillSetEntry[]): boolean {
  const key = (entry: SkillSetEntry) => `${entry.document_id}@${entry.version_id}#${entry.sha256}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
