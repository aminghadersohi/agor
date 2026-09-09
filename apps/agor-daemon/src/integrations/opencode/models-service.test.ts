import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeModelsService } from './models-service';

const resolveBinary = vi.hoisted(() => vi.fn());
vi.mock('@agor/agentic-tool-opencode/runtime/binary', () => ({
  resolvePackagedOpenCodeBinary: resolveBinary,
}));

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return { ...actual, isTenantAgenticToolEnabled: vi.fn(), loadConfigSync: vi.fn() };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return { ...actual, UsersRepository: vi.fn() };
});

vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/unix')>('@agor/core/unix');
  return {
    ...actual,
    getHomedirFromUsername: (username: string) => `/home/${username}`,
    validateResolvedUnixUser: vi.fn(),
  };
});

const runCommand = vi.hoisted(() => vi.fn());
vi.mock('../../utils/spawn-executor.js', () => ({
  requestExecutor: runCommand,
  startContainedExecutorCommand: (payload: unknown, options: unknown) => ({
    result: runCommand(payload, options),
    verifyAbsence: vi.fn(async () => true),
    retainContainmentFence: vi.fn(async () => undefined),
  }),
}));

const enabled = vi.mocked(isTenantAgenticToolEnabled);
const loadConfig = vi.mocked(loadConfigSync);
const usersRepository = vi.mocked(UsersRepository);
const db = { run: vi.fn() } as never;
const params = {
  user: { user_id: 'fictional-user', email: 'reader@example.invalid', role: 'member' },
} as never;
const catalog = {
  runtimeVersion: '1.14.33',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      availableForSelection: true,
      suggestedModel: 'gpt-5',
      models: [{ id: 'gpt-5', name: 'GPT-5', status: 'active' }],
    },
  ],
};

function service() {
  return createOpenCodeModelsService(db, loadConfigSync());
}

function configureOllama(model = 'qwen3-coder:30b') {
  usersRepository.mockImplementation(function repository() {
    return {
      findById: vi.fn(async () => ({ unix_username: 'fictional-unix-user' })),
      getToolConfig: vi.fn(async () => ({
        ollama_enabled: 'true',
        ollama_endpoint: 'http://127.0.0.1:11435',
        ollama_model: model,
      })),
    };
  } as never);
}

