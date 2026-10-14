import { describe, expect, it } from 'vitest';
import type { SkillSetEntry, SkillSetManifest } from '../types/skills';
import { splitMarkdownFrontmatter } from './frontmatter';
import {
  parseSkillSetManifest,
  renderSkillSetManifest,
  sameSkillPins,
  skillSetPath,
} from './skillsets';

const entry = (n: number, overrides: Partial<SkillSetEntry> = {}): SkillSetEntry => ({
  name: `skill-${n}`,
  version: `0.1.${n}`,
  document_id: `doc-${n}` as SkillSetEntry['document_id'],
  path: `skills/frink/skill-${n}.md`,
  version_id: `ver-${n}` as SkillSetEntry['version_id'],
  version_number: n,
  sha256: `${n}`.repeat(64).slice(0, 64),
  ...overrides,
});

const manifest: SkillSetManifest = {
  name: 'frink',
  teammate: 'Professor Frink',
  release: 3,
  created_at: '2026-10-14T10:00:00.000Z',
  created_by: 'user-1',
  skills: [entry(1), entry(2, { name: 'pipes | and stuff' })],
};

describe('skill set manifests', () => {
  it('files a teammate set under skillsets/', () => {
    expect(skillSetPath('frink')).toBe('skillsets/frink.md');
  });

  it('round-trips through the rendered document', () => {
    const doc = renderSkillSetManifest(manifest);
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('# Skill set frink: release 3');
    expect(doc).toContain('| pipes \\| and stuff | 0.1.2 | 2 | `skills/frink/skill-2.md` |');
    expect(parseSkillSetManifest(doc)).toEqual({ manifest });
    // The frontmatter is plain YAML with the required fields.
    const { frontmatter } = splitMarkdownFrontmatter(doc);
    expect(frontmatter).toMatchObject({ name: 'frink', release: 3, teammate: 'Professor Frink' });
  });

  it('rejects manifests that cannot be delivered as a whole', () => {
    expect(parseSkillSetManifest('# no frontmatter')).toEqual({
      error: 'the manifest has no YAML frontmatter',
    });
    expect(parseSkillSetManifest('---\nname: x\nrelease: 0\nskills: []\n---\n')).toEqual({
      error: '`release` must be a positive integer',
    });
    expect(parseSkillSetManifest('---\nname: x\nrelease: 1\nskills: nope\n---\n')).toEqual({
      error: '`skills` must be a list',
    });
    expect(
      parseSkillSetManifest(
        '---\nname: x\nrelease: 1\nskills:\n  - document_id: d\n    path: p\n---\n'
      )
    ).toEqual({
      error: 'skills[0] needs document_id, path, version_id, version_number and sha256',
    });
    expect(parseSkillSetManifest('---\nrelease: 1\nskills: []\n---\n')).toEqual({
      error: '`name` is required',
    });
  });

  it('compares pins by document, version and hash, ignoring order', () => {
    expect(sameSkillPins([entry(1), entry(2)], [entry(2), entry(1)])).toBe(true);
    expect(sameSkillPins([entry(1)], [entry(1, { version_id: 'ver-9' as never })])).toBe(false);
    expect(sameSkillPins([entry(1)], [entry(1, { sha256: 'f'.repeat(64) })])).toBe(false);
    expect(sameSkillPins([entry(1)], [entry(1), entry(2)])).toBe(false);
  });
});
