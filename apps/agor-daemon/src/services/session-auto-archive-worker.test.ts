import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, Session, SessionID, Task, TenantID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { completionCallbackTaskId } from '../utils/durable-task-id';
import { SessionAutoArchiveWorker } from './session-auto-archive-worker';
import { TasksService } from './tasks';

const USER_ID = '018f0000-0000-7000-8000-000000000001' as UUID;

async function seedBranch(db: any): Promise<BranchID> {
  const users = new UsersRepository(db);
  if (!(await users.findById(USER_ID))) {
    await users.create({
      user_id: USER_ID,
      email: 'auto-archive@example.test',
      role: 'member',
    });
  }
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `auto-archive-${generateId()}`,
    name: 'Auto archive test',
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'auto-archive',
    ref: 'auto-archive',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    created_by: USER_ID,
  });
  return branch.branch_id;
}

async function seedSession(
  db: any,
  branchId: BranchID,
  overrides: Partial<Session> = {}
): Promise<Session> {
  return new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branchId,
    agentic_tool: 'claude-code',
    created_by: USER_ID,
    status: SessionStatus.IDLE,
    genealogy: { children: [] },
    tasks: [],
    contextFiles: [],
    auto_archive: 'never',
    ...overrides,
  });
}

async function seedTask(
  db: any,
  sessionId: SessionID,
  overrides: Partial<Task> = {}
): Promise<Task> {
  const now = new Date().toISOString();
  return new TaskRepository(db).create({
    task_id: generateId(),
    session_id: sessionId,
    created_by: USER_ID,
    full_prompt: 'finish child work',
    status: TaskStatus.COMPLETED,
    completed_at: now,
    message_range: { start_index: 0, end_index: 0, start_timestamp: now },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
    tool_use_count: 0,
    ...overrides,
  });
}

async function dueChild(db: any, callbackEnabled = false) {
  const branchId = await seedBranch(db);
  const parent = await seedSession(db, branchId);
  const deadline = Date.now() - 10_000;
  const child = await seedSession(db, branchId, {
    genealogy: { parent_session_id: parent.session_id, children: [] },
    callback_config: { enabled: callbackEnabled, callback_session_id: parent.session_id },
    auto_archive: 'after_completion',
    auto_archive_after_seconds: 60,
    auto_archive_at: new Date(deadline).toISOString(),
  });
  const task = await seedTask(db, child.session_id);
  return { branchId, parent, child, task, deadline };
}

