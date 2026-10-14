import type {
  BranchID,
  BranchSkillFile,
  KnowledgeDocumentID,
  KnowledgeDocumentVersionID,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  assembleTeammateSkills,
  type KnowledgeSkillInput,
  mergeSkillGaps,
  parseSkillGaps,
  readSkillOrigin,
  skillKey,
  vendorPinLabel,
} from './assemble';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function kbDoc(overrides: Partial<KnowledgeSkillInput> & { content: string }): KnowledgeSkillInput {
  return {
    document_id: 'doc-1' as KnowledgeDocumentID,
    path: 'skills/verifying-a-fix/SKILL.md',
    uri: 'agor://kb/document/doc-1',
    url: 'http://agor.test/ui/kb/teammate-x/skills/verifying-a-fix/SKILL.md',
    updated_at: '2026-10-09T00:00:00.000Z',
    metadata: null,
    version_id: 'ver-1' as KnowledgeDocumentVersionID,
    version_number: 3,
    content_sha256: SHA_C,
    ...overrides,
  };
}

function repoFile(overrides: Partial<BranchSkillFile> = {}): BranchSkillFile {
  return {
    name: 'connect-saas',
    path: 'skills/connect-saas/SKILL.md',
    sha256: SHA_A,
    mtime: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

const empty = { knowledge: [], inRepo: [], peers: null, harness: null, gapsDocs: [] };

describe('assembleTeammateSkills: sources', () => {
  it('maps a Knowledge skill to its version pin and doc timestamps', () => {
    const { skills } = assembleTeammateSkills({
      ...empty,
      knowledge: [
        kbDoc({ content: '---\nname: verifying-a-fix\ndescription: Prove the fix.\n---\nBody' }),
      ],
    });
    expect(skills).toEqual([
      expect.objectContaining({
        name: 'verifying-a-fix',
        source: 'knowledge',
        status: 'ok',
        version_label: 'v3',
        version_id: 'ver-1',
        description: 'Prove the fix.',
        updated_at: '2026-10-09T00:00:00.000Z',
        sha256: SHA_C,
        uri: 'agor://kb/document/doc-1',
      }),
    ]);
  });

  it('names a Knowledge skill after its folder when the frontmatter has no name', () => {
    const { skills } = assembleTeammateSkills({
      ...empty,
      knowledge: [kbDoc({ content: 'Body' })],
    });
    expect(skills[0].name).toBe('verifying-a-fix');
  });

  it('treats a Knowledge skill with metadata.agor.origin as vendored', () => {
    const content = [
      '---',
      'name: django-perf-review',
      'metadata:',
      '  agor:',
      '    origin:',
      '      provider: git',
      '      uri: https://github.com/example-org/skills/tree/1a2b3c4d/skills/django-perf-review',
      '      commit: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      '      license: Apache-2.0',
      '      reviewed_by: amin',
      '      reviewed_at: "2026-10-20"',
      '---',
      'Body',
    ].join('\n');
    const { skills } = assembleTeammateSkills({ ...empty, knowledge: [kbDoc({ content })] });
    expect(skills[0]).toEqual(
      expect.objectContaining({
        source: 'vendor',
        status: 'reviewed',
        version_label: 'example-org/skills@1a2b3c4',
        updated_at: '2026-10-20',
        origin: expect.objectContaining({ license: 'Apache-2.0', reviewed_by: 'amin' }),
      })
    );
  });

  it('marks a vendored skill without a reviewer as unreviewed', () => {
    const { skills } = assembleTeammateSkills({
      ...empty,
      knowledge: [
        kbDoc({
          content: 'Body',
          metadata: { agor: { origin: { provider: 'git', commit: 'abcdef1234' } } },
        }),
      ],
    });
    expect(skills[0]).toEqual(
      expect.objectContaining({
        source: 'vendor',
        status: 'unreviewed',
        version_label: 'git@abcdef1',
      })
    );
  });

  it('lists in-repo skills with a short sha pin and no drift claim when drift was not computed', () => {
    const { skills } = assembleTeammateSkills({ ...empty, inRepo: [repoFile()] });
    expect(skills[0]).toEqual(
      expect.objectContaining({
        source: 'in-repo',
        status: 'ok',
        version_label: 'sha aaaaaaa',
        updated_at: '2026-10-02T00:00:00.000Z',
      })
    );
    expect(skills[0].drift).toBeUndefined();
  });

  it('adds only the harness names that no other source explains', () => {
    const { skills } = assembleTeammateSkills({
      ...empty,
      inRepo: [repoFile()],
      harness: {
        skills: ['Connect-SaaS', 'plugin:pdf', 'pdf', '', 'xlsx'],
        at: '2026-10-13T00:00:00Z',
      },
    });
    expect(skills.map((skill) => [skill.name, skill.source, skill.status])).toEqual([
      ['connect-saas', 'in-repo', 'ok'],
      ['plugin:pdf', 'harness', 'synced'],
      ['xlsx', 'harness', 'synced'],
    ]);
    expect(skills[1]).toEqual(
      expect.objectContaining({
        version_label: 'loaded last run',
        updated_at: '2026-10-13T00:00:00Z',
      })
    );
  });
});

describe('assembleTeammateSkills: drift', () => {
  const peers = [
    {
      branch_id: 'b-2' as BranchID,
      name: 'Bjorn',
      skills: [
        { name: 'connect-saas', sha256: SHA_A },
        { name: 'gateway-channels', sha256: SHA_B },
      ],
    },
    {
      branch_id: 'b-3' as BranchID,
      name: 'Ivar',
      skills: [{ name: 'GATEWAY-CHANNELS', sha256: SHA_C }],
    },
  ];

  it('reports same when every readable copy matches', () => {
    const { skills } = assembleTeammateSkills({ ...empty, inRepo: [repoFile()], peers });
    expect(skills[0].status).toBe('same');
    expect(skills[0].drift).toEqual({
      variants: 1,
      shared_with: [{ branch_id: 'b-2', name: 'Bjorn', sha256: SHA_A }],
    });
  });

  it('counts distinct variants across teammates, case-insensitively by name', () => {
    const { skills } = assembleTeammateSkills({
      ...empty,
      inRepo: [repoFile({ name: 'gateway-channels', sha256: SHA_A })],
      peers,
    });
    expect(skills[0].status).toBe('drift');
    expect(skills[0].drift?.variants).toBe(3);
    expect(skills[0].drift?.shared_with.map((peer) => peer.name)).toEqual(['Bjorn', 'Ivar']);
  });

  it('reports same with no peers to compare against', () => {
    const { skills } = assembleTeammateSkills({ ...empty, inRepo: [repoFile()], peers: [] });
    expect(skills[0].status).toBe('same');
    expect(skills[0].drift).toEqual({ variants: 1, shared_with: [] });
  });
});

describe('parseSkillGaps', () => {
  const doc = (content: string) => ({ uri: 'agor://kb/document/gaps', url: null, content });

  it('reports a missing gap list', () => {
    expect(parseSkillGaps(null, [])).toEqual({ status: 'missing', items: [] });
  });

  it('parses gaps, closes the ones with an equipped skill, and orders open-first by priority', () => {
    const content = [
      '---',
      'gaps:',
      '  - skill: upstream-sync-conflict-triage',
      '    priority: P1',
      '  - skill: release-evidence-pack',
      '    priority: p0',
      '    source: agor://kb/document/audit',
      '    note: no canonical skill yet',
      '  - skill: Connect-SaaS',
      '    priority: P0',
      '  - skill: odd-priority',
      '    priority: urgent',
      '  - note: entry without a skill is dropped',
      '---',
      '# Gaps',
    ].join('\n');
    const gaps = parseSkillGaps(doc(content), ['connect-saas']);
    expect(gaps.status).toBe('ok');
    expect(gaps.uri).toBe('agor://kb/document/gaps');
    expect(gaps.items).toEqual([
      {
        skill: 'release-evidence-pack',
        priority: 'P0',
        source: 'agor://kb/document/audit',
        note: 'no canonical skill yet',
        closed: false,
      },
      { skill: 'upstream-sync-conflict-triage', priority: 'P1', closed: false },
      { skill: 'odd-priority', priority: 'P2', closed: false },
      { skill: 'Connect-SaaS', priority: 'P0', closed: true },
    ]);
  });

  it('flags a document without a gaps list as invalid', () => {
    expect(parseSkillGaps(doc('# Just prose'), [])).toEqual(
      expect.objectContaining({ status: 'invalid', items: [], error: expect.any(String) })
    );
    expect(parseSkillGaps(doc('---\ngaps: nope\n---\n'), []).status).toBe('invalid');
  });

  it('closes gaps against every source, including harness-only skills', () => {
    const gapsDoc = doc('---\ngaps:\n  - skill: pdf\n    priority: P2\n---\n');
    const { gaps } = assembleTeammateSkills({
      ...empty,
      harness: { skills: ['pdf'] },
      gapsDocs: [gapsDoc],
    });
    expect(gaps.items).toEqual([{ skill: 'pdf', priority: 'P2', closed: true }]);
  });
});

describe('helpers', () => {
  it('skillKey ignores case and a plugin prefix', () => {
    expect(skillKey(' Plugin:PDF ')).toBe('pdf');
  });

  it('readSkillOrigin accepts metadata.origin as well as metadata.agor.origin', () => {
    expect(readSkillOrigin({ metadata: { origin: { provider: 'git' } } })).toEqual(
      expect.objectContaining({ provider: 'git' })
    );
    expect(readSkillOrigin({ metadata: { version: '1.0' } }, null)).toBeUndefined();
  });

  it('vendorPinLabel falls back without a GitHub URI', () => {
    expect(vendorPinLabel({ provider: 'marketplace' })).toBe('marketplace');
    expect(vendorPinLabel({ uri: 'https://github.com/o/r.git' })).toBe('o/r');
  });
});

describe('mergeSkillGaps', () => {
  const gapDoc = (path: string, body: string, namespace_slug?: string) => ({
    uri: `agor://kb/${path}`,
    path,
    namespace_slug,
    content: `---\ngaps:\n${body}---\n`,
  });

  it('reports missing with no documents', () => {
    expect(mergeSkillGaps([], [])).toEqual({ status: 'missing', items: [] });
  });

  it('merges documents, the first to list a skill winning, and records every source', () => {
    const folder = gapDoc(
      'skills/frink/_gaps.md',
      '  - skill: release-evidence-pack\n    priority: P0\n',
      'team'
    );
    const primary = gapDoc(
      'skills/_gaps.md',
      '  - skill: Release-Evidence-Pack\n    priority: P2\n  - skill: pdf\n    priority: P1\n',
      'teammate-frink'
    );
    const merged = mergeSkillGaps([folder, primary], ['pdf']);
    expect(merged.status).toBe('ok');
    expect(merged.uri).toBe('agor://kb/skills/frink/_gaps.md');
    expect(merged.items).toEqual([
      { skill: 'release-evidence-pack', priority: 'P0', closed: false },
      { skill: 'pdf', priority: 'P1', closed: true },
    ]);
    expect(merged.documents).toEqual([
      {
        uri: 'agor://kb/skills/frink/_gaps.md',
        path: 'skills/frink/_gaps.md',
        namespace_slug: 'team',
      },
      {
        uri: 'agor://kb/skills/_gaps.md',
        path: 'skills/_gaps.md',
        namespace_slug: 'teammate-frink',
      },
    ]);
  });

  it('skips an unreadable document when another one parses', () => {
    const broken = { uri: 'agor://kb/broken', path: 'skills/frink/_gaps.md', content: '# prose' };
    const good = gapDoc('skills/_gaps.md', '  - skill: pdf\n    priority: P1\n');
    expect(mergeSkillGaps([broken, good], []).items).toHaveLength(1);
    expect(mergeSkillGaps([broken], []).status).toBe('invalid');
  });
});

describe('Knowledge namespace on skills', () => {
  it('carries the namespace through so a shared source is visible', () => {
    const { skills } = assembleTeammateSkills({
      ...empty,
      knowledge: [
        kbDoc({ content: 'Body', namespace_slug: 'team-skills', namespace_name: 'Team skills' }),
      ],
    });
    expect(skills[0]).toMatchObject({
      namespace_slug: 'team-skills',
      namespace_name: 'Team skills',
    });
  });
});
