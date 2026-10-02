import type { OpenCodeOllamaInvocationConfig } from '@agor/core/types';

/** Local native-file context: the daemon-authorized XDG data home in the execution home. */
export interface OpenCodeNativeFileExecutorContext {
  dataHome: string;
  ollama?: OpenCodeOllamaInvocationConfig;
}

/** Hosted context: logical identity only; the executor resolves paths under its own home and scratch. */
export interface OpenCodeManagedExecutorContext {
  mode: 'managed';
  sessionId: string;
  taskId: string;
}

export type OpenCodeExecutorContext =
  | OpenCodeNativeFileExecutorContext
  | OpenCodeManagedExecutorContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createOpenCodeExecutorContext(
  dataHome: string,
  ollama?: OpenCodeOllamaInvocationConfig
): OpenCodeNativeFileExecutorContext {
  if (!dataHome.trim()) throw new Error('OpenCode executor context requires a native data home');
  return { dataHome, ...(ollama ? { ollama } : {}) };
}

export function createOpenCodeManagedExecutorContext(
  sessionId: string,
  taskId: string
): OpenCodeManagedExecutorContext {
  if (!UUID.test(sessionId) || !UUID.test(taskId)) {
    throw new Error('OpenCode managed executor context requires session and task identity');
  }
  return { mode: 'managed', sessionId, taskId };
}

export function isOpenCodeManagedExecutorContext(
  context: OpenCodeExecutorContext
): context is OpenCodeManagedExecutorContext {
  return 'mode' in context;
}

export function parseOpenCodeExecutorContext(value: unknown): OpenCodeExecutorContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode executor context is missing');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== undefined) {
    if (
      candidate.mode !== 'managed' ||
      Object.keys(candidate).length !== 3 ||
      typeof candidate.sessionId !== 'string' ||
      typeof candidate.taskId !== 'string'
    ) {
      throw new Error('OpenCode managed executor context is malformed');
    }
    return createOpenCodeManagedExecutorContext(candidate.sessionId, candidate.taskId);
  }
  const dataHome = candidate.dataHome;
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
