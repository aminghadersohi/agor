import {
  BranchRepository,
  generateId,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { MessageRole, ROLES, SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createMessagesService } from './messages';
import { TasksService } from './tasks';

describe('callback BTW final report idempotency', () => {
  dbTest('concurrent completion retries append one bounded coordinator result', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      user_id: generateId(),
      email: `callback-result-${generateId()}@example.invalid`,
      role: ROLES.MEMBER,
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `callback-result-${generateId()}`,
      name: 'Callback result test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/callback-result.git',
      local_path: `/tmp/callback-result-${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: 'callback-result',
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: `/tmp/callback-result-${generateId()}`,
      created_by: user.user_id,
    });
    const sessions = new SessionRepository(db);
    const destination = await sessions.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: user.user_id,
      status: SessionStatus.RUNNING,
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
    });
    const sourceSessionId = generateId();
    const sourceTaskId = generateId();
    const finalMessageId = generateId();
    const side = await sessions.create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: user.user_id,
      status: SessionStatus.RUNNING,
      fork_origin: 'btw',
      tasks: [],
      contextFiles: [],
      genealogy: { forked_from_session_id: destination.session_id, children: [] },
      callback_config: {
        enabled: false,
        delivery: 'direct',
        digest: {
          kind: 'callback_digest',
          source_session_id: sourceSessionId,
          source_task_id: sourceTaskId,
          destination_session_id: destination.session_id,
          relationship_ids: [],
          route: 'standing',
          requested_delivery: 'auto',
          resolved_delivery: 'btw',
          callback_created_by: user.user_id,
          final_message_id: finalMessageId,
        },
      },
    });
    const sideTask = await new TaskRepository(db).create({
      task_id: generateId(),
      session_id: side.session_id,
      created_by: user.user_id,
      full_prompt: 'Digest this callback',
      status: TaskStatus.COMPLETED,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: new Date().toISOString(),
      },
      tool_use_count: 0,
      git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    });
    await new MessagesRepository(db).create({
      message_id: generateId(),
      session_id: side.session_id,
      task_id: sideTask.task_id,
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: 'result',
      content: 'x'.repeat(8_000),
    });
    const messagesService = createMessagesService(db);
    const app = {
      service: (name: string) => {
        if (name === 'messages') return messagesService;
        if (name === 'sessions') {
          return { get: (id: string) => sessions.findById(id) };
        }
        throw new Error(`Unexpected service ${name}`);
      },
    } as unknown as Application;
    const service = new TasksService(db, app);

    await Promise.all([
      (service as any).injectBtwResultMessage(sideTask, side),
      (service as any).injectBtwResultMessage(sideTask, side),
    ]);

    const results = (
      await new MessagesRepository(db).findAll({
        sessionId: destination.session_id,
      })
    ).filter((message) => message.metadata?.is_callback_digest_result === true);
    expect(results).toHaveLength(1);
    expect(results[0].message_id).toBe(finalMessageId);
    expect(
      Buffer.byteLength(String(results[0].content[0]?.text ?? ''), 'utf8')
    ).toBeLessThanOrEqual(4_096);
    expect(results[0].metadata).toMatchObject({
      callback_source_session_id: sourceSessionId,
      callback_source_task_id: sourceTaskId,
      callback_destination_session_id: destination.session_id,
    });
    await expect(new TaskRepository(db).findById(sideTask.task_id)).resolves.toMatchObject({
      metadata: { btw_result_delivered_at: expect.any(String) },
    });
  });
});
