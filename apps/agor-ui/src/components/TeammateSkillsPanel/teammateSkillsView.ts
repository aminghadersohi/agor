import type {
  TeammateSkill,
  TeammateSkillGap,
  TeammateSkillSource,
  TeammateSkillStatus,
  TeammateSkillsReport,
} from '@agor-live/client';

export const SKILL_SOURCE_LABELS: Record<TeammateSkillSource, string> = {
  knowledge: 'Knowledge',
  vendor: 'vendor',
  'in-repo': 'in-repo',
  harness: 'harness',
};

/** AntD preset tag colors; they follow the active theme. */
export const SKILL_SOURCE_COLORS: Record<TeammateSkillSource, string | undefined> = {
  knowledge: 'blue',
  vendor: 'purple',
  'in-repo': 'cyan',
  harness: undefined,
};

export type SkillSourceFilter = TeammateSkillSource | 'all';

/** A skill that needs attention: content that differs across teammates, or an unreviewed import. */
export function isProblemSkill(skill: TeammateSkill): boolean {
  return skill.status === 'drift' || skill.status === 'unreviewed';
}

export function statusLabel(skill: TeammateSkill): string {
  const labels: Record<TeammateSkillStatus, string> = {
    drift: `${skill.drift?.variants ?? 2} variants`,
    same: 'same',
    reviewed: 'reviewed',
    unreviewed: 'unreviewed',
    ok: 'ok',
    synced: 'synced',
  };
  return labels[skill.status];
}

export interface TeammateSkillsSummary {
  equipped: number;
  bySource: Record<TeammateSkillSource, number>;
  drifted: number;
  unreviewed: number;
  openGaps: number;
  closedGaps: number;
}

export function summarizeTeammateSkills(report: TeammateSkillsReport): TeammateSkillsSummary {
  const bySource: Record<TeammateSkillSource, number> = {
    knowledge: 0,
    vendor: 0,
    'in-repo': 0,
    harness: 0,
  };
  for (const skill of report.skills) bySource[skill.source] += 1;
  const openGaps = report.gaps.items.filter((gap) => !gap.closed).length;
  return {
    equipped: report.skills.length,
    bySource,
    drifted: report.skills.filter((skill) => skill.status === 'drift').length,
    unreviewed: report.skills.filter((skill) => skill.status === 'unreviewed').length,
    openGaps,
    closedGaps: report.gaps.items.length - openGaps,
  };
}

export function filterTeammateSkills(
  skills: TeammateSkill[],
  filters: { search: string; source: SkillSourceFilter; onlyProblems: boolean }
): TeammateSkill[] {
  const needle = filters.search.trim().toLowerCase();
  return skills.filter((skill) => {
    if (filters.source !== 'all' && skill.source !== filters.source) return false;
    if (filters.onlyProblems && !isProblemSkill(skill)) return false;
    if (!needle) return true;
    return [skill.name, skill.description, skill.path]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(needle));
  });
}

export function filterTeammateSkillGaps(
  gaps: TeammateSkillGap[],
  filters: { search: string; onlyProblems: boolean }
): TeammateSkillGap[] {
  const needle = filters.search.trim().toLowerCase();
  return gaps.filter((gap) => {
    if (filters.onlyProblems && gap.closed) return false;
    if (!needle) return true;
    return [gap.skill, gap.note]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(needle));
  });
}

/** The doc's `source` is a link only when it is a web URL; `agor://` refs are shown as text. */
export function webHref(value: string | undefined): string | undefined {
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}
