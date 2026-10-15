import { describe, expect, it } from 'vitest';
import {
  assignTeammateSkillDocs,
  providerSkillAssignment,
  providerSkillIsFor,
  type SkillDocRef,
  skillFolder,
  slugify,
  teammateGapPaths,
  teammateSkillKeys,
} from './assign';

describe('teammateSkillKeys', () => {
  it('uses each slug token plus the full slug', () => {
    expect(teammateSkillKeys('Professor Fritz')).toEqual(['professor', 'fritz', 'professor-fritz']);
    expect(teammateSkillKeys('Freda Lund')).toEqual(['freda', 'lund', 'freda-lund']);
  });

  it('yields one key for a one-word name, ignoring emoji and punctuation', () => {
    expect(teammateSkillKeys('Larkspur ⚔️')).toEqual(['larkspur']);
    expect(teammateSkillKeys('  Sage!  ')).toEqual(['sage']);
  });

  it('folds accents and case', () => {
    expect(teammateSkillKeys('Lýra ÅSTRÖM')).toEqual(['lyra', 'astrom', 'lyra-astrom']);
    expect(slugify('Yara_von  Berg')).toBe('yara-von-berg');
  });

  it('has no keys for a name with no letters or digits', () => {
    expect(teammateSkillKeys('🤖')).toEqual([]);
  });
});

describe('skillFolder', () => {
  it('reads the folder of skills/<folder>/… paths only', () => {
    expect(skillFolder('skills/fritz/connect-saas.md')).toBe('fritz');
    expect(skillFolder('skills/Fritz/x/SKILL.md')).toBe('fritz');
    expect(skillFolder('skills/connect-saas.md')).toBeUndefined();
    expect(skillFolder('docs/fritz/x.md')).toBeUndefined();
  });
});

describe('assignTeammateSkillDocs', () => {
  const FRITZ_NS = 'ns-fritz';
  const TEAM_NS = 'ns-team';
  const doc = (id: string, namespace_id: string, path: string): SkillDocRef => ({
    document_id: id,
    namespace_id,
    path,
  });
  const docs = [
    doc('fritz-own', FRITZ_NS, 'skills/fritz/review.md'),
    doc('freda-in-fritz-ns', FRITZ_NS, 'skills/freda/triage.md'),
    doc('fritz-unfoldered', FRITZ_NS, 'skills/connect-saas/SKILL.md'),
    doc('fritz-outside-skills', FRITZ_NS, 'playbooks/deploy.md'),
    doc('unknown-folder-in-fritz-ns', FRITZ_NS, 'skills/nobody/x.md'),
    doc('fritz-in-team-ns', TEAM_NS, 'skills/professor/deep-dive.md'),
    doc('unfoldered-in-team-ns', TEAM_NS, 'skills/loose.md'),
    doc('freda-in-team-ns', TEAM_NS, 'skills/freda-lund/notes.md'),
  ];
  const fritz = teammateSkillKeys('Professor Fritz');
  const freda = teammateSkillKeys('Freda Lund');
  const ids = (assigned: SkillDocRef[]) => assigned.map((d) => d.document_id);

  it("gives the namespace owner its folder and unfoldered skills, not other teammates' folders", () => {
    const assigned = assignTeammateSkillDocs(docs, {
      ownKeys: fritz,
      otherKeys: freda,
      primaryNamespaceId: FRITZ_NS,
    });
    expect(ids(assigned)).toEqual([
      'fritz-own',
      'fritz-unfoldered',
      'fritz-outside-skills',
      'unknown-folder-in-fritz-ns',
      'fritz-in-team-ns',
    ]);
  });

  it('assigns folder skills from any namespace to a teammate without a primary namespace', () => {
    const assigned = assignTeammateSkillDocs(docs, { ownKeys: freda, otherKeys: fritz });
    expect(ids(assigned)).toEqual(['freda-in-fritz-ns', 'freda-in-team-ns']);
  });

  it('never takes unfoldered skills from a namespace that is not the primary one', () => {
    const assigned = assignTeammateSkillDocs(docs, {
      ownKeys: freda,
      otherKeys: fritz,
      primaryNamespaceId: 'ns-freda',
    });
    expect(ids(assigned)).not.toContain('unfoldered-in-team-ns');
    expect(ids(assigned)).not.toContain('fritz-unfoldered');
  });

  it("keeps a folder named after a key both teammates share in each one's panel", () => {
    const lund = doc('lund-shared', FRITZ_NS, 'skills/lund/x.md');
    const ownerView = assignTeammateSkillDocs([lund], {
      ownKeys: ['lund', 'karl', 'karl-lund'],
      otherKeys: freda,
      primaryNamespaceId: FRITZ_NS,
    });
    expect(ids(ownerView)).toEqual(['lund-shared']);
  });

  it('dedupes by document id, keeping the first occurrence', () => {
    const repeated = [docs[0], { ...docs[0] }, docs[2], docs[0]];
    const assigned = assignTeammateSkillDocs(repeated, {
      ownKeys: fritz,
      otherKeys: [],
      primaryNamespaceId: FRITZ_NS,
    });
    expect(ids(assigned)).toEqual(['fritz-own', 'fritz-unfoldered']);
    expect(assigned[0]).toBe(docs[0]);
  });
});

