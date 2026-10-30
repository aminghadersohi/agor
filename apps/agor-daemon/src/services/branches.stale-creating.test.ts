import { join } from 'node:path';
import { getBranchesDir } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  runWithTenantContext,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, TenantID } from '@agor/core/types';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import { markBranchArchiveDeleteAuthorized } from '../utils/branch-archive-delete-authorization';
import { requestExecutor, spawnExecutor } from '../utils/spawn-executor';
import { BranchesService } from './branches';
import { ReposService, STALE_CREATING_PROVISIONING_MS } from './repos';

vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<object>()),
  spawnExecutor: vi.fn(),
  requestExecutor: vi.fn(),
}));

/**
 * A branch left in `creating` by a provisioning attempt whose owner is gone
 * (e.g. a restart the startup watchdog skipped) must not be permanently
 * un-archivable and un-deletable. Fictional fixtures only.
 */
const STUCK_SINCE = new Date('2026-09-30T12:00:00.000Z');

function paramsFor(user: { user_id: string }): AuthenticatedParams {
  return {
    provider: 'rest',
    user,
    tenant: { tenant_id: 'default' as TenantID, source: 'explicit' },
  } as AuthenticatedParams;
}

function setup(db: Database, { authority }: { authority: boolean }) {
  const scoped = createTenantScopedDatabaseProxy(db);
  const others = { emit: vi.fn(), archiveBranchSessions: vi.fn(async () => ({ count: 0 })) };
  let repos: ReposService;
  const app = {
    get: () => ({ execution: {} }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'fixture-command-token') },
    service: (name: string) => (name === 'repos' ? repos : others),
  } as unknown as Application;
  repos = new ReposService(scoped, app);
  repos.setStaleProvisioningRecoveryAuthority(authority);
  const service = new BranchesService(scoped, app);
  vi.spyOn(service, 'get').mockImplementation(
    async (id: BranchID) => (await new BranchRepository(db).findById(id))! as never
  );
  vi.spyOn(
    service as unknown as {
      resolveEnvironmentExecutorContext: BranchesService['resolveEnvironmentExecutorContext'];
    },
    'resolveEnvironmentExecutorContext'
  ).mockImplementation(async (branch) => ({
    env: {},
    executionUserId: branch.created_by,
    branchFsAccess: 'write',
    sandboxMounts: {},
  }));
  return { service, repos };
}

/** Seed a managed branch whose provisioning attempt last wrote at `at`. */
async function seedCreatingBranch(db: Database, at: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  try {
    const seeded = await seedEnvironmentCommandBranch(db, {
      path: join(getBranchesDir(), 'fixture', 'repo', `stuck-${generateId()}`),
    });
    const branch = await new BranchRepository(db).update(seeded.branch.branch_id, {
      filesystem_status: 'creating',
      provisioning_attempt_id: 'fixture-orphaned-attempt',
    });
    return { branch, user: seeded.user };
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestExecutor).mockImplementation(async (payload) => ({
    success: true,
    data: {
      branchId: (payload.params as { branchId: BranchID }).branchId,
      exists: true,
      kind: 'directory',
    },
  }));
});
afterEach(() => vi.useRealTimers());

async function archive(service: BranchesService, branchId: BranchID, params: AuthenticatedParams) {
  markBranchArchiveDeleteAuthorized(params, branchId, 'archive');
  return service.archiveOrDelete(
    branchId,
    { metadataAction: 'archive', filesystemAction: 'preserved' },
    params
  );
}

test('without single-daemon authority a stale creating branch stays protected (shared replicas)', async ({
  db,
}) => {
  const { branch, user } = await seedCreatingBranch(db, STUCK_SINCE);
  const { service } = setup(db, { authority: false });
  await runWithTenantContext('default', async () => {
    await expect(archive(service, branch.branch_id, paramsFor(user))).rejects.toThrow(
      'materialization is active or unsettled'
    );
  });
  expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
    filesystem_status: 'creating',
    archived: false,
  });
});

test('a recently written creating branch is never taken over, even with authority', async ({
  db,
}) => {
  const { branch, user } = await seedCreatingBranch(
    db,
    new Date(Date.now() - STALE_CREATING_PROVISIONING_MS / 2)
  );
  const { service } = setup(db, { authority: true });
  await runWithTenantContext('default', async () => {
    await expect(archive(service, branch.branch_id, paramsFor(user))).rejects.toThrow(
      'materialization is active or unsettled'
    );
  });
  expect((await new BranchRepository(db).findById(branch.branch_id))?.filesystem_status).toBe(
    'creating'
  );
});

test('archive releases a stale orphaned creating branch to failed, then archives it', async ({
  db,
}) => {
  const { branch, user } = await seedCreatingBranch(db, STUCK_SINCE);
  const { service } = setup(db, { authority: true });
  const result = await runWithTenantContext('default', () =>
    archive(service, branch.branch_id, paramsFor(user))
  );
  expect(result).toMatchObject({ archived: true, workspace_operation: { status: 'succeeded' } });
  expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
    archived: true,
    filesystem_status: 'failed',
    error_message: expect.stringContaining('no active materialization process'),
  });
  expect(spawnExecutor).not.toHaveBeenCalled();
});

test('permanent delete releases a stale orphaned creating branch and enters the deletion lifecycle', async ({
  db,
}) => {
  const { branch, user } = await seedCreatingBranch(db, STUCK_SINCE);
  const { service } = setup(db, { authority: true });
  const params = paramsFor(user);
  markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'delete');
  await runWithTenantContext('default', () =>
    service.archiveOrDelete(
      branch.branch_id,
      { metadataAction: 'delete', filesystemAction: 'deleted' },
      params
    )
  );
  const row = await new BranchRepository(db).findById(branch.branch_id);
  expect(row?.filesystem_status).toBe('failed');
  expect(row?.deletion_status).toBeDefined();
});

test('a newer attempt acknowledging first wins the fenced CAS', async ({ db }) => {
  const { branch } = await seedCreatingBranch(db, STUCK_SINCE);
  const { repos } = setup(db, { authority: true });
  const released = await runWithTenantContext('default', () =>
    repos.releaseStaleCreatingProvisioning(
      { ...branch, provisioning_attempt_id: 'superseded-attempt' },
      paramsFor({ user_id: branch.created_by })
    )
  );
  expect(released).toBeNull();
  expect((await new BranchRepository(db).findById(branch.branch_id))?.filesystem_status).toBe(
    'creating'
  );
});
