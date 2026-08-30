import {
  attachHiddenTenant,
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, Session, UserID } from '@agor/core/types';
import { ROLES, SessionStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { type SessionParams, SessionsService } from './sessions';

function app(): Application {
  return {
    get: (key: string) =>
      key === 'config' ? { execution: { allow_superadmin: false } } : undefined,
    service: () => ({ get: vi.fn() }),
  } as unknown as Application;
}

async function user(db: any, label: string): Promise<UserID> {
  return (
    await new UsersRepository(db).create({
      user_id: generateId(),
      email: `${label}-${generateId()}@example.invalid`,
      role: ROLES.MEMBER,
    })
  ).user_id;
}

async function branch(db: any, owner: UserID, label: string): Promise<Branch> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `transfer-${label}-${generateId()}`,
    name: label,
    repo_type: 'remote',
    remote_url: `https://example.invalid/${label}.git`,
    local_path: `/tmp/${label}-${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: label,
    ref: label,
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${label}-${generateId()}`,
    created_by: owner,
  });
}

async function session(
  db: any,
  targetBranch: Branch,
  owner: UserID,
  overrides: Partial<Session> = {}
): Promise<Session> {
  return new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: targetBranch.branch_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: owner,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
}

function params(caller: UserID): SessionParams {
  return {
    provider: 'mcp',
    authenticated: true,
    user: { user_id: caller, email: `${caller}@example.invalid`, role: ROLES.MEMBER },
  } as SessionParams;
}

