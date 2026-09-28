/**
 * `repos/:id/import-launch-json` against real PostgreSQL row-level security.
 *
 * The route is declared `identity-only`: tenant identity is armed, no request
 * transaction is held, and every database access opens its own short unit —
 * because the launch file is read by an executor process. These tests run the
 * real ReposService on a scope-requiring handle, connected as a role that is
 * verified NOSUPERUSER/NOBYPASSRLS, so an unscoped access throws and a
 * cross-tenant read is filtered by the database rather than by the service.
 */
import {
  acquireTenantWriteGate,
  BoardRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  releaseTenantWriteGate,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  sql,
  UsersRepository,
} from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import type {
  Application,
  Branch,
  Repo,
  RepoEnvironment,
  TenantID,
  User,
  UserRole,
} from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { ReposService } from './repos';

const executor = vi.hoisted(() => ({ requestExecutor: vi.fn() }));

vi.mock('../utils/spawn-executor.js', () => ({
  requestExecutor: executor.requestExecutor,
  startContainedExecutorCommand: vi.fn(() => {
    throw new Error('launch.json import must not take the workspace-write path');
  }),
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  spawnExecutorFireAndForget: vi.fn(),
}));

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

const EXISTING: RepoEnvironment = {
  version: 2,
  default: 'dev',
  variants: { dev: { start: 'pnpm dev' } },
  template_overrides: { port: 4000 },
};
const IMPORTED: RepoEnvironment = {
  version: 2,
  default: 'web',
  variants: { web: { start: 'node server.js' }, api: { start: 'node api.js' } },
};

interface TenantFixture {
  tenantId: TenantID;
  admin: User;
  member: User;
  repo: Repo;
  branch: Branch;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'ReposService.importFromLaunchJson (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: ReturnType<typeof createTenantScopedDatabaseProxy>;
    let tokenTenants: Array<string | undefined>;

