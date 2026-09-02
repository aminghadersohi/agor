import { BadRequest } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import {
  inOpenCodeOllamaExecutionSlot,
  normalizeOpenCodeOllamaEndpoint,
  probeOpenCodeOllama,
} from './ollama-service.js';

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function ollamaFetch(input: {
  capabilities?: string[];
  context?: number;
  runningContext?: number;
  redirect?: boolean;
}) {
  return vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (input.redirect && url.endsWith('/api/version')) {
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9/' } });
    }
    if (url.endsWith('/api/version')) return json({ version: '0.33.2' });
    if (url.endsWith('/api/tags')) {
      return json({
        models: [
          {
            name: 'qwen3-coder:30b',
            model: 'qwen3-coder:30b',
            size: 18_000_000_000,
            details: { parameter_size: '30.5B', quantization_level: 'Q4_K_M' },
          },
        ],
      });
    }
    if (url.endsWith('/api/ps')) {
      return json({
        models:
          input.runningContext === undefined
            ? []
            : [{ name: 'qwen3-coder:30b', context_length: input.runningContext }],
      });
    }
    if (url.endsWith('/api/show')) {
      return json({
        capabilities: input.capabilities ?? ['completion', 'tools', 'thinking'],
        model_info: { 'qwen3.context_length': input.context ?? 32_768 },
      });
    }
    throw new Error(`unexpected path ${url}`);
  }) as unknown as typeof fetch;
}

const configuration = {
  enabled: true,
  endpoint: 'http://127.0.0.1:11435',
  model: 'qwen3-coder:30b',
};

describe('OpenCode Ollama loopback boundary', () => {
  it.each([
    'https://127.0.0.1:11435',
    'http://localhost:11435',
    'http://127.0.0.1:11435/path',
    'http://127.0.0.1:11435?token=secret',
    'http://user:secret@127.0.0.1:11435',
    'http://2130706433:11435',
    'http://0177.0.0.1:11435',
    'http://127.0.0.1:70000',
    'http://[::ffff:127.0.0.1]:11435',
    'http://10.0.0.1:11435',
  ])('rejects ambiguous, credential-bearing, DNS, or non-loopback endpoint %s', (endpoint) => {
    expect(() => normalizeOpenCodeOllamaEndpoint(endpoint)).toThrow(BadRequest);
  });

  it.each([
    ['http://127.0.0.1:11435/', 'http://127.0.0.1:11435'],
    ['http://127.1.2.3:11435', 'http://127.1.2.3:11435'],
    ['http://[::1]:11435', 'http://[::1]:11435'],
  ])('canonicalizes literal loopback %s', (endpoint, expected) => {
    expect(normalizeOpenCodeOllamaEndpoint(endpoint)).toBe(expected);
  });

  it('refuses redirects rather than following them', async () => {
    const fetch = ollamaFetch({ redirect: true });
    const result = await probeOpenCodeOllama({ configuration, fetch });
    expect(result).toMatchObject({ status: 'unavailable', models: [] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('OpenCode Ollama capability and context admission', () => {
  it('uses exact Ollama show metadata to admit tools and distinguish thinking/vision', async () => {
    const result = await probeOpenCodeOllama({
      configuration,
      fetch: ollamaFetch({ capabilities: ['completion', 'tools', 'thinking', 'vision'] }),
    });
    expect(result).toMatchObject({ status: 'ready', serviceVersion: '0.33.2' });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'qwen3-coder:30b',
        sizeBytes: 18_000_000_000,
        contextTokens: 32_768,
        tools: true,
        thinking: true,
        vision: true,
      }),
    ]);
  });

  it('refuses a model when Ollama show does not report tools', async () => {
    const result = await probeOpenCodeOllama({
      configuration,
      fetch: ollamaFetch({ capabilities: ['completion'] }),
    });
    expect(result.status).toBe('no-tools');
  });

  it.each([
    [{ context: 16_384 }, 'model context'],
    [{ context: 32_768, runningContext: 65_536 }, 'running model allocation'],
  ])('refuses dangerous context mismatch %#', async (probe, expectedMessage) => {
    const result = await probeOpenCodeOllama({
      configuration,
      fetch: ollamaFetch(probe),
    });
    expect(result.status).toBe('unsafe-context');
    expect(result.message).toMatch(new RegExp(expectedMessage, 'i'));
  });

  it('distinguishes a reachable service with no selected exact model', async () => {
    const result = await probeOpenCodeOllama({
      configuration: { ...configuration, model: '' },
      fetch: ollamaFetch({}),
    });
    expect(result.status).toBe('service-reachable');
  });

  it('admits only one Agor runner for the same endpoint', async () => {
    let release!: () => void;
    const first = inOpenCodeOllamaExecutionSlot(
      configuration.endpoint,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await Promise.resolve();
    await expect(
      inOpenCodeOllamaExecutionSlot(configuration.endpoint, async () => undefined)
    ).rejects.toThrow(/already has an Agor runner/i);
    release();
    await first;
    await expect(
      inOpenCodeOllamaExecutionSlot(configuration.endpoint, async () => 'ok')
    ).resolves.toBe('ok');
  });
});
