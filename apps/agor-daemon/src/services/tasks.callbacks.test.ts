import { runWithTenantDatabaseScope, shortId } from '@agor/core/db';
import { type Session, type Task, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { completionCallbackTaskId } from '../utils/durable-task-id.js';
import { TasksService } from './tasks';

const childSessionId = '018f0000-0000-7000-8000-000000000101';
const parentSessionId = '018f0000-0000-7000-8000-000000000102';
const taskId = '018f0000-0000-7000-8000-000000000201';
const callbackTaskId = '018f0000-0000-7000-8000-000000000301';
const relationshipId = '018f0000-0000-7000-8000-000000000302';
const userId = '018f0000-0000-7000-8000-000000000401';
const completionSubscriptionId = '018f0000-0000-7000-8000-000000000501';
const durableCallbackTaskId = completionCallbackTaskId(
  taskId as Task['task_id'],
  parentSessionId as Session['session_id']
);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: taskId,
    session_id: childSessionId,
    created_by: userId,
    full_prompt: 'investigate duplicate callbacks',
    status: TaskStatus.RUNNING,
    message_range: {
      start_index: 0,
      end_index: 2,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    tool_use_count: 3,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: childSessionId,
    branch_id: undefined,
    created_by: userId,
    agentic_tool: 'claude-code',
    status: 'running',
    title: 'Child session',
    description: 'Child session',
    tasks: [taskId],
    ready_for_prompt: false,
    archived: false,
    genealogy: {
      parent_session_id: parentSessionId,
      children: [],
    },
    callback_config: {
      enabled: true,
      callback_session_id: parentSessionId,
      callback_created_by: userId,
      callback_mode: 'once',
      include_last_message: true,
    },
    git_state: {},
    contextFiles: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function makeService(
  options: {
    task?: Partial<Task>;
    childSession?: Partial<Session>;
    parentSession?: Partial<Session>;
  } = {}
) {
  const initialTask = makeTask(options.task);
  const tasksById = new Map<string, Task>([[initialTask.task_id, initialTask]]);
  const childSession = makeSession(options.childSession);
  const parentSession = makeSession({
    session_id: parentSessionId,
    status: 'idle',
    title: 'Parent session',
    tasks: [],
    ready_for_prompt: true,
    genealogy: { children: [childSessionId] },
    callback_config: undefined,
    ...options.parentSession,
  });

  const repository = {
    findById: vi.fn(async (id: string) => tasksById.get(id) ?? null),
    update: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasksById.get(id) ?? makeTask({ task_id: id as Task['task_id'] });
      const updated = { ...current, ...updates } as Task;
      tasksById.set(id, updated);
      return updated;
    }),
    create: vi.fn(),
    findAll: vi.fn(async () => [...tasksById.values()]),
    delete: vi.fn(),
  };

  const callbackTask = makeTask({
    task_id: callbackTaskId,
    session_id: parentSessionId,
    status: TaskStatus.QUEUED,
  });
  const createPending = vi.fn(async (data: Partial<Task>) => {
    const pending = { ...callbackTask, ...data } as Task;
    tasksById.set(pending.task_id, pending);
    return pending;
  });

  const sessionsPatch = vi.fn(async (id: string, updates: Partial<Session>) => {
    const target = id === parentSessionId ? parentSession : childSession;
    Object.assign(target, updates);
    return { ...target };
  });
  const sessionsFork = vi.fn(async (_id: string, data: Record<string, unknown>) =>
    makeSession({
      session_id: data.stableSessionId as Session['session_id'],
      genealogy: { forked_from_session_id: parentSessionId, children: [] },
      fork_origin: 'btw',
      callback_config: data.callbackConfig as Session['callback_config'],
      tasks: [],
    })
  );
  const triggerQueueProcessing = vi.fn(async () => undefined);
  const messagesFind = vi.fn(async () => [
    {
      role: 'assistant',
      index: 2,
      content: [{ type: 'text', text: 'Final child result' }],
    },
  ]);
  const revokeTaskTokens = vi.fn(async () => 1);

  const service = Object.create(TasksService.prototype) as TasksService & {
    repository: typeof repository;
    taskRepo: typeof repository & { createPending: typeof createPending };
    id: string;
    emit: ReturnType<typeof vi.fn>;
    app: { service: ReturnType<typeof vi.fn> };
    completionCallbackDispatches: Map<string, Promise<unknown>>;
    executorCredentialRevoker: { revokeTaskTokens: typeof revokeTaskTokens };
  };
  service.repository = repository;
  service.taskRepo = { ...repository, createPending };
  service.id = 'task_id';
  service.emit = vi.fn();
  service.completionCallbackDispatches = new Map();
  service.executorCredentialRevoker = { revokeTaskTokens };
  service.app = {
    service: vi.fn((name: string) => {
      if (name === 'sessions') {
        return {
          get: vi.fn(async (id: string) => (id === parentSessionId ? parentSession : childSession)),
          patch: sessionsPatch,
          fork: sessionsFork,
          triggerQueueProcessing,
        };
      }
      if (name === 'messages') return { find: messagesFind };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    }),
  };

  return {
    service,
    repository,
    createPending,
    sessionsPatch,
    sessionsFork,
    triggerQueueProcessing,
    messagesFind,
    revokeTaskTokens,
    getStoredTask: (id = taskId) => tasksById.get(id),
    childSession,
  };
}

