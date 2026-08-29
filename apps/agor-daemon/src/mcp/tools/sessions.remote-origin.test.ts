/**
 * Remote-origin discoverability: an agent orienting through the normal path
 * must be able to find the session that remotely created it, and reach it.
 *
 * The reproduced failure: an orchestrator on branch A remote-creates a session
 * on branch B with a one-shot completion callback. The callback fires
 * correctly and, correctly, disables itself. Later the delegated session has a
 * follow-up to send, inspects its own orientation, sees `parent_session_id:
 * null` / `genealogy: "root"`, and concludes it has no parent to notify — even
 * though Agor still holds a `remote_create` row naming its origin exactly.
 *
 * These tests run against a REAL migrated SQLite database with the REAL
 * repositories and the REAL `ensureCanPromptTargetSession` authorization
 * helper, so the relationship rows, the one-shot disable, and the branch RBAC
 * decision are all produced by production code rather than restated by mocks.
 * Only the Feathers service layer is a thin harness over those repositories.
 */

import {
  BranchRepository,
  createDatabaseAsync,
  RepoRepository,
  runMigrations,
  SessionRelationshipRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Branch, Session, SessionID, SessionRelationship, UserID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

/** Every prompt the harness delivered, in order — the delivery ledger. */
interface DeliveredPrompt {
  sessionId: string;
  prompt: string;
}

interface Harness {
  rawDb: any;
  sessionRepo: SessionRepository;
  relationshipRepo: SessionRelationshipRepository;
  ownerId: UserID;
  strangerId: UserID;
  branchA: Branch;
  branchB: Branch;
  delivered: DeliveredPrompt[];
  /** Sessions the harness refuses to serve, simulating a hard delete. */
  deletedSessionIds: Set<string>;
  makeSession(branch: Branch, title: string): Promise<Session>;
  tools(sessionId: string | undefined, asUserId?: UserID): Promise<Record<string, ToolHandler>>;
}

async function setupHarness(): Promise<Harness> {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = rawDb as unknown as TenantScopeAwareDatabase;

  const usersRepo = new UsersRepository(rawDb);
  const owner = await usersRepo.create({
    email: `origin-owner-${Math.random()}@example.com`,
    role: 'member',
  });
  const stranger = await usersRepo.create({
    email: `origin-stranger-${Math.random()}@example.com`,
    role: 'member',
  });
  const ownerId = owner.user_id as UserID;
  const strangerId = stranger.user_id as UserID;

  const repo = await new RepoRepository(rawDb).create({
    name: 'orchestration-fixture',
    slug: 'orchestration-fixture',
    local_path: '/fixture/orchestration',
    repo_type: 'local',
    created_by: ownerId,
  });

  const branchRepo = new BranchRepository(rawDb);
  const makeBranch = (name: string, uniqueId: string) =>
    branchRepo.create({
      repo_id: repo.repo_id,
      created_by: ownerId,
      name,
      ref: `refs/heads/${name}`,
      branch_unique_id: uniqueId,
      path: `/fixture/orchestration/${name}`,
    });

  const branchA = await makeBranch('orchestrator-branch', 'fixture-branch-a');
  const branchB = await makeBranch('delegated-branch', 'fixture-branch-b');

  const sessionRepo = new SessionRepository(rawDb);
  const relationshipRepo = new SessionRelationshipRepository(rawDb);

  const delivered: DeliveredPrompt[] = [];
  const deletedSessionIds = new Set<string>();

  const loadSession = async (id: string): Promise<Session> => {
    if (deletedSessionIds.has(id)) throw new Error(`Session not found: ${id}`);
    const session = await sessionRepo.findById(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  };

  const app = {
    service(name: string) {
      switch (name) {
        case 'sessions':
          return { get: (id: string) => loadSession(id) };
        case 'users':
          return { get: async () => ({ name: 'Ada', email: 'ada@example.com', role: 'member' }) };
        case 'branches':
          return {
            get: async (id: string) => {
              const branch = await branchRepo.findById(id);
              if (!branch) throw new Error(`Branch not found: ${id}`);
              return branch;
            },
          };
        case 'repos':
          return { get: (id: string) => new RepoRepository(rawDb).findById(id) };
        case 'boards':
          return {
            get: async () => {
              throw new Error('no board');
            },
          };
        case 'tasks':
          return {
            get: async () => {
              throw new Error('no task');
            },
          };
        case '/sessions/:id/prompt':
          return {
            create: async (data: { prompt: string }, params: { route: { id: string } }) => {
              // The real route auto-unarchives its target; the archived guard
              // under test exists precisely so an archived origin never gets
              // here. Loading through the same path keeps a deleted target
              // failing rather than silently "delivering".
              const target = await loadSession(params.route.id);
              delivered.push({ sessionId: target.session_id, prompt: data.prompt });
              return { task_id: `task-${delivered.length}`, status: 'created' };
            },
          };
        default:
          throw new Error(`Unexpected service call: ${name}`);
      }
    },
  };

  return {
    rawDb,
    sessionRepo,
    relationshipRepo,
    ownerId,
    strangerId,
    branchA,
    branchB,
    delivered,
    deletedSessionIds,
    makeSession(branch: Branch, title: string) {
      return sessionRepo.create({
        branch_id: branch.branch_id,
        created_by: ownerId,
        title,
        agentic_tool: 'claude-code',
      });
    },
    async tools(sessionId: string | undefined, asUserId: UserID = ownerId) {
      const { registerSessionTools } = await import('./sessions.js');
      const captured: Record<string, ToolHandler> = {};
      const fakeServer = {
        registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
          captured[name] = cb;
        },
      } as unknown as McpServer;

      registerSessionTools(fakeServer, {
        app: app as any,
        db: db as any,
        userId: asUserId as any,
        sessionId: sessionId as any,
        authenticatedUser: { user_id: asUserId, role: 'member' } as any,
        baseServiceParams: {
          provider: 'mcp',
          user: { user_id: asUserId, role: 'member' },
        } as any,
      });
      return captured;
    },
  };
}

/**
 * The reproduced scenario, up to the moment the follow-up is attempted:
 * orchestrator on branch A remote-creates a session on branch B with a
 * one-shot completion callback targeting itself, the initial task completes,
 * and the automatic channel correctly closes behind it.
 */
async function reproduceCompletedOneShotDelegation(harness: Harness): Promise<{
  orchestrator: Session;
  delegated: Session;
  relationship: SessionRelationship;
}> {
  const orchestrator = await harness.makeSession(harness.branchA, 'Orchestrator');
  const delegated = await harness.sessionRepo.create({
    branch_id: harness.branchB.branch_id,
    created_by: harness.ownerId,
    title: 'Delegated worker',
    agentic_tool: 'claude-code',
    // A cross-branch create is never genealogy-linked (agor_sessions_create
    // refuses a parent outside the target branch). This session is a real root
    // in its own branch and must stay one.
    genealogy: { children: [] },
    callback_config: {
      enabled: true,
      callback_session_id: orchestrator.session_id,
      callback_created_by: harness.ownerId,
      callback_mode: 'once',
    },
  });

  const relationship = await harness.relationshipRepo.create({
    source_session_id: orchestrator.session_id,
    target_session_id: delegated.session_id,
    relationship_type: 'remote_create',
    created_by: harness.ownerId,
    callback_enabled: true,
    callback_session_id: orchestrator.session_id,
    data: {
      source_branch_id: harness.branchA.branch_id,
      target_branch_id: harness.branchB.branch_id,
    },
  });

  // Consume the one-shot exactly as production does: TasksService patches
  // `callback_config.enabled = false` on completion, and SessionsService.patch
  // syncs that onto the durable relationship via
  // `setCallbackEnabledForTargetSession`. Both halves are real repository
  // calls, so the resulting state is the real post-callback state.
  await harness.sessionRepo.update(delegated.session_id, {
    callback_config: { ...delegated.callback_config, enabled: false },
  });
  await harness.relationshipRepo.setCallbackEnabledForTargetSession(
    delegated.session_id as SessionID,
    false
  );

  const consumed = await harness.relationshipRepo.get(relationship.relationship_id);
  // Guard the premise. If this stops being false these tests no longer
  // exercise the post-one-shot state the bug report describes.
  expect(consumed.callback_enabled).toBe(false);
  // And the relationship itself survived the one-shot — the whole basis of the fix.
  expect(consumed.source_session_id).toBe(orchestrator.session_id);

  return { orchestrator, delegated, relationship: consumed };
}

describe('remote origin discoverability after a one-shot completion callback', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  it('surfaces the origin in orientation once the one-shot callback has already fired', async () => {
    const { orchestrator, delegated, relationship } =
      await reproduceCompletedOneShotDelegation(harness);

    const tools = await harness.tools(delegated.session_id);
    const context = parse(
      await tools.agor_sessions_get_current_context({ includeSiblings: false })
    );

    expect(context.remote_origins).toHaveLength(1);
    expect(context.remote_origins[0]).toMatchObject({
      relationship_id: relationship.relationship_id,
      origin_session_id: orchestrator.session_id,
      origin_branch_id: harness.branchA.branch_id,
      report_to_session_id: orchestrator.session_id,
      // The automatic channel is off — orientation says so without hiding the origin.
      automatic_completion_callback_enabled: false,
    });
    expect(context.remote_origin_note).toMatch(/agor_session_relationships_report/);
  });

  it('leaves genealogy untouched: a remote-created session is still root with no parent', async () => {
    const { delegated } = await reproduceCompletedOneShotDelegation(harness);

    const tools = await harness.tools(delegated.session_id);
    const context = parse(
      await tools.agor_sessions_get_current_context({ includeSiblings: false })
    );

    expect(context.genealogy).toBe('root');
    expect(context.parent_session_id).toBeNull();
    expect(context.children_count).toBe(0);
    // The origin must never leak into the genealogy fields.
    expect(context.remote_origins[0].origin_session_id).not.toBe(context.parent_session_id);
  });

  it('does not report the orchestrator itself as having a remote origin', async () => {
    // The orchestrator is the SOURCE of the relationship, not its target.
    // `remote_origins` answers "who created me" — being a creator must never
    // make a session look created.
    const { orchestrator, delegated } = await reproduceCompletedOneShotDelegation(harness);

    const tools = await harness.tools(orchestrator.session_id);
    const context = parse(
      await tools.agor_sessions_get_current_context({ includeSiblings: false })
    );

    expect(context.remote_origins).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain(delegated.session_id);

    const report = await tools.agor_session_relationships_report({ message: 'upward?' });
    expect(harness.delivered).toHaveLength(0);
    expect(report.isError).toBe(true);
    expect(parse(report).error).toMatch(/no recorded remote origin/i);
  });

  it('omits remote_origins entirely for a session nobody remote-created', async () => {
    const plain = await harness.makeSession(harness.branchB, 'Locally created');

    const tools = await harness.tools(plain.session_id);
    const context = parse(
      await tools.agor_sessions_get_current_context({ includeSiblings: false })
    );

    expect(context.remote_origins).toBeUndefined();
    expect(context.remote_origin_note).toBeUndefined();
    expect(context.genealogy).toBe('root');
  });

  it('delivers an explicit follow-up to the origin exactly once', async () => {
    const { orchestrator, delegated } = await reproduceCompletedOneShotDelegation(harness);

    const tools = await harness.tools(delegated.session_id);
    const result = parse(
      await tools.agor_session_relationships_report({
        message: 'The migration script needs a manual rollback step.',
      })
    );

    expect(result.success).toBe(true);
    expect(result.delivered_to_session_id).toBe(orchestrator.session_id);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0].sessionId).toBe(orchestrator.session_id);
    expect(harness.delivered[0].prompt).toContain('manual rollback step');
    expect(harness.delivered[0].prompt).toContain('Follow-up from remote-created session');
  });

  it('does not re-enable the automatic completion callback as a side effect', async () => {
    const { delegated, relationship } = await reproduceCompletedOneShotDelegation(harness);

    const tools = await harness.tools(delegated.session_id);
    const result = parse(
      await tools.agor_session_relationships_report({ message: 'status update' })
    );

    expect(result.automatic_completion_callback_enabled).toBe(false);
    const after = await harness.relationshipRepo.get(relationship.relationship_id);
    expect(after.callback_enabled).toBe(false);
    const delegatedAfter = await harness.sessionRepo.findById(delegated.session_id);
    expect(delegatedAfter?.callback_config?.enabled).toBe(false);
  });

  it('sends one message per call rather than opening a channel', async () => {
    const { orchestrator, delegated } = await reproduceCompletedOneShotDelegation(harness);

    const tools = await harness.tools(delegated.session_id);
    await tools.agor_session_relationships_report({ message: 'first' });
    expect(harness.delivered).toHaveLength(1);

    await tools.agor_session_relationships_report({ message: 'second' });
    expect(harness.delivered).toHaveLength(2);
    expect(harness.delivered.every((d) => d.sessionId === orchestrator.session_id)).toBe(true);
  });

  it('routes to the registered callback target when it differs from the creator', async () => {
    const orchestrator = await harness.makeSession(harness.branchA, 'Orchestrator');
    const reportDesk = await harness.makeSession(harness.branchA, 'Report desk');
    const delegated = await harness.makeSession(harness.branchB, 'Delegated worker');
    await harness.relationshipRepo.create({
      source_session_id: orchestrator.session_id,
      target_session_id: delegated.session_id,
      relationship_type: 'remote_create',
      created_by: harness.ownerId,
      callback_enabled: false,
      callback_session_id: reportDesk.session_id,
      data: {
        source_branch_id: harness.branchA.branch_id,
        target_branch_id: harness.branchB.branch_id,
      },
    });

    const tools = await harness.tools(delegated.session_id);
    const result = parse(await tools.agor_session_relationships_report({ message: 'done' }));

    expect(result.delivered_to_session_id).toBe(reportDesk.session_id);
    expect(harness.delivered.map((d) => d.sessionId)).toEqual([reportDesk.session_id]);
  });
});

