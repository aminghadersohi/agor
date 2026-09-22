/**
 * Provisioning correctness hinges on selecting the right `git worktree add`
 * invocation for the actual ref state. Getting this wrong is the classic
 * "ref created twice → git exits 1" and "detached checkout of a fresh branch"
 * family of provisioning failures, so pin the argument construction directly.
 *
 * Privacy: uses only generic placeholder names.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorktreeAddArgs, directoryHasEntries } from './index';

const PATH = '/worktrees/sample-app/feature-x';

describe('buildWorktreeAddArgs', () => {
  it('creates a NEW branch from the base ref exactly as given (fresh worktree)', () => {
    // createBranch=true → branch off the caller-supplied base, never a second
    // `git branch` first (which would make `-b` collide and exit 1).
    //
    // The base ref arrives already resolved (see `resolveGitRef` and
    // `effectiveSourceBranch` in ./index). This builder must pass it through
    // verbatim: qualifying a bare name with `origin/` here would silently
    // retarget a deliberately local base, and would break the non-origin
    // remote and raw-SHA bases that callers already resolve for themselves.
    const args = buildWorktreeAddArgs({
      branchPath: PATH,
      ref: 'feature-x',
      createBranch: true,
      sourceBranch: 'main',
      refType: 'branch',
    });
    expect(args).toEqual(['worktree', 'add', '-b', 'feature-x', '--', PATH, 'main']);
  });

  it('passes an already-qualified base ref through untouched (no re-prefixing)', () => {
    // Remote-tracking refs, operation-local fetch namespaces
    // (`refs/agor/base/<uuid>`) and raw SHAs all reach this builder fully
    // resolved. Re-prefixing any of them would produce a ref that does not
    // exist.
    for (const base of ['origin/main', 'upstream/release', 'refs/agor/base/abc123']) {
      expect(
        buildWorktreeAddArgs({
          branchPath: PATH,
          ref: 'feature-x',
          createBranch: true,
          sourceBranch: base,
          refType: 'branch',
        })
      ).toEqual(['worktree', 'add', '-b', 'feature-x', '--', PATH, base]);
    }
  });

  it('checks out an EXISTING ref without -b (no double-create)', () => {
    // createBranch=false → attach the worktree to the existing ref. Passing
    // `-b` here is exactly the "ref already exists, git exits 1" bug.
    const args = buildWorktreeAddArgs({
      branchPath: PATH,
      ref: 'existing-feature',
      createBranch: false,
    });
    expect(args).toEqual(['worktree', 'add', '--', PATH, 'existing-feature']);
    expect(args).not.toContain('-b');
  });

  it('creates a new branch from a TAG using the raw tag ref (no origin/ prefix)', () => {
    const args = buildWorktreeAddArgs({
      branchPath: PATH,
      ref: 'release-branch',
      createBranch: true,
      sourceBranch: 'v1.2.3',
      refType: 'tag',
    });
    expect(args).toEqual(['worktree', 'add', '-b', 'release-branch', '--', PATH, 'v1.2.3']);
  });

  it('always uses -- to terminate options (guards against ref option-injection)', () => {
    const args = buildWorktreeAddArgs({
      branchPath: PATH,
      ref: 'feature-x',
      createBranch: true,
      sourceBranch: 'main',
    });
    const dashDash = args.indexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    // Every positional (path + base ref) comes after the `--` terminator.
    expect(args.slice(dashDash + 1)).toEqual([PATH, 'main']);
  });
});

describe('directoryHasEntries (retry idempotency guard)', () => {
  it('returns false for a missing path', () => {
    expect(directoryHasEntries(join(tmpdir(), `nope-${Math.random().toString(36).slice(2)}`))).toBe(
      false
    );
  });

  it("returns false for an empty directory (a failed attempt's leftover — must be retryable)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'agor-empty-'));
    expect(directoryHasEntries(dir)).toBe(false);
  });

  it('returns true for a non-empty directory (genuinely occupied — must be refused)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agor-full-'));
    writeFileSync(join(dir, 'README.md'), 'x');
    expect(directoryHasEntries(dir)).toBe(true);
  });

  it('returns true for a file at the path (fail safe, do not clobber)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agor-file-'));
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(directoryHasEntries(file)).toBe(true);
  });
});
