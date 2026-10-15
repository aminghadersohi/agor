/**
 * Text shapes the skills tools return: compact index rows and the provenance
 * header placed above a skill body.
 *
 * Every Knowledge-derived value interpolated here goes through
 * `skillTextField`: one line, no leading markdown structure, bounded. A skill
 * author must not be able to add headings or instructions around the body.
 */

import { skillTextField } from '@agor/core/knowledge';
import type { SkillContent, SkillSummary } from '@agor/core/types';

/** Index descriptions are cut to about this many characters. */
export const SKILL_INDEX_DESCRIPTION_CHARS = 160;
/** Bounds for the other interpolated fields. */
export const SKILL_FIELD_CHARS = {
  name: 64,
  version: 32,
  namespace: 64,
  path: 160,
  license: 80,
  origin: 200,
  selectedBy: 160,
} as const;

/** First `max` characters on one line, with an ellipsis when cut. */
export function truncateOneLine(text: string | undefined, max: number): string {
  return skillTextField(text ?? '', max);
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
  const f = SKILL_FIELD_CHARS;
  const version = skillTextField(provenance.version, f.version);
  const origin = provenance.origin
    ? skillTextField(
        [provenance.origin.uri, provenance.origin.commit && `@${provenance.origin.commit}`]
          .filter(Boolean)
          .join(''),
        f.origin
      )
    : '';
  const license = skillTextField(provenance.license, f.license);
  const lines = [
    `> Skill "${skillTextField(name, f.name)}"${version ? ` v${version}` : ''} from Knowledge`,
    `> ${skillTextField(provenance.namespace, f.namespace)}/${skillTextField(provenance.path, f.path)} · version ${Number(provenance.version_number) || 0} (${skillTextField(provenance.selected_by, f.selectedBy)})`,
    `> sha256 ${skillTextField(provenance.sha256, 64)}`,
  ];
  if (license) lines.push(`> license: ${license}`);
  if (origin) lines.push(`> origin: ${origin}`);
  return lines.join('\n');
}

/** One `agor_skills_list` row: what to pick a skill by, and how to fetch it. */
export function skillIndexEntry(skill: SkillSummary) {
  const f = SKILL_FIELD_CHARS;
  const version = skillTextField(skill.version, f.version);
  return {
    name: skillTextField(skill.name, f.name),
    ...(version ? { version } : {}),
    description: skillTextField(skill.description, SKILL_INDEX_DESCRIPTION_CHARS),
    namespace: skill.namespace_slug,
    path: skill.path,
    document_id: skill.document_id,
    version_number: skill.version_number,
    for: skill.assignment.kind === 'shared' ? 'everyone' : skill.assignment.key,
    ...(skill.issues ? { issues: skill.issues } : {}),
  };
}
