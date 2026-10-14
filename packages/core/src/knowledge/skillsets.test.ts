import { describe, expect, it } from 'vitest';
import type { SkillSetEntry, SkillSetManifest } from '../types/skills';
import { splitMarkdownFrontmatter } from './frontmatter';
import {
  isSkillSetPath,
  parseSkillSetManifest,
  renderSkillSetManifest,
  sameSkillPins,
  skillSetPath,
} from './skillsets';

const entry = (n: number, overrides: Partial<SkillSetEntry> = {}): SkillSetEntry => ({
  name: `skill-${n}`,
  version: `0.1.${n}`,
  document_id: `doc-${n}` as SkillSetEntry['document_id'],
  path: `skills/fritz/skill-${n}.md`,
  version_id: `ver-${n}` as SkillSetEntry['version_id'],
  version_number: n,
  sha256: `${n}`.repeat(64).slice(0, 64),
  ...overrides,
});

const manifest: SkillSetManifest = {
  name: 'fritz',
  teammate: 'Professor Fritz',
  release: 3,
  created_at: '2026-10-14T10:00:00.000Z',
  created_by: 'user-1',
  skills: [entry(1), entry(2, { name: 'pipes | and stuff' })],
};

describe('skill set manifests', () => {
  it('files a teammate set under skillsets/', () => {
    expect(skillSetPath('fritz')).toBe('skillsets/fritz.md');
  });

  it('round-trips through the rendered document', () => {
    const doc = renderSkillSetManifest(manifest);
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('# Skill set fritz: release 3');
    expect(doc).toContain('| pipes \\| and stuff | 0.1.2 | 2 | `skills/fritz/skill-2.md` |');
    expect(parseSkillSetManifest(doc)).toEqual({ manifest });
    // The frontmatter is plain YAML with the required fields.
    const { frontmatter } = splitMarkdownFrontmatter(doc);
    expect(frontmatter).toMatchObject({ name: 'fritz', release: 3, teammate: 'Professor Fritz' });
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
  it('shares one size bound between writing and reading', () => {
    const many = Array.from({ length: 151 }, (_, i) => entry(i + 1));
    expect(() => renderSkillSetManifest({ ...manifest, skills: many })).toThrow(
      'A skill set pins at most 150 skills; this release has 151.'
    );
    const fat = Array.from({ length: 150 }, (_, i) =>
      entry(i + 1, { path: `skills/fritz/${'p'.repeat(400)}-${i}.md` })
    );
    expect(() => renderSkillSetManifest({ ...manifest, skills: fat })).toThrow(
      /bytes; the limit is 49152/
    );
    // A hand-made manifest over the bound is unreadable rather than half-read.
    const listed = many
      .map(
        (e) =>
          `  - document_id: ${e.document_id}\n    path: ${e.path}\n    version_id: ${e.version_id}\n    version_number: ${e.version_number}\n    sha256: ${e.sha256}`
      )
      .join('\n');
    expect(parseSkillSetManifest(`---\nname: x\nrelease: 1\nskills:\n${listed}\n---\n`)).toEqual({
      error: 'a skill set pins at most 150 skills',
    });
  });

  it('recognises release-only paths', () => {
    expect(isSkillSetPath('skillsets/fritz.md')).toBe(true);
    expect(isSkillSetPath('/SkillSets/fritz.md')).toBe(true);
    expect(isSkillSetPath('skillsets')).toBe(true);
    expect(isSkillSetPath('notes/skillsets.md')).toBe(false);
    expect(isSkillSetPath('skillsets-old/x.md')).toBe(false);
    expect(isSkillSetPath(undefined)).toBe(false);
  });
});