function healthyOllamaFetch() {
  return vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith('/api/version')) return Response.json({ version: '0.33.3' });
    if (url.endsWith('/api/tags')) {
      return Response.json({
        models: [
          {
            name: 'qwen3-coder:30b',
            size: 18_000_000_000,
            details: { parameter_size: '30.5B', quantization_level: 'Q4_K_M' },
          },
        ],
      });
    }
    if (url.endsWith('/api/ps')) return Response.json({ models: [] });
    if (url.endsWith('/api/show')) {
      return Response.json({
        capabilities: ['completion', 'tools'],
        model_info: { 'qwen3.context_length': 262_144 },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockResolvedValue(true);
  loadConfig.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  usersRepository.mockImplementation(function repository() {
    return {
      findById: vi.fn(async () => ({ unix_username: 'fictional-unix-user' })),
      getToolConfig: vi.fn(async () => null),
    };
  } as never);
  runCommand.mockResolvedValue({ success: true, data: catalog });
  resolveBinary.mockResolvedValue('/packaged/opencode');
});

afterEach(() => vi.unstubAllGlobals());

describe('OpenCode production model-catalog path', () => {
  it('requires the authenticated tenant subject and accepts no target identity or scope', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().find()).rejects.toThrow(/sign in/i);
      await expect(
        service().find({
          ...params,
          query: { user_id: 'another-user', path: '/private', branch_id: 'branch-1' },
        } as never)
      ).rejects.toThrow(/does not accept query parameters/i);
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('makes one bounded, output-suppressed configured-provider read without branch data', async () => {
    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers).toEqual([
      expect.objectContaining({
        id: 'openai',
        availableForSelection: true,
        availabilityStatus: 'available',
      }),
    ]);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agentic-tool.invoke',
        params: { tool: 'opencode', request: { operation: 'read-model-catalog' } },
      }),
      expect.objectContaining({ timeoutMs: 5_000, sensitiveOutput: true })
    );
  });

  it.each(['missing binary', 'stale managed install'])(
    'keeps the server-free catalog available with a %s',
    async () => {
      resolveBinary.mockRejectedValueOnce(new Error('private runtime detail'));

      const result = await runWithTenantContext('tenant-a', () => service().find(params));

      expect(result.providers[0]).toMatchObject({ id: 'openai', availableForSelection: true });
      expect(resolveBinary).not.toHaveBeenCalled();
      expect(runCommand).toHaveBeenCalledOnce();
    }
  );

  it.each([
    undefined,
    {},
    { runtimeVersion: '1.14.33' },
    { ...catalog, runtimeVersion: '1.14.32' },
    { runtimeVersion: '1.14.33', providers: [{}] },
    { ...catalog, suggestedSelection: { providerId: 'openai' } },
    {
      runtimeVersion: '1.14.33',
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          availableForSelection: true,
          models: [{ id: 'gpt-test', name: 'GPT test', status: 'unknown' }],
        },
      ],
    },
  ])('degrades malformed configured-provider metadata to scoped statuses', async (data) => {
    runCommand.mockResolvedValueOnce({ success: true, data });

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers.find(({ id }) => id === 'opencode')).toMatchObject({
      availableForSelection: true,
      availabilityStatus: 'available',
    });
    expect(result.providers.find(({ id }) => id === 'openai')).toMatchObject({
      availableForSelection: false,
      availabilityStatus: 'discovery-failed',
      availabilityMessage: expect.not.stringMatching(/private|token|endpoint/i),
    });
  });

  it.each(['EXECUTOR_TIMEOUT', 'EXECUTOR_RESULT_MISSING', 'COMMAND_FAILED'])(
    'keeps credentialless cloud choices and manual entry after %s',
    async (code) => {
      runCommand.mockResolvedValueOnce({
        success: false,
        error: { code, message: 'secret at /private/path' },
      });

      const result = await runWithTenantContext('tenant-a', () => service().find(params));

      expect(result.providers.find(({ id }) => id === 'opencode')).toMatchObject({
        availableForSelection: true,
        availabilityStatus: 'available',
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|\/private\/path/);
    }
  );

  it("adds only the caller's healthy exact canonical Ollama model", async () => {
    configureOllama();
    vi.stubGlobal('fetch', healthyOllamaFetch());

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers).toEqual([
      expect.objectContaining({ id: 'openai', availabilityStatus: 'available' }),
      expect.objectContaining({
        id: 'ollama',
        availableForSelection: true,
        availabilityStatus: 'available',
        suggestedModel: 'qwen3-coder:30b',
        models: [
          expect.objectContaining({
            id: 'qwen3-coder:30b',
            sizeBytes: 18_000_000_000,
            contextTokens: 262_144,
            tools: true,
            thinking: false,
            vision: false,
          }),
        ],
      }),
    ]);
  });

  it('reserves the canonical ollama provider ID for the isolated local configuration', async () => {
    runCommand.mockResolvedValueOnce({
      success: true,
      data: {
        ...catalog,
        providers: [
          ...catalog.providers,
          {
            id: 'ollama',
            name: 'Untrusted catalog Ollama',
            availableForSelection: true,
            models: [{ id: 'remote-model', name: 'Remote model', status: 'active' }],
          },
        ],
      },
    });

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers.map(({ id }) => id)).toEqual(['openai']);
  });

  it('keeps cloud providers intact when Ollama is unreachable', async () => {
    configureOllama();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connection secret')))
    );

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers[0]).toMatchObject({ id: 'openai', availableForSelection: true });
    expect(result.providers.find(({ id }) => id === 'ollama')).toMatchObject({
      availableForSelection: false,
      availabilityStatus: 'unavailable',
      availabilityMessage: 'The local Ollama service could not be inspected safely.',
    });
    expect(JSON.stringify(result)).not.toContain('connection secret');
  });

  it('keeps healthy Ollama available when configured cloud discovery times out', async () => {
    configureOllama();
    vi.stubGlobal('fetch', healthyOllamaFetch());
    runCommand.mockResolvedValueOnce({
      success: false,
      error: { code: 'EXECUTOR_TIMEOUT', message: 'private timeout path' },
    });

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers.find(({ id }) => id === 'ollama')).toMatchObject({
      availableForSelection: true,
      availabilityStatus: 'available',
    });
    expect(result.providers.find(({ id }) => id === 'openai')).toMatchObject({
      availabilityStatus: 'discovery-failed',
    });
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('contains malformed Ollama metadata to the local provider', async () => {
    configureOllama();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: string | URL | Request) => {
        const url = String(request);
        if (url.endsWith('/api/version')) return Response.json({ version: '0.33.3' });
        if (url.endsWith('/api/tags')) return Response.json({ models: { malformed: true } });
        if (url.endsWith('/api/ps')) return Response.json({ models: [] });
        throw new Error('unexpected request');
      })
    );

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers[0]).toMatchObject({ id: 'openai', availableForSelection: true });
    expect(result.providers.find(({ id }) => id === 'ollama')).toMatchObject({
      availableForSelection: false,
      availabilityStatus: 'unavailable',
    });
  });

  it('contains a local configuration read failure without exposing its details', async () => {
    usersRepository.mockImplementation(function repository() {
      return {
        findById: vi.fn(async () => ({ unix_username: 'fictional-unix-user' })),
        getToolConfig: vi.fn(async () => Promise.reject(new Error('private database value'))),
      };
    } as never);

    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result.providers[0]).toMatchObject({ id: 'openai', availableForSelection: true });
    expect(result.providers.find(({ id }) => id === 'ollama')).toMatchObject({
      availableForSelection: false,
      availabilityStatus: 'discovery-failed',
      availabilityMessage:
        'Local Ollama availability could not be inspected safely. The saved configuration was not changed.',
    });
    expect(JSON.stringify(result)).not.toContain('private database value');
  });

  it('routes identical user IDs in different tenants to isolated opaque XDG namespaces', async () => {
    const seen: string[] = [];
    runCommand.mockImplementation(async (payload) => {
      seen.push(String((payload.agenticToolContext as { dataHome?: string }).dataHome));
      return { success: true, data: catalog };
    });

    await runWithTenantContext('tenant-a', () => service().find(params));
    await runWithTenantContext('tenant-b', () => service().find(params));

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.join(' ')).not.toMatch(/tenant-a|tenant-b|fictional-user/);
  });

  it('does not forward daemon provider credentials or expose executor failures', async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-cross';
    runCommand.mockRejectedValue(new Error('must-not-cross at /home/private'));
    try {
      const result = await runWithTenantContext('tenant-a', () => service().find(params));
      expect(runCommand.mock.calls[0]?.[1]?.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(JSON.stringify(result)).not.toMatch(/must-not-cross|\/home\/private/);

      runCommand.mockResolvedValueOnce({
        success: true,
        data: {
          ...catalog,
          providers: [
            {
              ...catalog.providers[0],
              availabilityMessage: 'must-not-cross from an unexpected executor field',
            },
          ],
        },
      });
      const sanitized = await runWithTenantContext('tenant-a', () => service().find(params));
      expect(JSON.stringify(sanitized)).not.toContain('must-not-cross');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });
});
