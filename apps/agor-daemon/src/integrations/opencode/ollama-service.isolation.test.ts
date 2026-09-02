import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => new Map<string, Record<string, string>>());

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return {
    ...actual,
    getCurrentTenantId: () => 'tenant-a',
    runWithTenantDatabaseScope: async (
      _db: unknown,
      tenantId: string,
      work: (tenantDb: { tenantId: string }) => Promise<unknown>
    ) => work({ tenantId }),
    UsersRepository: vi.fn(function repository(db: { tenantId: string }) {
      return {
        getToolConfig: vi.fn(async (userId: string) => stored.get(`${db.tenantId}:${userId}`)),
      };
    }),
  };
});

vi.mock('./credential-namespace.js', () => ({
  resolveAuthenticatedOpenCodeSubjectContext: vi.fn(
    async (_db: unknown, _config: unknown, params: any) => ({
      tenantId: params.tenant.tenant_id,
      subjectUserId: params.user.user_id,
      dataHome: '/opaque',
      namespaceKey: 'opaque',
      mode: 'simple',
      executorEnv: {},
    })
  ),
}));

import { OpenCodeOllamaService } from './ollama-service.js';

describe('OpenCode Ollama subject isolation', () => {
  beforeEach(() => stored.clear());

  it('reads only the authenticated tenant/user pair and accepts no target query', async () => {
    stored.set('tenant-a:user-1', {
      ollama_enabled: 'false',
      ollama_endpoint: 'http://127.0.0.1:11435',
      ollama_model: 'qwen3-coder:30b',
    });
    stored.set('tenant-a:user-2', {
      ollama_enabled: 'false',
      ollama_endpoint: 'http://127.0.0.2:11435',
      ollama_model: 'private-other-user:latest',
    });
    stored.set('tenant-b:user-1', {
      ollama_enabled: 'false',
      ollama_endpoint: 'http://127.0.0.3:11435',
      ollama_model: 'private-other-tenant:latest',
    });
    const service = new OpenCodeOllamaService({} as never, {} as never, vi.fn());
    const params = {
      user: { user_id: 'user-1' },
      tenant: { tenant_id: 'tenant-a' },
    } as never;

    await expect(service.find(params)).resolves.toMatchObject({
      configuration: {
        endpoint: 'http://127.0.0.1:11435',
        model: 'qwen3-coder:30b',
      },
    });
    await expect(
      service.find({ ...params, query: { user_id: 'user-2' } } as never)
    ).rejects.toThrow(/does not accept query parameters/i);
    const serialized = JSON.stringify(await service.find(params));
    expect(serialized).not.toContain('private-other-user');
    expect(serialized).not.toContain('private-other-tenant');
  });

  it('writes only the authenticated caller and rejects a caller-supplied target id', async () => {
    const patchUser = vi.fn(async () => undefined);
    const service = new OpenCodeOllamaService({} as never, {} as never, patchUser);
    const params = {
      user: { user_id: 'user-1' },
      tenant: { tenant_id: 'tenant-a' },
    } as never;

    await expect(
      service.patch(
        null,
        {
          enabled: false,
          endpoint: 'http://127.0.0.1:11435',
          model: 'qwen3-coder:30b',
        },
        params
      )
    ).resolves.toMatchObject({ configuration: { enabled: false } });
    expect(patchUser).toHaveBeenCalledWith(
      'user-1',
      {
        ollama_enabled: 'false',
        ollama_endpoint: 'http://127.0.0.1:11435',
        ollama_model: 'qwen3-coder:30b',
      },
      params
    );
    await expect(service.patch('user-2' as never, { enabled: false }, params)).rejects.toThrow(
      /signed-in user/i
    );
  });
});
