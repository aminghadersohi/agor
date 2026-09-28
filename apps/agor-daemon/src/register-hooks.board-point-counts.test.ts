import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks.js';

type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;

const BOARD_ID = '00000000-0000-7000-8000-000000000010';
const MEMBER_ID = '00000000-0000-7000-8000-000000000001';

function captureBoardGetChains() {
  const before = new Map<string, RegisteredHook[]>();
  const after = new Map<string, RegisteredHook[]>();
  const app = {
    service(path: string) {
      return {
        on() {},
        hooks(hooks: {
          before?: Record<string, RegisteredHook[]>;
          after?: Record<string, RegisteredHook[]>;
        }) {
          for (const [target, source] of [
            [before, hooks.before],
            [after, hooks.after],
          ] as const) {
            for (const [method, chain] of Object.entries(source ?? {})) {
              const key = `${path.replace(/^\//, '')}.${method}`;
              target.set(key, [...(target.get(key) ?? []), ...chain]);
            }
          }
        },
      };
    },
    use() {},
    publish() {},
  };
  const board = { board_id: BOARD_ID, objects: {} };
  const boardRepository = {
    findBySlugOrId: vi.fn(async () => ({ ...board })),
    canViewResolved: vi.fn(async () => true),
  };
  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'board-counts-hook-test' },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'board-counts-hook-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    boardRepository: boardRepository as unknown as RegisterHooksContext['boardRepository'],
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });
  return { before, after };
}

function getContext(params: Record<string, unknown>) {
  const attachCallerCounts = vi.fn(async (board: Record<string, unknown>) => ({
    ...board,
    worktree_count: 2,
    total_session_count: 3,
    active_session_count: 1,
  }));
  const context = {
    path: 'boards',
    method: 'get',
    id: BOARD_ID,
    params,
    service: { attachCallerCounts },
  } as unknown as HookContext;
  return { context, attachCallerCounts };
}

async function runGet(
  chains: ReturnType<typeof captureBoardGetChains>,
  context: HookContext,
  result: unknown
) {
  for (const hook of chains.before.get('boards.all') ?? []) await hook(context);
  for (const hook of chains.before.get('boards.get') ?? []) await hook(context);
  (context as { result?: unknown }).result = result;
  // Only the counts hook matters here; the artifact filter needs a real DB.
  const [attachCounts] = chains.after.get('boards.get') ?? [];
  await attachCounts?.(context);
}

describe('boards.get caller-scoped counts', () => {
  it('attaches counts scoped to the regular caller’s branch visibility', async () => {
    const chains = captureBoardGetChains();
    const { context, attachCallerCounts } = getContext({
      provider: 'mcp',
      user: { user_id: MEMBER_ID, role: 'member' },
    });

    await runGet(chains, context, { board_id: BOARD_ID, worktree_count: 0 });

    expect(attachCallerCounts).toHaveBeenCalledWith(
      expect.objectContaining({ board_id: BOARD_ID }),
      MEMBER_ID
    );
    expect(context.result).toMatchObject({
      worktree_count: 2,
      total_session_count: 3,
      active_session_count: 1,
    });
  });

  it('counts unscoped for a superadmin, matching the list read', async () => {
    const chains = captureBoardGetChains();
    const { context, attachCallerCounts } = getContext({
      provider: 'rest',
      user: { user_id: MEMBER_ID, role: 'superadmin' },
    });

    await runGet(chains, context, { board_id: BOARD_ID });

    expect(attachCallerCounts).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('skips the aggregate for internal reads', async () => {
    const chains = captureBoardGetChains();
    const { context, attachCallerCounts } = getContext({});

    await runGet(chains, context, { board_id: BOARD_ID, worktree_count: 0 });

    expect(attachCallerCounts).not.toHaveBeenCalled();
    expect(context.result).toMatchObject({ worktree_count: 0 });
  });
});
