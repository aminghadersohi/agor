import { describe, expect, it } from 'vitest';
import { createOpenCodeExecutorContext, parseOpenCodeExecutorContext } from './executor-context.js';

describe('OpenCode executor context', () => {
  it('round-trips the daemon-authorized native data home', () => {
    expect(
      parseOpenCodeExecutorContext(createOpenCodeExecutorContext('/opaque/native-home'))
    ).toEqual({
      dataHome: '/opaque/native-home',
    });
  });

  it('fails closed when the generic host context is absent or malformed', () => {
    for (const value of [undefined, null, {}, { dataHome: '' }, { dataHome: 1 }]) {
      expect(() => parseOpenCodeExecutorContext(value)).toThrow(/executor context|data home/i);
    }
  });

  it('round-trips only the bounded local-provider launch shape', () => {
    const ollama = {
      endpoint: 'http://127.0.0.1:11435',
      contextTokens: 32_768 as const,
      model: {
        id: 'qwen3-coder:30b',
        name: 'qwen3-coder:30b',
        tools: true,
        thinking: true,
        vision: false,
      },
    };
    expect(
      parseOpenCodeExecutorContext(createOpenCodeExecutorContext('/opaque/home', ollama))
    ).toEqual({
      dataHome: '/opaque/home',
      ollama,
    });
    expect(() =>
      parseOpenCodeExecutorContext({
        dataHome: '/opaque/home',
        ollama: { ...ollama, contextTokens: 65_536 },
      })
    ).toThrow(/Ollama executor context/i);
  });
});
