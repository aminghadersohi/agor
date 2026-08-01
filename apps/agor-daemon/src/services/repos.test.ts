import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
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

describe('ReposService branch provisioning lifecycle (never stuck in creating)', () => {
  type BranchesMock = {
    get: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    find?: ReturnType<typeof vi.fn>;
  };

  function makeService(branches: BranchesMock) {
    const app = {
      settings: { authentication: { secret: 'test-secret' } },
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

  it('dispatch installs an onExit net that marks a crashed provision as failed', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const patch = vi.fn(async () => ({}));
    const get = vi.fn(async () => branch({ path: missingPath(), filesystem_status: 'creating' }));
    const { service } = makeService({ get, patch });

    await (
      service as unknown as {
        dispatchBranchProvisioning: (...a: unknown[]) => Promise<void>;
      }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    grabOnExit()(1); // simulate executor exit-1 (crash / SIGTERM / stale build)

    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        'b1',
        expect.objectContaining({ filesystem_status: 'failed' })
      )
    );
    // sanitized, actionable, no absolute-path leakage requirement: message set
    const lastPatch = patch.mock.calls.at(-1);
    const msg = (lastPatch?.[1] as { error_message?: string } | undefined)?.error_message;
    expect(msg).toMatch(/provisioning/i);
  });

  it('onExit recovers to ready when a valid checkout is already on disk', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const dir = makeValidCheckout();
    const patch = vi.fn(async () => ({}));
    const get = vi.fn(async () => branch({ path: dir, filesystem_status: 'creating' }));
    const { service } = makeService({ get, patch });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch({ path: dir }), repo, 'user-1', undefined, 'create');

    grabOnExit()(1);

    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith('b1', { filesystem_status: 'ready' })
    );
  });

  it('onExit code 0 does not double-write (executor already patched)', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const patch = vi.fn(async () => ({}));
    const get = vi.fn(async () => branch({ filesystem_status: 'ready' }));
    const { service } = makeService({ get, patch });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    grabOnExit()(0);
    await new Promise((r) => setImmediate(r));
    expect(patch).not.toHaveBeenCalled();
  });

  it('synchronous spawn failure marks the branch failed (no lost provisioning)', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    executorMocks.spawnExecutorFireAndForget.mockImplementationOnce(() => {
      throw new Error('executor binary not found');
    });
    const patch = vi.fn(async () => ({}));
    const get = vi.fn(async () => branch({ filesystem_status: 'creating' }));
    const { service } = makeService({ get, patch });

    await (
      service as unknown as { dispatchBranchProvisioning: (...a: unknown[]) => Promise<void> }
    ).dispatchBranchProvisioning(branch(), repo, 'user-1', undefined, 'create');

    expect(patch).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ filesystem_status: 'failed' })
    );
  });

  it('retry is idempotent: an existing valid checkout is reconciled to ready without re-dispatch', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const dir = makeValidCheckout();
    const patch = vi.fn(async () => ({ ...branch({ path: dir }), filesystem_status: 'ready' }));
    const get = vi.fn(async () => branch({ path: dir, filesystem_status: 'failed' }));
    const { service } = makeService({ get, patch });

    await service.retryBranchProvisioning('b1');

    expect(patch).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ filesystem_status: 'ready' }),
      undefined
    );
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('retry re-dispatches provisioning when the directory is missing', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const path = missingPath();
    const creatingRow = branch({ path, filesystem_status: 'creating' });
    const patch = vi.fn(async () => creatingRow);
    const get = vi.fn(async () => branch({ path, filesystem_status: 'failed' }));
    const { service } = makeService({ get, patch });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    await service.retryBranchProvisioning('b1');

    expect(patch).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({ filesystem_status: 'creating' }),
      undefined
    );
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git.branch.add' }),
      expect.objectContaining({ asUser: 'daemon-user' })
    );
  });

  it('watchdog recovers/retries/ignores stuck creating branches on restart', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const goodDir = makeValidCheckout();
    const recoverable = branch({ branch_id: 'ok', path: goodDir, filesystem_status: 'creating' });
    const retryable = branch({
      branch_id: 'gone',
      path: missingPath(),
      filesystem_status: 'creating',
    });
    const alreadyReady = branch({ branch_id: 'rdy', filesystem_status: 'ready' });

    const patch = vi.fn(async (id: string) => ({ branch_id: id, filesystem_status: 'creating' }));
    const get = vi.fn(async (id: string) =>
      [recoverable, retryable].find((b) => b.branch_id === id)
    );
    const find = vi.fn(async () => [recoverable, retryable, alreadyReady]);
    const { service } = makeService({ get, patch, find });
    (service as unknown as { repoRepo: { findById: ReturnType<typeof vi.fn> } }).repoRepo.findById =
      vi.fn(async () => repo);

    const summary = await service.reconcileStuckCreatingBranches();

    expect(summary.scanned).toBe(2); // the ready one is filtered out
    expect(summary.recovered).toBe(1); // valid checkout → ready
    expect(summary.retried).toBe(1); // missing dir → re-dispatch
    expect(executorMocks.spawnExecutorFireAndForget).toHaveBeenCalledTimes(1);
  });

  it('retry on an already-ready branch is a no-op (no patch, no re-dispatch)', async () => {
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const patch = vi.fn(async () => ({}));
    const get = vi.fn(async () => branch({ filesystem_status: 'ready' }));
    const { service } = makeService({ get, patch });

    const result = await service.retryBranchProvisioning('b1');

    expect(result.filesystem_status).toBe('ready');
    expect(patch).not.toHaveBeenCalled();
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });

  it('concurrent retries against a valid checkout both reconcile to ready, never re-dispatch', async () => {
    // Two callers race a retry on the same failed row whose checkout is
    // actually present on disk (e.g. a manually materialized worktree). Both
    // must converge on ready and neither may spawn a duplicate materializer.
    executorMocks.spawnExecutorFireAndForget.mockClear();
    const dir = makeValidCheckout();
    const patch = vi.fn(async () => ({ ...branch({ path: dir }), filesystem_status: 'ready' }));
    const get = vi.fn(async () => branch({ path: dir, filesystem_status: 'failed' }));
    const { service } = makeService({ get, patch });

    const [a, b] = await Promise.all([
      service.retryBranchProvisioning('b1'),
      service.retryBranchProvisioning('b1'),
    ]);

    expect(a.filesystem_status).toBe('ready');
    expect(b.filesystem_status).toBe('ready');
    expect(executorMocks.spawnExecutorFireAndForget).not.toHaveBeenCalled();
  });
});
