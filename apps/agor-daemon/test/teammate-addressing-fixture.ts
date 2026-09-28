/**
 * Real-database fixture and shared suite for name-based teammate addressing.
 *
 * `teammate-addressing.test.ts` proves the resolution *rule* with
 * `findTeammateBranches` stubbed. That leaves the part of the feature that is
 * actually dialect-specific unproven: teammate discovery is a JSON predicate
 * over `branches.data -> custom_context`, and `jsonExtract` emits
 * `json_extract(col, '$.a.b')` on SQLite but `col->'a'->>'b'` on PostgreSQL.
 * A mocked repository returns hand-built rows either way, so it cannot tell a
 * working predicate from one that silently matches nothing.
 *
 * This module runs the same assertions against a real migrated database, and
 * is instantiated once per dialect (`*.integration.test.ts` for SQLite,
 * `*.postgres.test.ts` for PostgreSQL) so both engines are covered by one set
 * of expectations rather than two that can drift.
 *
 * What is real here: migrations, the branch/session/RBAC schema, the discovery
 * SQL, `SessionsService.find` recency ordering, and the registered
 * `agor_sessions_prompt` handler. Only the executor boundary
 * (`/sessions/:id/prompt`) is stubbed — nothing in this feature reaches it.
 */

import {
  BoardRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import {
  type Branch,
  type BranchID,
  type HookContext,
  type Session,
  type SessionID,
  SessionStatus,
  type TenantID,
  type User,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { generateId } from '../../../packages/core/src/lib/ids';
import type { McpContext } from '../src/mcp/server';
import { tenantScopedToolProxy } from '../src/mcp/tenant-scope';
import { registerSessionTools } from '../src/mcp/tools/sessions';
import { resolveTeammateName, resolveTeammateSession } from '../src/mcp/tools/teammate-addressing';
import { SessionsService } from '../src/services/sessions';
import { ensureCanView, loadSessionBranch } from '../src/utils/branch-authorization';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** `branch_unique_id` is a port-allocation seed and must not repeat. */
let branchUnique = (Date.now() % 900_000) + 1000;

export interface TeammateSeedOptions {
  /** Branch slug, e.g. "front-desk". */
  name: string;
  /** `custom_context.teammate.displayName`; omitted entirely when undefined. */
  displayName?: string;
  archived?: boolean;
  /** Seed a non-teammate branch (no `custom_context` marker) instead. */
  plainBranch?: boolean;
}

export interface SessionSeedOptions {
  branchId: BranchID;
  /** Written to `sessions.updated_at`; the column recency ordering reads. */
  updatedAt: Date;
  archived?: boolean;
  /** Pin the UUID so tie-breaker direction can be asserted, not guessed. */
  sessionId?: SessionID;
}

export interface TeammateAddressingFixture {
  db: Database;
  tenantId: TenantID;
  owner: User;
  outsider: User;
  boardId: string;
  promptService: ReturnType<typeof vi.fn>;
  createTeammate(options: TeammateSeedOptions): Promise<Branch>;
  createSession(options: SessionSeedOptions): Promise<Session>;
  contextFor(user?: User): McpContext;
  handlersFor(user?: User): Record<string, Handler>;
  /** Parse the JSON payload an MCP tool handler returned. */
  payloadOf(result: Awaited<ReturnType<Handler>>): Record<string, unknown>;
}

/**
 * Seed one tenant with a board, a repo, an owning member and an unrelated
 * member, and wire the real `sessions` service plus the registered MCP tools
 * over the supplied database handle.
 */
export async function teammateAddressingFixture(
  rawDb: Database,
  tenantId: TenantID = 'default' as TenantID
): Promise<TeammateAddressingFixture> {
  const db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });

  const seeded = await runWithTenantDatabaseScope(db, tenantId, async () => {
    const users = new UsersRepository(db);
    // Deliberately `member`, not `superadmin`: that makes
    // `shouldScopeToUser` true, so discovery runs the RBAC-scoped SQL branch
    // (`sessionBranchAccessCondition`) rather than the unscoped one.
    const owner = await users.create({
      email: `teammate-owner-${generateId()}@example.invalid`,
      name: 'Teammate Owner',
      role: 'member',
    });
    const outsider = await users.create({
      email: `teammate-outsider-${generateId()}@example.invalid`,
      name: 'Teammate Outsider',
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      slug: `teammate-addressing-${generateId()}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/teammate-addressing.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const board = await new BoardRepository(db).create({
      name: 'Teammate addressing',
      created_by: owner.user_id,
      access_mode: 'private',
    });
    return { owner, outsider, repo, board };
  });

  const app = feathers();
  app.set('config', { execution: { unix_user_mode: 'simple' } });
  const sessionsService = new SessionsService(db, app as unknown as McpContext['app']);
  app.use('sessions', sessionsService as never);
  app.use('branches', { get: (id: string) => new BranchRepository(db).findById(id) });
  app.use('users', { get: (id: string) => new UsersRepository(db).findById(id) });
  for (const path of ['sessions', 'branches', 'users']) {
    app.service(path).hooks({
      around: {
        all: [
          async (context: HookContext, next) => {
            await runWithTenantDatabaseScope(
              db,
              context.params.tenant?.tenant_id ?? tenantId,
              next
            );
          },
        ],
      },
    });
  }
  app.service('sessions').hooks({
    before: {
      get: [
        loadSessionBranch(new SessionRepository(db), new BranchRepository(db)),
        ensureCanView(),
      ],
    },
  });

  // The executor boundary. Name addressing never reaches it; stubbing keeps
  // the suite to the DB + routing surface it is meant to prove.
  const promptService = vi.fn(async () => ({ task_id: generateId(), status: 'queued' }));
  app.use('/sessions/:id/prompt', { create: promptService });

  async function createTeammate(options: TeammateSeedOptions): Promise<Branch> {
    return runWithTenantDatabaseScope(db, tenantId, () =>
      new BranchRepository(db).create({
        repo_id: seeded.repo.repo_id,
        board_id: seeded.board.board_id,
        permission_binding: 'inherit',
        created_by: seeded.owner.user_id,
        name: options.name,
        ref: 'main',
        branch_unique_id: branchUnique++,
        path: `/tmp/${generateId()}`,
        archived: options.archived ?? false,
        ...(options.plainBranch
          ? {}
          : {
              custom_context: {
                teammate: {
                  kind: 'teammate',
                  ...(options.displayName === undefined
                    ? {}
                    : { displayName: options.displayName }),
                },
              },
            }),
      })
    );
  }

  async function createSession(options: SessionSeedOptions): Promise<Session> {
    return runWithTenantDatabaseScope(db, tenantId, () =>
      new SessionRepository(db).create({
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
        branch_id: options.branchId,
        created_by: seeded.owner.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
        archived: options.archived ?? false,
        // `sessionToInsert` maps `last_updated` onto the `updated_at` column.
        last_updated: options.updatedAt.toISOString(),
        model_config: { mode: 'alias', model: 'sonnet', updated_at: new Date().toISOString() },
        tasks: [],
        genealogy: { children: [] },
      })
    );
  }

  function contextFor(user: User = seeded.owner): McpContext {
    return {
      app,
      db,
      // A caller session id is required for `btw` (it is the callback target).
      sessionId: 'caller-session' as SessionID,
      userId: user.user_id,
      authenticatedUser: user,
      baseServiceParams: {
        user,
        provider: 'mcp',
        authenticated: true,
        tenant: { tenant_id: tenantId, source: 'explicit' },
      },
    } as unknown as McpContext;
  }

  function handlersFor(user: User = seeded.owner): Record<string, Handler> {
    const ctx = contextFor(user);
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    registerSessionTools(tenantScopedToolProxy(server, ctx), ctx);
    return handlers;
  }

  return {
    db,
    tenantId,
    owner: seeded.owner,
    outsider: seeded.outsider,
    boardId: seeded.board.board_id,
    promptService,
    createTeammate,
    createSession,
    contextFor,
    handlersFor,
    payloadOf: (result) => JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

/**
 * Name resolution: the teammate-discovery SQL, the JSON round trip, folding
 * and ambiguity. Touches `branches` only, so it runs on every engine.
 *
 * `setup` hands back a fresh fixture per test so one test's teammates cannot
 * leak into the next test's discovery scan.
 */
export function teammateNameResolutionSuite(setup: () => Promise<TeammateAddressingFixture>): void {
  it('resolves a teammate by branch slug through the real discovery SQL', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });

    const resolution = await resolveTeammateName(f.contextFor(), 'front-desk');

    expect(resolution.outcome).toBe('matched');
    expect(resolution).toMatchObject({ branch: { branch_id: branch.branch_id } });
  });

  it('resolves a teammate by displayName read back out of custom_context JSON', async () => {
    const f = await setup();
    // Slug and display name are deliberately unrelated: a match here can only
    // come from JSON that survived the write/read round trip, not from the
    // branch name column.
    const branch = await f.createTeammate({ name: 'fd-alpha', displayName: 'Front Desk' });

    const resolution = await resolveTeammateName(f.contextFor(), 'Front Desk');

    expect(resolution.outcome).toBe('matched');
    expect(resolution).toMatchObject({ branch: { branch_id: branch.branch_id } });
    // Prove the JSON actually persisted rather than the row matching by luck.
    expect((resolution as { branch: Branch }).branch.custom_context?.teammate).toMatchObject({
      kind: 'teammate',
      displayName: 'Front Desk',
    });
  });

  it('matches slug and displayName case-insensitively', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'night-shift', displayName: 'Night Shift' });

    for (const name of ['NIGHT-SHIFT', 'Night-Shift', 'night shift', 'NIGHT SHIFT']) {
      const resolution = await resolveTeammateName(f.contextFor(), name);
      // "night shift" (space) is not the slug, so those two cases can only
      // land via the display name.
      expect({ name, outcome: resolution.outcome }).toEqual({ name, outcome: 'matched' });
      expect(resolution).toMatchObject({ branch: { branch_id: branch.branch_id } });
    }
  });

  it('tolerates surrounding whitespace in the addressed name', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'dispatch', displayName: 'Dispatch' });

    const resolution = await resolveTeammateName(f.contextFor(), '  Dispatch  ');

    expect(resolution).toMatchObject({
      outcome: 'matched',
      branch: { branch_id: branch.branch_id },
    });
  });

  it('refuses an ambiguous name and lists every candidate', async () => {
    const f = await setup();
    // One branch answers to "front-desk" as its slug, the other as its display
    // name. Folding is case-insensitive but not punctuation-insensitive, so
    // both sides are written with the hyphen to actually collide.
    const bySlug = await f.createTeammate({ name: 'front-desk', displayName: 'Reception' });
    const byDisplayName = await f.createTeammate({ name: 'fd-two', displayName: 'Front-Desk' });

    const resolution = await resolveTeammateName(f.contextFor(), 'front-desk');

    expect(resolution.outcome).toBe('ambiguous');
    const candidates = (resolution as { candidates: Array<{ branch_id: string }> }).candidates;
    expect(candidates.map((c) => c.branch_id).sort()).toEqual(
      [bySlug.branch_id, byDisplayName.branch_id].sort()
    );
    // Both namespaces are reported with the identity a caller can re-address by.
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'front-desk', display_name: 'Reception' }),
        expect.objectContaining({ name: 'fd-two', display_name: 'Front-Desk' }),
      ])
    );
  });

  it('reports not_found for an unknown name and lists what is addressable', async () => {
    const f = await setup();
    await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });

    const resolution = await resolveTeammateName(f.contextFor(), 'nobody-here');

    expect(resolution).toMatchObject({ outcome: 'not_found', scanTruncated: false });
    expect((resolution as { known: Array<{ name: string }> }).known).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'front-desk' })])
    );
  });

  it('does not treat a branch without a teammate marker as addressable', async () => {
    const f = await setup();
    await f.createTeammate({ name: 'plain-feature-branch', plainBranch: true });

    const resolution = await resolveTeammateName(f.contextFor(), 'plain-feature-branch');

    expect(resolution).toMatchObject({ outcome: 'not_found' });
    expect((resolution as { known: unknown[] }).known).toEqual([]);
  });

  it('does not resolve an archived teammate branch', async () => {
    const f = await setup();
    await f.createTeammate({ name: 'retired-desk', displayName: 'Retired Desk', archived: true });

    await expect(resolveTeammateName(f.contextFor(), 'Retired Desk')).resolves.toMatchObject({
      outcome: 'not_found',
    });
  });

  it('does not expose a teammate the caller has no session permission on', async () => {
    const f = await setup();
    await f.createTeammate({ name: 'private-desk', displayName: 'Private Desk' });

    // Owner sees it; an unrelated member of the same tenant does not.
    await expect(resolveTeammateName(f.contextFor(f.owner), 'Private Desk')).resolves.toMatchObject(
      { outcome: 'matched' }
    );
    await expect(
      resolveTeammateName(f.contextFor(f.outsider), 'Private Desk')
    ).resolves.toMatchObject({ outcome: 'not_found' });
  });
}

/**
 * Session routing: which session inside a resolved teammate branch gets the
 * prompt, and the `agor_sessions_prompt` wiring around it.
 *
 * Separated from name resolution because these read the `sessions` table,
 * which the SQLite caller currently cannot do — see the note in
 * `teammate-addressing.integration.test.ts`.
 */
export function teammateSessionRoutingSuite(setup: () => Promise<TeammateAddressingFixture>): void {
  it('picks the most recently updated non-archived session in the branch', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
    await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newest = await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const target = await resolveTeammateSession(f.contextFor(), branch);

    expect(target).toMatchObject({
      outcome: 'session',
      session: { session_id: newest.session_id },
    });
  });

  it('skips an archived session even when it is the most recently updated', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
    const live = await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      archived: true,
    });

    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      outcome: 'session',
      session: { session_id: live.session_id },
    });
  });

  it('breaks an updated_at tie on the lower session_id, stably across repeats', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
    const tiedAt = new Date('2026-04-01T00:00:00.000Z');
    // Two ids sharing every byte except the last, so their relative order is
    // known but neither encodes a different creation time. The shared prefix
    // is randomized because `sessions_pkey` is global, not per-tenant, and
    // this suite reuses one PostgreSQL database across runs.
    const stem = generateId().slice(0, -1);
    const lower = `${stem}0` as SessionID;
    const higher = `${stem}1` as SessionID;
    // Insert the higher ID first so physical row order disagrees with the
    // expected answer — a missing tie-breaker would surface as the wrong row.
    await f.createSession({ branchId: branch.branch_id, updatedAt: tiedAt, sessionId: higher });
    await f.createSession({ branchId: branch.branch_id, updatedAt: tiedAt, sessionId: lower });

    for (let attempt = 0; attempt < 3; attempt++) {
      // `findPage` orders `desc(updated_at), asc(session_id)`, so a tie
      // resolves to the LOWEST id — which for UUIDv7 is the older session.
      await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
        outcome: 'session',
        session: { session_id: lower },
      });
    }
  });

  it('reports no_session for a teammate branch with nothing to talk to', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'fresh-desk', displayName: 'Fresh Desk' });

    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      outcome: 'no_session',
      branch: { branch_id: branch.branch_id },
    });
  });

  it('routes agor_sessions_prompt by teammate name to that teammate’s warm session', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
    // A second teammate with a session, so "reached the right one" is a real
    // claim rather than the only available row.
    const other = await f.createTeammate({ name: 'back-office', displayName: 'Back Office' });
    await f.createSession({
      branchId: other.branch_id,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const warm = await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const result = await f.handlersFor().agor_sessions_prompt({
      teammate: 'Front Desk',
      prompt: 'Who is on the desk today?',
    });
    const payload = f.payloadOf(result);

    expect(result.isError).toBeFalsy();
    expect(payload.addressed).toMatchObject({
      resolved_by: 'teammate_name',
      // Defaults to btw when addressing by name.
      mode: 'btw',
      session_id: warm.session_id,
      teammate: { branch_id: branch.branch_id, name: 'front-desk', display_name: 'Front Desk' },
    });
    // btw forks the warm session rather than prompting it directly, so the
    // conversation it inherits is the one we resolved.
    expect(payload.session).toMatchObject({
      branch_id: branch.branch_id,
      genealogy: { forked_from_session_id: warm.session_id },
    });
    expect(payload.note).toMatch(/btw/);
    expect(f.promptService).toHaveBeenCalledTimes(1);
  });

  it('returns needs_session with the branch id when the teammate has no session', async () => {
    const f = await setup();
    const branch = await f.createTeammate({ name: 'fresh-desk', displayName: 'Fresh Desk' });

    const result = await f.handlersFor().agor_sessions_prompt({
      teammate: 'fresh-desk',
      prompt: 'Anyone home?',
    });

    expect(result.isError).toBe(true);
    expect(f.payloadOf(result)).toMatchObject({
      needs_session: true,
      branch_id: branch.branch_id,
      teammate: { name: 'fresh-desk', display_name: 'Fresh Desk' },
    });
    expect(f.promptService).not.toHaveBeenCalled();
  });

  it('returns the ambiguity error from the tool without prompting anyone', async () => {
    const f = await setup();
    await f.createTeammate({ name: 'front-desk', displayName: 'Reception' });
    await f.createTeammate({ name: 'fd-two', displayName: 'Front-Desk' });

    const result = await f.handlersFor().agor_sessions_prompt({
      teammate: 'FRONT-DESK',
      prompt: 'Ambiguous on purpose',
    });

    expect(result.isError).toBe(true);
    const payload = f.payloadOf(result);
    expect(payload.error).toMatch(/matches 2 teammates/);
    expect(payload.candidates).toHaveLength(2);
    expect(f.promptService).not.toHaveBeenCalled();
  });
}
