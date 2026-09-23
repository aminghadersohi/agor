/**
 * Tests for name-based teammate addressing on `agor_sessions_prompt`.
 *
 * Two layers:
 *   1. `resolveTeammateName` / `resolveTeammateSession` — the resolution rule
 *      itself: slug vs displayName, case folding, ambiguity, no-session.
 *   2. The `agor_sessions_prompt` wiring — that a name reaches the right
 *      session, defaults to `btw`, and that passing `sessionId` still behaves
 *      exactly as it did before this feature existed.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

const findTeammateBranches = vi.hoisted(() => vi.fn());

vi.mock('../resolve-ids.js', () => ({
  resolveBoardId: async (_ctx: unknown, id: string) => id,
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveBranchId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
  resolveTaskId: async (_ctx: unknown, id: string) => id,
}));

vi.mock('../../utils/branch-authorization.js', () => ({
  ensureCanPromptTargetSession: vi.fn(async () => undefined),
  isSuperAdmin: (role: string | undefined, allow: boolean) => allow && role === 'superadmin',
}));

vi.mock('@agor/core/db', () => ({
  enqueueAfterTenantDatabaseCommit: () => false,
  getCurrentTenantId: () => undefined,
  runWithTenantDatabaseTransaction: async (
    _db: unknown,
    _tenantId: unknown,
    work: (db: unknown) => Promise<unknown>
  ) => work({}),
  BranchRepository: class FakeBranchRepository {
    findTeammateBranches = findTeammateBranches;
  },
  SessionRelationshipRepository: class FakeSessionRelationshipRepository {},
  TaskRepository: class FakeTaskRepository {},
  shortId: (id: string) => id,
}));

vi.mock('../../services/tenant-authorization-fence.js', () => ({
  lockTenantAuthorizationFence: vi.fn(async () => undefined),
  resolveCurrentTenantAuthorityActor: vi.fn(async () => ({
    service: false,
    user_id: 'user-1',
    role: 'member',
  })),
}));

vi.mock('../../termination-coordinator.js', () => ({
  requestExecutorTermination: vi.fn(),
}));

type ServiceStub = Record<string, (...args: never[]) => unknown>;

function makeFakeApp(services: Record<string, ServiceStub>, config: Record<string, unknown> = {}) {
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
    service: (name: string) => {
      const svc = services[name];
      if (!svc) throw new Error(`Unexpected service call: ${name}`);
      return svc;
    },
  };
}

/** Minimal teammate branch shaped the way `findTeammateBranches` returns them. */
function teammateBranch(
  name: string,
  displayName?: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    branch_id: `branch-${name}`,
    name,
    archived: false,
    custom_context: displayName ? { teammate: { kind: 'teammate', displayName } } : undefined,
    ...overrides,
  };
}