describe('teammateGapPaths', () => {
  it('looks for one gap list per key', () => {
    expect(teammateGapPaths(['freda', 'lund', 'freda-lund', 'lund'])).toEqual([
      'skills/freda/_gaps.md',
      'skills/lund/_gaps.md',
      'skills/freda-lund/_gaps.md',
    ]);
  });
});

describe('providerSkillAssignment', () => {
  it('assigns _shared to everyone and other folders to that key', () => {
    expect(providerSkillAssignment('skills/_shared/standing-facts.md')).toEqual({ kind: 'shared' });
    expect(providerSkillAssignment('skills/Fritz/research.md')).toEqual({
      kind: 'teammate',
      key: 'fritz',
    });
    expect(providerSkillAssignment('skills/triage/x/SKILL.md')).toEqual({
      kind: 'teammate',
      key: 'triage',
    });
  });

  it('ignores README files and paths outside a skills folder', () => {
    expect(providerSkillAssignment('skills/README.md')).toBeUndefined();
    expect(providerSkillAssignment('skills/fritz/README.md')).toBeUndefined();
    expect(providerSkillAssignment('skills/loose.md')).toBeUndefined();
    expect(providerSkillAssignment('docs/fritz/x.md')).toBeUndefined();
  });

  it('matches a teammate by any of its keys, plus shared skills', () => {
    const keys = teammateSkillKeys('Professor Fritz');
    expect(providerSkillIsFor('skills/fritz/x.md', keys)).toBe(true);
    expect(providerSkillIsFor('skills/professor-fritz/x.md', keys)).toBe(true);
    expect(providerSkillIsFor('skills/_shared/x.md', keys)).toBe(true);
    expect(providerSkillIsFor('skills/mila/x.md', keys)).toBe(false);
    expect(providerSkillIsFor('skills/fritz/README.md', keys)).toBe(false);
  });
});

describe('assignTeammateSkillDocs and _shared', () => {
  const doc = (document_id: string, namespace_id: string, path: string): SkillDocRef => ({
    document_id,
    namespace_id,
    path,
  });

  it('gives provider _shared skills to every teammate, but not _shared elsewhere', () => {
    const docs = [
      doc('a', 'provider', 'skills/_shared/standing-facts.md'),
      doc('b', 'other', 'skills/_shared/ignored.md'),
      doc('c', 'provider', 'skills/mila/brief.md'),
    ];
    expect(
      assignTeammateSkillDocs(docs, {
        ownKeys: ['sienna'],
        otherKeys: ['mila'],
        sharedNamespaceIds: ['provider'],
      }).map((d) => d.document_id)
    ).toEqual(['a']);
  });
});
