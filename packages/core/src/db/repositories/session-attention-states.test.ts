import { SessionStatus, sessionHasUnseenAttention, type UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { runWithTenantContext } from '../tenant-context';
import { ownedDbTest as dbTest } from '../test-helpers';
import { attachHiddenTenant, RepositoryError } from './base';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionAttentionStateRepository } from './session-attention-states';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

async function createSession(db: Database) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `attention-${generateId()}`,
    name: 'Attention test repo',
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/attention-test-repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'attention-test',
    ref: 'attention-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/attention-test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UserID,
  });
  return new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.RUNNING,
    created_by: 'test-user',
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ready_for_prompt: false,
  });
}

describe('SessionAttentionStateRepository', () => {
  dbTest('keeps acknowledgement independent for two users of the same session', async ({ db }) => {
    const sessions = new SessionRepository(db);
    const attention = new SessionAttentionStateRepository(db);
    const firstUserId = 'test-user' as UserID;
    const secondUser = await new UsersRepository(db).create({
      email: `attention-second-${generateId()}@example.test`,
      name: 'Second viewer',
    });
    const session = await createSession(db);

    const firstResult = await sessions.update(session.session_id, {
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    });
    expect(firstResult.attention_generation).toBe(1);
    expect(
      sessionHasUnseenAttention((await attention.enrichForViewer([firstResult], firstUserId))[0])
    ).toBe(true);
    expect(
      sessionHasUnseenAttention(
        (await attention.enrichForViewer([firstResult], secondUser.user_id as UserID))[0]
      )
    ).toBe(true);

    await attention.acknowledge(firstResult, firstUserId);
    expect(
      sessionHasUnseenAttention((await attention.enrichForViewer([firstResult], firstUserId))[0])
    ).toBe(false);
    expect(
      sessionHasUnseenAttention(
        (await attention.enrichForViewer([firstResult], secondUser.user_id as UserID))[0]
      )
    ).toBe(true);

    // This assertion specifically bites if acknowledgement is keyed by session
    // alone: the second user's acknowledgement must create an independent row.
    await attention.acknowledge(firstResult, secondUser.user_id as UserID);
    expect(
      sessionHasUnseenAttention(
        (await attention.enrichForViewer([firstResult], secondUser.user_id as UserID))[0]
      )
    ).toBe(false);

    await sessions.update(session.session_id, {
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
    });
    const secondResult = await sessions.update(session.session_id, {
      status: SessionStatus.FAILED,
      ready_for_prompt: true,
    });
    expect(secondResult.attention_generation).toBe(2);

    await attention.acknowledge(secondResult, firstUserId);
    expect(
      sessionHasUnseenAttention((await attention.enrichForViewer([secondResult], firstUserId))[0])
    ).toBe(false);
    expect(
      sessionHasUnseenAttention(
        (await attention.enrichForViewer([secondResult], secondUser.user_id as UserID))[0]
      )
    ).toBe(true);

    const repeatedProjection = await sessions.update(session.session_id, {
      ready_for_prompt: true,
    });
    expect(repeatedProjection.attention_generation).toBe(2);
  });

  dbTest('rejects a session DTO from a different tenant before writing', async ({ db }) => {
    const attention = new SessionAttentionStateRepository(db);
    const session = attachHiddenTenant(await createSession(db), { tenant_id: 'tenant-a' });

    await expect(
      runWithTenantContext('tenant-b', () => attention.acknowledge(session, 'test-user' as UserID))
    ).rejects.toThrow(RepositoryError);
  });
});