function teammateSession(id: string, branchId: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: id,
    branch_id: branchId,
    agentic_tool: 'claude-code',
    status: 'idle',
    archived: false,
    ...overrides,
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

type CapturedTool = { cfg: { inputSchema?: z.ZodType }; cb: ToolHandler };

async function captureTool(
  ctx: { app: unknown; userId: string; sessionId?: string; role?: string },
  toolName: string
): Promise<CapturedTool> {
  const { registerSessionTools } = await import('./sessions.js');
  let captured: CapturedTool | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) captured = { cfg: cfg as CapturedTool['cfg'], cb };
    },
  } as unknown as McpServer;

  registerSessionTools(fakeServer, {
    app: ctx.app as never,
    db: {} as never,
    userId: ctx.userId as never,
    sessionId: ctx.sessionId as never,
    authenticatedUser: { user_id: ctx.userId, role: ctx.role ?? 'member' } as never,
    baseServiceParams: {} as never,
  });

  if (!captured) throw new Error(`Tool ${toolName} was not registered`);
  return captured;
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTeammateName', () => {
  async function resolve(name: string, branches: unknown[], role = 'member') {
    findTeammateBranches.mockResolvedValue(branches);
    const { resolveTeammateName } = await import('./teammate-addressing.js');
    const app = makeFakeApp({});
    return resolveTeammateName(
      {
        app: app as never,
        db: {} as never,
        userId: 'user-1' as never,
        authenticatedUser: { user_id: 'user-1', role } as never,
        baseServiceParams: {} as never,
      },
      name
    );
  }

  it('matches a branch slug exactly', async () => {
    const result = await resolve('front-desk', [
      teammateBranch('front-desk', 'Front Desk'),
      teammateBranch('archivist', 'Archivist'),
    ]);
    expect(result.outcome).toBe('matched');
    expect(result.outcome === 'matched' && result.branch.name).toBe('front-desk');
  });

  it('matches a slug case-insensitively and ignores surrounding whitespace', async () => {
    const result = await resolve('  FRONT-DESK  ', [teammateBranch('front-desk', 'Front Desk')]);
    expect(result.outcome).toBe('matched');
  });

  it('matches the teammate displayName, not just the slug', async () => {
    const result = await resolve('Front Desk', [
      teammateBranch('fd-2', 'Front Desk'),
      teammateBranch('archivist', 'Archivist'),
    ]);
    expect(result.outcome).toBe('matched');
    expect(result.outcome === 'matched' && result.branch.branch_id).toBe('branch-fd-2');
  });

  it('matches displayName case-insensitively', async () => {
    const result = await resolve('front desk', [teammateBranch('fd-2', 'Front Desk')]);
    expect(result.outcome).toBe('matched');
    expect(result.outcome === 'matched' && result.branch.branch_id).toBe('branch-fd-2');
  });

  it('reads legacy custom_context.assistant teammate config', async () => {
    const legacy = teammateBranch('legacy', undefined, {
      custom_context: { assistant: { kind: 'assistant', displayName: 'Legacy Helper' } },
    });
    const result = await resolve('Legacy Helper', [legacy]);
    expect(result.outcome).toBe('matched');
    expect(result.outcome === 'matched' && result.branch.branch_id).toBe('branch-legacy');
  });

  it('reports ambiguity with every candidate rather than picking one', async () => {
    const result = await resolve('helper', [
      teammateBranch('helper', 'Helper One'),
      teammateBranch('helper-2', 'Helper'),
    ]);
    expect(result.outcome).toBe('ambiguous');
    if (result.outcome !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.branch_id).sort()).toEqual([
      'branch-helper',
      'branch-helper-2',
    ]);
  });

  it('treats a slug match and a displayName match on different branches as ambiguous', async () => {
    const result = await resolve('archivist', [
      teammateBranch('archivist', 'The Filer'),
      teammateBranch('other', 'Archivist'),
    ]);
    expect(result.outcome).toBe('ambiguous');
  });

  it('returns not_found with the names the caller could have meant', async () => {
    const result = await resolve('nobody', [teammateBranch('front-desk', 'Front Desk')]);
    expect(result.outcome).toBe('not_found');
    if (result.outcome !== 'not_found') throw new Error('expected not_found');
    expect(result.scanTruncated).toBe(false);
    expect(result.known).toEqual([
      { branch_id: 'branch-front-desk', name: 'front-desk', display_name: 'Front Desk' },
    ]);
  });

  it('falls back to the slug as display_name when no teammate config is present', async () => {
    const result = await resolve('nobody', [teammateBranch('bare')]);
    if (result.outcome !== 'not_found') throw new Error('expected not_found');
    expect(result.known[0].display_name).toBe('bare');
  });

  it('flags a truncated scan instead of claiming the teammate does not exist', async () => {
    const { TEAMMATE_NAME_SCAN_LIMIT } = await import('./teammate-addressing.js');
    const many = Array.from({ length: TEAMMATE_NAME_SCAN_LIMIT + 1 }, (_, i) =>
      teammateBranch(`mate-${i}`)
    );
    const result = await resolve('nobody', many);
    if (result.outcome !== 'not_found') throw new Error('expected not_found');
    expect(result.scanTruncated).toBe(true);
  });

  it('scopes discovery to teammates the caller may prompt', async () => {
    await resolve('front-desk', [teammateBranch('front-desk')]);
    expect(findTeammateBranches).toHaveBeenCalledWith(
      expect.objectContaining({
        archived: false,
        userId: 'user-1',
        minimumPermission: 'session',
      })
    );
  });
});

