import type { BranchID, SessionID, TaskID, UserID, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionMemoryRepository, SessionReminderRepository } from './session-memory';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

let uniqueBranch = 20_000;

async function setup(db: Database) {
  const user = await new UsersRepository(db).create({
    email: `memory-${generateId()}@example.test`,
    name: 'Casey Example',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `memory-${generateId()}`,
    name: 'Fictional memory repo',
    repo_type: 'remote',
    remote_url: 'https://example.test/fictional.git',
    local_path: '/tmp/fictional-memory',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'memory-test',
    ref: 'refs/heads/memory-test',
    branch_unique_id: uniqueBranch++,
    path: '/tmp/fictional-memory/memory-test',
    created_by: user.user_id as UUID,
  });
  const sessions = new SessionRepository(db);
  const createSession = () =>
    sessions.create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      created_by: user.user_id as UUID,
    });
  return { user, first: await createSession(), second: await createSession() };
}

describe('SessionMemoryRepository', () => {
  dbTest('persists and searches only inside the explicit Session scope', async ({ db }) => {
    const ctx = await setup(db);
    const repo = new SessionMemoryRepository(db);
    const first = await repo.create({
      session_id: ctx.first.session_id,
      title: 'Decision',
      text: 'Use the amber protocol for the fictional launch.',
      tags: ['architecture'],
      created_by: ctx.user.user_id as UserID,
    });
    await repo.create({
      session_id: ctx.second.session_id,
      text: 'Amber belongs to another conversation.',
      tags: [],
      created_by: ctx.user.user_id as UserID,
    });

    await expect(
      repo.findPage({ session_id: ctx.first.session_id, search: 'AMBER', limit: 25, skip: 0 })
    ).resolves.toMatchObject({ total: 1, data: [{ memory_id: first.memory_id }] });
    await expect(
      repo.findPage({ session_id: ctx.first.session_id, search: '%_', limit: 25, skip: 0 })
    ).resolves.toMatchObject({ total: 0, data: [] });
  });

  dbTest('uses revision CAS and soft archive', async ({ db }) => {
    const ctx = await setup(db);
    const repo = new SessionMemoryRepository(db);
    const memory = await repo.create({
      session_id: ctx.first.session_id,
      text: 'Initial fictional decision',
      tags: [],
      created_by: ctx.user.user_id as UserID,
    });
    const updated = await repo.updateInSession(ctx.first.session_id, memory.memory_id, 1, {
      archived: true,
    });
    expect(updated).toMatchObject({ archived: true, revision: 2 });
    await expect(
      repo.updateInSession(ctx.first.session_id, memory.memory_id, 1, { text: 'stale edit' })
    ).rejects.toMatchObject({ code: 'session_memory_revision_conflict' });
  });
});

describe('SessionReminderRepository', () => {
  dbTest(
    'claims one due reminder once across concurrent workers and records immutable Task provenance',
    async ({ db }) => {
      const ctx = await setup(db);
      const reminders = new SessionReminderRepository(db);
      const reminder = await reminders.create({
        session_id: ctx.first.session_id,
        text: 'Review the fictional launch notes.',
        due_at: new Date(Date.now() - 1_000).toISOString(),
        display_timezone: 'America/New_York',
        created_by: ctx.user.user_id as UserID,
      });
      const now = new Date();
      const [a, b] = await Promise.all([
        reminders.claimDue(reminder.reminder_id, now, 'worker-a', 60_000),
        reminders.claimDue(reminder.reminder_id, now, 'worker-b', 60_000),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const winner = a ? 'worker-a' : 'worker-b';

      const task = await new TaskRepository(db).createPending({
        task_id: generateId() as TaskID,
        session_id: ctx.first.session_id,
        full_prompt: 'Structured fictional reminder',
        created_by: ctx.user.user_id as UserID,
        status: TaskStatus.QUEUED,
      });
      const queued = await reminders.markQueued(
        reminder.reminder_id,
        winner,
        task.task_id,
        new Date()
      );
      expect(queued).toMatchObject({ status: 'queued', task_id: task.task_id, attempt_count: 1 });
      await expect(new TaskRepository(db).delete(task.task_id)).rejects.toThrow();
      await expect(
        reminders.findPage({ session_id: ctx.first.session_id, limit: 10, skip: 0 })
      ).resolves.toMatchObject({ data: [expect.objectContaining({ task_id: task.task_id })] });
      await expect(
        reminders.updateScheduledInSession(
          ctx.first.session_id,
          reminder.reminder_id,
          queued!.revision,
          {
            cancel: true,
          }
        )
      ).rejects.toMatchObject({ code: 'session_reminder_revision_conflict' });
    }
  );

  dbTest('edits and cancels only while scheduled', async ({ db }) => {
    const ctx = await setup(db);
    const reminders = new SessionReminderRepository(db);
    const created = await reminders.create({
      session_id: ctx.first.session_id,
      text: 'Original fictional reminder',
      due_at: new Date(Date.now() + 120_000).toISOString(),
      display_timezone: 'UTC',
      created_by: ctx.user.user_id as UserID,
    });
    const edited = await reminders.updateScheduledInSession(
      ctx.first.session_id,
      created.reminder_id,
      created.revision,
      { text: 'Edited fictional reminder' }
    );
    const cancelled = await reminders.updateScheduledInSession(
      ctx.first.session_id,
      edited.reminder_id,
      edited.revision,
      { cancel: true }
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', revision: 3 });
  });
});
