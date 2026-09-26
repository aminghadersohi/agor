/**
 * Artifact interaction-binding routes as registered, against PostgreSQL RLS.
 *
 * `artifacts/:id/actions/:actionId` is classified `identity-only` (a
 * `schedule_run` action dispatches run-now, which spawns) and
 * `artifacts/:id/data/:dataId` is `scoped` (read-only). These tests drive the
 * real registerHooks registrations and the real artifacts and schedules
 * services — with their RBAC hooks — on a scope-requiring handle, connected as
 * a role verified NOSUPERUSER/NOBYPASSRLS. run-now is stubbed to observe what
 * the action route hands it; its own registration is covered by
 * register-routes.schedule-run-now.postgres.test.ts.
 *
 * The round-trip tests declare bindings through the ordinary REST patch, read
 * them back from the payload route, and invoke them — the path a browser takes.
 */
import {
  ArtifactRepository,
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
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  shortId,
  sql,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress } from '@agor/core/feathers';
import type {
  Artifact,
  ArtifactPayload,
  AuthenticatedParams,
  HookContext,
  Schedule,
  TenantID,
  User,
} from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks.js';
import {
  ARTIFACTS_SERVICE_TRANSPORT_METHODS,
  createArtifactsService,
} from './services/artifacts.js';
import { createSchedulesService } from './services/schedules.js';
import { createUsersService } from './services/users.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

const inertService = {
  find: async () => [],
  get: async () => null,
  create: async (data: unknown) => data,
  update: async (_id: unknown, data: unknown) => data,
  patch: async (_id: unknown, data: unknown) => data,
  remove: async () => null,
};

interface TenantFixture {
  tenantId: TenantID;
  owner: User;
  outsider: User;
  viewer: User;
  schedule: Schedule;
  artifact: Artifact;
  privateArtifact: Artifact;
  unboundArtifact: Artifact;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'artifact binding routes (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: ReturnType<typeof createTenantScopedDatabaseProxy>;
    let app: Application;
    const runNowCalls: Array<{
      scope: unknown;
      tenant: string | undefined;
      scheduleId: string;
      provider: unknown;
      userId: unknown;
      paramsTenant: unknown;
    }> = [];

    function interactions(scheduleId: string) {
      return {
        interactions: {
          actions: [
            { id: 'run', label: 'Run', effect: { kind: 'schedule_run', schedule_id: scheduleId } },
            {
              id: 'pause',
              label: 'Pause',
              effect: { kind: 'schedule_set_enabled', schedule_id: scheduleId, enabled: false },
            },
          ],
          data: [
            {
              id: 'status',
              label: 'Status',
              source: { kind: 'schedule_status', schedule_id: scheduleId },
            },
          ],
        },
      };
    }