describe('resolveTeammateSession', () => {
  async function resolveSession(sessions: unknown[]) {
    const find = vi.fn(async () => ({ data: sessions, total: sessions.length }));
    const app = makeFakeApp({ sessions: { find } });
    const { resolveTeammateSession } = await import('./teammate-addressing.js');
    const result = await resolveTeammateSession(
      {
        app: app as never,
        db: {} as never,
        userId: 'user-1' as never,
        authenticatedUser: { user_id: 'user-1', role: 'member' } as never,
        baseServiceParams: {} as never,
      },
      teammateBranch('front-desk', 'Front Desk') as never
    );
    return { result, find };
  }

  it('asks for the single most recently updated non-archived session in the branch', async () => {
    const { find } = await resolveSession([teammateSession('sess-warm', 'branch-front-desk')]);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: {
          branch_id: 'branch-front-desk',
          archived: false,
          $sort: { updated_at: -1 },
          $limit: 1,
        },
      })
    );
  });

  it('returns the warm session when one exists', async () => {
    const { result } = await resolveSession([teammateSession('sess-warm', 'branch-front-desk')]);
    expect(result.outcome).toBe('session');
    expect(result.outcome === 'session' && result.session.session_id).toBe('sess-warm');
  });

  it('reports no_session when the teammate has none', async () => {
    const { result } = await resolveSession([]);
    expect(result.outcome).toBe('no_session');
  });

  it('refuses a session from a different branch instead of messaging it', async () => {
    await expect(
      resolveSession([teammateSession('sess-x', 'branch-someone-else')])
    ).rejects.toThrow(/outside the requested branch/i);
  });
});

