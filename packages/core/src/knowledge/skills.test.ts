import { describe, expect, it } from 'vitest';
import { splitMarkdownFrontmatter } from './frontmatter';
import {
  expectedSkillName,
  isSkillReadmePath,
  isSkillsProviderNamespace,
  parseSkillDocument,
  readSkillFrontmatter,
  validateSkillDocument,
} from './skills';

const SKILL = `---
name: fork-changelog-versioning
description: "Keeps a cumulative changelog. Use when deploying."
license: Internal — all rights reserved
compatibility: Claude Code / Agor teammates
metadata:
  owner: Larkspur
  version: "0.1.3"
  agor:
    origin:
      provider: git
      uri: https://github.com/acme/skills/tree/abc/skills/changelog
      commit: abcdef1234567
      license: Apache-2.0
---
# Fork version string + changelog

## When to use
`;

describe('splitMarkdownFrontmatter', () => {
  it('returns the parsed block and the markdown after it', () => {
    const { frontmatter, body } = splitMarkdownFrontmatter(SKILL);
    expect(frontmatter?.name).toBe('fork-changelog-versioning');
    expect(body).toBe('# Fork version string + changelog\n\n## When to use\n');
  });

  it('keeps the whole content as body when there is no block', () => {
    expect(splitMarkdownFrontmatter('# Title\n')).toEqual({ frontmatter: null, body: '# Title\n' });
  });

  it('drops an unparsable block but still strips it from the body', () => {
    const { frontmatter, body } = splitMarkdownFrontmatter('---\nname: [oops\n---\nBody');
    expect(frontmatter).toBeNull();
    expect(body).toBe('Body');
  });
});

describe('readSkillFrontmatter / parseSkillDocument', () => {
  it('reads name, description, metadata.version, license and origin', () => {
    const parsed = parseSkillDocument(SKILL);
    expect(parsed.fields).toEqual({
      name: 'fork-changelog-versioning',
      description: 'Keeps a cumulative changelog. Use when deploying.',
      version: '0.1.3',
      license: 'Internal — all rights reserved',
      compatibility: 'Claude Code / Agor teammates',
      origin: {
        provider: 'git',
        uri: 'https://github.com/acme/skills/tree/abc/skills/changelog',
        commit: 'abcdef1234567',
        license: 'Apache-2.0',
        reviewed_by: undefined,
        reviewed_at: undefined,
      },
    });
    expect(parsed.body.startsWith('# Fork version string')).toBe(true);
  });

  it('falls back to the origin license and accepts numeric versions', () => {
    expect(
      readSkillFrontmatter({
        name: 'x',
        metadata: { version: 2, origin: { license: 'MIT' } },
      })
    ).toMatchObject({ name: 'x', version: '2', license: 'MIT' });
  });

  it('returns an empty object without frontmatter', () => {
    expect(readSkillFrontmatter(null)).toEqual({});
  });
});

describe('skill paths', () => {
  it('derives the expected name from the stem, or the folder for SKILL.md', () => {
    expect(expectedSkillName('skills/larkspur/fork-changelog-versioning.md')).toBe(
      'fork-changelog-versioning'
    );
    expect(expectedSkillName('skills/triage/SKILL.md')).toBe('triage');
    expect(expectedSkillName('skills/triage/skill.md')).toBe('triage');
    expect(expectedSkillName('')).toBeUndefined();
  });

  it('recognises README files', () => {
    expect(isSkillReadmePath('skills/README.md')).toBe(true);
    expect(isSkillReadmePath('skills/fritz/readme.md')).toBe(true);
    expect(isSkillReadmePath('skills/fritz/research.md')).toBe(false);
  });

  it('detects provider namespaces by the metadata flag only', () => {
    expect(isSkillsProviderNamespace({ metadata: { skills_provider: true } })).toBe(true);
    expect(isSkillsProviderNamespace({ metadata: { skills_provider: 'true' } })).toBe(false);
    expect(isSkillsProviderNamespace({ metadata: null })).toBe(false);
    expect(isSkillsProviderNamespace(null)).toBe(false);
  });
});

describe('validateSkillDocument', () => {
  const doc = (name: string, description = 'Use it.') =>
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nBody\n`;

  it('accepts a valid skill', () => {
    expect(
      validateSkillDocument({
        path: 'skills/larkspur/fork-changelog-versioning.md',
        content: SKILL,
      })
    ).toEqual([]);
    expect(
      validateSkillDocument({ path: 'skills/triage/SKILL.md', content: doc('triage') })
    ).toEqual([]);
  });

  it('requires a frontmatter block', () => {
    expect(validateSkillDocument({ path: 'skills/a/b.md', content: '# b' })).toEqual([
      expect.stringContaining('must start with a YAML frontmatter block'),
    ]);
  });

  it('checks name presence, shape, length and the path match', () => {
    expect(
      validateSkillDocument({ path: 'skills/a/b.md', content: '---\ndescription: d\n---\n' })
    ).toEqual(['frontmatter `name` is required']);
    expect(
      validateSkillDocument({ path: 'skills/a/Foo--bar.md', content: doc('Foo--bar') })
    ).toEqual([expect.stringContaining('must be kebab-case')]);
    const long = 'a'.repeat(65);
    expect(validateSkillDocument({ path: `skills/a/${long}.md`, content: doc(long) })).toEqual([
      '`name` is 65 characters; the limit is 64',
    ]);
    expect(validateSkillDocument({ path: 'skills/a/b.md', content: doc('c') })).toEqual([
      '`name` "c" must match the file name "b"',
    ]);
    expect(validateSkillDocument({ path: 'skills/x/SKILL.md', content: doc('y') })).toEqual([
      '`name` "y" must match the folder "x"',
    ]);
  });

  it('checks description presence and length (1024 is the limit)', () => {
    expect(
      validateSkillDocument({ path: 'skills/a/b.md', content: '---\nname: b\n---\n' })
    ).toEqual(['frontmatter `description` is required']);
    expect(
      validateSkillDocument({ path: 'skills/a/b.md', content: doc('b', 'd'.repeat(1024)) })
    ).toEqual([]);
    expect(
      validateSkillDocument({ path: 'skills/a/b.md', content: doc('b', 'd'.repeat(1025)) })
    ).toEqual(['`description` is 1025 characters; the limit is 1024']);
  });
});
