import type { Branch, Session, UserID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRelationshipRepository } from './session-relationships';
import { SessionRepository, SessionTransferValidationError } from './sessions';
import { TaskRepository } from './tasks';

const OWNER = 'test-user' as UserID;

async function createBranch(db: any, name: string): Promise<Branch> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `session-transfer-${generateId()}`,
    name: 'Session transfer test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/session-transfer.git',
    local_path: `/tmp/session-transfer-${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name,
    ref: name,
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/session-transfer-${generateId()}`,
    base_ref: 'main',
    created_by: OWNER,
  });
}

async function createSession(
  db: any,
  branch: Branch,
  overrides: Partial<Session> = {}
): Promise<Session> {
  return new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: OWNER,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
}

describe('SessionRepository transfer operations', () => {
  dbTest(
    'atomically retargets the direct route and remote relationship while preserving flags and exact-Task subscriptions',
    async ({ db }) => {
      const sourceBranch = await createBranch(db, 'source');
      const destinationBranch = await createBranch(db, 'destination');
      const oldDestination = await createSession(db, sourceBranch);
      const newDestination = await createSession(db, destinationBranch);
      const source = await createSession(db, destinationBranch, {
        callback_config: {
          enabled: true,
          callback_session_id: oldDestination.session_id,
          callback_created_by: OWNER,
          callback_mode: 'persistent',
          include_last_message: false,
          include_original_prompt: true,
          template: 'preserve me',
        },
      });
      const relationship = await new SessionRelationshipRepository(db).create({
        source_session_id: oldDestination.session_id,
        target_session_id: source.session_id,
        relationship_type: 'remote_create',
        created_by: OWNER,
        callback_enabled: true,
        callback_session_id: oldDestination.session_id,
        data: { preserve: true },
      });
      const task = await new TaskRepository(db).create({
        task_id: generateId(),
        session_id: source.session_id,
        status: TaskStatus.RUNNING,
        created_by: OWNER,
        metadata: {
          completion_callback: {
            target_session_id: oldDestination.session_id,
            requested_from_session_id: oldDestination.session_id,
            requested_by_user_id: OWNER,
          },
        },
      });

      const result = await new SessionRepository(db).retargetCompletionCallback(
        source.session_id,
        newDestination.session_id
      );

      expect(result).toEqual({
        session_id: source.session_id,
        previous_callback_session_id: oldDestination.session_id,
        callback_session_id: newDestination.session_id,
        relationship_ids: [relationship.relationship_id],
        task_callback_subscriptions_retargeted: false,
      });
      const updatedSource = await new SessionRepository(db).findById(source.session_id);
      expect(updatedSource?.callback_config).toEqual({
        ...source.callback_config,
        callback_session_id: newDestination.session_id,
      });
      await expect(
        new SessionRelationshipRepository(db).get(relationship.relationship_id)
      ).resolves.toMatchObject({
        callback_enabled: true,
        callback_session_id: newDestination.session_id,
        data: { preserve: true },
      });
      await expect(new TaskRepository(db).findById(task.task_id)).resolves.toMatchObject({
        metadata: {
          completion_callback: {
            target_session_id: oldDestination.session_id,
            requested_from_session_id: oldDestination.session_id,
            requested_by_user_id: OWNER,
          },
        },
      });
    }
  );

  dbTest(
    'fails closed on an archived callback destination without partial writes',
    async ({ db }) => {
      const branch = await createBranch(db, 'callback-archived');
      const oldDestination = await createSession(db, branch);
      const archivedDestination = await createSession(db, branch, { archived: true });
      const source = await createSession(db, branch, {
        callback_config: {
          enabled: false,
          callback_session_id: oldDestination.session_id,
          callback_mode: 'once',
        },
      });

      await expect(
        new SessionRepository(db).retargetCompletionCallback(
          source.session_id,
          archivedDestination.session_id
        )
      ).rejects.toThrow(SessionTransferValidationError);
      await expect(new SessionRepository(db).findById(source.session_id)).resolves.toMatchObject({
        callback_config: { callback_session_id: oldDestination.session_id },
      });
    }
  );

  dbTest('fails closed with a clear reason when either destination was deleted', async ({ db }) => {
    const branch = await createBranch(db, 'missing-destination');
    const oldDestination = await createSession(db, branch);
    const source = await createSession(db, branch, {
      callback_config: {
        enabled: true,
        callback_session_id: oldDestination.session_id,
      },
    });
    const deletedDestinationId = generateId();
    const repo = new SessionRepository(db);

    await expect(
      repo.retargetCompletionCallback(source.session_id, deletedDestinationId)
    ).rejects.toThrow(/Callback destination session .* unavailable or deleted/);
    await expect(
      repo.reparentBranchLocalGenealogy(source.session_id, deletedDestinationId)
    ).rejects.toThrow(/Genealogy destination session .* unavailable or deleted/);
  });

  dbTest('reparents branch-local genealogy and updates both parent child lists', async ({ db }) => {
    const branch = await createBranch(db, 'genealogy');
    const child = await createSession(db, branch);
    const oldParent = await createSession(db, branch, {
      genealogy: { children: [child.session_id] },
    });
    await new SessionRepository(db).update(child.session_id, {
      genealogy: { ...child.genealogy, parent_session_id: oldParent.session_id },
    });
    const newParent = await createSession(db, branch, {
      genealogy: { children: [] },
    });

    const result = await new SessionRepository(db).reparentBranchLocalGenealogy(
      child.session_id,
      newParent.session_id
    );

    expect(result).toEqual({
      session_id: child.session_id,
      branch_id: branch.branch_id,
      previous_parent_session_id: oldParent.session_id,
      parent_session_id: newParent.session_id,
    });
    await expect(new SessionRepository(db).findById(child.session_id)).resolves.toMatchObject({
      genealogy: { parent_session_id: newParent.session_id },
    });
    expect(
      (await new SessionRepository(db).findById(oldParent.session_id))?.genealogy.children
    ).not.toContain(child.session_id);
    expect(
      (await new SessionRepository(db).findById(newParent.session_id))?.genealogy.children
    ).toEqual([child.session_id]);
  });

  dbTest(
    'rejects cross-branch, direct-cycle, indirect-cycle, and archived parents',
    async ({ db }) => {
      const branch = await createBranch(db, 'cycle-source');
      const otherBranch = await createBranch(db, 'cycle-other');
      const root = await createSession(db, branch);
      const child = await createSession(db, branch, {
        genealogy: { parent_session_id: root.session_id, children: [] },
      });
      const grandchild = await createSession(db, branch, {
        genealogy: { parent_session_id: child.session_id, children: [] },
      });
      const foreign = await createSession(db, otherBranch);
      const archived = await createSession(db, branch, { archived: true });
      const repo = new SessionRepository(db);

      await expect(
        repo.reparentBranchLocalGenealogy(root.session_id, root.session_id)
      ).rejects.toThrow(/cycles are not allowed/);
      await expect(
        repo.reparentBranchLocalGenealogy(root.session_id, grandchild.session_id)
      ).rejects.toThrow(/descendant.*cycles are not allowed/);
      await expect(
        repo.reparentBranchLocalGenealogy(root.session_id, foreign.session_id)
      ).rejects.toThrow(/branch-local/);
      await expect(
        repo.reparentBranchLocalGenealogy(root.session_id, archived.session_id)
      ).rejects.toThrow(/destination.*archived/);
      await expect(repo.findById(root.session_id)).resolves.toMatchObject({
        genealogy: { parent_session_id: null },
      });
    }
  );

  dbTest('detaches a Session to a branch-local root', async ({ db }) => {
    const branch = await createBranch(db, 'detach');
    const parent = await createSession(db, branch);
    const child = await createSession(db, branch, {
      genealogy: { parent_session_id: parent.session_id, children: [] },
    });
    await new SessionRepository(db).update(parent.session_id, {
      genealogy: { ...parent.genealogy, children: [child.session_id] },
    });

    const result = await new SessionRepository(db).reparentBranchLocalGenealogy(
      child.session_id,
      null
    );

    expect(result.parent_session_id).toBeNull();
    await expect(new SessionRepository(db).findById(child.session_id)).resolves.toMatchObject({
      genealogy: { parent_session_id: null },
    });
    expect(
      (await new SessionRepository(db).findById(parent.session_id))?.genealogy.children
    ).toEqual([]);
  });
});
