import { BoardObjectRepository, CardRepository, ZoneWorkflowRepository } from '@agor/core/db';
import type { HookContext } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks.js';

type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;

function captureChains(canView: boolean, canMutate: boolean) {
  const chains = new Map<string, RegisteredHook[]>();
  const app = {
    service(path: string) {
      return {
        on() {},
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          for (const [method, chain] of Object.entries(hooks.before ?? {})) {
            const key = `${path.replace(/^\//, '')}.${method}`;
            chains.set(key, [...(chains.get(key) ?? []), ...chain]);
          }
        },
      };
    },
    use() {},
    publish() {},
  };
  const boardRepository = {
    canView: vi.fn(async () => canView),
    canMutate: vi.fn(async () => canMutate),
  };
  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'workflow-hook-test' },
      execution: { branch_rbac: true, unix_user_mode: 'simple' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'workflow-hook-secret',
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
  return { chains, boardRepository };
}

async function runChain(chains: Map<string, RegisteredHook[]>, key: string, context: HookContext) {
  for (const hook of chains.get(`${key.split('.')[0]}.all`) ?? []) await hook(context);
  for (const hook of chains.get(key) ?? []) await hook(context);
}

afterEach(() => vi.restoreAllMocks());

describe('registered zone workflow authorization', () => {
  it('enforces the member write floor and current board mutation permission', async () => {
    const denied = captureChains(true, false);
    const createContext = (role: 'viewer' | 'member') =>
      ({
        path: 'zone-workflow-transitions',
        method: 'create',
        data: { board_id: '00000000-0000-7000-8000-000000000010' },
        params: {
          provider: 'rest',
          user: { user_id: '00000000-0000-7000-8000-000000000001', role },
        },
      }) as unknown as HookContext;

    await expect(
      runChain(denied.chains, 'zone-workflow-transitions.create', createContext('viewer'))
    ).rejects.toThrow(/member access/i);
    expect(denied.boardRepository.canMutate).not.toHaveBeenCalled();

    await expect(
      runChain(denied.chains, 'zone-workflow-transitions.create', createContext('member'))
    ).rejects.toThrow(/Board resource is unavailable/);
    expect(denied.boardRepository.canMutate).toHaveBeenCalled();

    const allowed = captureChains(true, true);
    await expect(
      runChain(allowed.chains, 'zone-workflow-transitions.create', createContext('member'))
    ).resolves.toBeUndefined();
  });

  it('binds advance permission to the transition board and every referenced entity', async () => {
    vi.spyOn(ZoneWorkflowRepository.prototype, 'findTransition').mockResolvedValue({
      board_id: '00000000-0000-7000-8000-000000000010',
    } as never);
    const branchVisibility = vi
      .spyOn(BoardObjectRepository.prototype, 'canViewBranchReference')
      .mockResolvedValue(false);
    const cardVisibility = vi
      .spyOn(CardRepository.prototype, 'findVisibleById')
      .mockResolvedValue(null);
    const { chains, boardRepository } = captureChains(true, true);
    const context = {
      path: 'zone-workflow-advances',
      method: 'create',
      data: {
        transition_id: '00000000-0000-7000-8000-000000000020',
        entities: [{ entity_type: 'branch', entity_id: '00000000-0000-7000-8000-000000000030' }],
      },
      params: {
        provider: 'rest',
        user: { user_id: '00000000-0000-7000-8000-000000000001', role: 'member' },
      },
    } as unknown as HookContext;

    await expect(runChain(chains, 'zone-workflow-advances.create', context)).rejects.toThrow(
      'Workflow entities are unavailable'
    );
    expect(boardRepository.canMutate).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000010',
      '00000000-0000-7000-8000-000000000001'
    );
    expect(branchVisibility).toHaveBeenCalled();
    expect(cardVisibility).not.toHaveBeenCalled();
  });
});
