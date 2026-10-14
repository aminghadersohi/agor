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
    expect(teammateSkillKeys('Professor Frink')).toEqual(['professor', 'frink', 'professor-frink']);
    expect(teammateSkillKeys('Freja Lind')).toEqual(['freja', 'lind', 'freja-lind']);
  });

  it('yields one key for a one-word name, ignoring emoji and punctuation', () => {
    expect(teammateSkillKeys('Lagertha ⚔️')).toEqual(['lagertha']);
    expect(teammateSkillKeys('  Saga!  ')).toEqual(['saga']);
  });

  it('folds accents and case', () => {
    expect(teammateSkillKeys('Linnéa ÅSTRÖM')).toEqual(['linnea', 'astrom', 'linnea-astrom']);
    expect(slugify('Ylva_von  Berg')).toBe('ylva-von-berg');
  });

  it('has no keys for a name with no letters or digits', () => {
    expect(teammateSkillKeys('🤖')).toEqual([]);
  });
});

describe('skillFolder', () => {
  it('reads the folder of skills/<folder>/… paths only', () => {
    expect(skillFolder('skills/frink/connect-saas.md')).toBe('frink');
    expect(skillFolder('skills/Frink/x/SKILL.md')).toBe('frink');
    expect(skillFolder('skills/connect-saas.md')).toBeUndefined();
    expect(skillFolder('docs/frink/x.md')).toBeUndefined();
  });
});

describe('assignTeammateSkillDocs', () => {
  const FRINK_NS = 'ns-frink';
  const TEAM_NS = 'ns-team';
  const doc = (id: string, namespace_id: string, path: string): SkillDocRef => ({
    document_id: id,
    namespace_id,
    path,
  });
  const docs = [
    doc('frink-own', FRINK_NS, 'skills/frink/review.md'),
    doc('freja-in-frink-ns', FRINK_NS, 'skills/freja/triage.md'),
    doc('frink-unfoldered', FRINK_NS, 'skills/connect-saas/SKILL.md'),
    doc('frink-outside-skills', FRINK_NS, 'playbooks/deploy.md'),
    doc('unknown-folder-in-frink-ns', FRINK_NS, 'skills/nobody/x.md'),
    doc('frink-in-team-ns', TEAM_NS, 'skills/professor/deep-dive.md'),
    doc('unfoldered-in-team-ns', TEAM_NS, 'skills/loose.md'),
    doc('freja-in-team-ns', TEAM_NS, 'skills/freja-lind/notes.md'),
  ];
  const frink = teammateSkillKeys('Professor Frink');
  const freja = teammateSkillKeys('Freja Lind');
  const ids = (assigned: SkillDocRef[]) => assigned.map((d) => d.document_id);

  it("gives the namespace owner its folder and unfoldered skills, not other teammates' folders", () => {
    const assigned = assignTeammateSkillDocs(docs, {
      ownKeys: frink,
      otherKeys: freja,
      primaryNamespaceId: FRINK_NS,
    });
    expect(ids(assigned)).toEqual([
      'frink-own',
      'frink-unfoldered',
      'frink-outside-skills',
      'unknown-folder-in-frink-ns',
      'frink-in-team-ns',
    ]);
  });

  it('assigns folder skills from any namespace to a teammate without a primary namespace', () => {
    const assigned = assignTeammateSkillDocs(docs, { ownKeys: freja, otherKeys: frink });
    expect(ids(assigned)).toEqual(['freja-in-frink-ns', 'freja-in-team-ns']);
  });

  it('never takes unfoldered skills from a namespace that is not the primary one', () => {
    const assigned = assignTeammateSkillDocs(docs, {
      ownKeys: freja,
      otherKeys: frink,
      primaryNamespaceId: 'ns-freja',
    });
    expect(ids(assigned)).not.toContain('unfoldered-in-team-ns');
    expect(ids(assigned)).not.toContain('frink-unfoldered');
  });

  it("keeps a folder named after a key both teammates share in each one's panel", () => {
    const lind = doc('lind-shared', FRINK_NS, 'skills/lind/x.md');
    const ownerView = assignTeammateSkillDocs([lind], {
      ownKeys: ['lind', 'karl', 'karl-lind'],
      otherKeys: freja,
      primaryNamespaceId: FRINK_NS,
    });
    expect(ids(ownerView)).toEqual(['lind-shared']);
  });

  it('dedupes by document id, keeping the first occurrence', () => {
    const repeated = [docs[0], { ...docs[0] }, docs[2], docs[0]];
    const assigned = assignTeammateSkillDocs(repeated, {
      ownKeys: frink,
      otherKeys: [],
      primaryNamespaceId: FRINK_NS,
    });
    expect(ids(assigned)).toEqual(['frink-own', 'frink-unfoldered']);
    expect(assigned[0]).toBe(docs[0]);
  });
});

describe('teammateGapPaths', () => {
  it('looks for one gap list per key', () => {
    expect(teammateGapPaths(['freja', 'lind', 'freja-lind', 'lind'])).toEqual([
      'skills/freja/_gaps.md',
      'skills/lind/_gaps.md',
      'skills/freja-lind/_gaps.md',
    ]);
  });
});

describe('providerSkillAssignment', () => {
  it('assigns _shared to everyone and other folders to that key', () => {
    expect(providerSkillAssignment('skills/_shared/standing-facts.md')).toEqual({ kind: 'shared' });
    expect(providerSkillAssignment('skills/Frink/research.md')).toEqual({
      kind: 'teammate',
      key: 'frink',
    });
    expect(providerSkillAssignment('skills/triage/x/SKILL.md')).toEqual({
      kind: 'teammate',
      key: 'triage',
    });
  });

  it('ignores README files and paths outside a skills folder', () => {
    expect(providerSkillAssignment('skills/README.md')).toBeUndefined();
    expect(providerSkillAssignment('skills/frink/README.md')).toBeUndefined();
    expect(providerSkillAssignment('skills/loose.md')).toBeUndefined();
    expect(providerSkillAssignment('docs/frink/x.md')).toBeUndefined();
  });

  it('matches a teammate by any of its keys, plus shared skills', () => {
    const keys = teammateSkillKeys('Professor Frink');
    expect(providerSkillIsFor('skills/frink/x.md', keys)).toBe(true);
    expect(providerSkillIsFor('skills/professor-frink/x.md', keys)).toBe(true);
    expect(providerSkillIsFor('skills/_shared/x.md', keys)).toBe(true);
    expect(providerSkillIsFor('skills/maya/x.md', keys)).toBe(false);
    expect(providerSkillIsFor('skills/frink/README.md', keys)).toBe(false);
  });
});
