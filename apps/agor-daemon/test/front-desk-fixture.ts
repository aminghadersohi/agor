/**
 * Real-database fixture and shared suite for pinned front desks (Slice 1).
 *
 * Builds on — and deliberately does not modify — the Part 1
 * `teammate-addressing-fixture.ts`: same migrated schema, same RBAC-scoped
 * teammate discovery, same `SessionsService` recency ordering, same
 * registered `agor_sessions_prompt`. On top of that it registers the
 * front-desk MCP tools and seeds a branch Collaborator, so "only a Manager
 * may pin" is proven against the real capability policy rather than a stub.
 *
 * Instantiated once per engine (`front-desk.integration.test.ts` for SQLite,
 * `front-desk.postgres.test.ts` for PostgreSQL) so both run one set of
 * expectations. PostgreSQL-only properties — concurrent promotion and RLS —
 * live in the PostgreSQL file.
 */

import {
  BranchFrontDeskRepository,
  branchFrontDeskSessions,
  CapabilityPolicyRepository,
  type Database,
  eq,
  FrontDeskPinRefusedError,
  insert,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
  update,
} from '@agor/core/db';
import {
  type BranchFrontDeskID,
  type BranchFrontDeskSession,
  type BranchID,
  capabilityPolicyPresetCapabilities,
  FRONT_DESK_TEAMMATE_SCOPE,
  type FrontDeskStatus,
  type SdkFailure,
  type SessionID,
  type Task,
  TaskStatus,
  type TenantID,
  type User,
  type UserID,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { generateId } from '../../../packages/core/src/lib/ids';
import { tenantScopedToolProxy } from '../src/mcp/tenant-scope';
import { registerFrontDeskTools } from '../src/mcp/tools/front-desk';
import { resolveTeammateSession } from '../src/mcp/tools/teammate-addressing';
import {
  type TeammateAddressingFixture,
  teammateAddressingFixture,
} from './teammate-addressing-fixture';

type Handler = ReturnType<TeammateAddressingFixture['handlersFor']>[string];

export interface FrontDeskFixture extends TeammateAddressingFixture {
  /** Branch Collaborator on every teammate branch: may prompt, may not pin. */
  collaborator: User;
  /** The registered front-desk MCP tools, as `user`. */
  frontDeskHandlersFor(user?: User): Record<string, Handler>;
  /** Every declaration for a branch, occupants and history, read in-tenant. */
  declarations(branchId: BranchID): Promise<BranchFrontDeskSession[]>;
  /** Repository-level pin, bypassing RBAC — for arranging state only. */
  pinDirect(branchId: BranchID, sessionId: SessionID): Promise<BranchFrontDeskSession>;
  archiveSession(sessionId: SessionID): Promise<void>;
  /** Force a declaration's status, standing in for the (later) rotation ritual. */
  setDeclarationStatus(id: BranchFrontDeskID, status: FrontDeskStatus): Promise<void>;
  /** Record a settled Task on a session. */
  settleTask(
    sessionId: SessionID,
    options: { status: Task['status']; sdkFailure?: SdkFailure; completedAt: Date }
  ): Promise<void>;
  inTenant<T>(work: (db: Database) => Promise<T>): Promise<T>;
}

/** The failure supervision stamps when an executor stops heartbeating. */
export const HEARTBEAT_LOST: SdkFailure = {
  reason: 'heartbeat_lost',
  detected_at: '2026-06-01T00:00:00.000Z',
  tool: 'claude-code',
  termination: 'verified',
};

export async function frontDeskFixture(
  rawDb: Database,
  tenantId: TenantID = 'default' as TenantID
): Promise<FrontDeskFixture> {
  const base = await teammateAddressingFixture(rawDb, tenantId);
  const { db } = base;
  const inTenant = <T>(work: (scoped: Database) => Promise<T>) =>
    runWithTenantDatabaseScope(db, tenantId, work);

  const collaborator = await inTenant(async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `front-desk-collaborator-${generateId()}@example.invalid`,
      name: 'Front Desk Collaborator',
      role: 'member',
    });
    // Teammate branches inherit the board's branch template, so one direct
    // Collaborator entry there applies to every teammate the fixture seeds.
    const policies = new CapabilityPolicyRepository(scoped);
    const board = await policies.getBoardPolicies(base.boardId as never);
    board.branch_template.access.sharing_mode = 'shared';
    board.branch_template.access.entries.push({
      entry_id: generateId(),
      principal: { principal_type: 'user', user_id: user.user_id as UserID },
      preset: 'collaborator',
      capabilities: capabilityPolicyPresetCapabilities('branch_access', 'collaborator') ?? [],
      fs_access: 'none',
    });
    await policies.replaceBoardPolicies(base.boardId as never, board, base.owner.user_id as UserID);
    return user;
  });

  function frontDeskHandlersFor(user: User = base.owner): Record<string, Handler> {
    const ctx = base.contextFor(user);
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    registerFrontDeskTools(tenantScopedToolProxy(server, ctx), ctx);
    return handlers;
  }

  return {
    ...base,
    collaborator,
    frontDeskHandlersFor,
    inTenant,
    declarations: (branchId) =>
      inTenant((scoped) => new BranchFrontDeskRepository(scoped).findByBranch(branchId)),
    pinDirect: (branchId, sessionId) =>
      inTenant(async (scoped) => {
        const result = await new BranchFrontDeskRepository(scoped).promote({
          branchId,
          scope: FRONT_DESK_TEAMMATE_SCOPE,
          sessionId,
          promotedBy: base.owner.user_id as UserID,
        });
        return result.desk;
      }),
    setDeclarationStatus: async (id, status) => {
      await inTenant((scoped) =>
        update(scoped, branchFrontDeskSessions)
          .set({ status })
          .where(eq(branchFrontDeskSessions.id, id))
          .run()
      );
    },
    archiveSession: async (sessionId) => {
      await inTenant((scoped) =>
        new SessionRepository(scoped).update(sessionId, { archived: true })
      );
    },
    settleTask: async (sessionId, options) => {
      await inTenant((scoped) =>
        new TaskRepository(scoped).create({
          session_id: sessionId,
          created_by: base.owner.user_id,
          full_prompt: 'front desk health fixture',
          status: options.status,
          created_at: options.completedAt.toISOString(),
          completed_at: options.completedAt.toISOString(),
          ...(options.sdkFailure ? { sdk_failure: options.sdkFailure } : {}),
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: options.completedAt.toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'fixture' },
        })
      );
    },
  };
}

