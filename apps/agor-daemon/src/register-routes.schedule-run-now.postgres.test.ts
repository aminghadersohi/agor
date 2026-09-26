/**
 * `schedules/:id/run-now` as registered, against PostgreSQL row-level security.
 *
 * The route is classified `identity-only`. These tests drive the real
 * registration — its around hooks and RBAC before-hooks — on a scope-requiring
 * handle, connected as a role verified NOSUPERUSER/NOBYPASSRLS. Only the
 * scheduler is stubbed, to observe what the route hands it.
 */
import {
  acquireTenantWriteGate,
  BoardRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  releaseTenantWriteGate,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  sql,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import type { AuthenticatedParams, Schedule, TenantID, User } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from './register-routes.js';

const INERT_SERVICES = ['branches', 'repos', 'tasks', 'users'];

/** Wiring-time collaborator whose methods no run-now request ever calls. */
const inert = () =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : vi.fn()) });

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

interface TenantFixture {
  tenantId: TenantID;
  owner: User;
  outsider: User;
  viewer: User;
  schedule: Schedule;
  /** Created by `outsider` on the owner's branch, where outsider has no grant. */
  outsiderSchedule: Schedule;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'schedules/:id/run-now registration (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: ReturnType<typeof createTenantScopedDatabaseProxy>;
    let app: Application;
    const observed: Array<{ scope: unknown; tenant: string | undefined; scheduleId: string }> = [];
    const executeScheduleNow = vi.fn(
      async ({ scheduleId }: { scheduleId: string; triggeredBy: string }) => {
        observed.push({
          scope: getCurrentTenantDatabaseScope(),
          tenant: getCurrentTenantId(),
          scheduleId,
        });
        return {
          session_id: generateId(),
          schedule_id: scheduleId,
          branch_id: generateId(),
          scheduled_run_at: Date.now(),
        };
      }
    );

