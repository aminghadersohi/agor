import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReposService } from './repos';

/** Create a temp dir that looks like a materialized git checkout (has `.git`). */
function makeValidCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agor-branch-'));
  writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x');
  return dir;
}
/** A path guaranteed not to exist on disk. */
function missingPath(): string {
  return join(tmpdir(), `agor-missing-${Math.floor(performance.now())}-${process.pid}`);
}

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    ensureBranchStorageModeAllowed: vi.fn(),
    resolveBranchStorageConfig: vi.fn(() => ({
      defaultMode: 'worktree',
      allowedModes: ['worktree', 'clone'],
    })),
    resolveExecutionSecurityMode: vi.fn(() => ({
      appRbacEnabled: true,
      unixUserMode: 'simple',
      requiresExecutionHomeKey: false,
    })),
    resolveMultiTenancyConfig: vi.fn(() => ({ mode: 'disabled' })),
  };
});

const repositoryMocks = vi.hoisted(() => ({
  deleteRepo: vi.fn(),
  findAllBranchesByRepoId: vi.fn(),
  lockRepoForBranchInventory: vi.fn(),
}));

// Shared BranchRepository mock so tests can drive/assert the atomic CAS methods
// (`claimFailedForProvisioningRetry` / `markProvisioningFailedIfCreating`) that
// the provisioning safety nets and retry go through. Every `new
// BranchRepository()` in the service returns this same object.
const branchRepoMock = vi.hoisted(() => ({
  findActiveByRepoAndName: vi.fn(async () => null),
  getAllUsedUniqueIds: vi.fn(async () => [] as number[]),
  addOwner: vi.fn(async () => undefined),
  claimFailedForProvisioningRetry: vi.fn(),
  markProvisioningFailedIfCreating: vi.fn(),
}));

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();

  return {
    ...actual,
    BranchRepository: vi.fn().mockImplementation(function BranchRepository() {
      return {
        findActiveByRepoAndName: vi.fn(async () => null),
        findAllByRepoId: repositoryMocks.findAllBranchesByRepoId,
        getAllUsedUniqueIds: vi.fn(async () => []),
        addOwner: vi.fn(async () => undefined),
        claimFailedForProvisioningRetry: branchRepoMock.claimFailedForProvisioningRetry,
        markProvisioningFailedIfCreating: branchRepoMock.markProvisioningFailedIfCreating,
      };
    }),
    RepoRepository: vi.fn().mockImplementation(function RepoRepository() {
      return {
        create: vi.fn(),
        findById: vi.fn(),
        findAll: vi.fn(async () => []),
        update: vi.fn(),
        delete: repositoryMocks.deleteRepo,
        findBySlug: vi.fn(),
        lockForBranchInventory: repositoryMocks.lockRepoForBranchInventory,
      };
    }),
  };
});

const executorMocks = vi.hoisted(() => ({
  runExecutorCommand: vi.fn(),
  spawnExecutorFireAndForget: vi.fn(),
}));
const delegatedHomeMocks = vi.hoisted(() => ({ resolve: vi.fn(async () => undefined) }));
vi.mock('../utils/executor-delegated-home.js', () => ({
  resolveDelegatedExecutionHomeKey: delegatedHomeMocks.resolve,
}));
vi.mock('../utils/spawn-executor.js', () => {
  return {
    runExecutorCommand: executorMocks.runExecutorCommand,
    generateScopedServiceToken: vi.fn(() => 'scoped-token'),
    getDaemonUrl: vi.fn(() => 'http://daemon'),
    spawnExecutorFireAndForget: executorMocks.spawnExecutorFireAndForget,
  };
});

