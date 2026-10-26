/**
 * ScheduleRepository Tests
 *
 * Focuses on the new behavior introduced with first-class schedules:
 *   - findDue: the scheduler hot-path query (enabled + due)
 *   - findAccessibleSchedules: SQL-JOIN RBAC filter
 *   - findByBranchId: list a branch's schedules newest-first
 *   - basic CRUD round-trip + agentic_tool_config jsonb/text roundtrip
 */

import { normalizePersistedScheduleAgenticToolConfig } from '@agor/core/config';
import {
  type AgenticToolPresetID,
  type BranchID,
  type PersistedScheduleAgenticToolConfig,
  type Schedule,
  TaskStatus,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  type UserID,
  type UUID,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { executeRaw, select, update } from '../database-wrapper';
import { schedules } from '../schema';
import { dbTest } from '../test-helpers';
import { AgenticToolPresetRepository } from './agentic-tool-presets';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { ScheduleRepository } from './schedules';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

async function setupContext(db: Database) {
  const userRepo = new UsersRepository(db);
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const scheduleRepo = new ScheduleRepository(db);

  const user = await userRepo.create({
    email: `schedule-test-${Date.now()}-${Math.random()}@example.com`,
    name: 'Schedule Test',
  });
  const userId = user.user_id as UUID;

  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: `schedule-test-${Date.now()}`,
    name: 'sched-test',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/sched-test',
    default_branch: 'main',
  });

  const branch = await branchRepo.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'feat-sched',
    ref: 'refs/heads/feat-sched',
    branch_unique_id: 1,
    path: '/tmp/sched-test/feat-sched',
    new_branch: false,
    last_used: new Date().toISOString(),
    created_by: userId,
    others_can: 'view',
  });

  return {
    branchId: branch.branch_id as BranchID,
    userId,
    branchRepo,
    scheduleRepo,
  };
}

function scheduleData(overrides?: {
  name?: string;
  enabled?: boolean;
  next_run_at?: number | null;
  retention?: number;
}) {
  return {
    name: overrides?.name ?? 'Hourly heartbeat',
    cron_expression: '0 * * * *',
    timezone_mode: 'utc' as const,
    prompt: 'Heartbeat for {{branch.name}}',
    agentic_tool_config: {
      agentic_tool: 'claude-code' as const,
    },
    enabled: overrides?.enabled ?? true,
    allow_concurrent_runs: false,
    retention: overrides?.retention ?? 5,
    next_run_at: overrides?.next_run_at ?? undefined,
  };
}