    async function seedTenant(label: string): Promise<TenantFixture> {
      const tenantId = `artifact-bindings-${label}-${generateId()}` as TenantID;
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
          slug: `artifact-bindings-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/artifact-bindings.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const board = await new BoardRepository(db).create({
          name: `Artifact bindings ${label}`,
          created_by: owner.user_id,
          access_mode: 'private',
        });
        const branch = await new BranchRepository(db).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          permission_binding: 'inherit',
          created_by: owner.user_id,
          name: 'artifact-bindings',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
        });
        const schedule = await new ScheduleRepository(db).create({
          branch_id: branch.branch_id,
          created_by: owner.user_id,
          name: 'Nightly',
          cron_expression: '0 * * * *',
          timezone_mode: 'utc',
          prompt: 'Run',
          enabled: true,
          retention: 0,
          allow_concurrent_runs: false,
          agentic_tool_config: { agentic_tool: 'claude-code' },
        });
        const artifacts = new ArtifactRepository(db);
        const base = {
          board_id: board.board_id,
          branch_id: branch.branch_id,
          template: 'static' as const,
          files: { '/index.html': '<h1>bindings</h1>' },
          content_hash: generateId(),
          created_by: owner.user_id,
          agor_runtime: interactions(schedule.schedule_id),
        };
        const artifact = await artifacts.create({
          ...base,
          artifact_id: generateId(),
          name: 'Public console',
          public: true,
        } as never);
        const privateArtifact = await artifacts.create({
          ...base,
          artifact_id: generateId(),
          name: 'Private console',
          public: false,
        } as never);
        const { agor_runtime: _bindings, ...unbound } = base;
        const unboundArtifact = await artifacts.create({
          ...unbound,
          artifact_id: generateId(),
          name: 'Unbound console',
          public: true,
        } as never);
        return {
          tenantId,
          owner,
          outsider,
          viewer,
          schedule,
          artifact,
          privateArtifact,
          unboundArtifact,
        };
      });
    }

    function params(caller: User, tenantId: TenantID, route: Record<string, string>) {
      return {
        provider: 'rest',
        route,
        user: caller,
        tenant: { tenant_id: tenantId, source: 'explicit' },
      } as AuthenticatedParams;
    }

    function runAction(caller: User, tenantId: TenantID, artifactId: string, actionId: string) {
      return app
        .service('artifacts/:id/actions/:actionId')
        .create({}, params(caller, tenantId, { id: artifactId, actionId }));
    }

    function readData(caller: User, tenantId: TenantID, artifactId: string, dataId: string) {
      return app
        .service('artifacts/:id/data/:dataId')
        .find(params(caller, tenantId, { id: artifactId, dataId }));
    }

    function patchArtifact(
      caller: User,
      tenantId: TenantID,
      artifactId: string,
      data: Record<string, unknown>
    ) {
      return app.service('artifacts').patch(artifactId, data, params(caller, tenantId, {}));
    }

    function readPayload(caller: User, tenantId: TenantID, artifactId: string) {
      return app
        .service('artifacts/:id/payload')
        .find(params(caller, tenantId, { id: artifactId })) as Promise<ArtifactPayload>;
    }

    function readPersistedRuntime(tenantId: TenantID, artifactId: string) {
      return runWithTenantDatabaseScope(db, tenantId, async () => {
        return (await new ArtifactRepository(db).findById(artifactId))?.agor_runtime;
      });
    }

    function readSchedule(tenantId: TenantID, scheduleId: string) {
      return runWithTenantDatabaseScope(db, tenantId, () =>
        new ScheduleRepository(db).findById(scheduleId)
      );
    }

    /** Re-point a tenant's artifact binding at an arbitrary schedule id. */
    function rebind(tenantId: TenantID, artifactId: string, scheduleId: string) {
      return runWithTenantDatabaseScope(db, tenantId, () =>
        new ArtifactRepository(db).update(artifactId, {
          agor_runtime: interactions(scheduleId),
        } as never)
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

      const config = {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth' },
        execution: {},
      } as RegisterHooksContext['config'];
      app = feathersExpress(feathers()) as unknown as Application;
      (app as unknown as { publish: () => void }).publish = () => undefined;
      app.set('config', config);
      for (const path of ['messages', 'repos', 'branches', 'sessions', 'leaderboard', 'tasks']) {
        app.use(`/${path}`, inertService);
      }
      app.use('/users', createUsersService(db, app, config));
      app.use('/schedules', createSchedulesService(db));
      app.use('/schedules/:id/run-now', {
        async create(_data: unknown, runParams: AuthenticatedParams & { route?: { id?: string } }) {
          runNowCalls.push({
            scope: getCurrentTenantDatabaseScope(),
            tenant: getCurrentTenantId(),
            scheduleId: runParams.route?.id as string,
            provider: runParams.provider,
            userId: runParams.user?.user_id,
            paramsTenant: runParams.tenant?.tenant_id,
          });
          return { schedule_id: runParams.route?.id, triggered_manually: true };
        },
      });
      app.use('/artifacts', createArtifactsService(db, app), {
        methods: [...ARTIFACTS_SERVICE_TRANSPORT_METHODS],
      });
      const users = new UsersRepository(db);
      registerHooks({
        db,
        app,
        config,
        jwtSecret: 'disposable-test-not-a-credential',
        // Authentication itself is out of scope; the caller arrives on params.
        requireAuth: (context: HookContext) => context,
        superadminOpts: { allowSuperadmin: false },
        deployment: { mode: 'standalone' },
        sessionsService: app.service('sessions') as never,
        messagesService: app.service('messages') as never,
        boardsService: undefined,
        branchRepository: new BranchRepository(db),
        usersRepository: users,
        sessionsRepository: new SessionRepository(db),
      } as unknown as RegisterHooksContext);
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    beforeEach(() => {
      runNowCalls.length = 0;
    });

    it('round-trips declared bindings: REST save, payload, action, and data', async () => {
      const a = await seedTenant('a');
      const id = a.unboundArtifact.artifact_id;
      // A short schedule id: stored canonically, so the payload and the
      // execute-time lookup see the full id.
      const declared = interactions(shortId(a.schedule.schedule_id)).interactions;

      await patchArtifact(a.owner, a.tenantId, id, { agor_runtime: { interactions: declared } });
      const expected = interactions(a.schedule.schedule_id).interactions;
      expect((await readPersistedRuntime(a.tenantId, id))?.interactions).toEqual(expected);

      const payload = await readPayload(a.owner, a.tenantId, id);
      expect(payload.interaction_config).toEqual(expected);

      await expect(runAction(a.owner, a.tenantId, id, 'run')).resolves.toMatchObject({
        artifact_id: id,
        action_id: 'run',
        effect: 'schedule_run',
      });
      expect(runNowCalls).toEqual([
        expect.objectContaining({
          scheduleId: a.schedule.schedule_id,
          provider: 'rest',
          userId: a.owner.user_id,
          tenant: a.tenantId,
        }),
      ]);
      await expect(readData(a.owner, a.tenantId, id, 'status')).resolves.toMatchObject({
        kind: 'schedule_status',
        schedule_id: a.schedule.schedule_id,
        enabled: true,
      });
      await runAction(a.owner, a.tenantId, id, 'pause');
      await expect(readData(a.owner, a.tenantId, id, 'status')).resolves.toMatchObject({
        enabled: false,
      });

      // A viewer who cannot view the source branch gets the artifact but no
      // controls, and the routes still refuse them on their own.
      const outsiderPayload = await readPayload(a.outsider, a.tenantId, id);
      expect(outsiderPayload.artifact_id).toBe(id);
      expect(outsiderPayload.interaction_config).toBeUndefined();
      await expect(readData(a.outsider, a.tenantId, id, 'status')).rejects.toMatchObject({
        name: 'Forbidden',
      });
    });

    it('rejects invalid bindings at save time and persists nothing', async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      const id = a.unboundArtifact.artifact_id;

      // Another tenant's real schedule is invisible under RLS: refused, and
      // the message is the same one a nonexistent id gets.
      await expect(
        patchArtifact(a.owner, a.tenantId, id, {
          agor_runtime: interactions(b.schedule.schedule_id),
        })
      ).rejects.toMatchObject({
        name: 'BadRequest',
        message: expect.stringContaining(
          `"${b.schedule.schedule_id}" is not a schedule on this artifact's branch`
        ),
      });
      await expect(
        patchArtifact(a.owner, a.tenantId, id, {
          agor_runtime: {
            interactions: {
              actions: [
                {
                  id: 'run',
                  label: 'Run',
                  effect: { kind: 'schedule_run', schedule_id: a.schedule.schedule_id },
                  args: { prompt: 'injected' },
                },
              ],
            },
          },
        })
      ).rejects.toMatchObject({
        name: 'BadRequest',
        message: expect.stringContaining('actions[0] ("run").args is not a recognized field'),
      });
      // Only the creator (or an admin) may declare bindings at all.
      await expect(
        patchArtifact(a.outsider, a.tenantId, id, {
          agor_runtime: interactions(a.schedule.schedule_id),
        })
      ).rejects.toMatchObject({ name: 'Forbidden' });

      expect(await readPersistedRuntime(a.tenantId, id)).toBeFalsy();
      await expect(runAction(a.owner, a.tenantId, id, 'run')).rejects.toMatchObject({
        name: 'NotFound',
      });
      expect(runNowCalls).toEqual([]);
    });

    it('dispatches run-now with the caller identity and no open database scope', async () => {
      const a = await seedTenant('a');
      await expect(
        runAction(a.owner, a.tenantId, a.artifact.artifact_id, 'run')
      ).resolves.toMatchObject({ action_id: 'run', effect: 'schedule_run' });
      expect(runNowCalls).toEqual([
        {
          scope: undefined,
          tenant: a.tenantId,
          scheduleId: a.schedule.schedule_id,
          provider: 'rest',
          userId: a.owner.user_id,
          paramsTenant: a.tenantId,
        },
      ]);
    });

    it('applies a pinned schedule_set_enabled through the real schedules RBAC', async () => {
      const a = await seedTenant('a');
      // Visible public artifact, but no grant on the private board's branch.
      await expect(
        runAction(a.outsider, a.tenantId, a.artifact.artifact_id, 'pause')
      ).rejects.toMatchObject({ name: 'Forbidden' });
      expect((await readSchedule(a.tenantId, a.schedule.schedule_id))?.enabled).toBe(true);

      await expect(
        runAction(a.owner, a.tenantId, a.artifact.artifact_id, 'pause')
      ).resolves.toMatchObject({ result: { enabled: false } });
      expect((await readSchedule(a.tenantId, a.schedule.schedule_id))?.enabled).toBe(false);
    });

    it('holds the member role floor for actions and refuses invisible artifacts', async () => {
      const a = await seedTenant('a');
      await expect(
        runAction(a.viewer, a.tenantId, a.artifact.artifact_id, 'run')
      ).rejects.toMatchObject({ name: 'Forbidden' });
      // A private artifact is only its creator's, whatever the caller's role.
      await expect(
        runAction(a.outsider, a.tenantId, a.privateArtifact.artifact_id, 'run')
      ).rejects.toMatchObject({ name: 'NotFound' });
      await expect(
        readData(a.outsider, a.tenantId, a.privateArtifact.artifact_id, 'status')
      ).rejects.toMatchObject({ name: 'NotFound' });
      expect(runNowCalls).toEqual([]);
    });

    it('refuses internal calls that would skip the delegated RBAC hooks', async () => {
      const a = await seedTenant('a');
      const artifacts = app.service('artifacts') as unknown as {
        invokeActionBinding(id: string, actionId: string, params: unknown): Promise<unknown>;
      };
      // Full tenant identity and a real user — only the missing provider is
      // wrong, and that alone must stop it.
      await expect(
        runWithTenantContext(a.tenantId, () =>
          artifacts.invokeActionBinding(a.artifact.artifact_id, 'run', {
            user: a.owner,
            tenant: { tenant_id: a.tenantId, source: 'explicit' },
          })
        )
      ).rejects.toThrow('Artifact bindings require an authenticated external caller');
      expect(runNowCalls).toEqual([]);
    });

    it("cannot reach another tenant's artifact or schedule by id", async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');

      // Tenant A caller names tenant B's real artifact.
      await expect(
        runAction(a.owner, a.tenantId, b.artifact.artifact_id, 'run')
      ).rejects.toMatchObject({ name: 'NotFound' });
      await expect(
        readData(a.owner, a.tenantId, b.artifact.artifact_id, 'status')
      ).rejects.toMatchObject({ name: 'NotFound' });

      // Tenant A's own artifact, re-pinned at tenant B's schedule: RLS hides
      // the target, so it is not on the artifact's branch.
      await rebind(a.tenantId, a.artifact.artifact_id, b.schedule.schedule_id);
      for (const actionId of ['run', 'pause']) {
        await expect(
          runAction(a.owner, a.tenantId, a.artifact.artifact_id, actionId)
        ).rejects.toMatchObject({ name: 'BadRequest' });
      }
      await expect(
        readData(a.owner, a.tenantId, a.artifact.artifact_id, 'status')
      ).rejects.toMatchObject({ name: 'BadRequest' });

      expect(runNowCalls).toEqual([]);
      expect((await readSchedule(b.tenantId, b.schedule.schedule_id))?.enabled).toBe(true);
    });

    it('projects a data binding through the real schedules view RBAC', async () => {
      const a = await seedTenant('a');
      const result = await readData(a.owner, a.tenantId, a.artifact.artifact_id, 'status');
      expect(result).toEqual(
        expect.objectContaining({
          kind: 'schedule_status',
          schedule_id: a.schedule.schedule_id,
          name: 'Nightly',
          enabled: true,
        })
      );
      expect(result).not.toHaveProperty('prompt');
      expect(result).not.toHaveProperty('created_by');
      // No branch grant: the delegated schedules.get refuses the outsider.
      await expect(
        readData(a.outsider, a.tenantId, a.artifact.artifact_id, 'status')
      ).rejects.toMatchObject({ name: 'Forbidden' });
    });
  }
);