describe('agor_sessions_prompt teammate addressing', () => {
  /** Wire a prompt tool whose teammate lookups resolve to `sessions`. */
  async function setup(opts: { branches: unknown[]; sessions?: unknown[]; sessionId?: string }) {
    findTeammateBranches.mockResolvedValue(opts.branches);
    const sessionsFind = vi.fn(async () => ({
      data: opts.sessions ?? [],
      total: (opts.sessions ?? []).length,
    }));
    const sessionsGet = vi.fn(async (id: string) =>
      teammateSession(id, 'branch-front-desk', { permission_config: { mode: 'default' } })
    );
    const sessionsPatch = vi.fn(async (id: string) => teammateSession(id, 'branch-front-desk'));
    const fork = vi.fn(async (id: string) => teammateSession(`${id}-fork`, 'branch-front-desk'));
    const promptCreate = vi.fn(async () => ({ task_id: 'task-1', status: 'running' }));

    const app = makeFakeApp({
      sessions: { find: sessionsFind, get: sessionsGet, patch: sessionsPatch, fork },
      '/sessions/:id/prompt': { create: promptCreate },
    });
    // `fork` lives on the service impl the tool casts to, same object here.
    const tool = await captureTool(
      { app, userId: 'user-1', sessionId: opts.sessionId ?? 'sess-caller' },
      'agor_sessions_prompt'
    );
    return { tool, sessionsFind, sessionsGet, sessionsPatch, fork, promptCreate };
  }

  it('defaults to btw so the target keeps working and the reply carries warm context', async () => {
    const { tool, fork, sessionsPatch, promptCreate } = await setup({
      branches: [teammateBranch('front-desk', 'Front Desk')],
      sessions: [teammateSession('sess-warm', 'branch-front-desk')],
    });

    const result = await tool.cb({ teammate: 'Front Desk', prompt: 'what are you on?' });
    const parsed = parse(result);

    // Forked off the teammate's warm session, not a fresh cold one.
    expect(fork).toHaveBeenCalledWith('sess-warm', expect.anything(), expect.anything());
    // btw metadata: ephemeral, auto-archiving, callback home to the caller.
    const patch = sessionsPatch.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.fork_origin).toBe('btw');
    expect(patch.auto_archive).toBe('after_completion');
    expect((patch.callback_config as Record<string, unknown>).callback_session_id).toBe(
      'sess-caller'
    );
    expect(promptCreate).toHaveBeenCalled();
    expect(parsed.addressed).toEqual({
      resolved_by: 'teammate_name',
      teammate: {
        branch_id: 'branch-front-desk',
        name: 'front-desk',
        display_name: 'Front Desk',
      },
      session_id: 'sess-warm',
      mode: 'btw',
    });
  });

  it('lets the caller override the default mode', async () => {
    const { tool, fork, promptCreate } = await setup({
      branches: [teammateBranch('front-desk', 'Front Desk')],
      sessions: [teammateSession('sess-warm', 'branch-front-desk')],
    });

    const result = await tool.cb({
      teammate: 'front-desk',
      prompt: 'take this over',
      mode: 'continue',
    });

    expect(fork).not.toHaveBeenCalled();
    expect(promptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'take this over' }),
      expect.objectContaining({ route: { id: 'sess-warm' } })
    );
    expect(parse(result).addressed.mode).toBe('continue');
  });

  it('errors with the candidates when a name is ambiguous, and sends nothing', async () => {
    const { tool, promptCreate, fork } = await setup({
      branches: [teammateBranch('helper', 'Helper One'), teammateBranch('helper-2', 'Helper')],
    });

    const result = await tool.cb({ teammate: 'helper', prompt: 'hi' });
    const parsed = parse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/matches 2 teammates/i);
    expect(parsed.candidates.map((c: { branch_id: string }) => c.branch_id).sort()).toEqual([
      'branch-helper',
      'branch-helper-2',
    ]);
    expect(promptCreate).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it('errors when the name matches nothing', async () => {
    const { tool, promptCreate } = await setup({
      branches: [teammateBranch('front-desk', 'Front Desk')],
    });

    const result = await tool.cb({ teammate: 'ghost', prompt: 'hi' });
    const parsed = parse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/No teammate matches "ghost"/);
    expect(parsed.known_teammates).toHaveLength(1);
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('reports needs_session with the branch when the teammate has no session', async () => {
    const { tool, promptCreate, fork } = await setup({
      branches: [teammateBranch('front-desk', 'Front Desk')],
      sessions: [],
    });

    const result = await tool.cb({ teammate: 'front-desk', prompt: 'hi' });
    const parsed = parse(result);

    expect(result.isError).toBe(true);
    expect(parsed.needs_session).toBe(true);
    expect(parsed.branch_id).toBe('branch-front-desk');
    expect(parsed.how_to_fix).toMatch(/agor_sessions_create/);
    // The point of the rule: we never silently cold-start on the caller's behalf.
    expect(promptCreate).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it('rejects supplying both sessionId and teammate', async () => {
    const { tool, promptCreate } = await setup({ branches: [] });
    const result = await tool.cb({ sessionId: 'sess-1', teammate: 'front-desk', prompt: 'hi' });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/exactly one of sessionId or teammate, not both/i);
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('rejects supplying neither sessionId nor teammate', async () => {
    const { tool, promptCreate } = await setup({ branches: [] });
    const result = await tool.cb({ prompt: 'hi' });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/exactly one of sessionId or teammate/i);
    expect(promptCreate).not.toHaveBeenCalled();
  });
});

describe('agor_sessions_prompt sessionId behavior is unchanged', () => {
  async function setup() {
    const sessionsFind = vi.fn(async () => ({ data: [], total: 0 }));
    const sessionsGet = vi.fn(async (id: string) =>
      teammateSession(id, 'branch-other', { permission_config: { mode: 'default' } })
    );
    const sessionsPatch = vi.fn(async (id: string) => teammateSession(id, 'branch-other'));
    const fork = vi.fn(async (id: string) => teammateSession(`${id}-fork`, 'branch-other'));
    const promptCreate = vi.fn(async () => ({ task_id: 'task-9', status: 'running' }));
    const app = makeFakeApp({
      sessions: { find: sessionsFind, get: sessionsGet, patch: sessionsPatch, fork },
      '/sessions/:id/prompt': { create: promptCreate },
    });
    const tool = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-caller' },
      'agor_sessions_prompt'
    );
    return { tool, promptCreate, fork, sessionsFind };
  }

  it('continue mode prompts the given session and does no name resolution', async () => {
    const { tool, promptCreate, sessionsFind } = await setup();

    const result = await tool.cb({
      sessionId: 'sess-target',
      prompt: 'carry on',
      mode: 'continue',
    });

    expect(promptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'carry on' }),
      expect.objectContaining({ route: { id: 'sess-target' } })
    );
    // No teammate scan and no branch session lookup for an explicit sessionId.
    expect(findTeammateBranches).not.toHaveBeenCalled();
    expect(sessionsFind).not.toHaveBeenCalled();
    // No `addressed` echo — that field only appears for name addressing.
    expect(parse(result).addressed).toBeUndefined();
    expect(parse(result).success).toBe(true);
  });

  it('btw mode on an explicit sessionId still forks that session', async () => {
    const { tool, fork } = await setup();
    await tool.cb({ sessionId: 'sess-target', prompt: 'quick q', mode: 'btw' });
    expect(fork).toHaveBeenCalledWith('sess-target', expect.anything(), expect.anything());
    expect(findTeammateBranches).not.toHaveBeenCalled();
  });

  it('still requires an explicit mode when addressing by sessionId', async () => {
    const { tool, promptCreate } = await setup();
    const result = await tool.cb({ sessionId: 'sess-target', prompt: 'carry on' });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/mode is required/i);
    expect(promptCreate).not.toHaveBeenCalled();
  });
});