describe('ScheduleRepository.create + findById', () => {
  for (const reference of [
    USER_DEFAULT_AGENTIC_CONFIGURATION,
    WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
  ] as const) {
    dbTest(`persists ${reference} for run-time resolution`, async ({ db }) => {
      const ctx = await setupContext(db);
      const created = await ctx.scheduleRepo.create({
        ...scheduleData(),
        branch_id: ctx.branchId,
        created_by: ctx.userId,
        agentic_tool_config: {
          agentic_tool: 'claude-code',
          configuration_reference: reference,
        },
      });

      await expect(ctx.scheduleRepo.findById(created.schedule_id)).resolves.toMatchObject({
        agentic_tool_config: { configuration_reference: reference },
      });
    });
  }

  dbTest('round-trips a schedule with all fields populated', async ({ db }) => {
    const ctx = await setupContext(db);

    const created = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'Daily summary' }),
      mcp_server_ids: ['mcp-one', 'mcp-two'],
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    expect(created.schedule_id).toBeTruthy();
    expect(created.name).toBe('Daily summary');
    expect(created.cron_expression).toBe('0 * * * *');
    expect(created.timezone_mode).toBe('utc');
    expect(created.agentic_tool_config.agentic_tool).toBe('claude-code');
    expect(created.enabled).toBe(true);
    expect(created.allow_concurrent_runs).toBe(false);
    expect(created.mcp_server_ids).toEqual(['mcp-one', 'mcp-two']);

    const fetched = await ctx.scheduleRepo.findById(created.schedule_id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Daily summary');
    // agentic_tool_config round-trips through text/jsonb cleanly
    expect(fetched?.agentic_tool_config).toEqual({ agentic_tool: 'claude-code' });
    expect(fetched?.mcp_server_ids).toEqual(['mcp-one', 'mcp-two']);
  });

  for (const [storedReference, canonicalReference] of [
    [USER_DEFAULT_AGENTIC_CONFIGURATION, USER_DEFAULT_AGENTIC_CONFIGURATION],
    [WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
    ['___workspace_default___', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
  ] as const) {
    dbTest(
      `reads and updates a raw legacy ${storedReference} row without moving it into the preset FK`,
      async ({ db }) => {
        const ctx = await setupContext(db);
        const created = await ctx.scheduleRepo.create({
          ...scheduleData(),
          branch_id: ctx.branchId,
          created_by: ctx.userId,
        });
        const storedConfig = {
          agentic_tool: 'codex',
          preset_id: storedReference,
          context_files: ['AGENTS.md'],
          model_config: { mode: 'exact', model: 'gpt-5.4' },
        } as unknown as PersistedScheduleAgenticToolConfig;

        await update(db, schedules)
          .set({ agentic_tool_config: storedConfig, agentic_tool_preset_id: null })
          .where(eq(schedules.schedule_id, created.schedule_id))
          .run();

        const read = await ctx.scheduleRepo.findById(created.schedule_id);
        expect(read?.agentic_tool_config).toEqual(storedConfig);

        const updated = await ctx.scheduleRepo.update(created.schedule_id, { name: 'updated' });
        expect(updated.agentic_tool_config).toEqual(storedConfig);
        expect(normalizePersistedScheduleAgenticToolConfig(updated.agentic_tool_config)).toEqual({
          agentic_tool: 'codex',
          configuration_reference: canonicalReference,
          context_files: ['AGENTS.md'],
          model_config: { mode: 'exact', model: 'gpt-5.4' },
        });

        const raw = await select(db)
          .from(schedules)
          .where(eq(schedules.schedule_id, created.schedule_id))
          .one();
        expect(raw?.agentic_tool_preset_id).toBeNull();
        expect(raw?.agentic_tool_config).toEqual(storedConfig);
      }
    );
  }

  dbTest('prefers a non-null preset FK without dropping the stored snapshot', async ({ db }) => {
    const ctx = await setupContext(db);
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'codex',
        name: 'Canonical preset',
        configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
      ctx.userId as UserID
    );
    const created = await ctx.scheduleRepo.create({
      ...scheduleData(),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    await update(db, schedules)
      .set({
        agentic_tool_config: {
          agentic_tool: 'codex',
          preset_id: USER_DEFAULT_AGENTIC_CONFIGURATION,
          context_files: ['AGENTS.md'],
          model_config: { mode: 'exact', model: 'snapshot-model' },
        },
        agentic_tool_preset_id: preset.preset_id,
      })
      .where(eq(schedules.schedule_id, created.schedule_id))
      .run();

    const read = await ctx.scheduleRepo.findById(created.schedule_id);
    expect(read?.agentic_tool_config).toEqual({
      agentic_tool: 'codex',
      preset_id: preset.preset_id as AgenticToolPresetID,
      context_files: ['AGENTS.md'],
      model_config: { mode: 'exact', model: 'snapshot-model' },
    });

    const updated = await ctx.scheduleRepo.update(created.schedule_id, { name: 'updated' });
    expect(updated.agentic_tool_config).toEqual(read?.agentic_tool_config);
  });

  dbTest('rejects schedule without required fields', async ({ db }) => {
    const ctx = await setupContext(db);
    await expect(
      ctx.scheduleRepo.create({
        branch_id: ctx.branchId,
        created_by: ctx.userId,
        // missing name, cron, prompt, agentic_tool_config
      })
    ).rejects.toThrow();
  });
});

describe('ScheduleRepository.findByBranchId', () => {
  dbTest('returns newest-first schedules for the given branch', async ({ db }) => {
    const ctx = await setupContext(db);

    const first = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'first' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Force a small gap so created_at orders correctly even at sub-ms speeds.
    await new Promise((r) => setTimeout(r, 5));
    const second = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'second' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const all = await ctx.scheduleRepo.findByBranchId(ctx.branchId);
    expect(all.map((s) => s.name)).toEqual(['second', 'first']);
    expect(all[0].schedule_id).toBe(second.schedule_id);
    expect(all[1].schedule_id).toBe(first.schedule_id);
  });
});

describe('ScheduleRepository.findDue', () => {
  dbTest('returns enabled schedules whose next_run_at <= now', async ({ db }) => {
    const ctx = await setupContext(db);
    const now = Date.now();

    // Due — past next_run_at.
    const due = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'due', next_run_at: now - 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Due — never-fired (next_run_at IS NULL).
    const never = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'never', next_run_at: null }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Not due — future next_run_at.
    await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'future', next_run_at: now + 60 * 60 * 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    // Disabled.
    await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'disabled', enabled: false, next_run_at: now - 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const dueList = await ctx.scheduleRepo.findDue(now);
    const dueIds = new Set(dueList.map((s) => s.schedule_id));
    expect(dueIds.has(due.schedule_id)).toBe(true);
    expect(dueIds.has(never.schedule_id)).toBe(true);
    expect(dueList.length).toBe(2);
  });

  dbTest('findDueRefs returns only due schedule routing refs', async ({ db }) => {
    const ctx = await setupContext(db);
    const now = Date.now();

    const due = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'due-ref', next_run_at: now - 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });
    await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'future-ref', next_run_at: now + 60 * 60 * 1000 }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const refs = await ctx.scheduleRepo.findDueRefs(now);

    expect(refs).toEqual([{ schedule_id: due.schedule_id }]);
  });

  dbTest('findDueRefs enforces the scheduler batch limit', async ({ db }) => {
    const ctx = await setupContext(db);
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ctx.scheduleRepo.create({
          ...scheduleData({ name: `due-${index}`, next_run_at: now - 5_000 + index }),
          branch_id: ctx.branchId,
          created_by: ctx.userId,
        })
      )
    );

    expect(await ctx.scheduleRepo.findDueRefs(now, 2)).toHaveLength(2);
    await expect(ctx.scheduleRepo.findDueRefs(now, 0)).rejects.toThrow(/between 1 and 1000/);
  });
});