describe('agor_session_relationships_report authorization', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  it('cannot be pointed at an unrelated session by supplying its relationship id', async () => {
    const { delegated } = await reproduceCompletedOneShotDelegation(harness);

    // A completely separate delegation between two other sessions. Its
    // relationship id is real and live — it is simply not ours.
    const strangerOrigin = await harness.makeSession(harness.branchA, 'Someone else');
    const strangerChild = await harness.makeSession(harness.branchB, "Someone else's worker");
    const strangerRelationship = await harness.relationshipRepo.create({
      source_session_id: strangerOrigin.session_id,
      target_session_id: strangerChild.session_id,
      relationship_type: 'remote_create',
      created_by: harness.ownerId,
      callback_enabled: true,
      callback_session_id: strangerOrigin.session_id,
    });

    const tools = await harness.tools(delegated.session_id);
    const result = await tools.agor_session_relationships_report({
      message: 'this must not arrive',
      relationshipId: strangerRelationship.relationship_id,
    });

    // The breach this guards against, asserted first so a regression names it:
    // nothing reached the stranger's orchestrator (nor anywhere else).
    expect(harness.delivered.map((d) => d.sessionId)).toEqual([]);
    expect(harness.delivered.map((d) => d.sessionId)).not.toContain(strangerOrigin.session_id);
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/not a remote origin of this session/i);
  });

  it('does not leak unrelated relationships when listing the caller-eligible ones', async () => {
    const { delegated, relationship } = await reproduceCompletedOneShotDelegation(harness);
    const strangerOrigin = await harness.makeSession(harness.branchA, 'Someone else');
    const strangerChild = await harness.makeSession(harness.branchB, "Someone else's worker");
    const strangerRelationship = await harness.relationshipRepo.create({
      source_session_id: strangerOrigin.session_id,
      target_session_id: strangerChild.session_id,
      relationship_type: 'remote_create',
      created_by: harness.ownerId,
      callback_enabled: true,
      callback_session_id: strangerOrigin.session_id,
    });

    const tools = await harness.tools(delegated.session_id);
    const body = parse(
      await tools.agor_session_relationships_report({
        message: 'x',
        relationshipId: 'no-such-relationship',
      })
    );

    expect(body.available_relationship_ids).toEqual([relationship.relationship_id]);
    expect(JSON.stringify(body)).not.toContain(strangerRelationship.relationship_id);
    expect(JSON.stringify(body)).not.toContain(strangerOrigin.session_id);
  });

  it('does not surface another session’s origin in this session’s orientation', async () => {
    const { orchestrator } = await reproduceCompletedOneShotDelegation(harness);
    const bystander = await harness.makeSession(harness.branchB, 'Unrelated worker');

    const tools = await harness.tools(bystander.session_id);
    const context = parse(
      await tools.agor_sessions_get_current_context({ includeSiblings: false })
    );

    expect(context.remote_origins).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain(orchestrator.session_id);
  });

  it('refuses when the caller has no session context at all', async () => {
    const tools = await harness.tools(undefined);
    const result = await tools.agor_session_relationships_report({ message: 'hello?' });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/requires current Agor session context/i);
    expect(harness.delivered).toHaveLength(0);
  });

  it('refuses a session that was never remote-created', async () => {
    const plain = await harness.makeSession(harness.branchB, 'Locally created');

    const tools = await harness.tools(plain.session_id);
    const result = await tools.agor_session_relationships_report({ message: 'anybody there?' });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/no recorded remote origin/i);
    expect(harness.delivered).toHaveLength(0);
  });

  it('refuses when branch RBAC denies the caller prompt access to the origin', async () => {
    const { delegated } = await reproduceCompletedOneShotDelegation(harness);

    // Same relationship, different caller: a member with no grant on branch A.
    // `ensureCanPromptTargetSession` here is the real helper resolving real
    // capability policy against the real database.
    const tools = await harness.tools(delegated.session_id, harness.strangerId);
    const thrown = await tools
      .agor_session_relationships_report({ message: 'should be forbidden' })
      .then(() => null)
      .catch((error: Error) => error);

    // Assert the outcome that matters before the shape of the refusal.
    expect(harness.delivered.map((d) => d.sessionId)).toEqual([]);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/Cannot prompt session|Collaborator access/i);
  });
});

