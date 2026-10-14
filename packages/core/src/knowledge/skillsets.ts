/**
 * Skill set manifests (`skillsets/<teammate key>.md`, `kind: bundle`):
 * frontmatter parsing and rendering. See `SkillSetManifest`.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  MAX_SKILLSET_MANIFEST_BYTES,
  MAX_SKILLSET_SKILLS,
  SKILLSETS_ROOT,
  type SkillSetEntry,
  type SkillSetManifest,
} from '../types/skills';
import { splitMarkdownFrontmatter } from './frontmatter';
import { serializeKnowledgeYaml } from './repository';

/** True for `skillsets/…` paths (the release-only part of a provider namespace). */
export function isSkillSetPath(path: string | null | undefined): boolean {
  const normalized = (path ?? '').trim().replace(/^\/+/, '').toLowerCase();
  return normalized === SKILLSETS_ROOT || normalized.startsWith(`${SKILLSETS_ROOT}/`);
}

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
  if (Buffer.byteLength(content) > MAX_SKILLSET_MANIFEST_BYTES + 16 * 1024) {
    return { error: `the manifest is larger than ${MAX_SKILLSET_MANIFEST_BYTES} bytes` };
  }
  const { frontmatter } = splitMarkdownFrontmatter(content);
  if (!frontmatter) return { error: 'the manifest has no YAML frontmatter' };
  const release = positiveInt(frontmatter.release);
  if (!release) return { error: '`release` must be a positive integer' };
  if (!Array.isArray(frontmatter.skills)) return { error: '`skills` must be a list' };
  if (frontmatter.skills.length > MAX_SKILLSET_SKILLS) {
    return { error: `a skill set pins at most ${MAX_SKILLSET_SKILLS} skills` };
  }
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

/**
 * Manifest document: YAML frontmatter plus a readable table of the pins.
 * Throws when the manifest exceeds the shared bounds or would not read back
 * as the same manifest, so an unreadable release is never written.
 */
export function renderSkillSetManifest(manifest: SkillSetManifest): string {
  if (manifest.skills.length > MAX_SKILLSET_SKILLS) {
    throw new Error(
      `A skill set pins at most ${MAX_SKILLSET_SKILLS} skills; this release has ${manifest.skills.length}.`
    );
  }
  const yaml = serializeKnowledgeYaml(manifest).trimEnd();
  if (Buffer.byteLength(yaml) > MAX_SKILLSET_MANIFEST_BYTES) {
    throw new Error(
      `The skill set manifest would be ${Buffer.byteLength(yaml)} bytes; the limit is ${MAX_SKILLSET_MANIFEST_BYTES}.`
    );
  }
  const rows = manifest.skills.map(
    (skill) =>
      `| ${cell(skill.name)} | ${cell(skill.version ?? '')} | ${skill.version_number} | \`${cell(skill.path)}\` | \`${skill.sha256.slice(0, 12)}\` |`
  );
  const document = [
    '---',
    yaml,
    '---',
    `# Skill set ${cell(manifest.name)}: release ${manifest.release}`,
    '',
    `Frozen release ${manifest.release} of ${cell(manifest.teammate)}'s skills, cut ${manifest.created_at}. ` +
      'Only skill set releases write this document: each release pins a document version and its sha256.',
    '',
    '| Skill | Version | KB version | Path | sha256 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  const reread = parseSkillSetManifest(document);
  if (!('manifest' in reread) || !isDeepStrictEqual(reread.manifest, manifest)) {
    throw new Error(
      `The skill set manifest does not read back as written${'error' in reread ? `: ${reread.error}` : ''}.`
    );
  }
  return document;
}

/** Same documents at the same versions and hashes, ignoring order. */
export function sameSkillPins(a: readonly SkillSetEntry[], b: readonly SkillSetEntry[]): boolean {
  const key = (entry: SkillSetEntry) => `${entry.document_id}@${entry.version_id}#${entry.sha256}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