describe('ScheduleRepository.findAccessibleSchedules', () => {
  dbTest('returns schedules whose parent branch the user can view', async ({ db }) => {
    const userRepo = new UsersRepository(db);
    const repoRepo = new RepoRepository(db);
    const branchRepo = new BranchRepository(db);
    const scheduleRepo = new ScheduleRepository(db);

    // Two users, two branches: alice owns one and the other is restricted.
    const alice = await userRepo.create({
      email: `alice-${Date.now()}@example.com`,
      name: 'Alice',
    });
    const bob = await userRepo.create({
      email: `bob-${Date.now()}@example.com`,
      name: 'Bob',
    });

    const repo = await repoRepo.create({
      repo_id: generateId() as UUID,
      slug: `acc-test-${Date.now()}`,
      name: 'acc-test',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/acc-test',
      default_branch: 'main',
    });

    const aliceBranch = await branchRepo.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id as UUID,
      name: 'alice-branch',
      ref: 'refs/heads/alice',
      branch_unique_id: 1,
      path: '/tmp/acc-test/alice',
      new_branch: false,
      last_used: new Date().toISOString(),
      created_by: alice.user_id as UUID,
      others_can: 'view', // bob can view via others_can
    });

    const lockedBranch = await branchRepo.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id as UUID,
      name: 'locked-branch',
      ref: 'refs/heads/locked',
      branch_unique_id: 2,
      path: '/tmp/acc-test/locked',
      new_branch: false,
      last_used: new Date().toISOString(),
      created_by: bob.user_id as UUID,
      others_can: 'none', // alice cannot view
    });

    const aliceSchedule = await scheduleRepo.create({
      ...scheduleData({ name: 'alice-sched' }),
      branch_id: aliceBranch.branch_id as BranchID,
      created_by: alice.user_id as UUID,
    });
    await scheduleRepo.create({
      ...scheduleData({ name: 'locked-sched' }),
      branch_id: lockedBranch.branch_id as BranchID,
      created_by: bob.user_id as UUID,
    });

    // alice-branch has others_can='view', so both alice and bob see its
    // schedule via the public-view path.
    const aliceVisible = await scheduleRepo.findAccessibleSchedules(alice.user_id as UUID);
    const aliceIds = new Set(aliceVisible.map((s) => s.schedule_id));
    expect(aliceIds.has(aliceSchedule.schedule_id)).toBe(true);
    // locked-branch is others_can='none' and alice has no branchOwners
    // row on it, so its schedule must not appear.
    expect(aliceVisible.every((s) => s.branch_id === aliceBranch.branch_id)).toBe(true);

    // Branch creation establishes the immutable primary owner. Bob therefore
    // sees both the shared Alice branch and his own private branch.
    const bobVisible = await scheduleRepo.findAccessibleSchedules(bob.user_id as UUID);
    const bobIds = new Set(bobVisible.map((s) => s.schedule_id));
    expect(bobIds.has(aliceSchedule.schedule_id)).toBe(true);
    expect(bobIds.size).toBe(2);
    expect(bobVisible.some((s) => s.branch_id === lockedBranch.branch_id)).toBe(true);
  });
});