describe('Session automatic archival repository fence', () => {
  dbTest(
    'independently blocks roots, active work, active descendants, and undelivered callbacks',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const branchId = await seedBranch(db);
      const deadline = Date.now() - 10_000;
      const root = await seedSession(db, branchId, {
        auto_archive: 'after_completion',
        auto_archive_after_seconds: 60,
        auto_archive_at: new Date(deadline).toISOString(),
      });
      await seedTask(db, root.session_id);
      await expect(repo.archiveDueChildIfEligible(root.session_id, deadline)).resolves.toBeNull();

      const active = await dueChild(db);
      await new TaskRepository(db).create({
        ...(await seedTask(db, active.child.session_id)),
        task_id: generateId(),
        status: TaskStatus.RUNNING,
        completed_at: undefined,
      });
      await expect(
        repo.archiveDueChildIfEligible(active.child.session_id, active.deadline)
      ).resolves.toBeNull();

      for (const status of [TaskStatus.AWAITING_PERMISSION, TaskStatus.AWAITING_INPUT]) {
        const waiting = await dueChild(db);
        await seedTask(db, waiting.child.session_id, { status, completed_at: undefined });
        await expect(
          repo.archiveDueChildIfEligible(waiting.child.session_id, waiting.deadline)
        ).resolves.toBeNull();
      }

      const nested = await dueChild(db);
      const descendant = await seedSession(db, nested.branchId, {
        genealogy: { parent_session_id: nested.child.session_id, children: [] },
        status: SessionStatus.RUNNING,
      });
      await seedTask(db, descendant.session_id, {
        status: TaskStatus.RUNNING,
        completed_at: undefined,
      });
      await expect(
        repo.archiveDueChildIfEligible(nested.child.session_id, nested.deadline)
      ).resolves.toBeNull();

      const callback = await dueChild(db, true);
      await expect(
        repo.archiveDueChildIfEligible(callback.child.session_id, callback.deadline)
      ).resolves.toBeNull();
    }
  );

  dbTest('archives only after callback delivery and fences concurrent retries', async ({ db }) => {
    const { child, parent, task, deadline } = await dueChild(db, true);
    const tasks = new TaskRepository(db);
    await tasks.update(task.task_id, {
      metadata: {
        callback_dispatches: [
          {
            event: 'task_completion',
            target_session_id: parent.session_id,
            dispatched_at: new Date().toISOString(),
          },
        ],
      },
    });
    const repoA = new SessionRepository(db);
    const repoB = new SessionRepository(db);
    const results = [
      await repoA.archiveDueChildIfEligible(child.session_id, deadline),
      await repoB.archiveDueChildIfEligible(child.session_id, deadline),
    ];
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(new SessionRepository(db).findById(child.session_id)).resolves.toMatchObject({
      archived: true,
      archived_reason: 'auto_completed',
      auto_archive_at: undefined,
    });
  });

  dbTest('keeps BTW work visible until its inline report is durably delivered', async ({ db }) => {
    const branchId = await seedBranch(db);
    const parent = await seedSession(db, branchId);
    const deadline = Date.now() - 10_000;
    const btw = await seedSession(db, branchId, {
      fork_origin: 'btw',
      genealogy: { forked_from_session_id: parent.session_id, children: [] },
      auto_archive: 'after_completion',
      auto_archive_after_seconds: 60,
      auto_archive_at: new Date(deadline).toISOString(),
    });
    const task = await seedTask(db, btw.session_id);
    const sessions = new SessionRepository(db);

    await expect(sessions.archiveDueChildIfEligible(btw.session_id, deadline)).resolves.toBeNull();

    await new TaskRepository(db).update(task.task_id, {
      metadata: { btw_result_delivered_at: new Date().toISOString() },
    });
    await expect(
      sessions.archiveDueChildIfEligible(btw.session_id, deadline)
    ).resolves.toMatchObject({
      session_id: btw.session_id,
      archived: true,
      archived_reason: 'btw_completed',
    });
  });

  dbTest(
    'archives eligible descendants bottom-up without cascading an ordinary root',
    async ({ db }) => {
      const branchId = await seedBranch(db);
      const root = await seedSession(db, branchId);
      const deadline = Date.now() - 10_000;
      const child = await seedSession(db, branchId, {
        genealogy: { parent_session_id: root.session_id, children: [] },
        callback_config: { enabled: false },
        auto_archive: 'after_completion',
        auto_archive_after_seconds: 60,
        auto_archive_at: new Date(deadline).toISOString(),
      });
      const grandchild = await seedSession(db, branchId, {
        genealogy: { parent_session_id: child.session_id, children: [] },
        callback_config: { enabled: false },
        auto_archive: 'after_completion',
        auto_archive_after_seconds: 60,
        auto_archive_at: new Date(deadline).toISOString(),
      });
      await seedTask(db, child.session_id);
      await seedTask(db, grandchild.session_id);
      const sessions = new SessionRepository(db);

      await expect(
        sessions.archiveDueChildIfEligible(child.session_id, deadline)
      ).resolves.toBeNull();
      await expect(
        sessions.archiveDueChildIfEligible(grandchild.session_id, deadline)
      ).resolves.toMatchObject({ archived: true });
      await expect(
        sessions.archiveDueChildIfEligible(child.session_id, deadline)
      ).resolves.toMatchObject({ archived: true });
      await expect(
        sessions.archiveDueChildIfEligible(root.session_id, deadline)
      ).resolves.toBeNull();
      await expect(sessions.findById(root.session_id)).resolves.toMatchObject({ archived: false });
    }
  );
});