describe('ReposService.addLocalRepository executor boundary', () => {
  it('persists sanitized executor metadata with an explicit slug and no remote URL', async () => {
    executorMocks.runExecutorCommand.mockResolvedValueOnce({
      success: true,
      data: {
        path: '/trusted/repo',
        defaultBranch: 'main',
        credentialFindingCount: 0,
      },
    });
    const app = { get: () => ({}), service: vi.fn() } as unknown as Application;
    const service = new ReposService({} as never, app);
    const create = vi.spyOn(service, 'create').mockResolvedValue({
      repo_id: 'repo-id',
      slug: 'local/repo',
    } as never);

    await service.addLocalRepository({ path: '/submitted/repo', slug: 'local/repo' }, {
      user: { user_id: '550e8400-e29b-41d4-a716-446655440000' },
    } as never);

    expect(executorMocks.runExecutorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git.repo.inspect',
        params: { path: '/submitted/repo' },
      }),
      expect.any(Object)
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        local_path: '/trusted/repo',
        remote_url: undefined,
        slug: 'local/repo',
      }),
      expect.any(Object)
    );
  });

  it('does not persist when executor inspection fails', async () => {
    executorMocks.runExecutorCommand.mockResolvedValueOnce({
      success: false,
      error: { code: 'GIT_REPO_INSPECT_FAILED', message: 'Not a valid git repository' },
    });
    const service = new ReposService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );
    const create = vi.spyOn(service, 'create');
    await expect(
      service.addLocalRepository({ path: '/bad', slug: 'local/bad' }, {
        user: { user_id: '550e8400-e29b-41d4-a716-446655440000' },
      } as never)
    ).rejects.toThrow(/Not a valid git repository/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('ReposService.createBranch Git lifecycle execution', () => {
  it('rejects invalid delegated routing before persisting the branch', async () => {
    delegatedHomeMocks.resolve.mockRejectedValueOnce(
      new Error('Delegated execution requires a unix_username home key')
    );
    const branches = { create: vi.fn(), find: vi.fn(async () => []) };
    const app = {
      get: () => ({}),
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'branches') return branches;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    } as never);

    await expect(
      service.createBranch(
        '550e8400-e29b-41d4-a716-446655440001',
        {
          name: 'invalid-routing',
          ref: 'invalid-routing',
          createBranch: true,
          sourceBranch: 'main',
          boardId: '550e8400-e29b-41d4-a716-446655440003',
          storage_mode: 'worktree',
        },
        { user: { user_id: '550e8400-e29b-41d4-a716-446655440004' } } as never
      )
    ).rejects.toThrow(/unix_username/);
    expect(branches.create).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('returns the failed representation when executor dispatch throws synchronously', async () => {
    executorMocks.spawnExecutorFireAndForget.mockImplementationOnce(() => {
      throw new Error('launcher unavailable');
    });
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    };
    const creatingBranch = {
      branch_id: '550e8400-e29b-41d4-a716-446655440002',
      repo_id: repo.repo_id,
      name: 'dispatch-failure',
      path: '/managed/worktrees/preset-io/agor/dispatch-failure',
      filesystem_status: 'creating',
    };
    const failedBranch = {
      ...creatingBranch,
      filesystem_status: 'failed',
      error_message: 'Failed to spawn executor: launcher unavailable',
    };
    const branches = {
      create: vi.fn(async () => creatingBranch),
      patch: vi.fn(async () => failedBranch),
      find: vi.fn(async () => []),
    };
    const app = {
      get: () => ({}),
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
        if (name === 'branches') return branches;
        if (name === 'board-objects') {
          return { create: vi.fn(async () => undefined), find: vi.fn(async () => ({ data: [] })) };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    const result = await service.createBranch(
      repo.repo_id,
      {
        name: creatingBranch.name,
        ref: creatingBranch.name,
        createBranch: true,
        sourceBranch: 'main',
        boardId: '550e8400-e29b-41d4-a716-446655440003',
        position: { x: 10, y: 20 },
        storage_mode: 'worktree',
      },
      { user: { user_id: '550e8400-e29b-41d4-a716-446655440004' } } as never
    );

    expect(branches.patch).toHaveBeenCalledWith(
      creatingBranch.branch_id,
      {
        filesystem_status: 'failed',
        error_message: 'Failed to spawn executor: launcher unavailable',
      },
      expect.objectContaining({ provider: undefined })
    );
    expect(result).toEqual(failedBranch);
  });

  it('does not attach a delegated user to daemon-owned Git lifecycle work', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();

    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor',
      local_path: '/managed/repos/agor',
      default_branch: 'main',
    };
    const branch = {
      branch_id: '550e8400-e29b-41d4-a716-446655440002',
      repo_id: repo.repo_id,
      name: 'fix-lifecycle-identity',
      path: '/managed/worktrees/preset-io/agor/fix-lifecycle-identity',
      others_fs_access: 'read',
    };
    const branches = {
      create: vi.fn(async () => branch),
      find: vi.fn(async () => []),
    };
    const boardObjects = {
      create: vi.fn(async () => undefined),
      find: vi.fn(async () => ({ data: [] })),
    };
    const app = {
      get: () => ({}),
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
        if (name === 'branches') return branches;
        if (name === 'board-objects') return boardObjects;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);

    await service.createBranch(
      repo.repo_id,
      {
        name: branch.name,
        ref: branch.name,
        createBranch: true,
        sourceBranch: 'main',
        boardId: '550e8400-e29b-41d4-a716-446655440003',
        position: { x: 10, y: 20 },
        storage_mode: 'worktree',
      },
      {
        user: { user_id: '550e8400-e29b-41d4-a716-446655440004' },
      } as never
    );

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.branch.add' }),
      expect.not.objectContaining({ delegatedHomeKey: expect.anything() })
    );
  });
});

