/**
 * Text shapes the skills tools return: compact index rows and the provenance
 * header placed above a skill body.
 */

import type { SkillContent, SkillSummary } from '@agor/core/types';

/** Index descriptions are cut to about this many characters. */
export const SKILL_INDEX_DESCRIPTION_CHARS = 160;

/** First `max` characters on one line, with an ellipsis when cut. */
export function truncateOneLine(text: string | undefined, max: number): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface SkillProvenance {
  provider: string;
  namespace: string;
  path: string;
  document_id: string;
  version_id: string;
  version_number: number;
  sha256: string;
  /** Frontmatter `metadata.version`. */
  version?: string;
  license?: string;
  origin?: SkillContent['origin'];
  /** How this version was chosen: a release pin, an explicit request, or the current version. */
  selected_by: string;
}

export function skillProvenance(skill: SkillContent, selectedBy: string): SkillProvenance {
  return {
    provider: skill.ref.provider,
    namespace: skill.namespace_slug,
    path: skill.path,
    document_id: skill.document_id,
    version_id: skill.version_id,
    version_number: skill.version_number,
    sha256: skill.sha256,
    ...(skill.version ? { version: skill.version } : {}),
    ...(skill.license ? { license: skill.license } : {}),
    ...(skill.origin ? { origin: skill.origin } : {}),
    selected_by: selectedBy,
  };
}

/** A blockquote the model sees above the body, so it knows where the procedure came from. */
export function renderProvenanceHeader(name: string, provenance: SkillProvenance): string {
  const origin = provenance.origin
    ? [provenance.origin.uri, provenance.origin.commit && `@${provenance.origin.commit}`]
        .filter(Boolean)
        .join('')
    : undefined;
  const lines = [
    `> Skill \`${name}\`${provenance.version ? ` v${provenance.version}` : ''} from Knowledge`,
    `> ${provenance.namespace}/${provenance.path} · version ${provenance.version_number} (${provenance.selected_by})`,
    `> sha256 ${provenance.sha256}`,
  ];
  if (provenance.license) lines.push(`> license: ${provenance.license}`);
  if (origin) lines.push(`> origin: ${origin}`);
  return lines.join('\n');
}

/** One `agor_skills_list` row: what to pick a skill by, and how to fetch it. */
export function skillIndexEntry(skill: SkillSummary) {
  return {
    name: skill.name,
    ...(skill.version ? { version: skill.version } : {}),
    description: truncateOneLine(skill.description, SKILL_INDEX_DESCRIPTION_CHARS),
    namespace: skill.namespace_slug,
    path: skill.path,
    document_id: skill.document_id,
    version_number: skill.version_number,
    for: skill.assignment.kind === 'shared' ? 'everyone' : skill.assignment.key,
    ...(skill.issues ? { issues: skill.issues } : {}),
  };
}
