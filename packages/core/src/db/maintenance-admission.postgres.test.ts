import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { TaskStatus } from '../types';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import {
  acquireMaintenanceAdmission,
  inspectMaintenanceAdmission,
  releaseMaintenanceAdmission,
  sealMaintenanceAdmission,
} from './maintenance-admission';
import { runMigrations } from './migrate';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { runWithTenantContext, runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const enabled = !!url && process.env.AGOR_DB_DIALECT === 'postgresql';
describe.skipIf(!enabled)('operator maintenance admission (real PostgreSQL, forced RLS)', () => {
  let db: Database;
  let peer: Database;
  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: url! });
    peer = createDatabase({ dialect: 'postgresql', url: url! });
    expect(
      rawRows(
        await executeRaw(
          db,
          sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
        )
      )
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await runMigrations(db, { allowOfflineCutover: true });
  }, 30000);
  beforeEach(async () => {
    // Disposable database per suite in the CI runner, not an operator database.
    await executeRaw(db, sql`DROP SCHEMA IF EXISTS agor_maintenance CASCADE`);
    await executeRaw(db, sql`DROP POLICY IF EXISTS maintenance_admission_discovery ON tasks`);
    await executeRaw(db, sql`DROP POLICY IF EXISTS maintenance_admission_discovery ON branches`);
    // Keep old tenant fixtures terminal/non-active; no config or cadence changes.
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    await (peer as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  async function fixture(tenant: string, status: TaskStatus = TaskStatus.COMPLETED) {
    return runWithTenantDatabaseScope(db, tenant, async (scoped) => {
      const { branch, user } = await seedEnvironmentCommandBranch(scoped);
      const session = await new SessionRepository(scoped).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'codex',
        created_by: user.user_id,
      });
      const task = await new TaskRepository(scoped).create({
        session_id: session.session_id,
        created_by: user.user_id,
        full_prompt: 'fixture',
        status,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'fixture' },
      });
      return { task, session, branch, user };
    });
  }
  const acquire = () => acquireMaintenanceAdmission(db, { ttlMs: 900000, install: true });
  async function ageIdle() {
    // Time is DB-authored in production; age only the disposable fixture to
    // exercise the second finite probe without sleeping for a minute in CI.
    await executeRaw(
      db,
      sql`UPDATE agor_maintenance.control SET idle_since=clock_timestamp()-interval '61 seconds'`
    );
  }

  it('atomically installs on old binaries and blocks all producer inserts across tenants', async () => {
    const a = await fixture('producer-a'),
      b = await fixture('producer-b');
    const lease = await acquire();
    for (const [tenant, f] of [
      ['producer-a', a],
      ['producer-b', b],
    ] as const) {
      // Entire failed SQL transaction must reject (not catch inside an aborted transaction).
      await expect(
        runWithTenantDatabaseScope(peer, tenant, (scoped) =>
          executeRaw(
            scoped,
            sql`INSERT INTO tasks SELECT (jsonb_populate_record(NULL::public.tasks, to_jsonb(t) || jsonb_build_object('task_id', ${generateId()}::text))).* FROM tasks t WHERE task_id=${f.task.task_id}`
          )
        )
      ).rejects.toThrow();
      await expect(
        runWithTenantDatabaseScope(peer, tenant, async (scoped) =>
          new TaskRepository(scoped).createPending({
            session_id: f.session.session_id,
            created_by: f.user.user_id,
            full_prompt: 'held',
            status: TaskStatus.QUEUED,
          })
        )
      ).rejects.toThrow();
    }
    expect(await inspectMaintenanceAdmission(db)).toMatchObject({
      phase: 'draining',
      unfinishedTasks: 0,
    });
    await releaseMaintenanceAdmission(db, lease);
    await expect(
      runWithTenantDatabaseScope(peer, 'producer-b', async (scoped) =>
        new TaskRepository(scoped).createPending({
          session_id: b.session.session_id,
          created_by: b.user.user_id,
          full_prompt: 'after release',
          status: TaskStatus.QUEUED,
        })
      )
    ).resolves.toMatchObject({ status: TaskStatus.QUEUED });
    await runWithTenantDatabaseScope(db, 'producer-b', async (scoped) =>
      executeRaw(
        scoped,
        sql`UPDATE tasks SET status='completed' WHERE session_id=${b.session.session_id}`
      )
    );
  });

  it('rejects tenant-context management even for the SQL owner and preserves RLS', async () => {
    const a = await fixture('auth-a'),
      b = await fixture('auth-b');
    await acquire();
    await expect(
      runWithTenantContext('auth-a', () => inspectMaintenanceAdmission(db))
    ).rejects.toThrow('operator connection');
    await expect(
      runWithTenantDatabaseScope(db, 'auth-a', (scoped) =>
        acquireMaintenanceAdmission(scoped, { ttlMs: 60000 })
      )
    ).rejects.toThrow('operator connection');
    await runWithTenantDatabaseScope(db, 'auth-a', async (scoped) => {
      expect(await new TaskRepository(scoped).findById(b.task.task_id)).toBeNull();
      expect(await new TaskRepository(scoped).findById(a.task.task_id)).not.toBeNull();
    });
  });

  it('drains pre-existing queued/running work without cancellation, token revocation changes or replay', async () => {
    const f = await fixture('drain', TaskStatus.QUEUED);
    const lease = await acquire();
    await runWithTenantDatabaseScope(peer, 'drain', async (scoped) => {
      await executeRaw(
        scoped,
        sql`UPDATE tasks SET status='dispatching' WHERE task_id=${f.task.task_id}`
      );
      expect(await new TaskRepository(scoped).connectExecutor(f.task.task_id)).toMatchObject({
        transitioned: true,
        task: { status: 'running' },
      });
    });
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      phase: 'draining',
      unfinishedTasks: 1,
      admissionDrained: false,
    });
    await runWithTenantDatabaseScope(peer, 'drain', async (scoped) =>
      executeRaw(scoped, sql`UPDATE tasks SET status='completed' WHERE task_id=${f.task.task_id}`)
    );
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      phase: 'draining',
      admissionDrained: false,
    });
    await ageIdle();
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      phase: 'sealed',
      admissionDrained: true,
    });
    await expect(
      runWithTenantDatabaseScope(peer, 'drain', (scoped) =>
        executeRaw(scoped, sql`UPDATE tasks SET status='running' WHERE task_id=${f.task.task_id}`)
      )
    ).rejects.toThrow();
  });

  it('counts foreign work, unknown statuses and pending restart intents, with no own-task exemption', async () => {
    const f = await fixture('foreign-work', TaskStatus.CREATED);
    const lease = await acquire();
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      unfinishedTasks: 1,
      idleSince: null,
    });
    await runWithTenantDatabaseScope(peer, 'foreign-work', async (scoped) =>
      executeRaw(
        scoped,
        sql`UPDATE tasks SET status='stopped',data=jsonb_set(data,'{metadata}', '{"restart_recovery":{"state":"pending"}}'::jsonb) WHERE task_id=${f.task.task_id}`
      )
    );
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      unfinishedTasks: 0,
      pendingRestartRecoveries: 1,
      admissionDrained: false,
    });
    await runWithTenantDatabaseScope(peer, 'foreign-work', async (scoped) =>
      executeRaw(
        scoped,
        sql`UPDATE tasks SET data=data #- '{metadata,restart_recovery}' WHERE task_id=${f.task.task_id}`
      )
    );
    await releaseMaintenanceAdmission(db, lease);
    await runWithTenantDatabaseScope(peer, 'foreign-work', async (scoped) =>
      executeRaw(
        scoped,
        sql`UPDATE tasks SET status='future_status' WHERE task_id=${f.task.task_id}`
      )
    );
    const again = await acquire();
    expect(await sealMaintenanceAdmission(db, again)).toMatchObject({
      unfinishedTasks: 1,
      admissionDrained: false,
    });
    await runWithTenantDatabaseScope(peer, 'foreign-work', async (scoped) =>
      executeRaw(scoped, sql`UPDATE tasks SET status='completed' WHERE task_id=${f.task.task_id}`)
    );
  });

  it('expiry invalidates readiness but does not reopen ingress; exact expired owner can release', async () => {
    const f = await fixture('expiry');
    const lease = await acquire();
    // Exact deadline is fixed; a replacement/extension is never accepted.
    await expect(
      sealMaintenanceAdmission(db, { ...lease, generation: generateId() })
    ).rejects.toThrow('generation/deadline');
    await executeRaw(
      db,
      sql`UPDATE agor_maintenance.control SET expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second'`
    );
    const expired = await inspectMaintenanceAdmission(db);
    expect(expired).toMatchObject({ expired: true, phase: 'draining', admissionDrained: false });
    await expect(sealMaintenanceAdmission(db, lease)).rejects.toThrow();
    await expect(
      runWithTenantDatabaseScope(peer, 'expiry', (scoped) =>
        executeRaw(
          scoped,
          sql`INSERT INTO tasks SELECT (jsonb_populate_record(NULL::public.tasks, to_jsonb(t) || jsonb_build_object('task_id', ${generateId()}::text))).* FROM tasks t WHERE task_id=${f.task.task_id}`
        )
      )
    ).rejects.toThrow();
    await expect(releaseMaintenanceAdmission(db, lease)).rejects.toThrow('generation/deadline');
    await releaseMaintenanceAdmission(db, {
      database: lease.database,
      generation: lease.generation,
      expiresAt: expired.expiresAt!,
    });
    expect(await inspectMaintenanceAdmission(db)).toMatchObject({ phase: 'released' });
  });

  it('hold waits for an already-admitting transaction; late admissions cannot cross it', async () => {
    const f = await fixture('race');
    const initial = await acquire();
    await releaseMaintenanceAdmission(db, initial);
    let entered!: () => void, finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inflight = runWithTenantDatabaseScope(peer, 'race', async (scoped) => {
      await executeRaw(
        scoped,
        sql`UPDATE tasks SET status='queued' WHERE task_id=${f.task.task_id}`
      );
      entered();
      await gate;
    });
    await admitted;
    // Observe an actual cross-connection lock wait, not a fake sleep ordering.
    let acquired = false;
    const holding = acquire().then((v) => {
      acquired = true;
      return v;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acquired).toBe(false);
    finish();
    await inflight;
    const lease = await holding;
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      unfinishedTasks: 1,
      admissionDrained: false,
    });
    await runWithTenantDatabaseScope(peer, 'race', (scoped) =>
      executeRaw(scoped, sql`UPDATE tasks SET status='completed' WHERE task_id=${f.task.task_id}`)
    );
  });

  it('two acquire contenders have one winner; old generation cannot release a successor', async () => {
    await fixture('contenders');
    const initial = await acquire();
    await releaseMaintenanceAdmission(db, initial);
    const r = await Promise.allSettled([
      acquireMaintenanceAdmission(db, { ttlMs: 60000 }),
      acquireMaintenanceAdmission(peer, { ttlMs: 60000 }),
    ]);
    expect(r.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    const lease = (
      r.find((v) => v.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquire>>
      >
    ).value;
    await expect(releaseMaintenanceAdmission(db, initial)).rejects.toThrow('generation/deadline');
    await releaseMaintenanceAdmission(db, lease);
    const audit = rawRows<{ event: string }>(
      await executeRaw(db, sql`SELECT event FROM agor_maintenance.audit ORDER BY sequence`)
    );
    expect(audit.map((r) => r.event)).toEqual(['acquired', 'released', 'acquired', 'released']);
  });

  it('missing/disabled trigger or missing global policy cannot report empty-and-ready', async () => {
    await fixture('proof');
    await acquire();
    await executeRaw(db, sql`ALTER TABLE tasks DISABLE TRIGGER agor_maintenance_admission`);
    await expect(inspectMaintenanceAdmission(db)).rejects.toThrow('installation');
    await executeRaw(db, sql`ALTER TABLE tasks ENABLE TRIGGER agor_maintenance_admission`);
    await executeRaw(db, sql`DROP POLICY maintenance_admission_discovery ON tasks`);
    await expect(inspectMaintenanceAdmission(db)).rejects.toThrow('installation');
  });
  it('covers new Session admission and branch command intents, while existing command settlement drains', async () => {
    const f = await fixture('branch-intent');
    await runWithTenantDatabaseScope(peer, 'branch-intent', (scoped) =>
      executeRaw(
        scoped,
        sql`
      UPDATE branches SET data=jsonb_set(data,'{environment_instance}',
        '{"command_attempt":{"id":"preexisting-command"}}'::jsonb) WHERE branch_id=${f.branch.branch_id}`
      )
    );
    const lease = await acquire();
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({
      branchOperations: 1,
      admissionDrained: false,
    });
    await expect(
      runWithTenantDatabaseScope(peer, 'branch-intent', (scoped) =>
        new SessionRepository(scoped).create({
          session_id: generateId(),
          branch_id: f.branch.branch_id,
          agentic_tool: 'codex',
          created_by: f.user.user_id,
        })
      )
    ).rejects.toThrow();
    await expect(
      runWithTenantDatabaseScope(peer, 'branch-intent', (scoped) =>
        executeRaw(
          scoped,
          sql`
      UPDATE branches SET data=jsonb_set(data,'{environment_instance}',
        '{"command_attempt":{"id":"new-command"}}'::jsonb) WHERE branch_id=${f.branch.branch_id}`
        )
      )
    ).rejects.toThrow();
    await runWithTenantDatabaseScope(peer, 'branch-intent', (scoped) =>
      executeRaw(
        scoped,
        sql`
      UPDATE branches SET data=jsonb_set(data,'{environment_instance,command_attempt,finished_at}',to_jsonb(clock_timestamp())) WHERE branch_id=${f.branch.branch_id}`
      )
    );
    expect(await sealMaintenanceAdmission(db, lease)).toMatchObject({ branchOperations: 0 });
  });

  it('a different database binding cannot seal or release even the exact generation and deadline', async () => {
    await fixture('db-binding');
    const lease = await acquire();
    await expect(
      sealMaintenanceAdmission(db, { ...lease, database: 'other-database' })
    ).rejects.toThrow('generation/deadline');
    await expect(
      releaseMaintenanceAdmission(db, { ...lease, database: 'other-database' })
    ).rejects.toThrow('generation/deadline');
    expect(await inspectMaintenanceAdmission(db)).toMatchObject({
      phase: 'draining',
      generation: lease.generation,
    });
  });

  it('negative control: disabling the enforcing trigger actually admits old-binary SQL', async () => {
    const f = await fixture('negative-control');
    await acquire();
    await executeRaw(db, sql`ALTER TABLE tasks DISABLE TRIGGER agor_maintenance_admission`);
    await runWithTenantDatabaseScope(peer, 'negative-control', (scoped) =>
      executeRaw(
        scoped,
        sql`
      INSERT INTO tasks SELECT (jsonb_populate_record(NULL::public.tasks,
        to_jsonb(t)||jsonb_build_object('task_id',${generateId()}::text))).* FROM tasks t WHERE task_id=${f.task.task_id}`
      )
    );
    // A duplicate-PK, syntax or RLS error cannot masquerade as successful enforcement.
    await expect(inspectMaintenanceAdmission(db)).rejects.toThrow('installation');
  });
});
