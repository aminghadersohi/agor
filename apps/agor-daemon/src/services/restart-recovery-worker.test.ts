import type { Task, TaskID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  findPendingRestartRecoveries: vi.fn(),
  update: vi.fn(),
}));
const scopes = vi.hoisted(() => ({ database: vi.fn(), tenant: vi.fn() }));

vi.mock('@agor/core/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...original,
    TaskRepository: class TaskRepository {
      findPendingRestartRecoveries = repository.findPendingRestartRecoveries;
      update = repository.update;
    },
    runWithTenantDatabaseScope: scopes.database.mockImplementation(async (_db, _tenantId, work) =>
      work()
    ),
    runWithTenantContext: scopes.tenant.mockImplementation(async (_tenantId, work) => work()),
  };
});

const { drainRestartRecoveries, RESTART_RECOVERY_PROMPT } = await import(
  './restart-recovery-worker.js'
);
const { restartRecoveryTaskId } = await import('../utils/durable-task-id.js');

function sourceTask(id: string, sessionId: string): Task {
  return {
    task_id: id,
    session_id: sessionId,
    created_by: 'user-1',
    status: TaskStatus.STOPPED,
    created_at: '2026-08-26T00:00:00.000Z',
    metadata: {
      restart_recovery: {
        source_task_id: id,
        state: 'pending',
        requested_at: '2026-08-26T00:00:01.000Z',
      },
    },
  } as Task;
}

function makeContext(
  tasks: Task[],
  sessions?: Record<string, Partial<import('@agor/core/types').Session>>
) {
  repository.findPendingRestartRecoveries.mockResolvedValue(tasks);
  repository.update.mockImplementation(async (id: string, patch: Partial<Task>) => ({
    ...tasks.find((task) => task.task_id === id),
    ...patch,
  }));
  const prompt = vi.fn(async (data) => ({ task_id: data.idempotencyTaskId }));
  const app = {
    service: (name: string) => {
      if (name === 'sessions') {
        return {
          get: vi.fn(async (id: string) => ({
            session_id: id,
            created_by: 'user-1',
            status: SessionStatus.IDLE,
            tasks: [tasks.find((task) => task.session_id === id)?.task_id],
            ...(sessions?.[id] ?? {}),
          })),
        };
      }
      if (name === 'users') return { get: vi.fn(async () => ({ user_id: 'user-1' })) };
      if (name === '/sessions/:id/prompt') return { create: prompt };
      throw new Error(`Unexpected service ${name}`);
    },
  };
  return {
    ctx: {
      app,
      db: {},
      config: {
        multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-a' },
        execution: {
          restart_recovery: { enabled: true, delay_ms: 250, max_tasks_per_start: 10 },
        },
      },
    } as Parameters<typeof drainRestartRecoveries>[0],
    prompt,
  };
}

describe('restart recovery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('admits deterministic continuations sequentially with tenant context', async () => {
    const tasks = [sourceTask('task-a', 'session-a'), sourceTask('task-b', 'session-b')];
    const { ctx, prompt } = makeContext(tasks);
    const sleep = vi.fn(async () => undefined);

    await expect(
      drainRestartRecoveries(ctx, { sleep, now: () => new Date('2026-08-26T00:00:02.000Z') })
    ).resolves.toEqual({ admitted: 2, superseded: 0, failed: 0 });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      prompt: RESTART_RECOVERY_PROMPT,
      idempotencyTaskId: restartRecoveryTaskId('task-a' as TaskID),
      metadata: {
        system_authored: true,
        restart_recovery: { source_task_id: 'task-a', state: 'admitted' },
      },
    });
    expect(prompt.mock.calls[0]?.[1]).toMatchObject({
      route: { id: 'session-a' },
      tenant: { tenant_id: 'tenant-a' },
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250);
    expect(scopes.tenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    expect(repository.update).toHaveBeenCalledTimes(2);
  });

  it('does not prompt when a user advanced or archived the session first', async () => {
    const tasks = [sourceTask('task-a', 'session-a'), sourceTask('task-b', 'session-b')];
    const { ctx, prompt } = makeContext(tasks, {
      'session-a': { tasks: ['task-a', 'new-user-task'] as never },
      'session-b': { archived: true },
    });

    await expect(drainRestartRecoveries(ctx, { sleep: vi.fn() })).resolves.toEqual({
      admitted: 0,
      superseded: 2,
      failed: 0,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(repository.update.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          restart_recovery: expect.objectContaining({
            state: 'superseded',
            disposition_reason: 'session_advanced',
          }),
        }),
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({
          restart_recovery: expect.objectContaining({
            state: 'superseded',
            disposition_reason: 'session_archived',
          }),
        }),
      }),
    ]);
  });

  it('leaves pending state untouched when admission fails so the next boot can retry', async () => {
    const task = sourceTask('task-a', 'session-a');
    const { ctx, prompt } = makeContext([task]);
    prompt.mockRejectedValueOnce(new Error('temporary database failure'));

    await expect(drainRestartRecoveries(ctx)).resolves.toEqual({
      admitted: 0,
      superseded: 0,
      failed: 1,
    });
    expect(repository.update).not.toHaveBeenCalled();
  });
});
