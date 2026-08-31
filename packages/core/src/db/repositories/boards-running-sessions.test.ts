import type { Board, Branch, Session, UserID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest, setTestBranchUserRole } from '../test-helpers';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

let uniqueBranchId = 40_000;

async function createRepo(db: Database) {
  return new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `running-count-${generateId()}`,
    name: 'Running count test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/running-count.git',
    local_path: `/tmp/running-count-${generateId()}`,
    default_branch: 'main',
  });
}

async function createBranch(
  db: Database,
  repoId: UUID,
  board: Board,
  owner: UUID,
  name: string
): Promise<Branch> {
  return new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repoId,
    board_id: board.board_id,
    name,
    ref: name,
    branch_unique_id: uniqueBranchId++,
    path: `/tmp/${name}-${generateId()}`,
    created_by: owner,
    permission_source: 'override',
    others_can: 'none',
  });
}

async function createSession(
  db: Database,
  branch: Branch,
  owner: UUID,
  overrides: Partial<Session> = {}
) {
  return new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    created_by: owner,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    ...overrides,
  });
}

describe('BoardRepository running Session counts', () => {
  dbTest(
    'counts exact running Sessions across agent, scheduled, and gateway origins without Task multiplication',
    async ({ db }) => {
      const owner = 'test-user' as UUID;
      const boards = new BoardRepository(db);
      const repo = await createRepo(db);
      const countedBoard = await boards.create({
        name: 'Counted',
        created_by: owner,
      });
      const zeroBoard = await boards.create({
        name: 'Zero',
        created_by: owner,
      });
      const branch = await createBranch(db, repo.repo_id, countedBoard, owner, 'counted');

      const agent = await createSession(db, branch, owner, { status: SessionStatus.RUNNING });
      await createSession(db, branch, owner, {
        status: SessionStatus.RUNNING,
        scheduled_from_branch: true,
        scheduled_run_at: Date.now(),
      });
      await createSession(db, branch, owner, {
        status: SessionStatus.RUNNING,
        custom_context: {
          gateway_source: { provider: 'slack', channel_name: 'fictional-test-channel' },
        },
      });

      for (const status of [
        SessionStatus.IDLE,
        SessionStatus.AWAITING_PERMISSION,
        SessionStatus.AWAITING_INPUT,
        SessionStatus.STOPPING,
        SessionStatus.COMPLETED,
        SessionStatus.FAILED,
        SessionStatus.TIMED_OUT,
      ]) {
        await createSession(db, branch, owner, { status });
      }
      await createSession(db, branch, owner, {
        status: SessionStatus.RUNNING,
        archived: true,
        archived_reason: 'manual',
      });

      const archivedBranch = await createBranch(
        db,
        repo.repo_id,
        countedBoard,
        owner,
        'archived-branch'
      );
      await createSession(db, archivedBranch, owner, { status: SessionStatus.RUNNING });
      await new BranchRepository(db).update(archivedBranch.branch_id, { archived: true });

      // Mutation guard: joining Tasks into the aggregate would turn this one
      // running Session into two. The board projection must remain Session-based.
      const tasks = new TaskRepository(db);
      for (const prompt of ['first task', 'second task']) {
        await tasks.create({
          task_id: generateId(),
          session_id: agent.session_id,
          created_by: owner,
          full_prompt: prompt,
          status: TaskStatus.CREATED,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          tool_use_count: 0,
          git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
          model: 'test-model',
        });
      }

      const result = await boards.findAll();
      expect(result.find((board) => board.board_id === countedBoard.board_id))?.toMatchObject({
        running_session_count: 3,
      });
      expect(result.find((board) => board.board_id === zeroBoard.board_id))?.toMatchObject({
        running_session_count: 0,
      });
    }
  );

  dbTest(
    'applies distinct-owner branch RBAC before paging and follows running/archive transitions',
    async ({ db }) => {
      const owner = 'test-user' as UUID;
      const viewer = generateId() as UUID;
      await new UsersRepository(db).create({
        user_id: viewer,
        email: `viewer-${viewer}@agor.test`,
        role: 'member',
      });

      const boards = new BoardRepository(db);
      const repo = await createRepo(db);
      const alpha = await boards.create({
        name: 'Alpha',
        created_by: owner,
        access_mode: 'shared',
      });
      const beta = await boards.create({
        name: 'Beta',
        created_by: owner,
        access_mode: 'shared',
      });
      const visible = await createBranch(db, repo.repo_id, alpha, owner, 'visible');
      const hidden = await createBranch(db, repo.repo_id, alpha, owner, 'hidden');
      const betaBranch = await createBranch(db, repo.repo_id, beta, owner, 'beta');
      await setTestBranchUserRole(
        db,
        visible.branch_id,
        viewer as UserID,
        'viewer',
        'none',
        owner as UserID
      );
      await setTestBranchUserRole(
        db,
        betaBranch.branch_id,
        viewer as UserID,
        'viewer',
        'none',
        owner as UserID
      );

      const transitioning = await createSession(db, visible, owner, {
        status: SessionStatus.RUNNING,
      });
      await createSession(db, hidden, owner, { status: SessionStatus.RUNNING });
      await createSession(db, betaBranch, owner, { status: SessionStatus.IDLE });

      const firstPage = await boards.findPage({
        visibleToUserId: viewer,
        sort: { name: 1 },
        limit: 1,
        offset: 0,
      });
      expect(firstPage.total).toBe(2);
      expect(firstPage.data).toHaveLength(1);
      expect(firstPage.data[0]).toMatchObject({
        board_id: alpha.board_id,
        running_session_count: 1,
      });

      // Permission mutation guard: without visibleBranchAccessCondition this
      // would be 2 because the distinct owner's hidden branch is also running.
      expect(firstPage.data[0].running_session_count).not.toBe(2);

      const sessions = new SessionRepository(db);
      await sessions.update(transitioning.session_id, {
        status: SessionStatus.AWAITING_PERMISSION,
      });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .running_session_count
      ).toBe(0);

      await sessions.update(transitioning.session_id, { status: SessionStatus.RUNNING });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .running_session_count
      ).toBe(1);

      await sessions.update(transitioning.session_id, {
        archived: true,
        archived_reason: 'manual',
      });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .running_session_count
      ).toBe(0);

      await sessions.update(transitioning.session_id, {
        archived: false,
      });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .running_session_count
      ).toBe(1);
    }
  );
});
