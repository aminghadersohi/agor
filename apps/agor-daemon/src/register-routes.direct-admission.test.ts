/**
 * Direct admission must survive this fork's prompt-compaction feature.
 *
 * Compaction gives every admitted prompt a request identity, and that identity
 * was once also passed as the Task ID. Because it falls back to a generated ID
 * it is always set, which collided with the repository's rule that direct
 * admission requires a fresh queued input — so every idle fast-path prompt was
 * refused. The two features want the same fresh-prompt path, and only a
 * caller-supplied stable identity may pin the Task ID.
 */

import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  generateId,
  RepoRepository,
  runMigrations,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { TaskID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function idleSessionFixture() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  cleanup.push(() => (rawDb as unknown as { $client: { close(): void } }).$client.close());
  await runMigrations(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb);
  const scoped = <T>(work: () => Promise<T>) =>
    runWithTenantDatabaseScope(db, DEFAULT_STATIC_TENANT_ID, work);
  const taskRepo = new TaskRepository(db);
  const { actor, session } = await scoped(async () => {
    const actor = await new UsersRepository(db).create({
      email: 'direct-admission@example.invalid',
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: generateId(),
      name: 'Fixture',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/repo',
      local_path: '/disposable/not-created',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'fixture',
      ref: 'main',
      branch_unique_id: 1,
      path: '/disposable/not-created/branch',
      created_by: actor.user_id,
    });
    const session = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      created_by: actor.user_id,
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    });
    return { actor, session };
  });
  return { scoped, taskRepo, actor, session };
}

function dispatchPreparation() {
  return {
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: -1, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'a'.repeat(40) },
  };
}

describe('direct admission with prompt compaction', () => {
  it('admits a fresh prompt to an idle Session when no stable identity was supplied', async () => {
    const { scoped, taskRepo, actor, session } = await idleSessionFixture();

    const task = await scoped(() =>
      taskRepo.createPending({
        session_id: session.session_id,
        full_prompt: 'hello',
        created_by: actor.user_id,
        status: TaskStatus.QUEUED,
        compaction: { request_id: generateId() as TaskID, eligible: true, stream: true },
        dispatchIfIdle: dispatchPreparation(),
      })
    );

    expect(task.status).toBe(TaskStatus.DISPATCHING);
    expect(task.task_id).toBeTruthy();
    // The created Task carries exactly the one request that admitted it, which
    // is what separates it from a prompt folded into the queue tail.
    expect(task.metadata?.prompt_compaction?.requests).toHaveLength(1);
  });

  it('refuses direct admission when the caller pins a Task ID', async () => {
    const { scoped, taskRepo, actor, session } = await idleSessionFixture();
    const pinned = generateId() as TaskID;

    await expect(
      scoped(() =>
        taskRepo.createPending({
          task_id: pinned,
          session_id: session.session_id,
          full_prompt: 'hello',
          created_by: actor.user_id,
          status: TaskStatus.QUEUED,
          compaction: { request_id: pinned, eligible: true, stream: true },
          dispatchIfIdle: dispatchPreparation(),
        })
      )
    ).rejects.toThrow('Direct admission requires a fresh queued input');
  });

  it('never pairs a synthesized Task ID with dispatch preparation on the prompt route', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./register-routes.ts', import.meta.url), 'utf8');
    const call = source.indexOf('createPending({', source.indexOf('const compactionRequestId'));
    const end = source.indexOf('});', call);
    const admission = source.slice(call, end);

    expect(call).toBeGreaterThan(0);
    expect(admission).toContain('dispatchIfIdle: preparedLaunch?.updates');
    // Only `data.idempotencyTaskId` may reach `task_id`. `compactionRequestId`
    // falls back to a generated ID, so pinning it here refuses every direct
    // admission — the regression this file exists to catch.
    expect(admission).toContain('task_id: data.idempotencyTaskId');
    expect(admission).not.toContain('task_id: compactionRequestId');
  });
});
