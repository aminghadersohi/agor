import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRANCH_SKILL_SCAN_LIMITS, scanBranchSkills } from './skills';

let sandbox: string;
let worktree: string;

async function put(relativePath: string, content: string): Promise<void> {
  const target = path.join(worktree, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'agor-skills-scan-'));
  worktree = path.join(sandbox, 'worktree');
  await mkdir(worktree);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('scanBranchSkills', () => {
  it('finds the three supported layouts and reads name/description from frontmatter', async () => {
    const folderSkill =
      '---\nname: connect-saas\ndescription: Wire a SaaS connector.\n---\n# Body\n';
    await put('skills/connect-saas/SKILL.md', folderSkill);
    await put('skills/flat-skill.md', '# No frontmatter\n');
    await put('.claude/skills/agor-ops/SKILL.md', '---\ndescription: Agor operations\n---\n');

    const scan = await scanBranchSkills(worktree);

    expect(scan.truncated).toBe(false);
    expect(scan.skills.map((skill) => [skill.name, skill.path])).toEqual([
      ['connect-saas', 'skills/connect-saas/SKILL.md'],
      ['flat-skill', 'skills/flat-skill.md'],
      ['agor-ops', '.claude/skills/agor-ops/SKILL.md'],
    ]);
    const connect = scan.skills[0];
    expect(connect.description).toBe('Wire a SaaS connector.');
    expect(connect.sha256).toBe(sha(folderSkill));
    expect(Number.isNaN(Date.parse(connect.mtime))).toBe(false);
    expect(scan.skills[2].description).toBe('Agor operations');
  });

  it('prefers the frontmatter name over the folder name', async () => {
    await put('skills/folder-name/SKILL.md', '---\nname: declared-name\n---\n');
    const scan = await scanBranchSkills(worktree);
    expect(scan.skills[0].name).toBe('declared-name');
  });

  it('falls back to the file name when the frontmatter is malformed or not a mapping', async () => {
    await put('skills/broken/SKILL.md', '---\nname: [unclosed\n---\n');
    await put('skills/listy/SKILL.md', '---\n- a\n- b\n---\n');
    const scan = await scanBranchSkills(worktree);
    expect(scan.skills.map((skill) => skill.name)).toEqual(['broken', 'listy']);
  });

  it('skips README and underscore files under skills/', async () => {
    await put('skills/README.md', '# Index');
    await put('skills/_gaps.md', '---\ngaps: []\n---\n');
    await put('skills/real.md', '# Real');
    const scan = await scanBranchSkills(worktree);
    expect(scan.skills.map((skill) => skill.name)).toEqual(['real']);
  });

  it('ignores other locations and nested SKILL.md files', async () => {
    await put('docs/skills/x/SKILL.md', '# not scanned');
    await put('skills/a/nested/SKILL.md', '# not scanned');
    await put('.claude/skills/flat.md', '# not scanned');
    const scan = await scanBranchSkills(worktree);
    expect(scan.skills).toEqual([]);
  });

  it('refuses files over the size bound without reading them', async () => {
    await put('skills/huge/SKILL.md', 'x'.repeat(2_048));
    await put('skills/small/SKILL.md', 'ok');
    const scan = await scanBranchSkills(worktree, {
      ...BRANCH_SKILL_SCAN_LIMITS,
      maxFileBytes: 1_024,
    });
    expect(scan.skills.map((skill) => skill.name)).toEqual(['small']);
    expect(scan.skipped).toEqual([{ path: 'skills/huge/SKILL.md', reason: 'too-large' }]);
  });

  it('stops at the file-count bound and reports truncation', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await put(`skills/${name}/SKILL.md`, name);
    const scan = await scanBranchSkills(worktree, { ...BRANCH_SKILL_SCAN_LIMITS, maxFiles: 2 });
    expect(scan.skills.map((skill) => skill.name)).toEqual(['a', 'b']);
    expect(scan.truncated).toBe(true);
  });

  it('stops at the directory-entry bound and reports truncation', async () => {
    for (const name of ['a', 'b', 'c']) await put(`skills/${name}.md`, name);
    const scan = await scanBranchSkills(worktree, {
      ...BRANCH_SKILL_SCAN_LIMITS,
      maxDirEntries: 2,
    });
    expect(scan.skills).toHaveLength(2);
    expect(scan.truncated).toBe(true);
  });

  it('follows symlinks that stay inside the worktree and lists the target once', async () => {
    await put('.agents/skills/bump/SKILL.md', '---\nname: bump\n---\n');
    await mkdir(path.join(worktree, '.claude/skills'), { recursive: true });
    await mkdir(path.join(worktree, 'skills'), { recursive: true });
    await symlink('../../.agents/skills/bump', path.join(worktree, '.claude/skills/bump'));
    await symlink('../.agents/skills/bump', path.join(worktree, 'skills/bump'));

    const scan = await scanBranchSkills(worktree);

    expect(scan.skills.map((skill) => [skill.name, skill.path])).toEqual([
      ['bump', 'skills/bump/SKILL.md'],
    ]);
  });

  it('never reads through a symlink that escapes the worktree', async () => {
    const outside = path.join(sandbox, 'outside');
    await mkdir(path.join(outside, 'secret'), { recursive: true });
    await writeFile(path.join(outside, 'secret', 'SKILL.md'), 'top secret');
    await writeFile(path.join(outside, 'leak.md'), 'top secret');
    await mkdir(path.join(worktree, 'skills'), { recursive: true });
    await symlink(path.join(outside, 'secret'), path.join(worktree, 'skills/secret'));
    await symlink(path.join(outside, 'leak.md'), path.join(worktree, 'skills/leak.md'));

    const scan = await scanBranchSkills(worktree);

    expect(scan.skills).toEqual([]);
    expect(scan.skipped).toEqual(
      expect.arrayContaining([
        { path: 'skills/secret/SKILL.md', reason: 'outside-worktree' },
        { path: 'skills/leak.md', reason: 'outside-worktree' },
      ])
    );
  });

  it('refuses a skills root that is itself a symlink out of the worktree', async () => {
    const outside = path.join(sandbox, 'outside-skills');
    await mkdir(path.join(outside, 'x'), { recursive: true });
    await writeFile(path.join(outside, 'x', 'SKILL.md'), 'top secret');
    await symlink(outside, path.join(worktree, 'skills'));

    const scan = await scanBranchSkills(worktree);

    expect(scan.skills).toEqual([]);
    expect(scan.skipped).toEqual([{ path: 'skills', reason: 'outside-worktree' }]);
  });

  it('returns an empty scan for a missing worktree', async () => {
    const scan = await scanBranchSkills(path.join(sandbox, 'gone'));
    expect(scan).toEqual({ skills: [], skipped: [], truncated: false });
  });
});
