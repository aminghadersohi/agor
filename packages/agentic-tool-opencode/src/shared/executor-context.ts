import type { OpenCodeOllamaInvocationConfig } from '@agor/core/types';

export interface OpenCodeExecutorContext {
  dataHome: string;
  ollama?: OpenCodeOllamaInvocationConfig;
}

export function createOpenCodeExecutorContext(
  dataHome: string,
  ollama?: OpenCodeOllamaInvocationConfig
): OpenCodeExecutorContext {
  if (!dataHome.trim()) throw new Error('OpenCode executor context requires a native data home');
  return { dataHome, ...(ollama ? { ollama } : {}) };
}

export function parseOpenCodeExecutorContext(value: unknown): OpenCodeExecutorContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode executor context is missing');
  }
  const dataHome = (value as { dataHome?: unknown }).dataHome;
  if (typeof dataHome !== 'string' || !dataHome.trim()) {
    throw new Error('OpenCode executor context requires a native data home');
  }
  const ollama = (value as { ollama?: unknown }).ollama;
  if (ollama !== undefined) {
    if (
      !ollama ||
      typeof ollama !== 'object' ||
      typeof (ollama as OpenCodeOllamaInvocationConfig).endpoint !== 'string' ||
      typeof (ollama as OpenCodeOllamaInvocationConfig).model?.id !== 'string' ||
      (ollama as OpenCodeOllamaInvocationConfig).contextTokens !== 32_768
    ) {
      throw new Error('OpenCode Ollama executor context is invalid');
    }
  }
  return {
    dataHome,
    ...(ollama ? { ollama: ollama as OpenCodeOllamaInvocationConfig } : {}),
  };
}
