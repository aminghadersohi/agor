import { getCurrentTenantDatabaseScope, runWithTenantContext } from '@agor/core/db';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { ReposService } from '../../services/repos';
import type { McpContext } from '../server';
import { registerRepoTools } from './repos';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function register(repos: Record<string, unknown>, role = 'admin') {
  let handler: Handler | undefined;
  let config: { inputSchema: { safeParse(value: unknown): { success: boolean } } } | undefined;
  const server = {
    registerTool(name: string, cfg: typeof config, callback: Handler) {
      if (name === 'agor_repos_import_environment') {
        handler = callback;
        config = cfg;
      }
    },
  } as unknown as McpServer;
  const services: Record<string, unknown> = {
    repos: { get: async () => ({ repo_id: 'repo-full' }), ...repos },
    branches: { get: async () => ({ branch_id: 'branch-full' }) },
  };
  const baseServiceParams = { user: { user_id: 'user-1', role } };
  registerRepoTools(server, {
    app: { service: (name: string) => services[name] },
    db: {},
    baseServiceParams,
  } as unknown as McpContext);
  if (!handler || !config) throw new Error('agor_repos_import_environment not registered');
  return { handler, config, baseServiceParams };
}

describe('agor_repos_import_environment', () => {
  it('imports launch.json outside any tenant database unit, with resolved IDs', async () => {
    const importFromLaunchJson = vi.fn(async () => {
      // Long route: the executor spawn must not run inside a held DB unit.
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      return { repo_id: 'repo-full', environment: { version: 2 } };
    });
    const importFromAgorYml = vi.fn();
    const { handler, baseServiceParams } = register({ importFromLaunchJson, importFromAgorYml });

    const result = await runWithTenantContext('default', () =>
      handler({ repoId: 'repo', branchId: 'branch', source: 'launch_json' })
    );

    expect(importFromLaunchJson).toHaveBeenCalledWith(
      'repo-full',
      { branch_id: 'branch-full' },
      baseServiceParams
    );
    expect(importFromAgorYml).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ repo_id: 'repo-full' });
  });

  it('imports .agor.yml through the agor_yml source', async () => {
    const importFromAgorYml = vi.fn(async () => ({ repo_id: 'repo-full' }));
    const importFromLaunchJson = vi.fn();
    const { handler, baseServiceParams } = register({ importFromLaunchJson, importFromAgorYml });

    await handler({ repoId: 'repo', branchId: 'branch', source: 'agor_yml' });

    expect(importFromAgorYml).toHaveBeenCalledWith(
      'repo-full',
      { branch_id: 'branch-full' },
      baseServiceParams
    );
    expect(importFromLaunchJson).not.toHaveBeenCalled();
  });

  it('rejects unknown sources at the schema', () => {
    const { config } = register({});
    expect(
      config.inputSchema.safeParse({ repoId: 'r', branchId: 'b', source: 'launch_json' }).success
    ).toBe(true);
    expect(
      config.inputSchema.safeParse({ repoId: 'r', branchId: 'b', source: 'docker' }).success
    ).toBe(false);
  });

  it.each([
    ['launch_json', 'importFromLaunchJson'],
    ['agor_yml', 'importFromAgorYml'],
  ] as const)(
    'non-admin %s import is refused by the service before any work',
    async (source, method) => {
      // Delegate to the real service method: its admin check runs before it
      // touches `this`, so an empty receiver proves nothing else was reached.
      const real = ReposService.prototype[method];
      const { handler } = register(
        { [method]: (...args: Parameters<typeof real>) => real.apply({} as ReposService, args) },
        'member'
      );
      await expect(handler({ repoId: 'repo', branchId: 'branch', source })).rejects.toThrow(
        'Admin access is required'
      );
    }
  );
});