describe('TasksService completion callbacks', () => {
  it('retires the exact executor Task lease on ordinary and coordinator terminality', async () => {
    const { service, revokeTaskTokens } = makeService();

    await service.patch(taskId, { status: TaskStatus.COMPLETED });
    expect(revokeTaskTokens).toHaveBeenCalledWith(taskId);

    const settledTask = makeTask({ status: TaskStatus.STOPPED });
    service.taskRepo.settleTermination = vi.fn().mockResolvedValue({
      outcome: 'terminal',
      task: settledTask,
    });
    await service.settleTermination({ taskId, outcome: 'verified_absent' } as never);
    expect(revokeTaskTokens).toHaveBeenLastCalledWith(taskId);
    expect(revokeTaskTokens).toHaveBeenCalledTimes(2);
  });

  it('retries credential retirement for an idempotent terminal-state write', async () => {
    const { service, revokeTaskTokens } = makeService();

    await service.patch(taskId, { status: TaskStatus.COMPLETED });
    revokeTaskTokens.mockClear();

    await service.patch(taskId, { status: TaskStatus.FAILED });

    expect(revokeTaskTokens).toHaveBeenCalledOnce();
    expect(revokeTaskTokens).toHaveBeenCalledWith(taskId);
  });

  it('defers callback dispatch until after the tenant transaction commits', async () => {
    const events: string[] = [];
    const { service, createPending } = makeService();
    const tx = {
      execute: vi.fn(async () => []),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:committed');
        return result;
      }),
    };
    createPending.mockImplementationOnce(async (data: Partial<Task>) => {
      events.push('callback:queued');
      return {
        ...makeTask({
          task_id: callbackTaskId,
          session_id: parentSessionId,
          status: TaskStatus.QUEUED,
        }),
        ...data,
      };
    });
    await runWithTenantDatabaseScope(db as never, 'tenant-1', async () => {
      await service.patch(taskId, {
        status: TaskStatus.COMPLETED,
        completed_at: '2026-01-01T00:00:05.000Z',
      });

      events.push('patch:returned');
      expect(createPending).not.toHaveBeenCalled();
    });

    expect(events).toEqual([
      'tx:start',
      'patch:returned',
      'tx:committed',
      'tx:start',
      'callback:queued',
      'tx:committed',
      'tx:start',
      'tx:committed',
      'tx:start',
      'tx:committed',
    ]);
    expect(createPending).toHaveBeenCalledTimes(1);
  });

  it('routes an already-running Task only to a direct destination retargeted before completion', async () => {
    const newDestinationId = '018f0000-0000-7000-8000-000000000888' as Session['session_id'];
    const { service, createPending, childSession, sessionsPatch, triggerQueueProcessing } =
      makeService({
        childSession: {
          callback_config: {
            enabled: true,
            callback_session_id: parentSessionId,
            callback_created_by: userId,
            callback_mode: 'persistent',
          },
        },
      });
    const latestChild = makeSession({
      ...childSession,
      callback_config: {
        ...childSession.callback_config,
        callback_session_id: newDestinationId,
      },
    });
    let childReads = 0;
    service.app.service.mockImplementation((name: string) => {
      if (name === 'sessions') {
        return {
          // The first read models the snapshot taken while terminalizing the
          // Task. The post-commit dispatch read must observe the committed
          // retarget instead of carrying that stale route forward.
          get: vi.fn(async (id: string) => {
            if (id === childSessionId) {
              childReads += 1;
              return childReads === 1 ? childSession : latestChild;
            }
            return makeSession({
              session_id: id as Session['session_id'],
              status: 'idle',
              tasks: [],
              callback_config: undefined,
            });
          }),
          patch: sessionsPatch,
          triggerQueueProcessing,
        };
      }
      if (name === 'messages') return { find: vi.fn(async () => []) };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(childReads).toBeGreaterThanOrEqual(2);
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: newDestinationId })
    );
    expect(createPending).not.toHaveBeenCalledWith(
      expect.objectContaining({ session_id: parentSessionId })
    );
  });

  it('owns a callback BTW under the current retargeted destination, never the stale one', async () => {
    const newDestinationId = '018f0000-0000-7000-8000-000000000889' as Session['session_id'];
    const { service, childSession, sessionsPatch, sessionsFork, triggerQueueProcessing } =
      makeService({
        childSession: {
          callback_config: {
            enabled: true,
            callback_session_id: parentSessionId,
            callback_created_by: userId,
            callback_mode: 'persistent',
            delivery: 'btw',
          },
        },
      });
    const latestChild = makeSession({
      ...childSession,
      callback_config: {
        ...childSession.callback_config,
        callback_session_id: newDestinationId,
      },
    });
    let childReads = 0;
    service.app.service.mockImplementation((name: string) => {
      if (name === 'sessions') {
        return {
          get: vi.fn(async (id: string) => {
            if (id === childSessionId) {
              childReads += 1;
              return childReads === 1 ? childSession : latestChild;
            }
            return makeSession({
              session_id: id as Session['session_id'],
              status: 'idle',
              tasks: [],
              callback_config: undefined,
            });
          }),
          patch: sessionsPatch,
          fork: sessionsFork,
          triggerQueueProcessing,
        };
      }
      if (name === 'messages') return { find: vi.fn(async () => []) };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    });
    vi.spyOn(service as any, 'callbackBtwUnavailableReason').mockResolvedValue(undefined);

    await service.patch(taskId, { status: TaskStatus.COMPLETED });

    await vi.waitFor(() => expect(sessionsFork).toHaveBeenCalledOnce());
    expect(sessionsFork).toHaveBeenCalledWith(
      newDestinationId,
      expect.objectContaining({
        callbackConfig: expect.objectContaining({
          digest: expect.objectContaining({ destination_session_id: newDestinationId }),
        }),
      }),
      { provider: undefined }
    );
    expect(sessionsFork).not.toHaveBeenCalledWith(
      parentSessionId,
      expect.anything(),
      expect.anything()
    );
  });

  it('queues exactly one templated callback with last-message metadata for a completed subsession task', async () => {
    const {
      service,
      createPending,
      sessionsPatch,
      triggerQueueProcessing,
      messagesFind,
      getStoredTask,
    } = makeService();

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: durableCallbackTaskId,
        session_id: parentSessionId,
        status: TaskStatus.QUEUED,
        metadata: expect.objectContaining({
          is_agor_callback: true,
          source: 'agor',
          child_session_id: childSessionId,
          child_task_id: taskId,
          queued_by_user_id: userId,
          initial_message_id: durableCallbackTaskId,
        }),
      })
    );
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
    expect(callbackPrompt).toContain(taskId);
    expect(callbackPrompt).not.toContain('## Original Prompt');
    expect(callbackPrompt).not.toContain('investigate duplicate callbacks');
    expect(messagesFind).toHaveBeenCalledTimes(1);
    expect(messagesFind).toHaveBeenCalledWith(
      expect.objectContaining({
        query: {
          session_id: childSessionId,
          task_id: taskId,
          role: 'assistant',
          $sort: { index: -1 },
          $limit: 1,
        },
      })
    );
    await vi.waitFor(() =>
      expect(triggerQueueProcessing).toHaveBeenCalledWith(parentSessionId, {})
    );
    await vi.waitFor(() =>
      expect(sessionsPatch).toHaveBeenCalledWith(
        childSessionId,
        expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
      )
    );
    await vi.waitFor(() =>
      expect(getStoredTask().metadata?.callback_dispatches).toEqual([
        expect.objectContaining({
          event: 'task_completion',
          target_session_id: parentSessionId,
          queued_task_id: durableCallbackTaskId,
        }),
      ])
    );
  });

  it('does not report an intermediary as terminal to the root completion requester', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService();
    const intermediaryTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      metadata: {
        completion_subscription_id: completionSubscriptionId,
      },
    });
    (service as any).resolveRootCompletionRoute = vi
      .fn()
      .mockResolvedValue({ targetSessionId: parentSessionId });

    await (service as any).dispatchCompletionCallbacks(intermediaryTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalled();
  });

  it('preserves a direct intermediary callback while suppressing the premature root callback', async () => {
    const intermediarySessionId = '018f0000-0000-7000-8000-000000000778';
    const { service, createPending, childSession } = makeService();
    const terminalTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      metadata: {
        completion_subscription_id: completionSubscriptionId,
        completion_callback: {
          target_session_id: intermediarySessionId as Task['session_id'],
          requested_from_session_id: intermediarySessionId as Task['session_id'],
          requested_by_user_id: userId,
        },
      },
    });
    (service as any).resolveRootCompletionRoute = vi
      .fn()
      .mockResolvedValue({ targetSessionId: parentSessionId });

    await (service as any).dispatchCompletionCallbacks(terminalTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: intermediarySessionId })
    );
    expect(createPending).not.toHaveBeenCalledWith(
      expect.objectContaining({ session_id: parentSessionId })
    );
  });

  it('includeOriginalPrompt=false queues one templated callback without an original prompt section', async () => {
    const { service, createPending } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: false,
          include_last_message: true,
        },
      },
      task: {
        full_prompt: 'original prompt should not appear when disabled',
      },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
    expect(callbackPrompt).not.toContain('## Original Prompt');
    expect(callbackPrompt).not.toContain('original prompt should not appear when disabled');
  });

  it('includeOriginalPrompt=true queues one templated callback with an explicit original prompt section', async () => {
    const originalPrompt = [
      'Investigate callback duplication.',
      'Keep this second line in the callback body.',
    ].join('\n');
    const { service, createPending } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: true,
          include_last_message: true,
        },
      },
      task: { full_prompt: originalPrompt },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('## Original Prompt');
    expect(callbackPrompt).toContain(originalPrompt);
    expect(callbackPrompt).toContain('**Result:**');
    expect(callbackPrompt).toContain('Final child result');
  });

  it('exposes childSessionTitle to custom callback templates', async () => {
    const { service, createPending } = makeService({
      childSession: { title: 'Investigate flaky test' },
      parentSession: {
        callback_config: {
          template: 'Child "{{childSessionTitle}}" ({{childSessionId}}) is done.',
        },
      },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toBe(
      `Child "Investigate flaky test" (${shortId(childSessionId as Session['session_id'])}) is done.`
    );
  });

  it('uses the same single templated patch completion path for sessions.create callbacks without spawn genealogy', async () => {
    const { service, createPending, sessionsPatch } = makeService({
      childSession: {
        genealogy: { children: [] },
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
          include_original_prompt: true,
          include_last_message: true,
        },
      },
      task: { full_prompt: 'remote session initial prompt' },
    });

    await service.patch(taskId, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    const callbackPrompt = createPending.mock.calls[0][0].full_prompt as string;
    expect(callbackPrompt).toContain('[Agor] Child session');
    expect(callbackPrompt).toContain('## Original Prompt');
    expect(callbackPrompt).toContain('remote session initial prompt');
    expect(callbackPrompt).toContain('Final child result');
    await vi.waitFor(() =>
      expect(sessionsPatch).toHaveBeenCalledWith(
        childSessionId,
        expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
      )
    );
  });

  it('dedupes concurrent completion callback dispatch for the same task target', async () => {
    const { service, createPending, childSession } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await Promise.all([
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
    ]);

    expect(createPending).toHaveBeenCalledTimes(1);
  });

  it('routes explicit BTW through one deterministic digest fork and one digest Task', async () => {
    const { service, createPending, sessionsFork, triggerQueueProcessing, childSession } =
      makeService({
        childSession: {
          callback_config: {
            enabled: true,
            callback_session_id: parentSessionId,
            callback_created_by: userId,
            callback_mode: 'persistent',
            delivery: 'btw',
          },
        },
      });
    childSession.remote_relationships = {
      as_target: [
        {
          relationship_id: relationshipId as any,
          source_session_id: parentSessionId as Session['session_id'],
          target_session_id: childSessionId as Session['session_id'],
          relationship_type: 'remote_create',
          created_by: userId as any,
          created_at: '2026-01-01T00:00:00.000Z',
          callback_enabled: true,
          callback_session_id: parentSessionId as Session['session_id'],
        },
      ],
    };
    vi.spyOn(service as any, 'callbackBtwUnavailableReason').mockResolvedValue(undefined);
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await Promise.all([
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
    ]);

    expect(sessionsFork).toHaveBeenCalledTimes(1);
    expect(sessionsFork).toHaveBeenCalledWith(
      parentSessionId,
      expect.objectContaining({
        stableSessionId: expect.any(String),
        forkOrigin: 'btw',
        callbackConfig: expect.objectContaining({
          enabled: false,
          delivery: 'direct',
          digest: expect.objectContaining({
            source_task_id: taskId,
            destination_session_id: parentSessionId,
            relationship_ids: [relationshipId],
          }),
        }),
      }),
      { provider: undefined }
    );
    expect(createPending).toHaveBeenCalledTimes(1);
    const digestTask = createPending.mock.calls[0][0];
    expect(digestTask.session_id).not.toBe(parentSessionId);
    expect(digestTask.metadata).toMatchObject({
      callback_delivery: {
        source_task_id: taskId,
        destination_session_id: parentSessionId,
        requested_delivery: 'btw',
        resolved_delivery: 'btw',
        relationship_ids: [relationshipId],
      },
    });
    expect(triggerQueueProcessing).toHaveBeenCalledWith(digestTask.session_id, {});
  });

  it('falls back to one direct Task with an audited reason when BTW is unavailable', async () => {
    const { service, createPending, sessionsFork, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'persistent',
          delivery: 'btw',
        },
      },
    });
    vi.spyOn(service as any, 'callbackBtwUnavailableReason').mockResolvedValue(
      'missing_fork_state'
    );

    await (service as any).dispatchCompletionCallbacks(
      makeTask({ status: TaskStatus.COMPLETED }),
      childSession,
      {}
    );

    expect(sessionsFork).not.toHaveBeenCalled();
    expect(createPending).toHaveBeenCalledOnce();
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: parentSessionId,
        metadata: expect.objectContaining({
          callback_delivery: expect.objectContaining({
            requested_delivery: 'btw',
            resolved_delivery: 'direct',
            fallback_reason: 'missing_fork_state',
          }),
        }),
      })
    );
  });

  it('keeps the durable direct fallback as the retry winner after BTW creation fails', async () => {
    const { service, createPending, sessionsFork, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'persistent',
          delivery: 'btw',
        },
      },
    });
    vi.spyOn(service as any, 'callbackBtwUnavailableReason').mockResolvedValue(undefined);
    const queueBtw = vi
      .spyOn(service as any, 'queueCallbackThroughBtw')
      .mockRejectedValue(new Error('side-session insert failed'));
    const completed = makeTask({ status: TaskStatus.COMPLETED });

    const first = await (service as any).queueCallbackToSession(
      completed,
      childSession,
      parentSessionId,
      {}
    );
    const second = await (service as any).queueCallbackToSession(
      completed,
      childSession,
      parentSessionId,
      {}
    );

    expect(first.delivery).toBe('direct');
    expect(second.delivery).toBe('direct');
    expect(queueBtw).toHaveBeenCalledOnce();
    expect(sessionsFork).not.toHaveBeenCalled();
    expect(createPending).toHaveBeenCalledOnce();
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: parentSessionId,
        metadata: expect.objectContaining({
          callback_delivery: expect.objectContaining({ fallback_reason: 'creation_failed' }),
        }),
      })
    );
  });

  it('keeps auto direct while idle and uses BTW while busy', async () => {
    const idle = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'persistent',
          delivery: 'auto',
        },
      },
    });
    await (idle.service as any).dispatchCompletionCallbacks(
      makeTask({ status: TaskStatus.COMPLETED }),
      idle.childSession,
      {}
    );
    expect(idle.sessionsFork).not.toHaveBeenCalled();
    expect(idle.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: parentSessionId })
    );

    const busy = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'persistent',
          delivery: 'auto',
        },
      },
      parentSession: { status: 'running' },
    });
    vi.spyOn(busy.service as any, 'callbackBtwUnavailableReason').mockResolvedValue(undefined);
    await (busy.service as any).dispatchCompletionCallbacks(
      makeTask({ status: TaskStatus.COMPLETED }),
      busy.childSession,
      {}
    );
    expect(busy.sessionsFork).toHaveBeenCalledOnce();
  });

  it('keeps an exact-Task subscription direct even when standing policy is BTW', async () => {
    const { service, createPending, sessionsFork, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'persistent',
          delivery: 'btw',
        },
      },
      task: {
        metadata: {
          completion_callback: {
            target_session_id: parentSessionId as Session['session_id'],
            requested_from_session_id: parentSessionId as Session['session_id'],
            requested_by_user_id: userId,
          },
        },
      },
    });

    await (service as any).dispatchCompletionCallbacks(
      makeTask({
        status: TaskStatus.COMPLETED,
        metadata: {
          completion_callback: {
            target_session_id: parentSessionId as Session['session_id'],
            requested_from_session_id: parentSessionId as Session['session_id'],
            requested_by_user_id: userId,
          },
        },
      }),
      childSession,
      {}
    );

    expect(sessionsFork).not.toHaveBeenCalled();
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: parentSessionId,
        metadata: expect.objectContaining({
          callback_delivery: expect.objectContaining({ route: 'exact_task' }),
        }),
      })
    );
  });

  it('loop-guards callback digest completion before any callback Task or fork is created', async () => {
    const { service, createPending, sessionsFork, childSession } = makeService({
      childSession: {
        fork_origin: 'btw',
        callback_config: {
          enabled: false,
          delivery: 'direct',
          digest: {
            kind: 'callback_digest',
            source_session_id: childSessionId as Session['session_id'],
            source_task_id: taskId as Task['task_id'],
            destination_session_id: parentSessionId as Session['session_id'],
            relationship_ids: [],
            route: 'standing',
            requested_delivery: 'btw',
            resolved_delivery: 'btw',
            callback_created_by: userId as any,
            final_message_id: callbackTaskId as any,
          },
        },
      },
    });

    await (service as any).dispatchCompletionCallbacks(
      makeTask({ status: TaskStatus.COMPLETED }),
      childSession,
      {}
    );

    expect(createPending).not.toHaveBeenCalled();
    expect(sessionsFork).not.toHaveBeenCalled();
  });

  it('still triggers target queue processing if dispatch marker persistence fails after queueing', async () => {
    const { service, repository, createPending, triggerQueueProcessing } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });
    const originalUpdate = repository.update.getMockImplementation();
    repository.update.mockImplementation(async (id: string, updates: Partial<Task>) => {
      if (updates.metadata?.callback_dispatches) {
        throw new Error('metadata write failed');
      }
      if (!originalUpdate) throw new Error('missing original update');
      return originalUpdate(id, updates);
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, makeSession(), {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(triggerQueueProcessing).toHaveBeenCalledWith(parentSessionId, {});
  });

  it('runs once-mode cleanup only for the caller that actually attempts dispatch', async () => {
    const { service, createPending, sessionsPatch, childSession } = makeService();
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await Promise.all([
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
      (service as any).dispatchCompletionCallbacks(completedTask, childSession, {}),
    ]);

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(
      sessionsPatch.mock.calls.filter(
        ([id, updates]) =>
          id === childSessionId && (updates as Partial<Session>).callback_config?.enabled === false
      )
    ).toHaveLength(1);
  });

  it("callbackMode='once' prevents a repeat callback after the first firing", async () => {
    const { service, createPending, childSession } = makeService();
    const firstTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(firstTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(childSession.callback_config?.enabled).toBe(false);

    createPending.mockClear();

    const secondTask = makeTask({
      task_id: '018f0000-0000-7000-8000-000000000202' as Task['task_id'],
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:01:05.000Z',
      metadata: undefined,
    });

    await (service as any).dispatchCompletionCallbacks(secondTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
  });

  it("callbackMode='once' does not disable when callback queueing fails before firing", async () => {
    const { service, createPending, sessionsPatch, childSession } = makeService();
    createPending.mockRejectedValueOnce(new Error('queue failed'));
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(
      sessionsPatch.mock.calls.filter(
        ([id, updates]) =>
          id === childSessionId && (updates as Partial<Session>).callback_config?.enabled === false
      )
    ).toHaveLength(0);
    expect(childSession.callback_config?.enabled).toBe(true);
  });

  it('does not queue or trigger when callback dispatch metadata already exists', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService({
      task: {
        metadata: {
          callback_dispatches: [
            {
              event: 'task_completion',
              target_session_id: parentSessionId,
              queued_task_id: callbackTaskId,
              dispatched_at: '2026-01-01T00:00:06.000Z',
            },
          ],
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
      metadata: {
        callback_dispatches: [
          {
            event: 'task_completion',
            target_session_id: parentSessionId,
            queued_task_id: callbackTaskId,
            dispatched_at: '2026-01-01T00:00:06.000Z',
          },
        ],
      },
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalledWith(parentSessionId, {});
  });

  it('does not queue or trigger target processing when callbacks are disabled', async () => {
    const { service, createPending, triggerQueueProcessing, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: false,
          callback_session_id: parentSessionId,
          callback_created_by: userId,
          callback_mode: 'once',
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).not.toHaveBeenCalled();
    expect(triggerQueueProcessing).not.toHaveBeenCalledWith(parentSessionId, {});
  });

  it('uses legacy genealogy parent fallback when callback_session_id is absent', async () => {
    const { service, createPending, childSession } = makeService({
      childSession: {
        callback_config: {
          enabled: true,
          callback_created_by: userId,
          callback_mode: 'persistent',
        },
      },
    });
    const completedTask = makeTask({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-01-01T00:00:05.000Z',
    });

    await (service as any).dispatchCompletionCallbacks(completedTask, childSession, {});

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: parentSessionId })
    );
  });

  it('delivers a task-level callback without mutating session callback configuration', async () => {
    const callerSessionId = '018f0000-0000-7000-8000-000000000777';
    const { service, createPending, sessionsPatch, childSession } = makeService({
      childSession: { genealogy: { children: [] }, callback_config: undefined },
      task: {
        metadata: {
          completion_callback: {
            target_session_id: callerSessionId as Task['session_id'],
            requested_from_session_id: callerSessionId as Task['session_id'],
            requested_by_user_id: userId,
          },
        },
      },
    });
    (service.app.service as any).mockImplementation((name: string) => {
      if (name === 'sessions') {
        return {
          get: vi.fn(async (id: string) =>
            id === childSessionId
              ? childSession
              : makeSession({ session_id: id as Session['session_id'], created_by: userId })
          ),
          patch: sessionsPatch,
          triggerQueueProcessing: vi.fn(async () => undefined),
        };
      }
      if (name === 'messages') return { find: vi.fn(async () => []) };
      if (name === 'branches') return { get: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    });

    await service.patch(taskId, { status: TaskStatus.COMPLETED });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: callerSessionId,
        metadata: expect.objectContaining({ child_task_id: taskId }),
      })
    );
    expect(sessionsPatch).not.toHaveBeenCalledWith(
      childSessionId,
      expect.objectContaining({ callback_config: expect.anything() })
    );
  });

  it('coalesces task-level and session-level callbacks to the same destination', async () => {
    const { service, createPending, sessionsPatch } = makeService({
      task: {
        metadata: {
          completion_callback: {
            target_session_id: parentSessionId as Task['session_id'],
            requested_from_session_id: parentSessionId as Task['session_id'],
            requested_by_user_id: userId,
          },
        },
      },
    });

    await service.patch(taskId, { status: TaskStatus.COMPLETED });

    await vi.waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(sessionsPatch).toHaveBeenCalledWith(
        childSessionId,
        expect.objectContaining({ callback_config: expect.objectContaining({ enabled: false }) })
      )
    );
  });
});