    async function seedTenant(label: string): Promise<TenantFixture> {
      const tenantId = `run-now-${label}-${generateId()}` as TenantID;
      return runWithTenantDatabaseScope(db, tenantId, async () => {
        const users = new UsersRepository(db);
        const owner = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const outsider = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const viewer = await users.create({
          email: `${generateId()}@example.invalid`,
          role: 'viewer',
        });
        const repo = await new RepoRepository(db).create({
          slug: `run-now-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/run-now.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const board = await new BoardRepository(db).create({
          name: `Run now ${label}`,
          created_by: owner.user_id,
          access_mode: 'private',
        });
        const branch = await new BranchRepository(db).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          permission_binding: 'inherit',
          created_by: owner.user_id,
          name: 'run-now',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
        });
        const schedules = new ScheduleRepository(db);
        const base = {
          branch_id: branch.branch_id,
          cron_expression: '0 * * * *',
          timezone_mode: 'utc' as const,
          prompt: 'Run now',
          enabled: true,
          retention: 0,
          allow_concurrent_runs: false,
          agentic_tool_config: { agentic_tool: 'claude-code' as const },
        };
        const schedule = await schedules.create({
          ...base,
          name: 'Owner schedule',
          created_by: owner.user_id,
        });
        const outsiderSchedule = await schedules.create({
          ...base,
          name: 'Outsider schedule',
          created_by: outsider.user_id,
        });
        return { tenantId, owner, outsider, viewer, schedule, outsiderSchedule };
      });
    }

    function runNow(caller: User, tenantId: TenantID, scheduleId: string) {
      return app.service('/schedules/:id/run-now').create({}, {
        provider: 'rest',
        route: { id: scheduleId },
        user: caller,
        tenant: { tenant_id: tenantId, source: 'explicit' },
      } as AuthenticatedParams);
    }

    function sessionCount(tenantId: TenantID) {
      return runWithTenantDatabaseScope(
        db,
        tenantId,
        async () => (await new SessionRepository(db).findAll()).length
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

      // Real Feathers registration and hooks, real repositories. Registration
      // stops right after run-now so unrelated routes need no fixtures.
      app = feathersExpress(feathers()) as unknown as Application;
      app.configure(socketio());
      app.set('scheduler', { executeScheduleNow });
      // Services registerRoutes reaches for while wiring earlier routes. None
      // is on run-now's path; they only need to exist.
      for (const path of INERT_SERVICES) app.use(path, { find: async () => [] });
      const branchRepository = new BranchRepository(db);
      const stopRegistration = new Error('run-now registered');
      const use = app.use.bind(app);
      const useSpy = vi.spyOn(app, 'use').mockImplementation((...args) => {
        if (args[0] === '/branches/:id/execute-schedule-now') throw stopRegistration;
        return use(...args);
      });
      try {
        await expect(
          registerRoutes({
            app,
            db,
            config: { multi_tenancy: { mode: 'required_from_auth' } },
            externalLaunchProvider: { enabled: false },
            jwtSecret: 'disposable-test-not-a-credential',
            requireAuth: (context: unknown) => context,
            enforcePasswordChange: (context: unknown) => context,
            superadminOpts: { allowSuperadmin: false },
            deployment: { mode: 'standalone' },
            sessionsService: inert(),
            sessionsRepository: new SessionRepository(db),
            branchRepository,
            usersRepository: new UsersRepository(db),
          } as unknown as RegisterRoutesContext)
        ).rejects.toBe(stopRegistration);
      } finally {
        useSpy.mockRestore();
      }
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('hands the scheduler tenant identity and no open database scope', async () => {
      const a = await seedTenant('a');
      observed.length = 0;
      await expect(runNow(a.owner, a.tenantId, a.schedule.schedule_id)).resolves.toMatchObject({
        schedule_id: a.schedule.schedule_id,
        triggered_manually: true,
      });
      expect(observed).toEqual([
        { scope: undefined, tenant: a.tenantId, scheduleId: a.schedule.schedule_id },
      ]);
    });

    it("cannot reach another tenant's schedule by id", async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      executeScheduleNow.mockClear();
      // Tenant B's branch owner names tenant A's real schedule id.
      await expect(runNow(b.owner, b.tenantId, a.schedule.schedule_id)).rejects.toMatchObject({
        name: 'NotFound',
      });
      expect(executeScheduleNow).not.toHaveBeenCalled();
      expect(await sessionCount(a.tenantId)).toBe(0);
    });

    it('enforces the role floor, runs-as-caller, and branch Manager access', async () => {
      const a = await seedTenant('a');
      executeScheduleNow.mockClear();
      // Viewer role is below the member floor.
      await expect(runNow(a.viewer, a.tenantId, a.schedule.schedule_id)).rejects.toMatchObject({
        name: 'Forbidden',
      });
      // A member may not run a schedule someone else created.
      await expect(runNow(a.outsider, a.tenantId, a.schedule.schedule_id)).rejects.toMatchObject({
        name: 'Forbidden',
      });
      // Their own schedule still needs branch `all` on its branch, which a
      // member with no grant on a private board does not hold.
      await expect(
        runNow(a.outsider, a.tenantId, a.outsiderSchedule.schedule_id)
      ).rejects.toMatchObject({ name: 'Forbidden' });
      expect(executeScheduleNow).not.toHaveBeenCalled();
    });

    it('refuses a write-frozen tenant before the scheduler starts anything', async () => {
      const a = await seedTenant('a');
      executeScheduleNow.mockClear();
      const { generation } = await acquireTenantWriteGate(rawDb, a.tenantId, {
        holder: 'run-now-test',
        reason: 'freeze before manual schedule run',
      });
      try {
        await expect(runNow(a.owner, a.tenantId, a.schedule.schedule_id)).rejects.toThrow(
          /write-gated/i
        );
      } finally {
        await releaseTenantWriteGate(rawDb, a.tenantId, { generation });
      }
      expect(executeScheduleNow).not.toHaveBeenCalled();
      await expect(runNow(a.owner, a.tenantId, a.schedule.schedule_id)).resolves.toBeTruthy();
      expect(executeScheduleNow).toHaveBeenCalledOnce();
    });
  }
);
