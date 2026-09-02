import type { AgorConfig } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  DeepReadonly,
  OpenCodeConfig,
  OpenCodeOllamaConfiguration,
  OpenCodeOllamaDiscovery,
  OpenCodeOllamaInvocationConfig,
  OpenCodeOllamaModel,
  OpenCodeOllamaSettingsPatch,
  OpenCodeOllamaTestRequest,
  UserID,
} from '@agor/core/types';
import {
  OPENCODE_OLLAMA_CONTEXT_TOKENS,
  OPENCODE_OLLAMA_DEFAULT_ENDPOINT,
  OPENCODE_OLLAMA_PROVIDER_ID,
} from '@agor/core/types';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';

const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_DISCOVERED_MODELS = 32;
const SAFE_PUBLIC_FAILURE = 'The local Ollama service could not be inspected safely.';
const activeExecutionOrigins = new Set<string>();

type Fetch = typeof globalThis.fetch;

interface OllamaTagsResponse {
  models?: Array<{
    name?: unknown;
    model?: unknown;
    size?: unknown;
    details?: { parameter_size?: unknown; quantization_level?: unknown };
  }>;
}

interface OllamaShowResponse {
  capabilities?: unknown;
  model_info?: Record<string, unknown>;
  details?: { parameter_size?: unknown; quantization_level?: unknown };
}

interface OllamaPsResponse {
  models?: Array<{ name?: unknown; model?: unknown; context_length?: unknown }>;
}

function canonicalIpv4Loopback(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return Number.NaN;
    return Number(part);
  });
  return octets[0] === 127 && octets.every((part) => Number.isInteger(part) && part <= 255);
}

/**
 * Accept only unambiguous literal loopback HTTP origins. Hostnames are not
 * accepted, so DNS and rebinding never participate in this boundary.
 */
export function normalizeOpenCodeOllamaEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 128) {
    throw new BadRequest('Ollama endpoint must be a short loopback HTTP origin.');
  }
  const match = /^http:\/\/(\[::1\]|[0-9.]+)(?::([0-9]{1,5}))?\/?$/.exec(value);
  if (!match) {
    throw new BadRequest(
      'Ollama endpoint must be an IPv4 or IPv6 loopback HTTP origin without credentials, path, query, or fragment.'
    );
  }
  const host = match[1];
  if (host !== '[::1]' && !canonicalIpv4Loopback(host)) {
    throw new BadRequest('Ollama endpoint must use a literal loopback address.');
  }
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BadRequest('Ollama endpoint port is invalid.');
  }
  return `http://${host}${port === 80 ? '' : `:${port}`}`;
}

function exactModel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/.test(value)
  ) {
    throw new BadRequest('Ollama model must be an exact local model ID.');
  }
  return value;
}

export function parseOpenCodeOllamaConfiguration(
  stored: OpenCodeConfig | null | undefined
): OpenCodeOllamaConfiguration {
  return {
    enabled: stored?.ollama_enabled === 'true',
    endpoint: normalizeOpenCodeOllamaEndpoint(
      stored?.ollama_endpoint || OPENCODE_OLLAMA_DEFAULT_ENDPOINT
    ),
    model: stored?.ollama_model?.trim() || '',
  };
}

