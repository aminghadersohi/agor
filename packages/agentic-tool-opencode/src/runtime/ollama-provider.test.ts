import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeOllamaInvocationConfig } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeOpenCodeOllamaProvider } from './opencode-tool.js';

const directories: string[] = [];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agor-opencode-ollama-'));
  directories.push(path);
  return path;
}

const ollama: OpenCodeOllamaInvocationConfig = {
  endpoint: 'http://127.0.0.1:11435',
  contextTokens: 32_768,
  model: {
    id: 'qwen3-coder:30b',
    name: 'qwen3-coder:30b',
    sizeBytes: 18_000_000_000,
    contextTokens: 32_768,
    tools: true,
    thinking: true,
    vision: false,
  },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('OpenCode invocation-scoped Ollama provider merge', () => {
  it('preserves other invocation providers and derives capability flags from Ollama inspection', async () => {
    const path = await directory();
    await writeFile(
      join(path, 'opencode.json'),
      JSON.stringify({ provider: { anthropic: { name: 'Branch Anthropic' } } })
    );
    const result = await mergeOpenCodeOllamaProvider(
      { mcp: {}, provider: { openai: { name: 'OpenAI' } } },
      path,
      ollama
    );
    expect(result.provider).toEqual({
      anthropic: { name: 'Branch Anthropic' },
      openai: { name: 'OpenAI' },
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local via Agor)',
        options: { baseURL: 'http://127.0.0.1:11435/v1' },
        models: {
          'qwen3-coder:30b': {
            name: 'qwen3-coder:30b',
            attachment: false,
            reasoning: true,
            tool_call: true,
            limit: { context: 32_768, output: 8_192 },
          },
        },
      },
    });
  });

  it.each(['opencode.json', 'opencode.jsonc'])(
    'fails clearly instead of overwriting a branch ollama provider in %s',
    async (name) => {
      const path = await directory();
      await writeFile(
        join(path, name),
        name.endsWith('jsonc')
          ? '{ // advanced branch provider\n "provider": { "ollama": { "name": "branch" }, }, }'
          : JSON.stringify({ provider: { ollama: { name: 'branch' } } })
      );
      await expect(mergeOpenCodeOllamaProvider({ mcp: {} }, path, ollama)).rejects.toThrow(
        /conflicts with the enabled Agor local preset/i
      );
    }
  );

  it('leaves cloud invocation configuration byte-for-byte untouched when no preset is supplied', async () => {
    const cloud = { mcp: {}, provider: { anthropic: { name: 'Anthropic' } } };
    await expect(
      mergeOpenCodeOllamaProvider(cloud, '/path/does/not/need/to/exist', undefined)
    ).resolves.toBe(cloud);
  });

  it('rejects a second invocation owner for the canonical provider ID', async () => {
    await expect(
      mergeOpenCodeOllamaProvider(
        { mcp: {}, provider: { ollama: { name: 'untrusted' } } },
        await directory(),
        ollama
      )
    ).rejects.toThrow(/already defines protected provider/i);
  });
});
