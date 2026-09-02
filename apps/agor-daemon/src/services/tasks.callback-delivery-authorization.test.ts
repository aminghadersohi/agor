import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { ROLES, SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { TasksService } from './tasks';

describe('callback BTW authorization preflight', () => {
  dbTest(
    'denies a different user who can view but cannot prompt the destination session',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const owner = await users.create({
        user_id: generateId(),
        email: `callback-owner-${generateId()}@example.invalid`,
        role: ROLES.MEMBER,
      });
      const callbackCreator = await users.create({
        user_id: generateId(),
        email: `callback-creator-${generateId()}@example.invalid`,
        role: ROLES.MEMBER,
      });
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: `callback-auth-${generateId()}`,
        name: 'Callback authorization test',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/callback-auth.git',
        local_path: `/tmp/callback-auth-${generateId()}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'callback-auth',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        path: `/tmp/callback-auth-${generateId()}`,
        created_by: owner.user_id,
      });
      await setTestBranchUserRole(db, branch.branch_id, callbackCreator.user_id, 'viewer');
      const destination = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'claude-code',
        created_by: owner.user_id,
        status: SessionStatus.IDLE,
        sdk_session_id: 'sdk-fork-state',
        tasks: [],
        contextFiles: [],
        genealogy: { children: [] },
      });
      const app = {
        service: (name: string) => {
          if (name !== 'sessions') throw new Error(`Unexpected service ${name}`);
          return { get: async () => destination };
        },
      } as unknown as Application;
      const service = Object.create(TasksService.prototype) as TasksService & {
        db: typeof db;
        app: Application;
      };
      service.db = db;
      service.app = app;

      await expect(
        (service as any).callbackBtwUnavailableReason(destination, callbackCreator.user_id)
      ).resolves.toBe('permission_denied');
    }
  );
});