const OLDER = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-05-01T00:00:00.000Z');

/** A teammate with two sessions: `pinned` is strictly older than `recent`. */
async function teammateWithTwoSessions(f: FrontDeskFixture, name = 'front-desk') {
  const branch = await f.createTeammate({ name, displayName: 'Front Desk' });
  const pinned = await f.createSession({ branchId: branch.branch_id, updatedAt: OLDER });
  const recent = await f.createSession({ branchId: branch.branch_id, updatedAt: NEWER });
  return { branch, pinned, recent };
}

function occupying(declarations: BranchFrontDeskSession[]) {
  return declarations.filter((d) => d.status === 'active' || d.status === 'retiring');
}

/**
 * Slice 1 acceptance, runnable on every engine. `setup` returns a fresh
 * fixture per test so no declaration leaks between tests.
 */
export function frontDeskSuite(setup: () => Promise<FrontDeskFixture>): void {
  it('reaches the pinned session even when a sibling session is strictly more recent', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);

    const set = await f.frontDeskHandlersFor().agor_teammates_front_desk_set({
      teammate: 'Front Desk',
      sessionId: pinned.session_id,
    });
    expect(set.isError).toBeFalsy();
    expect(f.payloadOf(set)).toMatchObject({
      front_desk: { session_id: pinned.session_id, status: 'active', branch_id: branch.branch_id },
      replaced: null,
      unchanged: false,
    });

    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      outcome: 'session',
      via: 'front_desk',
      session: { session_id: pinned.session_id },
    });
    const result = await f.handlersFor().agor_sessions_prompt({
      teammate: 'front-desk',
      prompt: 'Who is on the desk?',
    });
    expect(result.isError).toBeFalsy();
    const payload = f.payloadOf(result);
    expect(payload.addressed).toMatchObject({
      session_id: pinned.session_id,
      session_source: 'front_desk',
      mode: 'btw',
    });
    expect(payload.session).toMatchObject({
      genealogy: { forked_from_session_id: pinned.session_id },
    });
  });

  it('does not let an in-flight btw fork off the front desk intercept the next address', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);
    const prompt = f.handlersFor().agor_sessions_prompt;

    const first = f.payloadOf(await prompt({ teammate: 'front-desk', prompt: 'first' }));
    const fork = first.session as { session_id: string; archived: boolean };
    // The fork is live, unarchived, in the same branch, and the newest session
    // there — exactly what recency would pick next.
    expect(fork.archived).toBe(false);

    const second = f.payloadOf(await prompt({ teammate: 'front-desk', prompt: 'second' }));
    expect(second.addressed).toMatchObject({ session_id: pinned.session_id });
    expect(second.session).toMatchObject({
      genealogy: { forked_from_session_id: pinned.session_id },
    });
    expect((second.session as { session_id: string }).session_id).not.toBe(fork.session_id);

    // Control: without the pin, recency would have handed the address to a fork.
    await f.inTenant((scoped) =>
      new BranchFrontDeskRepository(scoped).clear({
        branchId: branch.branch_id,
        scope: FRONT_DESK_TEAMMATE_SCOPE,
      })
    );
    const unpinned = await resolveTeammateSession(f.contextFor(), branch);
    expect(unpinned).toMatchObject({ via: 'recency' });
    expect((unpinned as { session: { session_id: string } }).session.session_id).not.toBe(
      pinned.session_id
    );
  });

  it('refuses to pin a session from a different branch and writes nothing', async () => {
    const f = await setup();
    const { branch } = await teammateWithTwoSessions(f);
    const other = await f.createTeammate({ name: 'back-office', displayName: 'Back Office' });
    const foreign = await f.createSession({ branchId: other.branch_id, updatedAt: NEWER });

    const result = await f.frontDeskHandlersFor().agor_teammates_front_desk_set({
      teammate: 'front-desk',
      sessionId: foreign.session_id,
    });

    expect(result.isError).toBe(true);
    expect(f.payloadOf(result)).toMatchObject({ reason: 'session_in_other_branch' });
    expect(await f.declarations(branch.branch_id)).toEqual([]);
  });

  it('refuses to pin an archived session', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    await f.archiveSession(pinned.session_id);

    const result = await f.frontDeskHandlersFor().agor_teammates_front_desk_set({
      branchId: branch.branch_id,
      sessionId: pinned.session_id,
    });
    expect(f.payloadOf(result)).toMatchObject({ reason: 'session_archived' });
    expect(await f.declarations(branch.branch_id)).toEqual([]);
  });

  it('replaces an active pin atomically, keeping the old one as history', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);
    const set = f.frontDeskHandlersFor().agor_teammates_front_desk_set;
    await set({ teammate: 'front-desk', sessionId: pinned.session_id });

    const replaced = f.payloadOf(
      await set({ teammate: 'front-desk', sessionId: recent.session_id })
    );
    expect(replaced).toMatchObject({
      front_desk: { session_id: recent.session_id, status: 'active' },
      replaced: { session_id: pinned.session_id },
    });

    const declarations = await f.declarations(branch.branch_id);
    expect(occupying(declarations)).toEqual([
      expect.objectContaining({ session_id: recent.session_id, status: 'active' }),
    ]);
    expect(declarations).toContainEqual(
      expect.objectContaining({
        session_id: pinned.session_id,
        status: 'retired',
        retired_reason: 'replaced',
      })
    );

    // Re-pinning the current occupant is a no-op, not another history row.
    const again = f.payloadOf(await set({ teammate: 'front-desk', sessionId: recent.session_id }));
    expect(again).toMatchObject({ unchanged: true });
    expect(await f.declarations(branch.branch_id)).toHaveLength(2);
  });

  it('enforces one occupant per slot in the schema, not only in the repository', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);

    // Bypass the repository entirely: a second occupying row for the same
    // (branch, scope, slot) must be rejected by the partial unique index.
    for (const status of ['active', 'retiring'] as const) {
      await expect(
        f.inTenant((scoped) =>
          insert(scoped, branchFrontDeskSessions)
            .values({
              id: generateId(),
              branch_id: branch.branch_id,
              scope: FRONT_DESK_TEAMMATE_SCOPE,
              slot: 0,
              session_id: recent.session_id,
              status,
              promoted_at: new Date(),
            })
            .run()
        )
      ).rejects.toThrow();
    }
    // A retired row does not occupy the slot, so history is unconstrained.
    await f.inTenant((scoped) =>
      insert(scoped, branchFrontDeskSessions)
        .values({
          id: generateId(),
          branch_id: branch.branch_id,
          scope: FRONT_DESK_TEAMMATE_SCOPE,
          slot: 0,
          session_id: recent.session_id,
          status: 'retired',
          retired_reason: 'manual',
          promoted_at: new Date(),
        })
        .run()
    );
    expect(occupying(await f.declarations(branch.branch_id))).toHaveLength(1);
  });

  it('rejects any slot other than the primary one', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    await expect(
      f.inTenant((scoped) =>
        new BranchFrontDeskRepository(scoped).promote({
          branchId: branch.branch_id,
          scope: FRONT_DESK_TEAMMATE_SCOPE,
          slot: 1,
          sessionId: pinned.session_id,
        })
      )
    ).rejects.toBeInstanceOf(FrontDeskPinRefusedError);
    expect(await f.declarations(branch.branch_id)).toEqual([]);
  });

  it('demotes an archived front desk on the next resolve and still answers via recency', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);
    await f.archiveSession(pinned.session_id);

    const result = await f.handlersFor().agor_sessions_prompt({
      teammate: 'front-desk',
      prompt: 'still there?',
    });
    expect(result.isError).toBeFalsy();
    const payload = f.payloadOf(result);
    expect(payload.addressed).toMatchObject({ session_id: recent.session_id });
    // Recency fallback echoes exactly what Part 1 did: no front-desk marker.
    expect(payload.addressed).not.toHaveProperty('session_source');
    expect(await f.declarations(branch.branch_id)).toEqual([
      expect.objectContaining({
        session_id: pinned.session_id,
        status: 'retired',
        retired_reason: 'archived',
      }),
    ]);
  });

  it('demotes a front desk whose executor died, and keeps one whose agent merely erred', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);

    // An ordinary agent failure proves the executor is alive: pin holds.
    await f.settleTask(pinned.session_id, {
      status: TaskStatus.FAILED,
      completedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'front_desk',
      session: { session_id: pinned.session_id },
    });

    // Supervision declared the executor dead: demote to failed, fall through.
    await f.settleTask(pinned.session_id, {
      status: TaskStatus.FAILED,
      sdkFailure: HEARTBEAT_LOST,
      completedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'recency',
      session: { session_id: recent.session_id },
    });
    expect(await f.declarations(branch.branch_id)).toEqual([
      expect.objectContaining({ status: 'failed', retired_reason: 'dead' }),
    ]);
  });

  it('does not treat an executor death as fatal once a later turn completed', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);
    await f.settleTask(pinned.session_id, {
      status: TaskStatus.FAILED,
      sdkFailure: HEARTBEAT_LOST,
      completedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await f.settleTask(pinned.session_id, {
      status: TaskStatus.COMPLETED,
      completedAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'front_desk',
      session: { session_id: pinned.session_id },
    });
  });

  it('keeps serving a retiring slot while a turn is still in flight', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    const desk = await f.pinDirect(branch.branch_id, pinned.session_id);
    await f.setDeclarationStatus(desk.id, 'retiring');
    await f.settleTask(pinned.session_id, { status: TaskStatus.RUNNING, completedAt: NEWER });

    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'front_desk',
      session: { session_id: pinned.session_id },
    });
  });

  it('retires a retiring slot once no Task is in flight', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);
    const desk = await f.pinDirect(branch.branch_id, pinned.session_id);
    await f.setDeclarationStatus(desk.id, 'retiring');

    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'recency',
      session: { session_id: recent.session_id },
    });
    expect(await f.declarations(branch.branch_id)).toEqual([
      expect.objectContaining({ status: 'retired', retired_reason: 'context' }),
    ]);
  });

  it('still refuses an ambiguous name, even when one candidate has a front desk', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);
    await f.createTeammate({ name: 'fd-two', displayName: 'front-desk' });

    const result = await f.handlersFor().agor_sessions_prompt({
      teammate: 'front-desk',
      prompt: 'Ambiguous on purpose',
    });
    expect(result.isError).toBe(true);
    expect(f.payloadOf(result).error).toMatch(/matches 2 teammates/);
    expect(f.promptService).not.toHaveBeenCalled();
  });

  it('lets only a branch Manager pin or clear', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);

    // The Collaborator can address and prompt this teammate …
    await expect(
      resolveTeammateSession(f.contextFor(f.collaborator), branch)
    ).resolves.toMatchObject({ outcome: 'session' });
    // … but cannot redirect other people's messages to a session of their choosing.
    await expect(
      f.frontDeskHandlersFor(f.collaborator).agor_teammates_front_desk_set({
        teammate: 'front-desk',
        sessionId: recent.session_id,
      })
    ).rejects.toThrow(/Branch Manager/);
    expect(await f.declarations(branch.branch_id)).toEqual([]);

    // An unrelated member cannot even resolve the teammate.
    const outsider = await f.frontDeskHandlersFor(f.outsider).agor_teammates_front_desk_set({
      teammate: 'front-desk',
      sessionId: recent.session_id,
    });
    expect(outsider.isError).toBe(true);
    expect(f.payloadOf(outsider).error).toMatch(/No teammate matches/);

    // The owner (Manager) can; the Collaborator still cannot clear it.
    const owner = f.frontDeskHandlersFor(f.owner);
    expect(
      (
        await owner.agor_teammates_front_desk_set({
          teammate: 'front-desk',
          sessionId: pinned.session_id,
        })
      ).isError
    ).toBeFalsy();
    await expect(
      f.frontDeskHandlersFor(f.collaborator).agor_teammates_front_desk_clear({
        teammate: 'front-desk',
      })
    ).rejects.toThrow(/Branch Manager/);
    expect(occupying(await f.declarations(branch.branch_id))).toHaveLength(1);
  });

  it('clears back to recency, and a stale expectedSessionId is a conflict, not a write', async () => {
    const f = await setup();
    const { branch, pinned, recent } = await teammateWithTwoSessions(f);
    const tools = f.frontDeskHandlersFor();
    await tools.agor_teammates_front_desk_set({
      teammate: 'front-desk',
      sessionId: pinned.session_id,
    });

    const stale = await tools.agor_teammates_front_desk_set({
      teammate: 'front-desk',
      sessionId: recent.session_id,
      expectedSessionId: recent.session_id,
    });
    expect(stale.isError).toBe(true);
    expect(f.payloadOf(stale)).toMatchObject({
      conflict: true,
      current_front_desk: { session_id: pinned.session_id },
    });

    const cleared = await tools.agor_teammates_front_desk_clear({
      teammate: 'front-desk',
      expectedSessionId: pinned.session_id,
    });
    expect(f.payloadOf(cleared)).toMatchObject({ cleared: { session_id: pinned.session_id } });
    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'recency',
      session: { session_id: recent.session_id },
    });
    expect(await f.declarations(branch.branch_id)).toEqual([
      expect.objectContaining({ status: 'retired', retired_reason: 'manual' }),
    ]);

    // Clearing an empty slot is a no-op.
    expect(
      f.payloadOf(await tools.agor_teammates_front_desk_clear({ teammate: 'front-desk' }))
    ).toEqual({ cleared: null });
  });

  it('removes declarations with their session', async () => {
    const f = await setup();
    const { branch, pinned } = await teammateWithTwoSessions(f);
    await f.pinDirect(branch.branch_id, pinned.session_id);

    await f.inTenant((scoped) => new SessionRepository(scoped).delete(pinned.session_id));

    expect(await f.declarations(branch.branch_id)).toEqual([]);
  });
}