describe('agor_session_relationships_report failure-closed cases', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  it('refuses to deliver into an archived origin instead of resurrecting it', async () => {
    const { orchestrator, delegated } = await reproduceCompletedOneShotDelegation(harness);
    await harness.sessionRepo.update(orchestrator.session_id, {
      archived: true,
      archived_reason: 'manual',
    });

    const tools = await harness.tools(delegated.session_id);
    const result = await tools.agor_session_relationships_report({ message: 'too late' });

    expect(harness.delivered.map((d) => d.sessionId)).toEqual([]);
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/archived/i);
    // The origin stayed archived — the prompt route's auto-unarchive was never reached.
    const after = await harness.sessionRepo.findById(orchestrator.session_id);
    expect(after?.archived).toBe(true);
  });

  it('refuses with a clear reason when the origin session is unreachable', async () => {
    const { orchestrator, delegated } = await reproduceCompletedOneShotDelegation(harness);
    // The relationship row still names the origin, but the origin can no
    // longer be served to this caller.
    harness.deletedSessionIds.add(orchestrator.session_id);

    const tools = await harness.tools(delegated.session_id);
    const result = await tools.agor_session_relationships_report({ message: 'anyone?' });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/could not be loaded/i);
    expect(harness.delivered).toHaveLength(0);
  });

  it('refuses after the relationship is deleted, and orientation stops advertising it', async () => {
    const { orchestrator, delegated, relationship } =
      await reproduceCompletedOneShotDelegation(harness);

    // How a remote_create row actually disappears in production: the schema
    // cascades it away when either endpoint session is deleted.
    await harness.sessionRepo.delete(orchestrator.session_id);
    await expect(harness.relationshipRepo.get(relationship.relationship_id)).rejects.toThrow();

    const tools = await harness.tools(delegated.session_id);
    const context = parse(
      await tools.agor_sessions_get_current_context({ includeSiblings: false })
    );
    expect(context.remote_origins).toBeUndefined();

    const result = await tools.agor_session_relationships_report({ message: 'orphaned now' });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/no recorded remote origin/i);
    expect(harness.delivered).toHaveLength(0);
  });

  it('still delivers when the callback is disabled — disabled means no AUTOMATIC callback', async () => {
    const { orchestrator, delegated, relationship } =
      await reproduceCompletedOneShotDelegation(harness);
    expect(relationship.callback_enabled).toBe(false);

    const tools = await harness.tools(delegated.session_id);
    const result = parse(
      await tools.agor_session_relationships_report({ message: 'explicit follow-up' })
    );

    expect(result.success).toBe(true);
    expect(harness.delivered.map((d) => d.sessionId)).toEqual([orchestrator.session_id]);
  });

  it('requires relationshipId when several origins exist, and delivers nothing until given one', async () => {
    const { delegated, orchestrator } = await reproduceCompletedOneShotDelegation(harness);
    const secondOrigin = await harness.makeSession(harness.branchA, 'Second orchestrator');
    const secondRelationship = await harness.relationshipRepo.create({
      source_session_id: secondOrigin.session_id,
      target_session_id: delegated.session_id,
      relationship_type: 'remote_create',
      created_by: harness.ownerId,
      callback_enabled: false,
      callback_session_id: secondOrigin.session_id,
    });

    const tools = await harness.tools(delegated.session_id);
    const ambiguous = await tools.agor_session_relationships_report({ message: 'which one?' });
    // Guessing an origin is the failure mode; assert nothing was guessed at.
    expect(harness.delivered.map((d) => d.sessionId)).toEqual([]);
    expect(ambiguous.isError).toBe(true);
    expect(parse(ambiguous).error).toMatch(/more than one remote origin/i);

    const chosen = parse(
      await tools.agor_session_relationships_report({
        message: 'to the second one',
        relationshipId: secondRelationship.relationship_id,
      })
    );
    expect(chosen.delivered_to_session_id).toBe(secondOrigin.session_id);
    expect(harness.delivered.map((d) => d.sessionId)).toEqual([secondOrigin.session_id]);
    expect(harness.delivered.map((d) => d.sessionId)).not.toContain(orchestrator.session_id);
  });
});
