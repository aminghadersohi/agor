import type { Board, Branch, Session, UserID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
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

describe('BoardRepository Board list counts', () => {
  dbTest(
    'reproduces the production list path across worktrees, origins, task lifecycles, and explicit zeroes',
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
      await createBranch(db, repo.repo_id, countedBoard, owner, 'empty-worktree');

      const root = await createSession(db, branch, owner, { status: SessionStatus.RUNNING });
      const child = await createSession(db, branch, owner, {
        status: SessionStatus.STOPPING,
        genealogy: { parent_session_id: root.session_id, children: [] },
      });
      await createSession(db, branch, owner, {
        status: SessionStatus.AWAITING_PERMISSION,
        callback_config: {
          enabled: true,
          callback_session_id: root.session_id,
          callback_created_by: owner,
        },
      });
      await createSession(db, branch, owner, {
        status: SessionStatus.AWAITING_INPUT,
        custom_context: {
          gateway_source: {
            channel_id: 'fictional-test-channel-id',
            channel_name: 'fictional-test-channel',
            channel_type: 'slack',
            thread_id: 'fictional-thread-id',
          },
        },
      });
      const queued = await createSession(db, branch, owner, { status: SessionStatus.IDLE });
      const dispatching = await createSession(db, branch, owner, {
        status: SessionStatus.RUNNING,
      });
      const completed = await createSession(db, branch, owner, {
        status: SessionStatus.COMPLETED,
      });
      const failed = await createSession(db, branch, owner, { status: SessionStatus.FAILED });
      await createSession(db, branch, owner, {
        status: SessionStatus.IDLE,
        title: 'Recovered fictional Session',
      });
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

      // These Task states exercise the real lifecycle shapes visible beside
      // Sessions. Counts remain Session-based: Task rows neither add Sessions
      // nor redefine the shared isSessionExecuting classification.
      const tasks = new TaskRepository(db);
      for (const [session, status] of [
        [queued, TaskStatus.QUEUED],
        [dispatching, TaskStatus.DISPATCHING],
        [root, TaskStatus.RUNNING],
        [child, TaskStatus.STOPPING],
        [completed, TaskStatus.COMPLETED],
        [failed, TaskStatus.FAILED],
        // Mutation guard: a second Task on one Session must not multiply any
        // Board aggregate if the query is later changed to join Tasks.
        [root, TaskStatus.COMPLETED],
      ] as const) {
        await tasks.create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: owner,
          full_prompt: `fictional ${status} task`,
          status,
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

      const aggregateSpy = vi.spyOn(
        boards as unknown as { attachBoardListCounts: BoardRepository['findAll'] },
        'attachBoardListCounts'
      );
      const result = await boards.findAll();
      expect(result.find((board) => board.board_id === countedBoard.board_id))?.toMatchObject({
        worktree_count: 2,
        total_session_count: 9,
        active_session_count: 5,
      });
      expect(result.find((board) => board.board_id === zeroBoard.board_id))?.toMatchObject({
        worktree_count: 0,
        total_session_count: 0,
        active_session_count: 0,
      });
      // One set-based aggregate invocation covers every board in the list.
      expect(aggregateSpy).toHaveBeenCalledTimes(1);
    }
  );

  dbTest(
    'applies branch RBAC before paging and follows active/archive/move/recovery transitions',
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
        worktree_count: 1,
        total_session_count: 1,
        active_session_count: 1,
      });

      // Permission mutation guard: without visibleBranchAccessCondition this
      // would be 2 because the distinct owner's hidden branch is also running.
      expect(firstPage.data[0].active_session_count).not.toBe(2);

      const sessions = new SessionRepository(db);
      await sessions.update(transitioning.session_id, {
        status: SessionStatus.AWAITING_PERMISSION,
      });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .active_session_count
      ).toBe(1);

      await sessions.update(transitioning.session_id, { status: SessionStatus.COMPLETED });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .active_session_count
      ).toBe(0);

      // Recovery into an executing state must restore the count even though
      // the status is not exact RUNNING.
      await sessions.update(transitioning.session_id, { status: SessionStatus.STOPPING });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
          .active_session_count
      ).toBe(1);

      await sessions.update(transitioning.session_id, {
        archived: true,
        archived_reason: 'manual',
      });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
      ).toMatchObject({ total_session_count: 0, active_session_count: 0 });

      await sessions.update(transitioning.session_id, {
        archived: false,
      });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
      ).toMatchObject({ total_session_count: 1, active_session_count: 1 });

      await new BranchRepository(db).update(visible.branch_id, { board_id: beta.board_id });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [alpha.board_id] })).data[0]
      ).toMatchObject({ worktree_count: 0, total_session_count: 0, active_session_count: 0 });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [beta.board_id] })).data[0]
      ).toMatchObject({ worktree_count: 2, total_session_count: 2, active_session_count: 1 });

      await new BranchRepository(db).update(visible.branch_id, { archived: true });
      expect(
        (await boards.findPage({ visibleToUserId: viewer, boardIds: [beta.board_id] })).data[0]
      ).toMatchObject({ worktree_count: 1, total_session_count: 1, active_session_count: 0 });
    }
  );
});