describe('ScheduleRepository.update', () => {
  dbTest('patches a subset of fields without nuking the rest', async ({ db }) => {
    const ctx = await setupContext(db);
    const created = await ctx.scheduleRepo.create({
      ...scheduleData({ name: 'before' }),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    const patched = await ctx.scheduleRepo.update(created.schedule_id, {
      name: 'after',
      enabled: false,
    });

    expect(patched.name).toBe('after');
    expect(patched.enabled).toBe(false);
    expect(patched.cron_expression).toBe(created.cron_expression);
    expect(patched.prompt).toBe(created.prompt);
    expect(patched.agentic_tool_config).toEqual(created.agentic_tool_config);
  });
});

describe('ScheduleRepository.delete', () => {
  dbTest('removes a schedule and subsequent findById returns null', async ({ db }) => {
    const ctx = await setupContext(db);
    const created = await ctx.scheduleRepo.create({
      ...scheduleData(),
      branch_id: ctx.branchId,
      created_by: ctx.userId,
    });

    await ctx.scheduleRepo.delete(created.schedule_id);
    const after = await ctx.scheduleRepo.findById(created.schedule_id);
    expect(after).toBeNull();
  });
});

async function createOccurrence(db: Database, schedule: Schedule, manual = false) {
  const taskId = generateId();
  const session = await new SessionRepository(db).create({
    branch_id: schedule.branch_id,
    created_by: schedule.created_by,
    agentic_tool: 'claude-code',
    schedule_id: schedule.schedule_id,
    scheduled_from_branch: true,
    scheduled_run_at: Date.now(),
    custom_context: {
      scheduled_run: {
        rendered_prompt: 'Run once',
        run_index: 1,
        initial_task_id: taskId,
        triggered_manually: manual,
      },
    },
  });
  return new TaskRepository(db).create({
    task_id: taskId,
    session_id: session.session_id,
    created_by: schedule.created_by,
    full_prompt: 'Run once',
    status: TaskStatus.RUNNING,
  });
}

async function guardedSchedule(db: Database, overrides: Partial<Schedule> = {}) {
  const ctx = await setupContext(db);
  return ctx.scheduleRepo.create({
    ...scheduleData(),
    branch_id: ctx.branchId,
    created_by: ctx.userId,
    ...overrides,
  });
}

describe('durable schedule execution failure guard', () => {
  dbTest('a new database connection observes and continues the durable streak', async ({ db }) => {
    const schedule = await guardedSchedule(db, { failure_threshold: 2 });
    const first = await createOccurrence(db, schedule);
    await new TaskRepository(db).update(first.task_id, { status: TaskStatus.FAILED });
    const files = (await executeRaw(db, sql`PRAGMA database_list`)).rows as Array<{
      name: string;
      file: string;
    }>;
    const file = files.find((entry) => entry.name === 'main')?.file;
    if (!file) throw new Error('Expected a file-backed test database');
    const replacement = createDatabase({ url: `file:${file}` });
    const second = await createOccurrence(replacement, schedule);
    await new TaskRepository(replacement).update(second.task_id, { status: TaskStatus.FAILED });
    expect(await new ScheduleRepository(replacement).findById(schedule.schedule_id)).toMatchObject({
      enabled: false,
      consecutive_failures: 2,
      attention_required: true,
    });
  });

  dbTest(
    'defaults on, survives replacement repositories, counts each initial Task only once',
    async ({ db }) => {
      const schedule = await guardedSchedule(db);
      expect(schedule).toMatchObject({
        skills_enabled: true,
        failure_threshold: 3,
        consecutive_failures: 0,
        attention_required: false,
      });
      for (let i = 0; i < 3; i++) {
        const task = await createOccurrence(db, schedule);
        // A restarted daemon uses the same durable rows, not process-local counters.
        await new TaskRepository(db).update(task.task_id, { status: TaskStatus.FAILED });
        await new TaskRepository(db).update(task.task_id, { status: TaskStatus.FAILED });
        expect(
          (await new ScheduleRepository(db).findById(schedule.schedule_id))?.consecutive_failures
        ).toBe(i + 1);
      }
      expect(await new ScheduleRepository(db).findById(schedule.schedule_id)).toMatchObject({
        enabled: false,
        pause_reason: 'repeated_failures',
        attention_required: true,
        cron_expression: schedule.cron_expression,
        next_run_at: schedule.next_run_at,
        agentic_tool_config: schedule.agentic_tool_config,
      });
      expect(await new ScheduleRepository(db).findDue()).toHaveLength(0);
      const resumed = await new ScheduleRepository(db).update(schedule.schedule_id, {
        enabled: true,
      });
      expect(resumed).toMatchObject({
        enabled: true,
        consecutive_failures: 0,
        attention_required: false,
      });
      expect(resumed.pause_reason).toBeUndefined();
      // No Task is re-created or replayed by acknowledging the guard.
      expect(await new SessionRepository(db).countByScheduleId(schedule.schedule_id)).toBe(3);
    }
  );

  dbTest(
    'ignores later continuations and manual runs; success resets only the cron execution streak',
    async ({ db }) => {
      const schedule = await guardedSchedule(db);
      const tasks = new TaskRepository(db);
      const first = await createOccurrence(db, schedule);
      await tasks.update(first.task_id, { status: TaskStatus.FAILED });
      const later = await tasks.create({
        session_id: first.session_id,
        created_by: schedule.created_by,
        full_prompt: 'Ordinary continuation',
        status: TaskStatus.RUNNING,
      });
      await tasks.update(later.task_id, { status: TaskStatus.COMPLETED });
      const manual = await createOccurrence(db, schedule, true);
      await tasks.update(manual.task_id, { status: TaskStatus.FAILED });
      expect(
        (await new ScheduleRepository(db).findById(schedule.schedule_id))?.consecutive_failures
      ).toBe(1);
      const success = await createOccurrence(db, schedule);
      await tasks.update(success.task_id, { status: TaskStatus.COMPLETED });
      const failedContinuation = await tasks.create({
        session_id: success.session_id,
        created_by: schedule.created_by,
        full_prompt: 'Later failure',
        status: TaskStatus.RUNNING,
      });
      await tasks.update(failedContinuation.task_id, { status: TaskStatus.FAILED });
      expect(await new ScheduleRepository(db).findById(schedule.schedule_id)).toMatchObject({
        enabled: true,
        consecutive_failures: 0,
      });
    }
  );

  dbTest(
    'serializes overlapping failures and duplicate settlement without lost counts',
    async ({ db }) => {
      const schedule = await guardedSchedule(db, {
        allow_concurrent_runs: true,
        failure_threshold: 2,
      });
      const first = await createOccurrence(db, schedule);
      const second = await createOccurrence(db, schedule);
      await Promise.all([
        new TaskRepository(db).update(first.task_id, { status: TaskStatus.FAILED }),
        new TaskRepository(db).update(second.task_id, { status: TaskStatus.TIMED_OUT }),
        new TaskRepository(db).update(first.task_id, { status: TaskStatus.FAILED }),
      ]);
      expect(await new ScheduleRepository(db).findById(schedule.schedule_id)).toMatchObject({
        enabled: false,
        consecutive_failures: 2,
        attention_required: true,
      });
    }
  );

  dbTest(
    'preserves human pauses, opt-out, unrelated schedules and cancellation boundaries',
    async ({ db }) => {
      const human = await guardedSchedule(db, { enabled: false, failure_threshold: 1 });
      const optedOut = await guardedSchedule(db, { failure_threshold: 0 });
      const sibling = await new ScheduleRepository(db).create({
        ...human,
        schedule_id: generateId(),
        name: 'Sibling',
        enabled: true,
      });
      const tasks = new TaskRepository(db);
      for (const schedule of [human, optedOut]) {
        const failed = await createOccurrence(db, schedule);
        await tasks.update(failed.task_id, { status: TaskStatus.FAILED });
      }
      const stopped = await createOccurrence(db, sibling);
      await tasks.update(stopped.task_id, { status: TaskStatus.STOPPED });
      expect(await new ScheduleRepository(db).findById(human.schedule_id)).toMatchObject({
        enabled: false,
        attention_required: false,
      });
      expect(await new ScheduleRepository(db).findById(optedOut.schedule_id)).toMatchObject({
        enabled: true,
        attention_required: false,
      });
      expect(await new ScheduleRepository(db).findById(sibling.schedule_id)).toMatchObject({
        enabled: true,
        consecutive_failures: 0,
      });
    }
  );

  dbTest(
    'counts verified containment failure once, never unverified containment or user Stop',
    async ({ db }) => {
      const schedule = await guardedSchedule(db, { failure_threshold: 1 });
      const task = await createOccurrence(db, schedule);
      const tasks = new TaskRepository(db);
      await tasks.claimTermination({
        taskId: task.task_id,
        cause: 'heartbeat_lost',
        errorMessage: 'Connection lost',
        sdkFailure: {
          reason: 'heartbeat_lost',
          detected_at: new Date().toISOString(),
          tool: 'claude-code',
          termination: 'requested',
        },
      });
      await tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'test-claim',
        leaseDurationMs: 30_000,
        instanceId: 'test-instance',
        bootId: 'test-boot',
      });
      await tasks.settleTermination({
        taskId: task.task_id,
        outcome: 'unverified',
        coordinationToken: 'test-claim',
        errorMessage: 'Not verified',
      });
      expect(
        (await new ScheduleRepository(db).findById(schedule.schedule_id))?.consecutive_failures
      ).toBe(0);
      // A replacement coordinator may settle only after new authoritative evidence.
      const request = (await tasks.findById(task.task_id))!.termination_request!;
      await tasks.retryTermination(
        task.task_id,
        request.requested_at,
        request.recovery_revision ?? request.requested_at
      );
      await tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'test-claim-2',
        leaseDurationMs: 30_000,
        instanceId: 'test-instance-2',
        bootId: 'test-boot-2',
      });
      await tasks.settleTermination({
        taskId: task.task_id,
        outcome: 'verified_absent',
        coordinationToken: 'test-claim-2',
      });
      await tasks.settleTermination({
        taskId: task.task_id,
        outcome: 'verified_absent',
        coordinationToken: 'test-claim-2',
      });
      expect(await new ScheduleRepository(db).findById(schedule.schedule_id)).toMatchObject({
        enabled: false,
        consecutive_failures: 1,
      });
    }
  );
});
