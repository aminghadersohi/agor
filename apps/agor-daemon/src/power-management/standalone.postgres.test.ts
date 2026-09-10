import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  type ResolvedPowerManagementConfig,
  resolvePowerManagementConfig,
} from '@agor/core/config';
import {
  AppVariableRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  STANDALONE_POWER_OWNER_KEY as OWNER_KEY,
  STANDALONE_POWER_OWNER_LOCK_FAMILY as OWNER_LOCK_FAMILY,
  STANDALONE_POWER_OWNER_NAMESPACE as OWNER_NAMESPACE,
  PowerPolicyRuntimeSettingsRepository,
  RepoRepository,
  rawRows,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  StandalonePowerOwner,
  sql,
  TaskRepository,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Schedule, type SessionID, TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulerService } from '../services/scheduler.js';
import {
  createEnvironmentHealthMonitor,
  prepareTaskRuntimeStartup,
  type StartupContext,
} from '../startup.js';
import { PowerPolicyController } from './controller.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const HOST_A = '00000000-0000-4000-8000-000000000001';
const HOST_B = '00000000-0000-4000-8000-000000000002';
const defaults = resolvePowerManagementConfig({
  mode: 'off',
  poll_interval_ms: 1000,
  provider_timeout_ms: 100,
  stale_after_ms: 2000,
  online_stable_ms: 1000,
  on_battery_debounce_ms: 0,
  recovery_dispatch_interval_ms: 500,
});
class Clock {
  now = 0;
  monotonicMs = () => this.now;
  wallNow = () => new Date(Date.UTC(2026, 0, 1) + this.now);
  sleep = async (ms: number) => {
    this.now += ms;
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'standalone power authority (real PostgreSQL)',
  () => {
    let db: Database;
    const owners: StandalonePowerOwner[] = [];
    const children: ChildProcess[] = [];
    let unique = 600000;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
      const rows = rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
        await db.execute(
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const rls = rawRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        await db.execute(
          sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('app_variables', 'sessions', 'tasks')`
        )
      );
      expect(rls).toHaveLength(3);
      expect(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    });
    afterAll(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      await Promise.all(owners.map((o) => o.close()));
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    const inTenant = <T>(tenant: string, work: (db: TenantScopedDatabase) => Promise<T>) =>
      runWithTenantDatabaseScope(db, tenant, work);
    async function acquire(tenant: string, host = HOST_A) {
      const owner = await StandalonePowerOwner.acquire(url!, tenant, host);
      owners.push(owner);
      return owner;
    }
    async function seed() {
      const tenant = `power-${generateId()}`;
      return inTenant(tenant, async (tx) => {
        const user = await new UsersRepository(tx).create({
          email: `${generateId()}@example.invalid`,
          name: 'Fictional operator',
        });
        const repo = await new RepoRepository(tx).create({
          repo_id: generateId(),
          slug: `fictional/${generateId()}`,
          name: 'Fictional repo',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(tx).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'fictional',
          ref: 'main',
          branch_unique_id: unique++,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id,
        });
        const session = await new SessionRepository(tx).create({
          session_id: generateId() as SessionID,
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'claude-code',
        });
        const task = await new TaskRepository(tx).createPending({
          session_id: session.session_id,
          created_by: user.user_id,
          full_prompt: 'Fictional prompt; never launch an executor',
          status: TaskStatus.QUEUED,
        });
        return { tenant, user, branch, session, task };
      });
    }
    async function controller(tenant: string, owner: StandalonePowerOwner, clock = new Clock()) {
      const c = new PowerPolicyController(defaults, null, clock);
      c.setOwnership(owner);
      const state = await inTenant(tenant, (tx) =>
        new PowerPolicyRuntimeSettingsRepository(tx).load(defaults)
      );
      c.configureBeforeStart(state.effective, state.view);
      return c;
    }
    async function apply(
      seed: Awaited<ReturnType<typeof seed>>,
      c: PowerPolicyController,
      mode: ResolvedPowerManagementConfig['mode'],
      revision: number
    ) {
      return c.applyRuntimeMutation(() =>
        inTenant(seed.tenant, async (tx) => {
          await c.assertOwnershipInTransaction(tx);
          return new PowerPolicyRuntimeSettingsRepository(tx).compareAndSwap({
            expectedRevision: revision,
            operation: 'apply',
            runtimeOverride: { mode },
            operatorDefaults: defaults,
            updatedBy: seed.user.user_id,
          });
        })
      );
    }
    const claim = (s: Awaited<ReturnType<typeof seed>>, c: PowerPolicyController) =>
      c.withDispatchPermit('normal', () =>
        inTenant(s.tenant, async (tx) => {
          await c.assertOwnershipInTransaction(tx);
          return new TaskRepository(tx).claimDispatchAndProjectSession(
            s.task.task_id,
            TaskStatus.QUEUED,
            { status: TaskStatus.DISPATCHING }
          );
        })
      );

    it('rejects competing processes and cross-host restart; allows only a new same-host boot after crash', async () => {
      const tenant = `process-${generateId()}`;
      const moduleUrl = new URL(
        '../../../../packages/core/src/db/standalone-power-owner.ts',
        import.meta.url
      ).href;
      const child = spawn(
        process.execPath,
        [
          // Match Vitest's workspace source resolution in an unbuilt CI checkout.
          '--conditions=source',
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
      const {StandalonePowerOwner} = await import(${JSON.stringify(moduleUrl)});
      await StandalonePowerOwner.acquire(process.env.AGOR_TEST_POSTGRES_URL, ${JSON.stringify(tenant)}, ${JSON.stringify(HOST_A)});
      process.stdout.write('owned\\n');
      process.stdin.resume();
    `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }
      );
      children.push(child);
      const ready = await new Promise<string>((resolve, reject) => {
        child.stdout!.once('data', (chunk) => resolve(String(chunk)));
        child.once('exit', (code) => reject(new Error(`owner child exited before ready: ${code}`)));
        child.stderr!.on('data', (chunk) => reject(new Error(String(chunk))));
      });
      expect(ready).toBe('owned\n');
      await expect(acquire(tenant)).rejects.toThrow(/ownership unavailable/);
      await expect(acquire(tenant, HOST_B)).rejects.toThrow(/ownership unavailable/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      // The OS closes the disposable owner's backend; explicitly wait for server acknowledgement,
      // not a timing sleep, before attempting same-host restart.
      await inTenant(tenant, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${OWNER_LOCK_FAMILY}, hashtext(${tenant}))`
        );
      });
      await expect(acquire(tenant, HOST_B)).rejects.toThrow(/ownership unavailable/);
      const replacement = await acquire(tenant);
      await expect(
        inTenant(tenant, (tx) => StandalonePowerOwner.assertAdmission(tx, replacement))
      ).resolves.toBeUndefined();
    });

    it('admits the local environment monitor only while the real standalone PostgreSQL owner is healthy', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      const c = await controller(s.tenant, owner);
      const ctx = {
        config: {
          database: { dialect: 'postgresql' },
          deployment: { mode: 'standalone', standalone_power_host_id: HOST_A },
          multi_tenancy: { mode: 'static', static_tenant_id: s.tenant },
        },
        db,
        taskRuntimePolicy: 'shared_postgres',
        environmentHealthMonitorPolicy: 'standalone',
        powerPolicyController: c,
      } as StartupContext;
      const monitor = { initialize: async () => undefined, cleanup: () => undefined };
      expect(createEnvironmentHealthMonitor(ctx, () => monitor)).toBe(monitor);
      await owner.close();
      expect(createEnvironmentHealthMonitor(ctx, () => monitor)).toBeNull();
    });

    it('binds checks to the actual scoped transaction, not a raw pool handle', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      await expect(
        inTenant(s.tenant, () => StandalonePowerOwner.assertAdmission(db, owner))
      ).resolves.toBeUndefined();
      await expect(
        runWithTenantContext(s.tenant, () => StandalonePowerOwner.assertAdmission(db, owner))
      ).rejects.toThrow(/ownership unavailable/);
    });

    it('keeps the claim transaction fenced across owner disconnect, and never replays the claim', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      const c = await controller(s.tenant, owner);
      const checked = deferred();
      const finish = deferred();
      const admitting = inTenant(s.tenant, async (tx) => {
        await c.assertOwnershipInTransaction(tx);
        checked.resolve();
        await finish.promise;
        return new TaskRepository(tx).claimDispatchAndProjectSession(
          s.task.task_id,
          TaskStatus.QUEUED,
          { status: TaskStatus.DISPATCHING }
        );
      });
      await checked.promise;
      await owner.close();
      try {
        await expect(acquire(s.tenant)).rejects.toThrow(/ownership unavailable/);
      } finally {
        finish.resolve();
      }
      expect((await admitting).outcome).toBe('claimed');
      const replacement = await acquire(s.tenant);
      const restarted = await controller(s.tenant, replacement);
      expect((await claim(s, restarted)).value?.outcome).toBe('already_claimed');
      await expect(claim(s, c)).rejects.toThrow(/ownership unavailable/);
      expect(
        (await inTenant(s.tenant, (tx) => new TaskRepository(tx).findById(s.task.task_id)))?.status
      ).toBe(TaskStatus.DISPATCHING);
    });

    it('fails Off admission after server-side connection loss, despite healthy pooled connections', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      const c = await controller(s.tenant, owner);
      await inTenant(s.tenant, async (tx) => {
        const raw = await new AppVariableRepository(tx).getPlain(
          'standalone_power_owner',
          'binding'
        );
        const binding = JSON.parse(raw!);
        // The NOSUPERUSER role may terminate its own disposable backend only.
        await tx.execute(sql`SELECT pg_terminate_backend(${binding.pid})`);
      });
      await expect(claim(s, c)).rejects.toThrow(/ownership unavailable/);
      expect(c.status()).toMatchObject({ mode: 'off', ownership: 'lost', held: false });
      expect(
        (await inTenant(s.tenant, (tx) => new TaskRepository(tx).findById(s.task.task_id)))?.status
      ).toBe(TaskStatus.QUEUED);
      await expect(apply(s, c, 'observe', 0)).rejects.toThrow(/ownership unavailable/);
    });

    it('rejects repeated admissions in every mode after loss without stranding the controller mutex', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      await owner.close();
      for (const mode of ['off', 'observe', 'enforce'] as const) {
        const c = new PowerPolicyController({ ...defaults, mode }, null, new Clock());
        c.setOwnership(owner);
        await expect(c.withDispatchPermit('normal', async () => 'must not run')).rejects.toThrow(
          /ownership unavailable/
        );
        await expect(
          c.withScheduleMaterializationPermit(async () => 'must not run')
        ).rejects.toThrow(/ownership unavailable/);
        await expect(c.withPriorityMutation(async () => 'must not run')).rejects.toThrow(
          /ownership unavailable/
        );
        expect(() => c.setOwnership(owner)).toThrow(/only be attached once/);
      }
    });

    it('persists Apply/reset/audit/restart CAS and fences a stale controller and unowned claimant', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      const c = await controller(s.tenant, owner);
      const results = await Promise.allSettled([
        apply(s, c, 'observe', 0),
        apply(s, c, 'enforce', 0),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await owner.close();
      const replacement = await acquire(s.tenant);
      const restarted = await controller(s.tenant, replacement);
      expect(restarted.status().runtime_settings?.revision).toBe(1);
      await expect(apply(s, c, 'off', 1)).rejects.toThrow(/ownership unavailable/);
      await expect(
        inTenant(s.tenant, (tx) => StandalonePowerOwner.assertAdmission(tx))
      ).rejects.toThrow(/ownership unavailable/);
      await restarted.applyRuntimeMutation(() =>
        inTenant(s.tenant, async (tx) => {
          await restarted.assertOwnershipInTransaction(tx);
          return new PowerPolicyRuntimeSettingsRepository(tx).compareAndSwap({
            expectedRevision: 1,
            operation: 'reset_to_operator_defaults',
            operatorDefaults: defaults,
            updatedBy: s.user.user_id,
          });
        })
      );
      expect(restarted.status()).toMatchObject({
        mode: 'off',
        runtime_settings: { revision: 2, source: 'operator_defaults' },
      });
      const loaded = await controller(s.tenant, replacement);
      expect(loaded.status().runtime_settings?.revision).toBe(2);
      expect(
        await inTenant(s.tenant, (tx) =>
          new AppVariableRepository(tx).getPlain('power_policy_runtime_audit', '0000000000000002')
        )
      ).toContain('reset_to_operator_defaults');
    });

    it('refuses startup repair before touching running or queued Tasks; same-host restart preserves both', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      await inTenant(s.tenant, (tx) =>
        new TaskRepository(tx).update(s.task.task_id, { status: TaskStatus.RUNNING })
      );
      const unowned = new PowerPolicyController(defaults, null, new Clock());
      const ctx = {
        db: createTenantScopedDatabaseProxy(db),
        config: { multi_tenancy: { mode: 'static', static_tenant_id: s.tenant } },
        taskRuntimePolicy: 'standalone',
        powerPolicyController: unowned,
      } as unknown as StartupContext;
      // No mocked repository: if the ownership guard is removed, this reaches the
      // intentionally absent startup services instead of the expected refusal.
      await expect(prepareTaskRuntimeStartup(ctx)).rejects.toThrow(/ownership unavailable/);
      await owner.close();
      const replacement = await acquire(s.tenant);
      ctx.powerPolicyController = await controller(s.tenant, replacement);
      ctx.taskRuntimePolicy = 'shared_postgres';
      await expect(prepareTaskRuntimeStartup(ctx)).resolves.toBeNull();
      expect(
        (await inTenant(s.tenant, (tx) => new TaskRepository(tx).findById(s.task.task_id)))?.status
      ).toBe(TaskStatus.RUNNING);
    });

    it('holds real schedule materialization and coalesces missed occurrences without duplicate Sessions', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      const clock = new Clock();
      const c = await controller(s.tenant, owner, clock);
      await apply(s, c, 'enforce', 0);
      const database = createTenantScopedDatabaseProxy(db);
      const schedule = await inTenant(s.tenant, (tx) =>
        new ScheduleRepository(tx).create({
          branch_id: s.branch.branch_id,
          created_by: s.user.user_id,
          name: 'Fictional hourly',
          cron_expression: '0 * * * *',
          timezone_mode: 'utc',
          prompt: 'Never launch',
          enabled: true,
          retention: 0,
          agentic_tool_config: { agentic_tool: 'claude-code' },
        })
      );
      const app = {
        get: () => undefined,
        service: () => ({ emit: () => undefined }),
      } as unknown as ConstructorParameters<typeof SchedulerService>[1];
      const scheduler = new SchedulerService(database, app, {
        workIdentity: { instanceId: 'fictional-daemon', bootId: 'fictional-boot' },
        tenantId: s.tenant,
        powerPolicy: c,
        testHooks: {
          afterSessionAdmission: () => {
            throw new Error('fictional boundary: no executor');
          },
        },
      });
      const processSchedule = (
        scheduler as unknown as { processSchedule(schedule: Schedule, now: number): Promise<void> }
      ).processSchedule.bind(scheduler);
      const tick = (time: number) =>
        runWithTenantContext(s.tenant, () => processSchedule(schedule, time));
      const now = Date.UTC(2026, 0, 1, 5, 45);
      await tick(now);
      expect(
        await inTenant(s.tenant, (tx) =>
          new SessionRepository(tx).countByScheduleId(schedule.schedule_id)
        )
      ).toBe(0);
      await c.ingestForTest({ condition: 'online', communication: 'ok' });
      clock.now += 1000;
      await c.ingestForTest({ condition: 'online', communication: 'ok' });
      await expect(tick(now)).rejects.toThrow('fictional boundary: no executor');
      await expect(tick(now)).rejects.toThrow('fictional boundary: no executor');
      expect(
        await inTenant(s.tenant, (tx) =>
          new SessionRepository(tx).countByScheduleId(schedule.schedule_id)
        )
      ).toBe(1);
      expect(
        await inTenant(s.tenant, (tx) =>
          new SessionRepository(tx).findScheduleRun(schedule.schedule_id, Date.UTC(2026, 0, 1, 5))
        )
      ).toBeTruthy();
      await inTenant(s.tenant, async (tx) => {
        const binding = JSON.parse(
          (await new AppVariableRepository(tx).getPlain(OWNER_NAMESPACE, OWNER_KEY))!
        );
        await tx.execute(sql`SELECT pg_terminate_backend(${binding.pid})`);
      });
      await expect(tick(now + 3600000)).rejects.toThrow(/ownership unavailable/);
      expect(
        await inTenant(s.tenant, (tx) =>
          new SessionRepository(tx).countByScheduleId(schedule.schedule_id)
        )
      ).toBe(1);
    });

    it('forces tenant isolation for ownership/policy/Tasks and keeps Essential uniqueness under racing transactions', async () => {
      const a = await seed();
      const b = await seed();
      const owner = await acquire(a.tenant);
      await expect(
        inTenant(b.tenant, (tx) => StandalonePowerOwner.assertAdmission(tx, owner))
      ).rejects.toThrow(/ownership unavailable/);
      expect(
        await inTenant(b.tenant, (tx) =>
          new AppVariableRepository(tx).getPlain(OWNER_NAMESPACE, OWNER_KEY)
        )
      ).toBeNull();
      expect(
        await inTenant(b.tenant, (tx) => new TaskRepository(tx).findById(a.task.task_id))
      ).toBeNull();
      await inTenant(a.tenant, (tx) =>
        new PowerPolicyRuntimeSettingsRepository(tx).compareAndSwap({
          expectedRevision: 0,
          operation: 'apply',
          runtimeOverride: { mode: 'observe' },
          operatorDefaults: defaults,
          updatedBy: a.user.user_id,
        })
      );
      expect(
        (
          await inTenant(b.tenant, (tx) =>
            new PowerPolicyRuntimeSettingsRepository(tx).load(defaults)
          )
        ).view.revision
      ).toBe(0);
      await inTenant(b.tenant, async (tx) => {
        // Raw SQL deliberately has no application tenant predicate: forced RLS is the guard.
        expect(
          rawRows(
            await tx.execute(
              sql`SELECT value_text FROM app_variables WHERE namespace = ${OWNER_NAMESPACE}`
            )
          )
        ).toEqual([]);
        expect(
          rawRows(
            await tx.execute(
              sql`UPDATE app_variables SET value_text = 'foreign' WHERE tenant_id = ${a.tenant} RETURNING variable_id`
            )
          )
        ).toEqual([]);
        expect(
          rawRows(
            await tx.execute(sql`SELECT task_id FROM tasks WHERE task_id = ${a.task.task_id}`)
          )
        ).toEqual([]);
      });
      const other = await inTenant(a.tenant, (tx) =>
        new SessionRepository(tx).create({
          session_id: generateId() as SessionID,
          branch_id: a.branch.branch_id,
          created_by: a.user.user_id,
          agentic_tool: 'claude-code',
        })
      );
      const results = await Promise.allSettled(
        [a.session, other].map((session) =>
          inTenant(a.tenant, (tx) =>
            new SessionRepository(tx).update(session.session_id, { power_priority: 'essential' })
          )
        )
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      // The other tenant has an independent one-slot cap.
      await expect(
        inTenant(b.tenant, (tx) =>
          new SessionRepository(tx).update(b.session.session_id, { power_priority: 'essential' })
        )
      ).resolves.toBeTruthy();
    });

    it('fails closed on a corrupt private binding without exposing its contents', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      await inTenant(s.tenant, (tx) =>
        new AppVariableRepository(tx).set({
          namespace: OWNER_NAMESPACE,
          key: OWNER_KEY,
          value: 'fictional-private-binding-not-json',
        })
      );
      try {
        await inTenant(s.tenant, (tx) => StandalonePowerOwner.assertAdmission(tx, owner));
        throw new Error('corrupt binding admitted');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/ownership unavailable/);
        expect((error as Error).message).not.toContain('fictional-private-binding');
      }
    });

    it('detects the counterfactual removal of FORCE RLS and rolls back the fictional mutation', async () => {
      const a = await seed();
      const b = await seed();
      await acquire(a.tenant);
      const foreign = async (tx: TenantScopedDatabase) =>
        rawRows(
          await tx.execute(
            sql`SELECT value_text FROM app_variables WHERE tenant_id = ${a.tenant} AND namespace = ${OWNER_NAMESPACE}`
          )
        );
      expect(await inTenant(b.tenant, foreign)).toEqual([]);
      await expect(
        inTenant(b.tenant, async (tx) => {
          await tx.execute(sql`ALTER TABLE app_variables NO FORCE ROW LEVEL SECURITY`);
          expect(await foreign(tx)).toHaveLength(1);
          throw new Error('rollback fictional RLS counterfactual');
        })
      ).rejects.toThrow('rollback fictional RLS counterfactual');
      expect(await inTenant(b.tenant, foreign)).toEqual([]);
    });

    it('keeps queued work durable through battery/critical/stale recovery and paces real claims with fictional time', async () => {
      const s = await seed();
      const owner = await acquire(s.tenant);
      const clock = new Clock();
      const c = await controller(s.tenant, owner, clock);
      await apply(s, c, 'observe', 0);
      await c.ingestForTest({ condition: 'battery', communication: 'ok', critical: true });
      // Observe must still admit: use a separate pending Task for the later Enforce sweep.
      expect((await claim(s, c)).value?.outcome).toBe('claimed');
      await apply(s, c, 'enforce', 1);
      expect((await claim(s, c)).decision.outcome).toBe('held');
      await c.ingestForTest({ condition: 'online', communication: 'ok' });
      clock.now += 1000;
      await c.ingestForTest({ condition: 'online', communication: 'ok' });
      const admissions: number[] = [];
      await Promise.all(
        [1, 2, 3].map(() =>
          c.withDispatchPermit('normal', () =>
            inTenant(s.tenant, async (tx) => {
              await c.assertOwnershipInTransaction(tx);
              admissions.push(clock.now);
              return new AppVariableRepository(tx).set({
                namespace: 'fictional_admission',
                key: String(admissions.length),
                value: 'paced',
              });
            })
          )
        )
      );
      expect(admissions).toEqual([1000, 1500, 2000]);
      clock.now += 2001;
      expect((await claim(s, c)).decision.outcome).toBe('held');
      // Policy swap must not re-stamp a stale provider observation as fresh.
      await apply(s, c, 'enforce', 2);
      expect((await claim(s, c)).decision.outcome).toBe('held');
      expect(
        (await inTenant(s.tenant, (tx) => new TaskRepository(tx).findById(s.task.task_id)))?.status
      ).toBe(TaskStatus.DISPATCHING);
    });
  }
);