describe('SessionsService transfer authorization', () => {
  dbTest('requires distinct source-manager and destination-prompt authority', async ({ db }) => {
    const caller = await user(db, 'caller');
    const sourceOwner = await user(db, 'source-owner');
    const destinationOwner = await user(db, 'destination-owner');
    const sourceBranch = await branch(db, sourceOwner, 'source');
    const destinationBranch = await branch(db, destinationOwner, 'destination');
    await setTestBranchUserRole(db, sourceBranch.branch_id, caller, 'manager');
    await setTestBranchUserRole(db, destinationBranch.branch_id, caller, 'collaborator');

    const oldDestination = await session(db, sourceBranch, sourceOwner);
    const source = await session(db, sourceBranch, sourceOwner, {
      callback_config: {
        enabled: true,
        callback_session_id: oldDestination.session_id,
        callback_mode: 'persistent',
      },
    });
    // The caller owns the destination Session but not its Branch. This makes
    // destination authority independent from Manager authority on the source.
    const allowedDestination = await session(db, destinationBranch, caller);
    const service = new SessionsService(db, app());

    await expect(
      service.retargetCallback(
        source.session_id,
        { callbackSessionId: allowedDestination.session_id },
        params(caller)
      )
    ).resolves.toMatchObject({
      session_id: source.session_id,
      callback_session_id: allowedDestination.session_id,
    });
    await expect(
      service.resolveRelayDestination(
        source.session_id,
        { destination: 'coordinator' },
        params(caller)
      )
    ).resolves.toEqual({
      session_id: source.session_id,
      destination: 'coordinator',
      destination_session_id: allowedDestination.session_id,
    });

    const secondSource = await session(db, sourceBranch, sourceOwner, {
      callback_config: {
        enabled: true,
        callback_session_id: oldDestination.session_id,
      },
    });
    await setTestBranchUserRole(db, sourceBranch.branch_id, caller, 'collaborator');
    await expect(
      service.retargetCallback(
        secondSource.session_id,
        { callbackSessionId: allowedDestination.session_id },
        params(caller)
      )
    ).rejects.toThrow(/Manager permission on source session/);

    await setTestBranchUserRole(db, sourceBranch.branch_id, caller, 'manager');
    const forbiddenDestination = await session(db, destinationBranch, destinationOwner);
    await setTestBranchUserRole(db, destinationBranch.branch_id, caller, 'viewer');
    await expect(
      service.retargetCallback(
        secondSource.session_id,
        { callbackSessionId: forbiddenDestination.session_id },
        params(caller)
      )
    ).rejects.toThrow(/Cannot use destination session/);

    const relaySource = await session(db, sourceBranch, sourceOwner, {
      callback_config: {
        enabled: true,
        callback_session_id: forbiddenDestination.session_id,
      },
    });
    await expect(
      service.resolveRelayDestination(
        relaySource.session_id,
        { destination: 'coordinator' },
        params(caller)
      )
    ).rejects.toThrow(/Cannot use destination session/);
  });

  dbTest('requires authority over a new genealogy parent owned by another user', async ({ db }) => {
    const caller = await user(db, 'genealogy-caller');
    const branchOwner = await user(db, 'genealogy-owner');
    const targetBranch = await branch(db, branchOwner, 'genealogy');
    await setTestBranchUserRole(db, targetBranch.branch_id, caller, 'manager');
    const source = await session(db, targetBranch, branchOwner);
    const callerOwnedParent = await session(db, targetBranch, caller);
    const foreignParent = await session(db, targetBranch, branchOwner);
    const service = new SessionsService(db, app());

    await expect(
      service.reparent(
        source.session_id,
        { parentSessionId: callerOwnedParent.session_id },
        params(caller)
      )
    ).resolves.toMatchObject({ parent_session_id: callerOwnedParent.session_id });
    await expect(
      service.resolveRelayDestination(source.session_id, { destination: 'parent' }, params(caller))
    ).resolves.toEqual({
      session_id: source.session_id,
      destination: 'parent',
      destination_session_id: callerOwnedParent.session_id,
    });

    await expect(
      service.reparent(
        source.session_id,
        { parentSessionId: foreignParent.session_id },
        params(caller)
      )
    ).rejects.toThrow(/Cannot use destination session/);
  });

  dbTest(
    'relay requires independent source-view and destination-prompt authority',
    async ({ db }) => {
      const caller = await user(db, 'relay-auth-caller');
      const sourceOwner = await user(db, 'relay-source-owner');
      const destinationOwner = await user(db, 'relay-destination-owner');
      const sourceBranch = await branch(db, sourceOwner, 'relay-auth-source');
      const destinationBranch = await branch(db, destinationOwner, 'relay-auth-destination');
      const destination = await session(db, destinationBranch, destinationOwner);
      const source = await session(db, sourceBranch, sourceOwner, {
        callback_config: { enabled: true, callback_session_id: destination.session_id },
      });
      const service = new SessionsService(db, app());

      await expect(
        service.resolveRelayDestination(
          source.session_id,
          { destination: 'coordinator' },
          params(caller)
        )
      ).rejects.toThrow(/Viewer permission on source session/);

      await setTestBranchUserRole(db, sourceBranch.branch_id, caller, 'viewer');
      await expect(
        service.resolveRelayDestination(
          source.session_id,
          { destination: 'coordinator' },
          params(caller)
        )
      ).rejects.toThrow(/Cannot use destination session/);
    }
  );

  dbTest('rejects a cross-tenant destination before repository mutation', async ({ db }) => {
    const service = new SessionsService(db, app());
    const sourceId = generateId();
    const destinationId = generateId();
    const source = attachHiddenTenant(
      {
        session_id: sourceId,
        branch_id: generateId(),
        archived: false,
        callback_config: { enabled: true, callback_session_id: destinationId },
      } as Session,
      { tenant_id: 'tenant-a' }
    );
    const destination = attachHiddenTenant(
      {
        session_id: destinationId,
        branch_id: generateId(),
        archived: false,
      } as Session,
      { tenant_id: 'tenant-b' }
    );
    vi.spyOn(
      service as unknown as {
        requireSessionTransferAuthority(
          id: string,
          params: SessionParams,
          role: string
        ): Promise<Session>;
      },
      'requireSessionTransferAuthority'
    ).mockImplementation(async (id) => (id === sourceId ? source : destination));
    const mutate = vi.spyOn(
      (service as unknown as { sessionRepo: SessionRepository }).sessionRepo,
      'retargetCompletionCallback'
    );

    await expect(
      service.retargetCallback(
        sourceId,
        { callbackSessionId: destinationId },
        params(generateId() as UserID)
      )
    ).rejects.toThrow(/same tenant/);
    expect(mutate).not.toHaveBeenCalled();

    await expect(
      service.resolveRelayDestination(
        sourceId,
        { destination: 'coordinator' },
        params(generateId() as UserID)
      )
    ).rejects.toThrow(/same tenant/);
  });

  dbTest(
    'relay resolution fails closed for disabled, archived, and deleted destinations',
    async ({ db }) => {
      const caller = await user(db, 'relay-state-caller');
      const targetBranch = await branch(db, caller, 'relay-state');
      const archivedDestination = await session(db, targetBranch, caller, { archived: true });
      const disabledSource = await session(db, targetBranch, caller, {
        callback_config: {
          enabled: false,
          callback_session_id: archivedDestination.session_id,
        },
      });
      const service = new SessionsService(db, app());

      await expect(
        service.resolveRelayDestination(
          disabledSource.session_id,
          { destination: 'coordinator' },
          params(caller)
        )
      ).rejects.toThrow(/no enabled direct callback coordinator/);

      const archivedSource = await session(db, targetBranch, caller, {
        callback_config: {
          enabled: true,
          callback_session_id: archivedDestination.session_id,
        },
      });
      await expect(
        service.resolveRelayDestination(
          archivedSource.session_id,
          { destination: 'coordinator' },
          params(caller)
        )
      ).rejects.toThrow(/Destination session .* archived/);

      const deletedSource = await session(db, targetBranch, caller, {
        callback_config: { enabled: true, callback_session_id: generateId() },
      });
      await expect(
        service.resolveRelayDestination(
          deletedSource.session_id,
          { destination: 'coordinator' },
          params(caller)
        )
      ).rejects.toThrow(/Destination session .* unavailable or deleted/);
    }
  );
});
