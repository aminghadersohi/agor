/**
 * PostgreSQL/RLS proof for the caller-scoped Board running-Session aggregate.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql AGOR_TEST_POSTGRES_URL=... \
 *   pnpm exec vitest run src/db/repositories/boards-running-sessions.postgres.test.ts
 */
import type { UserID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { setTestBranchUserRole } from '../test-helpers';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Board running Session counts (PostgreSQL RLS)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });

    it('isolates tenants and excludes a distinct owner’s branch when the viewer lacks branch access', async () => {
      const tenantA = `board-count-a-${generateId()}`;
      const tenantB = `board-count-b-${generateId()}`;
      let foreignBoardId = '';

      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const foreignOwner = await new UsersRepository(scoped).create({
          email: `foreign-${generateId()}@agor.test`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `foreign-${generateId()}`,
          name: 'Foreign tenant repo',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/foreign.git',
          local_path: `/tmp/foreign-${generateId()}`,
          default_branch: 'main',
        });
        const board = await new BoardRepository(scoped).create({
          name: 'Foreign board',
          created_by: foreignOwner.user_id as UUID,
          access_mode: 'shared',
        });
        foreignBoardId = board.board_id;
        const branch = await new BranchRepository(scoped).create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          name: 'foreign-running',
          ref: 'foreign-running',
          path: `/tmp/foreign-running-${generateId()}`,
          branch_unique_id: 91_001,
          created_by: foreignOwner.user_id as UUID,
        });
        await new SessionRepository(scoped).create({
          branch_id: branch.branch_id,
          created_by: foreignOwner.user_id as UUID,
          agentic_tool: 'claude-code',
          status: SessionStatus.RUNNING,
        });
      });

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        const owner = await users.create({
          email: `owner-${generateId()}@agor.test`,
          role: 'member',
        });
        const viewer = await users.create({
          email: `viewer-${generateId()}@agor.test`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `local-${generateId()}`,
          name: 'Local tenant repo',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/local.git',
          local_path: `/tmp/local-${generateId()}`,
          default_branch: 'main',
        });
        const boardRepo = new BoardRepository(scoped);
        const board = await boardRepo.create({
          name: 'Visible board',
          created_by: owner.user_id as UUID,
          access_mode: 'shared',
        });
        const branches = new BranchRepository(scoped);
        const createBranch = (name: string, uniqueId: number) =>
          branches.create({
            repo_id: repo.repo_id,
            board_id: board.board_id,
            name,
            ref: name,
            path: `/tmp/${name}-${generateId()}`,
            branch_unique_id: uniqueId,
            created_by: owner.user_id as UUID,
            permission_source: 'override',
            others_can: 'none',
          });
        const visibleBranch = await createBranch('viewer-can-see', 91_002);
        const hiddenBranch = await createBranch('viewer-cannot-see', 91_003);
        await setTestBranchUserRole(
          scoped,
          visibleBranch.branch_id,
          viewer.user_id as UserID,
          'viewer',
          'none',
          owner.user_id as UserID
        );

        const sessions = new SessionRepository(scoped);
        for (const branch of [visibleBranch, hiddenBranch]) {
          await sessions.create({
            branch_id: branch.branch_id,
            created_by: owner.user_id as UUID,
            agentic_tool: 'claude-code',
            status: SessionStatus.RUNNING,
          });
        }

        const page = await boardRepo.findPage({
          visibleToUserId: viewer.user_id as UUID,
          limit: 10,
          offset: 0,
        });

        expect(page.data.map((item) => item.board_id)).toEqual([board.board_id]);
        expect(page.data[0].running_session_count).toBe(1);
        expect(page.data.map((item) => item.board_id)).not.toContain(foreignBoardId);
        // Removing the aggregate's branch permission predicate changes 1 → 2,
        // so this is a non-vacuous distinct-owner RBAC mutation guard.
        expect(owner.user_id).not.toBe(viewer.user_id);
      });
    });
  }
);