    async function seedTenant(label: string): Promise<TenantFixture> {
      const tenantId = `launch-json-${label}-${generateId()}` as TenantID;
      return runWithTenantDatabaseScope(db, tenantId, async () => {
        const users = new UsersRepository(db);
        const admin = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'admin',
        });
        const member = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(db).create({
          slug: `launch-json-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/launch.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        await new RepoRepository(db).setEnvironment(repo.repo_id, EXISTING);
        const board = await new BoardRepository(db).create({
          name: `Launch ${label}`,
          created_by: admin.user_id,
          access_mode: 'private',
        });
        const branch = await new BranchRepository(db).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          permission_binding: 'inherit',
          // The admin owns the branch, so the executor-side workspace check
          // (view + filesystem read) is satisfied by ownership.
          created_by: admin.user_id,
          name: 'launch',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
        });
        return { tenantId, admin, member, repo, branch };
      });
    }

    function readEnvironment(tenantId: TenantID, repoId: string) {
      return runWithTenantDatabaseScope(
        db,
        tenantId,
        async () => (await new RepoRepository(db).findById(repoId))?.environment
      );
    }

    function makeService() {
      const app = {
        get: (key: string) => (key === 'config' ? { execution: {} } : undefined),
        service: (path: string) => {
          if (path === 'branches') {
            // The real branches service arms its own tenant scope in a hook;
            // mirror that here so the call is RLS-filtered like production.
            return {
              get: (id: string, params: { tenant?: { tenant_id?: string } }) =>
                runWithTenantDatabaseScope(db, params.tenant?.tenant_id, async () => {
                  const branch = await new BranchRepository(db).findById(id);
                  if (!branch) throw new NotFound(`Branch not found: ${id}`);
                  return branch;
                }),
            };
          }
          return { emit: vi.fn() };
        },
        sessionTokenService: {
          generateCommandToken: vi.fn(async () => {
            // What the real service seals into the token's tenant_id claim.
            tokenTenants.push(getCurrentTenantId());
            return 'command-token';
          }),
        },
      } as unknown as Application;
      return new ReposService(db, app);
    }

    /** Run as the identity-only route does: tenant identity, no DB scope. */
    function importAs(
      caller: User,
      tenantId: TenantID,
      repoId: string,
      branchId: string,
      role: UserRole = caller.role
    ) {
      const params = {
        provider: 'rest',
        user: { ...caller, role },
        tenant: { tenant_id: tenantId, source: 'explicit' },
      };
      return runWithTenantContext(tenantId, () =>
        makeService().importFromLaunchJson(repoId, { branch_id: branchId }, params as never)
      );
    }

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
      const result = await executeRaw(
        rawDb,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    beforeEach(() => {
      tokenTenants = [];
      executor.requestExecutor.mockReset();
    });

    it('holds no database scope across the executor spawn and writes in a fresh unit', async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      const spawnState: Array<{ scope: unknown; tenant: string | undefined }> = [];
      executor.requestExecutor.mockImplementation(async (payload: { params: { cwd: string } }) => {
        spawnState.push({ scope: getCurrentTenantDatabaseScope(), tenant: getCurrentTenantId() });
        expect(payload.params.cwd).toBe(a.branch.path);
        // A concurrent edit while the executor runs. If the route held a
        // transaction here, the post-spawn write would clobber it.
        await runWithTenantDatabaseScope(db, a.tenantId, () =>
          new RepoRepository(db).setEnvironment(a.repo.repo_id, {
            ...EXISTING,
            template_overrides: { port: 5000 },
          })
        );
        return { success: true, data: { environment: IMPORTED, path: '.vscode/launch.json' } };
      });

      const updated = await importAs(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id);

      expect(spawnState).toEqual([{ scope: undefined, tenant: a.tenantId }]);
      expect(tokenTenants).toEqual([a.tenantId]);
      expect(updated.environment).toEqual({ ...IMPORTED, template_overrides: { port: 5000 } });
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual({
        ...IMPORTED,
        template_overrides: { port: 5000 },
      });
      expect(await readEnvironment(b.tenantId, b.repo.repo_id)).toEqual(EXISTING);
    });

    it("cannot read or write another tenant's repository, even as that tenant's id holder", async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      executor.requestExecutor.mockResolvedValue({
        success: true,
        data: { environment: IMPORTED },
      });

      // Tenant A admin names tenant B's real repo and branch ids.
      await expect(
        importAs(a.admin, a.tenantId, b.repo.repo_id, b.branch.branch_id)
      ).rejects.toMatchObject({ name: 'NotFound' });
      // Tenant A's own repo, tenant B's branch: RLS hides the branch.
      await expect(
        importAs(a.admin, a.tenantId, a.repo.repo_id, b.branch.branch_id)
      ).rejects.toMatchObject({ name: 'NotFound' });

      expect(executor.requestExecutor).not.toHaveBeenCalled();
      expect(tokenTenants).toEqual([]);
      expect(await readEnvironment(b.tenantId, b.repo.repo_id)).toEqual(EXISTING);
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });

    it('rejects non-admins before any read, spawn, or write', async () => {
      const a = await seedTenant('a');
      await expect(
        importAs(a.member, a.tenantId, a.repo.repo_id, a.branch.branch_id)
      ).rejects.toMatchObject({ name: 'Forbidden' });
      // The branch owner is still refused once demoted below admin.
      await expect(
        importAs(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id, 'member')
      ).rejects.toMatchObject({ name: 'Forbidden' });
      expect(executor.requestExecutor).not.toHaveBeenCalled();
      expect(tokenTenants).toEqual([]);
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });

    it('re-checks the tenant write gate after the spawn', async () => {
      const a = await seedTenant('a');
      let generation: number | undefined;
      executor.requestExecutor.mockImplementation(async () => {
        // A freeze that begins while the executor is running.
        ({ generation } = await acquireTenantWriteGate(rawDb, a.tenantId, {
          holder: 'launch-json-test',
          reason: 'freeze during launch.json import',
        }));
        return { success: true, data: { environment: IMPORTED } };
      });
      try {
        await expect(
          importAs(a.admin, a.tenantId, a.repo.repo_id, a.branch.branch_id)
        ).rejects.toThrow(/write-gated/i);
      } finally {
        if (generation !== undefined) {
          await releaseTenantWriteGate(rawDb, a.tenantId, { generation });
        }
      }
      expect(executor.requestExecutor).toHaveBeenCalledOnce();
      expect(await readEnvironment(a.tenantId, a.repo.repo_id)).toEqual(EXISTING);
    });
  }
);
