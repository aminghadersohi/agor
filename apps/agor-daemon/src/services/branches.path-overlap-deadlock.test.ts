import { BranchRepository, runWithTenantContext } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import { markBranchArchiveDeleteAuthorized } from '../utils/branch-archive-delete-authorization';
import { spawnExecutor } from '../utils/spawn-executor';
import { BranchesService } from './branches';

vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<object>()),
  spawnExecutor: vi.fn(),
}));

/**
 * SC-121372: two Branch rows that ended up sharing a filesystem path used to
 * deadlock archive/delete permanently. These exercise the exact service
 * method the `/branches/:id/archive-or-delete` route (and therefore the
 * `agor_branches_delete` MCP tool) calls, not the repository guard directly.
 */
function buildApp(): Application {
  return {
    get: () => ({ execution: {} }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'fixture-command-token') },
    service: () => ({ emit: vi.fn() }),
  } as unknown as Application;
}

function paramsFor(user: { user_id: string }): AuthenticatedParams {
  return {
    provider: 'mcp',
    user,
    tenant: { tenant_id: 'default' as TenantID, source: 'explicit' },
  } as AuthenticatedParams;
}

function serviceWithMockedGet(db: Parameters<typeof BranchesService>[0]) {
  const service = new BranchesService(db, buildApp());
  vi.spyOn(service, 'get').mockImplementation(
    async (id: BranchID) => (await new BranchRepository(db).findById(id))! as never
  );
  vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
    env: {},
    branchFsAccess: 'write',
  } as never);
  return service;
}

test('two branch rows sharing a path where neither owns anything on disk can both be deleted through the archive-or-delete service', async ({
  db,
}) => {
  vi.mocked(spawnExecutor).mockClear();
  const { branch: failed, user } = await seedEnvironmentCommandBranch(db);
  const branches = new BranchRepository(db);
  await branches.update(failed.branch_id, { filesystem_status: 'failed' });
  const cleaned = await branches.create({
    repo_id: failed.repo_id,
    name: 'sibling-cleaned',
    ref: 'sibling-cleaned',
    branch_unique_id: 9700001,
    path: failed.path,
    created_by: user.user_id,
    filesystem_status: 'cleaned',
    archived: true,
  });

  const service = serviceWithMockedGet(db);
  await runWithTenantContext('default', async () => {
    for (const branch of [failed, cleaned]) {
      const params = paramsFor(user);
      markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'delete');
      await expect(
        service.archiveOrDelete(
          branch.branch_id,
          { metadataAction: 'delete', filesystemAction: 'deleted' },
          params
        )
      ).resolves.toMatchObject({ deletion_status: 'deleting' });
    }
  });
  expect(spawnExecutor).toHaveBeenCalledTimes(2);
});

test('a live workspace still blocks deletion of a broken sibling sharing its path, and remains deletable itself, through the archive-or-delete service', async ({
  db,
}) => {
  vi.mocked(spawnExecutor).mockClear();
  const { branch: live, user } = await seedEnvironmentCommandBranch(db);
  const branches = new BranchRepository(db);
  const failed = await branches.create({
    repo_id: live.repo_id,
    name: 'sibling-failed',
    ref: 'sibling-failed',
    branch_unique_id: 9700002,
    path: live.path,
    created_by: user.user_id,
    filesystem_status: 'failed',
  });

  const service = serviceWithMockedGet(db);
  await runWithTenantContext('default', async () => {
    const blockedParams = paramsFor(user);
    markBranchArchiveDeleteAuthorized(blockedParams, failed.branch_id, 'delete');
    await expect(
      service.archiveOrDelete(
        failed.branch_id,
        { metadataAction: 'delete', filesystemAction: 'deleted' },
        blockedParams
      )
    ).rejects.toThrow('overlaps');
    expect(spawnExecutor).not.toHaveBeenCalled();

    const liveParams = paramsFor(user);
    markBranchArchiveDeleteAuthorized(liveParams, live.branch_id, 'delete');
    await expect(
      service.archiveOrDelete(
        live.branch_id,
        { metadataAction: 'delete', filesystemAction: 'deleted' },
        liveParams
      )
    ).resolves.toMatchObject({ deletion_status: 'deleting' });
  });
  expect(spawnExecutor).toHaveBeenCalledTimes(1);
});