describe('ReposService.cloneRepository Git lifecycle execution', () => {
  it('creates managed storage without delegated user routing', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();

    const repos = { patch: vi.fn() };
    const app = {
      get: () => ({}),
      settings: { authentication: { secret: 'test-secret' } },
      service: vi.fn((name: string) => {
        if (name === 'repos') return repos;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    vi.spyOn(service, 'create').mockResolvedValue({
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/agor-teammate',
    } as never);

    await service.cloneRepository({ url: 'https://github.com/preset-io/agor-teammate.git' }, {
      user: { user_id: '550e8400-e29b-41d4-a716-446655440004' },
    } as never);

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.clone' }),
      expect.not.objectContaining({ delegatedHomeKey: expect.anything() })
    );
  });
});

describe('ReposService.remove branch inventory', () => {
  it('uses the unbounded repository inventory after locking instead of Feathers pagination', async () => {
    const repo = {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'preset-io/large-repo',
      repo_type: 'remote',
    };
    const branches = Array.from({ length: 10_001 }, (_, index) => ({
      branch_id: `branch-${index}`,
      repo_id: repo.repo_id,
      name: `branch-${index}`,
    }));
    repositoryMocks.findAllBranchesByRepoId.mockReset().mockResolvedValue(branches);
    repositoryMocks.lockRepoForBranchInventory.mockReset().mockResolvedValue(repo);
    repositoryMocks.deleteRepo.mockReset().mockResolvedValue(undefined);

    const branchService = {
      find: vi.fn(async () => {
        throw new Error('transport-paginated find must not be used');
      }),
      removeMetadataWithRealtime: vi.fn(async () => undefined),
    };
    const app = {
      get: () => ({}),
      service: vi.fn((name: string) => {
        if (name === 'branches') return branchService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const tx = { run: vi.fn() };
    const db = {
      run: vi.fn(),
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const service = new ReposService(db as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(repo as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await service.remove(repo.repo_id, {
        tenant: { tenant_id: 'tenant-a', source: 'explicit' },
      } as never);
    } finally {
      log.mockRestore();
    }

    expect(branchService.find).not.toHaveBeenCalled();
    expect(repositoryMocks.findAllBranchesByRepoId).toHaveBeenNthCalledWith(1, repo.repo_id);
    expect(repositoryMocks.findAllBranchesByRepoId).toHaveBeenNthCalledWith(2, repo.repo_id);
    expect(repositoryMocks.lockRepoForBranchInventory).toHaveBeenCalledWith(repo.repo_id);
    expect(repositoryMocks.lockRepoForBranchInventory.mock.invocationCallOrder[0]).toBeLessThan(
      repositoryMocks.findAllBranchesByRepoId.mock.invocationCallOrder[1]!
    );
    expect(branchService.removeMetadataWithRealtime).toHaveBeenCalledTimes(10_001);
    expect(repositoryMocks.deleteRepo).toHaveBeenCalledOnce();
  });
});

describe('ReposService branch provisioning lifecycle', () => {
  type BranchesMock = {
    get: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    find?: ReturnType<typeof vi.fn>;
    emit?: ReturnType<typeof vi.fn>;
  };

  function makeService(branches: BranchesMock) {
    branches.emit ??= vi.fn();
    const app = {
      settings: { authentication: { secret: 'test-secret' } },
      get: vi.fn((name: string) => {
        if (name === 'config') return {};
        throw new Error(`Unexpected setting: ${name}`);
      }),
      service: vi.fn((name: string) => {
        if (name === 'branches') return branches;
        throw new Error(`Unexpected service: ${name}`);
      }),
    } as unknown as Application;
    const service = new ReposService({} as never, app);
    return { service, app };
  }

  function grabOnExit(): (code: number | null) => void {
    const opts = executorMocks.spawnExecutorFireAndForget.mock.calls.at(-1)?.[1] as {
      onExit?: (code: number | null) => void;
    };
    if (!opts?.onExit) throw new Error('expected an onExit safety net to be wired');
    return opts.onExit;
  }

  const branch = (over: Record<string, unknown> = {}) => ({
    branch_id: 'b1',
    repo_id: 'r1',
    name: 'feature',
    path: missingPath(),
    storage_mode: 'worktree' as const,
    created_by: 'user-1',
    filesystem_status: 'creating' as const,
    ...over,
  });
  const repo = { repo_id: 'r1', local_path: '/managed/repo', slug: 'acme/app' };

  beforeEach(() => {
    executorMocks.spawnExecutorFireAndForget.mockReset();
    branchRepoMock.claimFailedForProvisioningRetry.mockReset();
    branchRepoMock.markProvisioningFailedIfCreating.mockReset();
    // Sensible defaults: CAS is a no-op unless a test opts in.
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: false,
      branch: branch({ filesystem_status: 'failed' }),
    });
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: false,
      branch: branch({ filesystem_status: 'creating' }),
    });
  });

  // ---- crash / onExit safety net ------------------------------------------

  it('onExit(non-zero) atomically marks a still-creating branch failed (no .git promotion)', async () => {
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ filesystem_status: 'failed' }),
    });
    const { service } = makeService({ get: vi.fn(), patch: vi.fn() });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    grabOnExit()(1);

    await vi.waitFor(() => {
      expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalledWith(
        'b1',
        expect.stringMatching(/provisioning/i)
      );
    });
  });

  it('onExit does NOT promote to ready even when a valid checkout is on disk', async () => {
    // The whole point of the new design: the daemon never infers success from a
    // daemon-local .git path. A crash → failed, and the user retries.
    const dir = makeValidCheckout();
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ path: dir, filesystem_status: 'failed' }),
    });
    const patch = vi.fn(async () => ({}));
    const { service } = makeService({ get: vi.fn(), patch });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch({ path: dir }), repo, 'user-1', undefined, 'create');

    grabOnExit()(1);

    await vi.waitFor(() => {
      expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalled();
    });
    // Never a status patch to 'ready'.
    expect(patch).not.toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ filesystem_status: 'ready' })
    );
  });

  it('onExit code 0 does not touch the row (executor already acked)', async () => {
    const { service } = makeService({ get: vi.fn(), patch: vi.fn() });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    grabOnExit()(0);
    await new Promise((r) => setImmediate(r));
    expect(branchRepoMock.markProvisioningFailedIfCreating).not.toHaveBeenCalled();
  });

  it('synchronous spawn failure marks the branch failed (no lost provisioning)', async () => {
    executorMocks.spawnExecutorFireAndForget.mockImplementationOnce(() => {
      throw new Error('executor binary not found');
    });
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ filesystem_status: 'failed' }),
    });
    const { service } = makeService({ get: vi.fn(), patch: vi.fn() });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalledWith(
      'b1',
      expect.stringMatching(/failed to start branch provisioning/i)
    );
  });

  // ---- explicit retry (failed → creating only) ----------------------------

  it('retry on a ready branch is a no-op (no claim, no dispatch)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'ready' }));
    const { service } = makeService({ get, patch: vi.fn() });

    const result = await service.retryBranchProvisioning('b1');

    expect(result.filesystem_status).toBe('ready');
    expect(branchRepoMock.claimFailedForProvisioningRetry).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a creating branch is refused (409 in-progress)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'creating' }));
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/in progress/i);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a non-failed lifecycle state (e.g. preserved) is refused (not retryable)', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'preserved' }));
    const { service } = makeService({ get, patch: vi.fn() });

    await expect(service.retryBranchProvisioning('b1')).rejects.toThrow(/cannot be retried/i);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry on a failed branch atomically claims failed→creating and re-dispatches', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: true,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    const result = await service.retryBranchProvisioning('b1');

    expect(branchRepoMock.claimFailedForProvisioningRetry).toHaveBeenCalledWith('b1');
    expect(result.filesystem_status).toBe('creating');
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.branch.add' }),
      expect.objectContaining({ asUser: 'daemon-user' })
    );
  });

  it('retry that loses the atomic claim (concurrent/double-click) does NOT dispatch a 2nd executor', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    // Another caller already flipped it to creating and won the claim.
    branchRepoMock.claimFailedForProvisioningRetry.mockResolvedValue({
      claimed: false,
      branch: branch({ filesystem_status: 'creating' }),
    });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    const result = await service.retryBranchProvisioning('b1');

    expect(branchRepoMock.claimFailedForProvisioningRetry).toHaveBeenCalledTimes(1);
    expect(result.filesystem_status).toBe('creating');
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('two concurrent retries against the same failed branch dispatch exactly once', async () => {
    const get = vi.fn(async () => branch({ filesystem_status: 'failed' }));
    // The repo-level CAS is the fence: first call wins the claim, second loses.
    branchRepoMock.claimFailedForProvisioningRetry
      .mockResolvedValueOnce({ claimed: true, branch: branch({ filesystem_status: 'creating' }) })
      .mockResolvedValueOnce({ claimed: false, branch: branch({ filesystem_status: 'creating' }) });
    const { service } = makeService({ get, patch: vi.fn() });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await Promise.all([
      service.retryBranchProvisioning('b1'),
      service.retryBranchProvisioning('b1'),
    ]);

    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
  });

  // ---- startup watchdog (interrupted creating → failed) -------------------

  it('watchdog marks every stuck creating branch failed — never recovers or re-dispatches', async () => {
    const stuckA = branch({ branch_id: 'a', filesystem_status: 'creating' });
    const stuckB = branch({ branch_id: 'b', filesystem_status: 'creating' });
    const ready = branch({ branch_id: 'c', filesystem_status: 'ready' });
    const find = vi.fn(async () => [stuckA, stuckB, ready]);
    branchRepoMock.markProvisioningFailedIfCreating.mockResolvedValue({
      changed: true,
      branch: branch({ filesystem_status: 'failed' }),
    });
    const { service } = makeService({ get: vi.fn(), patch: vi.fn(), find });

    const summary = await service.reconcileStuckCreatingBranches();

    expect(summary).toEqual({ scanned: 2, failed: 2 });
    expect(branchRepoMock.markProvisioningFailedIfCreating).toHaveBeenCalledTimes(2);
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});
