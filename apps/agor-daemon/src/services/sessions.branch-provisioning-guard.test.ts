/**
 * Session creation must translate a branch's filesystem provisioning state
 * into a clear domain error instead of letting a downstream simple-git call
 * throw a raw ENOENT ("Cannot use simple-git on a directory that does not
 * exist"). These tests pin that guard (`assertBranchFilesystemUsable`) against
 * a real database + real on-disk directories.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BranchRepository, generateId, RepoRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;

function validCheckoutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agor-branch-'));
  writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x');
  return dir;
}
function missingDir(): string {
  return join(tmpdir(), `agor-missing-${generateId()}`);
}

async function makeBranch(db: any, over: Partial<Branch>): Promise<UUID> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UUID,
    ...over,
  });
  return branch.branch_id as UUID;
}

function guard(service: SessionsService): (branchId: string) => Promise<void> {
  return (service as any).assertBranchFilesystemUsable.bind(service);
}

describe('SessionsService branch provisioning guard', () => {
  dbTest('rejects creating branches with a clear "in progress" error', async ({ db }) => {
    const branchId = await makeBranch(db, { filesystem_status: 'creating', path: missingDir() });
    const service = new SessionsService(db, STUB_APP);
    await expect(guard(service)(branchId)).rejects.toThrow(/provisioning is still in progress/i);
  });

  dbTest('rejects failed branches and surfaces the stored provisioning error', async ({ db }) => {
    const branchId = await makeBranch(db, {
      filesystem_status: 'failed',
      error_message: 'git fetch rejected the ref',
      path: missingDir(),
    });
    const service = new SessionsService(db, STUB_APP);
    await expect(guard(service)(branchId)).rejects.toThrow(/git fetch rejected the ref/);
  });

  dbTest('rejects ready branches whose directory vanished out-of-band', async ({ db }) => {
    const branchId = await makeBranch(db, { filesystem_status: 'ready', path: missingDir() });
    const service = new SessionsService(db, STUB_APP);
    await expect(guard(service)(branchId)).rejects.toThrow(/missing from disk/i);
  });

  dbTest('allows a ready branch with a real checkout on disk', async ({ db }) => {
    const branchId = await makeBranch(db, { filesystem_status: 'ready', path: validCheckoutDir() });
    const service = new SessionsService(db, STUB_APP);
    await expect(guard(service)(branchId)).resolves.toBeUndefined();
  });

  dbTest('allows legacy rows (undefined status) with an existing directory', async ({ db }) => {
    const branchId = await makeBranch(db, { path: validCheckoutDir() });
    const service = new SessionsService(db, STUB_APP);
    await expect(guard(service)(branchId)).resolves.toBeUndefined();
  });
});
