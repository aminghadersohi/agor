import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionReminderRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, SessionReminder, TenantID, UserID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { sessionReminderTaskId } from '../utils/durable-task-id';
import { SessionReminderWorker } from './session-reminder-worker';

async function seed(db: Database, archived = false) {
  const user = await new UsersRepository(db).create({
    user_id: generateId(),
    email: `reminder-${generateId()}@example.test`,
    name: 'River Example',
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `reminder-${generateId()}`,
    name: 'Fictional reminder repo',
    repo_type: 'remote',
    remote_url: 'https://example.test/reminders.git',
    local_path: '/tmp/fictional-reminders',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'reminder-test',
    ref: 'refs/heads/reminder-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/fictional-reminders/reminder-test',
    created_by: user.user_id as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'codex',
    created_by: user.user_id as UUID,
    status: SessionStatus.IDLE,
    archived,
  });
  const reminder = await new SessionReminderRepository(db).create({
    session_id: session.session_id,
    text: 'Review the fictional decision.',
    due_at: new Date(Date.now() - 1_000).toISOString(),
    display_timezone: 'UTC',
    created_by: user.user_id as UserID,
  });
  return { user, session, reminder };
}

function promptText(reminder: SessionReminder): string {
  return `<session_reminder id="${reminder.reminder_id}" one_shot="true" due_at="${reminder.due_at}">
This is a durable one-shot reminder for this same Agor Session. It does not reschedule itself. Creating another reminder requires an explicit agor_session_reminders_create tool call.

${reminder.text}
</session_reminder>`;
}

function appFixture(db: Database) {
  const create = vi.fn(async (data: Record<string, unknown>, params: Record<string, unknown>) => {
    const taskId = data.idempotencyTaskId as UUID;
    const existing = await new TaskRepository(db).findById(taskId);
    if (existing) return existing;
    const route = params.route as { id: string };
    const user = params.user as { user_id: UserID };
    return new TaskRepository(db).createPending({
      task_id: taskId,
      session_id: route.id as UUID,
      full_prompt: data.prompt as string,
      created_by: user.user_id,
      metadata: data.metadata as never,
      status: TaskStatus.QUEUED,
    });
  });
  const emit = vi.fn();
  const app = {
    service(path: string) {
      if (path === '/sessions/:id/prompt') return { create };
      if (path === 'session-reminders') return { emit };
      throw new Error(`Unexpected service ${path}`);
    },
  } as unknown as Application;
  return { app, create, emit };
}

describe('SessionReminderWorker', () => {
  dbTest('two workers claim and enqueue one stable Task', async ({ db }) => {
    const { reminder } = await seed(db);
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    const discover = vi.fn(async () => [
      { reminder_id: reminder.reminder_id, tenant_id: tenantId },
    ]);
    const worker = () => new SessionReminderWorker(db, fixture.app, { tenantId, discover });
    await Promise.all([worker().checkOnce(), worker().checkOnce()]);

    expect(fixture.create).toHaveBeenCalledTimes(1);
    await expect(
      new SessionReminderRepository(db).findPage({
        session_id: reminder.session_id,
        limit: 10,
        skip: 0,
      })
    ).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          status: 'queued',
          task_id: sessionReminderTaskId(reminder.reminder_id),
        }),
      ],
    });
  });

  dbTest('blocks an archived Session instead of restoring or prompting it', async ({ db }) => {
    const { reminder } = await seed(db, true);
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    const worker = new SessionReminderWorker(db, fixture.app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    });
    await worker.checkOnce();
    expect(fixture.create).not.toHaveBeenCalled();
    const page = await new SessionReminderRepository(db).findPage({
      session_id: reminder.session_id,
      limit: 10,
      skip: 0,
    });
    expect(page.data[0]).toMatchObject({ status: 'blocked', failure_code: 'session_archived' });
  });

  dbTest(
    'reconciles a Task admitted before daemon shutdown without a duplicate prompt',
    async ({ db }) => {
      const { reminder, user } = await seed(db);
      const taskId = sessionReminderTaskId(reminder.reminder_id);
      await new TaskRepository(db).createPending({
        task_id: taskId,
        session_id: reminder.session_id,
        full_prompt: promptText(reminder),
        created_by: user.user_id as UserID,
        metadata: {
          system_authored: true,
          session_reminder: {
            reminder_id: reminder.reminder_id,
            due_at: reminder.due_at,
            created_at: reminder.created_at,
            one_shot: true,
          },
        },
        status: TaskStatus.QUEUED,
      });
      const fixture = appFixture(db);
      const tenantId = 'default' as TenantID;
      await new SessionReminderWorker(db, fixture.app, {
        tenantId,
        discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
      }).checkOnce();
      expect(fixture.create).not.toHaveBeenCalled();
      const page = await new SessionReminderRepository(db).findPage({
        session_id: reminder.session_id,
        limit: 10,
        skip: 0,
      });
      expect(page.data[0]).toMatchObject({ status: 'queued', task_id: taskId });
    }
  );

  dbTest('does not echo reminder or downstream error text in logs', async ({ db }) => {
    const { reminder } = await seed(db);
    const create = vi.fn(async () => {
      throw new Error('fictional-secret-from-downstream');
    });
    const app = {
      service(path: string) {
        if (path === '/sessions/:id/prompt') return { create };
        if (path === 'session-reminders') return { emit: vi.fn() };
        throw new Error(`Unexpected service ${path}`);
      },
    } as unknown as Application;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tenantId = 'default' as TenantID;

    await new SessionReminderWorker(db, app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    }).checkOnce();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('error_type="Error"'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('fictional-secret');
    expect(warn.mock.calls.flat().join(' ')).not.toContain(reminder.text);
    warn.mockRestore();
  });

  dbTest('blocks a stable Task ID with mismatched immutable provenance', async ({ db }) => {
    const { reminder, user } = await seed(db);
    await new TaskRepository(db).createPending({
      task_id: sessionReminderTaskId(reminder.reminder_id),
      session_id: reminder.session_id,
      full_prompt: 'Unrelated internal task',
      created_by: user.user_id as UserID,
      status: TaskStatus.QUEUED,
    });
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    await new SessionReminderWorker(db, fixture.app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    }).checkOnce();

    expect(fixture.create).not.toHaveBeenCalled();
    const page = await new SessionReminderRepository(db).findPage({
      session_id: reminder.session_id,
      limit: 10,
      skip: 0,
    });
    expect(page.data[0]).toMatchObject({ status: 'blocked', failure_code: 'dispatch_failed' });
  });
});