export function normalizeOpenCodeOllamaSettingsPatch(
  patch: OpenCodeOllamaSettingsPatch
): OpenCodeOllamaConfiguration {
  if (!patch || typeof patch !== 'object' || typeof patch.enabled !== 'boolean') {
    throw new BadRequest('Ollama settings require an explicit enabled state.');
  }
  const configuration = {
    enabled: patch.enabled,
    endpoint: normalizeOpenCodeOllamaEndpoint(patch.endpoint ?? OPENCODE_OLLAMA_DEFAULT_ENDPOINT),
    model: patch.model === undefined || patch.model === '' ? '' : exactModel(patch.model),
  };
  if (configuration.enabled && !configuration.model) {
    throw new BadRequest('Select an exact Ollama model before enabling the provider.');
  }
  return configuration;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error('redirect refused');
  }
  if (!response.ok) throw new Error('request failed');
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('body too large');
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('body too large');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function ollamaRequest(
  endpoint: string,
  path: '/api/version' | '/api/tags' | '/api/show' | '/api/ps',
  fetch: Fetch,
  body?: object
): Promise<unknown> {
  // Revalidate at every request rather than trusting a previously parsed string.
  const origin = normalizeOpenCodeOllamaEndpoint(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    // Fetch normally exposes a manual redirect, but fail closed if a custom
    // implementation followed one before returning.
    if (response.redirected || new URL(response.url || `${origin}${path}`).origin !== origin) {
      throw new Error('cross-origin response refused');
    }
    return await boundedJson(response);
  } finally {
    clearTimeout(timer);
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function modelContext(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  const contexts = Object.entries(modelInfo)
    .filter(([key]) => key.endsWith('.context_length'))
    .map(([, value]) => positiveInteger(value))
    .filter((value): value is number => value !== undefined);
  return contexts.length > 0 ? Math.max(...contexts) : undefined;
}

function modelName(entry: { name?: unknown; model?: unknown }): string | undefined {
  const value = typeof entry.model === 'string' ? entry.model : entry.name;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function inspectModel(input: {
  endpoint: string;
  fetch: Fetch;
  tag: NonNullable<OllamaTagsResponse['models']>[number];
  running: Map<string, number | undefined>;
}): Promise<OpenCodeOllamaModel | null> {
  const id = modelName(input.tag);
  if (!id) return null;
  const show = (await ollamaRequest(input.endpoint, '/api/show', input.fetch, {
    model: id,
    verbose: false,
  })) as OllamaShowResponse;
  const capabilities = Array.isArray(show.capabilities)
    ? new Set(show.capabilities.filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  const parameterSize =
    typeof show.details?.parameter_size === 'string'
      ? show.details.parameter_size
      : typeof input.tag.details?.parameter_size === 'string'
        ? input.tag.details.parameter_size
        : undefined;
  const quantization =
    typeof show.details?.quantization_level === 'string'
      ? show.details.quantization_level
      : typeof input.tag.details?.quantization_level === 'string'
        ? input.tag.details.quantization_level
        : undefined;
  return {
    id,
    name: id,
    ...(positiveInteger(input.tag.size) ? { sizeBytes: positiveInteger(input.tag.size) } : {}),
    ...(parameterSize ? { parameterSize } : {}),
    ...(quantization ? { quantization } : {}),
    ...(modelContext(show.model_info) ? { contextTokens: modelContext(show.model_info) } : {}),
    ...(input.running.has(id) && input.running.get(id)
      ? { runningContextTokens: input.running.get(id) }
      : {}),
    tools: capabilities.has('tools'),
    thinking: capabilities.has('thinking'),
    vision: capabilities.has('vision'),
  };
}

export async function probeOpenCodeOllama(input: {
  configuration: OpenCodeOllamaConfiguration;
  fetch?: Fetch;
}): Promise<OpenCodeOllamaDiscovery> {
  const { configuration } = input;
  const fetch = input.fetch ?? globalThis.fetch;
  const base: Pick<OpenCodeOllamaDiscovery, 'providerId' | 'experimental' | 'configuration'> = {
    providerId: OPENCODE_OLLAMA_PROVIDER_ID,
    experimental: true,
    configuration,
  };
  if (!configuration.enabled) {
    return {
      ...base,
      status: 'unavailable',
      message: 'The experimental local provider is disabled.',
      models: [],
    };
  }
  try {
    const versionResult = (await ollamaRequest(configuration.endpoint, '/api/version', fetch)) as {
      version?: unknown;
    };
    const serviceVersion =
      typeof versionResult.version === 'string' ? versionResult.version : undefined;
    const [tagsResult, psResult] = await Promise.all([
      ollamaRequest(configuration.endpoint, '/api/tags', fetch) as Promise<OllamaTagsResponse>,
      ollamaRequest(configuration.endpoint, '/api/ps', fetch) as Promise<OllamaPsResponse>,
    ]);
    const running = new Map<string, number | undefined>();
    for (const entry of psResult.models ?? []) {
      const id = modelName(entry);
      if (id) running.set(id, positiveInteger(entry.context_length));
    }
    const allTags = tagsResult.models ?? [];
    const selectedTag = allTags.find((tag) => modelName(tag) === configuration.model);
    const tags = allTags.slice(0, selectedTag ? MAX_DISCOVERED_MODELS - 1 : MAX_DISCOVERED_MODELS);
    if (selectedTag && !tags.includes(selectedTag)) tags.push(selectedTag);
    const models = (
      await Promise.all(
        tags.map((tag) => inspectModel({ endpoint: configuration.endpoint, fetch, tag, running }))
      )
    ).filter((model): model is OpenCodeOllamaModel => model !== null);
    const selected = models.find((model) => model.id === configuration.model);
    if (!configuration.model) {
      return {
        ...base,
        status: 'service-reachable',
        message: 'Ollama is reachable. Select an exact tools-capable model.',
        ...(serviceVersion ? { serviceVersion } : {}),
        models,
      };
    }
    if (!selected) {
      return {
        ...base,
        status: 'model-missing',
        message: 'The selected exact model is not installed on this Ollama service.',
        ...(serviceVersion ? { serviceVersion } : {}),
        models,
      };
    }
    if (!selected.tools) {
      return {
        ...base,
        status: 'no-tools',
        message: 'The selected model does not report Ollama tools capability.',
        ...(serviceVersion ? { serviceVersion } : {}),
        models,
      };
    }
    const unsafeModelContext =
      selected.contextTokens !== undefined &&
      selected.contextTokens < OPENCODE_OLLAMA_CONTEXT_TOKENS;
    const unsafeRunningContext =
      selected.runningContextTokens !== undefined &&
      selected.runningContextTokens !== OPENCODE_OLLAMA_CONTEXT_TOKENS;
    if (unsafeModelContext || unsafeRunningContext || running.size > 1) {
      return {
        ...base,
        status: 'unsafe-context',
        message: unsafeRunningContext
          ? `The running model allocation is ${selected.runningContextTokens} tokens; Agor requires exactly ${OPENCODE_OLLAMA_CONTEXT_TOKENS}.`
          : running.size > 1
            ? 'More than one Ollama model is loaded; this preset permits one runner/model at a time.'
            : `The model context is below Agor's required ${OPENCODE_OLLAMA_CONTEXT_TOKENS} tokens.`,
        ...(serviceVersion ? { serviceVersion } : {}),
        models,
      };
    }
    return {
      ...base,
      status: 'ready',
      message:
        selected.runningContextTokens === undefined
          ? `Ready. Agor will use a fixed ${OPENCODE_OLLAMA_CONTEXT_TOKENS}-token budget and re-check a running allocation at launch.`
          : `Ready with a ${OPENCODE_OLLAMA_CONTEXT_TOKENS}-token running allocation.`,
      ...(serviceVersion ? { serviceVersion } : {}),
      models,
    };
  } catch {
    return {
      ...base,
      status: 'unavailable',
      message: SAFE_PUBLIC_FAILURE,
      models: [],
    };
  }
}

async function readUserConfiguration(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  userId: UserID
): Promise<OpenCodeOllamaConfiguration> {
  return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const stored = await new UsersRepository(tenantDb).getToolConfig(userId, 'opencode');
    return parseOpenCodeOllamaConfiguration(stored);
  });
}

export async function discoverOpenCodeOllamaForSubject(input: {
  db: TenantScopeAwareDatabase;
  config: DeepReadonly<AgorConfig>;
  params?: AuthenticatedParams;
  fetch?: Fetch;
}): Promise<OpenCodeOllamaDiscovery> {
  const context = await resolveAuthenticatedOpenCodeSubjectContext(
    input.db,
    input.config,
    input.params
  );
  const configuration = await readUserConfiguration(
    input.db,
    context.tenantId,
    context.subjectUserId
  );
  return probeOpenCodeOllama({ configuration, fetch: input.fetch });
}

export async function resolveReadyOpenCodeOllamaForLaunch(input: {
  db: TenantScopeAwareDatabase;
  tenantId: string;
  userId: UserID;
  model: string;
  fetch?: Fetch;
}): Promise<OpenCodeOllamaInvocationConfig> {
  const configuration = await readUserConfiguration(input.db, input.tenantId, input.userId);
  if (!configuration.enabled) {
    throw new BadRequest('Enable Ollama (local via OpenCode) in your OpenCode settings first.');
  }
  if (configuration.model !== input.model) {
    throw new BadRequest(
      'The session Ollama model does not match the exact model selected in your OpenCode settings.'
    );
  }
  const discovery = await probeOpenCodeOllama({ configuration, fetch: input.fetch });
  if (discovery.status !== 'ready') throw new BadRequest(discovery.message);
  const model = discovery.models.find((candidate) => candidate.id === input.model);
  if (!model) throw new BadRequest('The selected exact Ollama model is unavailable.');
  return {
    endpoint: configuration.endpoint,
    model,
    contextTokens: OPENCODE_OLLAMA_CONTEXT_TOKENS,
  };
}

/** Process-local single-runner gate for the experimental host-local service. */
export async function inOpenCodeOllamaExecutionSlot<T>(
  endpoint: string,
  work: () => Promise<T>
): Promise<T> {
  const origin = normalizeOpenCodeOllamaEndpoint(endpoint);
  if (activeExecutionOrigins.has(origin)) {
    throw new BadRequest(
      'This local Ollama service already has an Agor runner. Wait for it to finish.'
    );
  }
  activeExecutionOrigins.add(origin);
  try {
    return await work();
  } finally {
    activeExecutionOrigins.delete(origin);
  }
}

export class OpenCodeOllamaService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>,
    private readonly patchUser: (
      userId: UserID,
      fields: Partial<Record<keyof OpenCodeConfig, string | null>>,
      params?: AuthenticatedParams
    ) => Promise<unknown>
  ) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeOllamaDiscovery> {
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('Ollama discovery does not accept query parameters.');
    }
    return discoverOpenCodeOllamaForSubject({ db: this.db, config: this.config, params });
  }

  async patch(
    id: null,
    data: OpenCodeOllamaSettingsPatch,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOllamaDiscovery> {
    if (id !== null) throw new BadRequest('Ollama settings are scoped to the signed-in user.');
    const callerId = params?.user?.user_id as UserID | undefined;
    const tenantId = getCurrentTenantId();
    if (!callerId || !tenantId) throw new NotAuthenticated('Sign in before configuring Ollama.');
    await resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
    const configuration = normalizeOpenCodeOllamaSettingsPatch(data);
    await this.patchUser(
      callerId,
      {
        ollama_enabled: String(configuration.enabled) as 'true' | 'false',
        ollama_endpoint: configuration.endpoint,
        ollama_model: configuration.model || null,
      },
      params
    );
    return probeOpenCodeOllama({ configuration });
  }

  async create(
    data: OpenCodeOllamaTestRequest,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOllamaDiscovery> {
    await resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
    if (!data || typeof data !== 'object')
      throw new BadRequest('Ollama test settings are invalid.');
    const configuration: OpenCodeOllamaConfiguration = {
      enabled: true,
      endpoint: normalizeOpenCodeOllamaEndpoint(data.endpoint ?? OPENCODE_OLLAMA_DEFAULT_ENDPOINT),
      model: data.model === undefined || data.model === '' ? '' : exactModel(data.model),
    };
    return probeOpenCodeOllama({ configuration });
  }
}
