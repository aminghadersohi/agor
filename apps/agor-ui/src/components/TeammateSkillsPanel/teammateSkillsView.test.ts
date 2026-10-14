import type { TeammateSkill, TeammateSkillsReport } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  filterTeammateSkillGaps,
  filterTeammateSkills,
  isProblemSkill,
  statusLabel,
  summarizeTeammateSkills,
  webHref,
} from './teammateSkillsView';

const skill = (overrides: Partial<TeammateSkill>): TeammateSkill => ({
  name: 'x',
  source: 'in-repo',
  status: 'ok',
  version_label: 'sha 0000000',
  ...overrides,
});

const skills = [
  skill({ name: 'connect-saas', status: 'drift', drift: { variants: 4, shared_with: [] } }),
  skill({ name: 'verifying-a-fix', source: 'knowledge', description: 'Prove the FIX first' }),
  skill({ name: 'django-perf-review', source: 'vendor', status: 'unreviewed' }),
  skill({ name: 'pdf', source: 'harness', status: 'synced' }),
];

describe('teammateSkillsView', () => {
  it('summarizes counts by source, drift, review and gaps', () => {
    const report = {
      skills,
      gaps: {
        status: 'ok',
        items: [
          { skill: 'a', priority: 'P0', closed: false },
          { skill: 'b', priority: 'P1', closed: true },
        ],
      },
    } as unknown as TeammateSkillsReport;
    expect(summarizeTeammateSkills(report)).toEqual({
      equipped: 4,
      bySource: { knowledge: 1, vendor: 1, 'in-repo': 1, harness: 1 },
      drifted: 1,
      unreviewed: 1,
      openGaps: 1,
      closedGaps: 1,
    });
  });

  it('treats drift and unreviewed vendor skills as problems', () => {
    expect(skills.filter(isProblemSkill).map((s) => s.name)).toEqual([
      'connect-saas',
      'django-perf-review',
    ]);
  });

  it('labels drift with its variant count', () => {
    expect(statusLabel(skills[0])).toBe('4 variants');
    expect(statusLabel(skills[3])).toBe('synced');
  });

  it('filters by source, problems, and a case-insensitive search over name, description and path', () => {
    const base = { search: '', source: 'all' as const, onlyProblems: false };
    expect(filterTeammateSkills(skills, { ...base, source: 'harness' }).map((s) => s.name)).toEqual(
      ['pdf']
    );
    expect(filterTeammateSkills(skills, { ...base, search: 'fix' }).map((s) => s.name)).toEqual([
      'verifying-a-fix',
    ]);
    expect(
      filterTeammateSkills(skills, { ...base, onlyProblems: true, source: 'vendor' }).map(
        (s) => s.name
      )
    ).toEqual(['django-perf-review']);
  });

  it('hides closed gaps when only problems are shown', () => {
    const gaps = [
      { skill: 'open-one', priority: 'P0' as const, closed: false },
      { skill: 'closed-one', priority: 'P2' as const, note: 'done', closed: true },
    ];
    expect(filterTeammateSkillGaps(gaps, { search: '', onlyProblems: true })).toHaveLength(1);
    expect(filterTeammateSkillGaps(gaps, { search: 'DONE', onlyProblems: false })).toEqual([
      gaps[1],
    ]);
  });

  it('links only web URLs', () => {
    expect(webHref('https://example.com/a')).toBe('https://example.com/a');
    expect(webHref('agor://kb/document/x')).toBeUndefined();
  });
});
