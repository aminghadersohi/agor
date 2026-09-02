export const OPENCODE_OLLAMA_PROVIDER_ID = 'ollama' as const;
export const OPENCODE_OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11435' as const;
export const OPENCODE_OLLAMA_CONTEXT_TOKENS = 32_768 as const;

/**
 * Non-secret, per-user OpenCode local-provider settings. These fields live in
 * the existing encrypted `agentic_tools.opencode` envelope, but are returned
 * in plaintext only to their owner through the existing public-field seam.
 */
export interface OpenCodeConfig {
  ollama_enabled?: 'true' | 'false';
  ollama_endpoint?: string;
  ollama_model?: string;
}

export interface OpenCodeOllamaConfiguration {
  enabled: boolean;
  endpoint: string;
  model: string;
}

export type OpenCodeOllamaStatus =
  | 'unavailable'
  | 'service-reachable'
  | 'model-missing'
  | 'no-tools'
  | 'unsafe-context'
  | 'ready';

export interface OpenCodeOllamaModel {
  id: string;
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  contextTokens?: number;
  runningContextTokens?: number;
  tools: boolean;
  thinking: boolean;
  vision: boolean;
}

/** Owner-only response from the authenticated local-provider service. */
export interface OpenCodeOllamaDiscovery {
  providerId: typeof OPENCODE_OLLAMA_PROVIDER_ID;
  experimental: true;
  configuration: OpenCodeOllamaConfiguration;
  status: OpenCodeOllamaStatus;
  message: string;
  serviceVersion?: string;
  models: OpenCodeOllamaModel[];
}

/** Bounded configuration sent to the already-existing OpenCode executor. */
export interface OpenCodeOllamaInvocationConfig {
  endpoint: string;
  model: OpenCodeOllamaModel;
  contextTokens: typeof OPENCODE_OLLAMA_CONTEXT_TOKENS;
}

export interface OpenCodeOllamaSettingsPatch {
  enabled: boolean;
  endpoint?: string;
  model?: string;
}

export interface OpenCodeOllamaTestRequest {
  endpoint?: string;
  model?: string;
}