describe('SessionAutoArchiveWorker', () => {
  dbTest(
    'durably queues the real callback before the worker archives the child',
    async ({ db }) => {
      const { child, parent, task, deadline } = await dueChild(db, true);
      const patched = vi.fn();
      let tasksService: TasksService;
      const sessionsService = {
        get: (id: string) => new SessionRepository(db).findById(id),
        patch: (id: string, updates: Partial<Session>) =>
          new SessionRepository(db).update(id, updates),
        triggerQueueProcessing: vi.fn().mockResolvedValue(undefined),
        emit: patched,
      };
      const app = {
        get: () => ({}),
        service(path: string) {
          if (path === 'tasks') return tasksService;
          if (path === 'sessions') return sessionsService;
          if (path === 'messages') {
            return {
              find: vi
                .fn()
                .mockResolvedValue([
                  { role: 'assistant', index: 1, content: 'Completed child report' },
                ]),
            };
          }
          throw new Error(`unexpected service ${path}`);
        },
      } as unknown as Application;
      tasksService = new TasksService(db, app);
      const tenantId = 'callback-order-tenant' as TenantID;
      const discover = vi
        .fn()
        .mockResolvedValue([
          { session_id: child.session_id, auto_archive_at: deadline, tenant_id: tenantId },
        ]);

      await new SessionAutoArchiveWorker(db, { app, tenantId, discover }).checkOnce();

      const callbackTaskId = completionCallbackTaskId(task.task_id, parent.session_id);
      await expect(new TaskRepository(db).findById(callbackTaskId)).resolves.toMatchObject({
        session_id: parent.session_id,
        metadata: { child_session_id: child.session_id, child_task_id: task.task_id },
      });
      await expect(new TaskRepository(db).findById(task.task_id)).resolves.toMatchObject({
        metadata: {
          callback_dispatches: [
            expect.objectContaining({
              target_session_id: parent.session_id,
              queued_task_id: callbackTaskId,
            }),
          ],
        },
      });
      await expect(new SessionRepository(db).findById(child.session_id)).resolves.toMatchObject({
        archived: true,
        archived_reason: 'auto_completed',
      });
      expect(patched).toHaveBeenCalledTimes(1);
    }
  );

  dbTest(
    'recovers a persisted deadline after restart and emits one HA transition',
    async ({ db }) => {
      const { child, deadline } = await dueChild(db);
      const patched = vi.fn();
      const ensureAutoArchiveDeliveries = vi.fn().mockResolvedValue(undefined);
      const app = {
        service(path: string) {
          if (path === 'tasks') return { ensureAutoArchiveDeliveries };
          if (path === 'sessions') return { emit: patched };
          throw new Error(`unexpected service ${path}`);
        },
      } as unknown as Application;
      const tenantId = 'restart-tenant' as TenantID;
      const discover = vi
        .fn()
        .mockResolvedValue([
          { session_id: child.session_id, auto_archive_at: deadline, tenant_id: tenantId },
        ]);

      // The first process stops without scanning. A replacement reconstructs all
      // state from the persisted row rather than an in-memory timeout.
      new SessionAutoArchiveWorker(db, { app, tenantId, discover }).stop();
      const workerA = new SessionAutoArchiveWorker(db, { app, tenantId, discover });
      const workerB = new SessionAutoArchiveWorker(db, { app, tenantId, discover });
      await Promise.all([workerA.checkOnce(), workerB.checkOnce()]);

      expect(ensureAutoArchiveDeliveries).toHaveBeenCalledWith(
        child.session_id,
        expect.objectContaining({ tenant: { tenant_id: tenantId, source: 'explicit' } })
      );
      expect(patched).toHaveBeenCalledTimes(1);
      await expect(new SessionRepository(db).findById(child.session_id)).resolves.toMatchObject({
        archived: true,
      });
    }
  );

  dbTest(
    'preserves the discovered tenant on every delivery and archive boundary',
    async ({ db }) => {
      const first = await dueChild(db);
      const second = await dueChild(db);
      const patched = vi.fn();
      const ensureAutoArchiveDeliveries = vi.fn().mockResolvedValue(undefined);
      const app = {
        service(path: string) {
          if (path === 'tasks') return { ensureAutoArchiveDeliveries };
          if (path === 'sessions') return { emit: patched };
          throw new Error(`unexpected service ${path}`);
        },
      } as unknown as Application;
      const tenantA = 'tenant-a' as TenantID;
      const tenantB = 'tenant-b' as TenantID;
      const discover = vi.fn().mockResolvedValue([
        {
          session_id: first.child.session_id,
          auto_archive_at: first.deadline,
          tenant_id: tenantA,
        },
        {
          session_id: second.child.session_id,
          auto_archive_at: second.deadline,
          tenant_id: tenantB,
        },
      ]);

      await new SessionAutoArchiveWorker(db, { app, discover }).checkOnce();

      expect(ensureAutoArchiveDeliveries.mock.calls).toEqual([
        [
          first.child.session_id,
          expect.objectContaining({ tenant: { tenant_id: tenantA, source: 'explicit' } }),
        ],
        [
          second.child.session_id,
          expect.objectContaining({ tenant: { tenant_id: tenantB, source: 'explicit' } }),
        ],
      ]);
      expect(patched).toHaveBeenCalledTimes(2);
    }
  );
});
