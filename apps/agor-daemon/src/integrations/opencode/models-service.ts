import { createOpenCodeKnownModelCatalog, OPENCODE_VERSION } from '@agor/agentic-tool-opencode';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams, DeepReadonly, OpenCodeModelCatalog } from '@agor/core/types';
import { OPENCODE_OLLAMA_PROVIDER_ID } from '@agor/core/types';
import {
  type AuthenticatedOpenCodeSubjectContext,
  resolveAuthenticatedOpenCodeSubjectContext,
} from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import { blockOpenCodeNativeStateNamespace } from './native-state-coordinator.js';
import { discoverOpenCodeOllamaForContext } from './ollama-service.js';

const CONFIGURED_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
const CONFIGURED_PROVIDER_FAILURE =
  'Configured provider availability could not be inspected. Exact provider/model entry remains available.';
const LOCAL_PROVIDER_FAILURE =
  'Local Ollama availability could not be inspected safely. The saved configuration was not changed.';
const OPEN_CODE_MODEL_STATUSES = new Set(['active', 'alpha', 'beta', 'deprecated']);

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOpenCodeModelCatalog(value: unknown): value is OpenCodeModelCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const catalog = value as Partial<OpenCodeModelCatalog>;
  if (catalog.runtimeVersion !== OPENCODE_VERSION || !Array.isArray(catalog.providers))
    return false;
  if (
    catalog.suggestedSelection !== undefined &&
    (!catalog.suggestedSelection ||
      typeof catalog.suggestedSelection !== 'object' ||
      Array.isArray(catalog.suggestedSelection) ||
      !isString(catalog.suggestedSelection.providerId) ||
      !isString(catalog.suggestedSelection.modelId))
  ) {
    return false;
  }
  const providerIds = new Set<string>();
  const providersValid = catalog.providers.every(
    (provider) =>
      provider &&
      isString(provider.id) &&
      !providerIds.has(provider.id) &&
      Boolean(providerIds.add(provider.id)) &&
      isString(provider.name) &&
      typeof provider.availableForSelection === 'boolean' &&
      (provider.suggestedModel === undefined || isString(provider.suggestedModel)) &&
      Array.isArray(provider.models) &&
      provider.models.every(
        (model) =>
          model &&
          isString(model.id) &&
          isString(model.name) &&
          OPEN_CODE_MODEL_STATUSES.has(model.status) &&
          isOptionalPositiveInteger(model.sizeBytes) &&
          isOptionalPositiveInteger(model.contextTokens) &&
          isOptionalBoolean(model.tools) &&
          isOptionalBoolean(model.thinking) &&
          isOptionalBoolean(model.vision)
      )
  );
  if (!providersValid || !catalog.suggestedSelection) return providersValid;
  const suggestedProvider = catalog.providers.find(
    ({ id }) => id === catalog.suggestedSelection?.providerId
  );
  return Boolean(
    suggestedProvider?.availableForSelection &&
      suggestedProvider.models.some(({ id }) => id === catalog.suggestedSelection?.modelId)
  );
}

function publicConfiguredProviderCatalog(catalog: OpenCodeModelCatalog): OpenCodeModelCatalog {
  return {
    runtimeVersion: catalog.runtimeVersion,
    ...(catalog.suggestedSelection
      ? {
          suggestedSelection: {
            providerId: catalog.suggestedSelection.providerId,
            modelId: catalog.suggestedSelection.modelId,
          },
        }
      : {}),
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      availableForSelection: provider.availableForSelection,
      ...(provider.suggestedModel ? { suggestedModel: provider.suggestedModel } : {}),
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        status: model.status,
        ...(model.sizeBytes ? { sizeBytes: model.sizeBytes } : {}),
        ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
        ...(model.tools === undefined ? {} : { tools: model.tools }),
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
        ...(model.vision === undefined ? {} : { vision: model.vision }),
      })),
    })),
  };
}

function serverFreeFallbackCatalog(): OpenCodeModelCatalog {
  return {
    runtimeVersion: OPENCODE_VERSION,
    ...createOpenCodeKnownModelCatalog(null),
  };
}

function withConfiguredProviderStatus(
  catalog: OpenCodeModelCatalog,
  failed: boolean
): OpenCodeModelCatalog {
  return {
    ...catalog,
    providers: catalog.providers
      .filter(({ id }) => id !== OPENCODE_OLLAMA_PROVIDER_ID)
      .map((provider) => ({
        ...provider,
        availabilityStatus: provider.availableForSelection
          ? ('available' as const)
          : failed
            ? ('discovery-failed' as const)
            : ('not-configured' as const),
        ...(failed && !provider.availableForSelection
          ? { availabilityMessage: CONFIGURED_PROVIDER_FAILURE }
          : {}),
      })),
  };
}

async function readConfiguredProviderCatalog(
  context: AuthenticatedOpenCodeSubjectContext
): Promise<OpenCodeModelCatalog> {
  const handle = startOpenCodeExecutorInvocation(
    context.dataHome,
    { operation: 'read-model-catalog' },
    {
      env: context.executorEnv,
      logPrefix: '[OpenCode Models]',
      timeoutMs: CONFIGURED_PROVIDER_DISCOVERY_TIMEOUT_MS,
      sensitiveOutput: true,
    }
  );
  const result = await handle.result;
  if (result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
    await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
  }
  if (!result.success || !isOpenCodeModelCatalog(result.data)) {
    throw new Error('configured provider discovery failed');
  }
  return publicConfiguredProviderCatalog(result.data);
}

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  // Authentication, tool enablement, and trusted tenant identity fail closed
  // before operational provider probes are allowed to degrade independently.
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, config, params);
  const [configuredResult, ollamaResult] = await Promise.allSettled([
    readConfiguredProviderCatalog(context),
    discoverOpenCodeOllamaForContext({ db, context }),
  ]);
  const catalog = withConfiguredProviderStatus(
    configuredResult.status === 'fulfilled' ? configuredResult.value : serverFreeFallbackCatalog(),
    configuredResult.status === 'rejected'
  );
  if (ollamaResult.status === 'rejected') {
    return {
      ...catalog,
      providers: [
        ...catalog.providers.filter(({ id }) => id !== OPENCODE_OLLAMA_PROVIDER_ID),
        {
          id: OPENCODE_OLLAMA_PROVIDER_ID,
          name: 'Ollama (local via OpenCode)',
          availableForSelection: false,
          availabilityStatus: 'discovery-failed',
          availabilityMessage: LOCAL_PROVIDER_FAILURE,
          models: [],
        },
      ],
    };
  }
  const ollama = ollamaResult.value;
  if (!ollama.configuration.enabled) return catalog;
  const selected = ollama.models.find((model) => model.id === ollama.configuration.model);
  return {
    ...catalog,
    providers: [
      ...catalog.providers.filter((provider) => provider.id !== OPENCODE_OLLAMA_PROVIDER_ID),
      {
        id: OPENCODE_OLLAMA_PROVIDER_ID,
        name: 'Ollama (local via OpenCode)',
        availableForSelection: ollama.status === 'ready' && Boolean(selected),
        availabilityStatus:
          ollama.status === 'ready' && selected ? ('available' as const) : ('unavailable' as const),
        availabilityMessage: ollama.message,
        suggestedModel: selected?.id,
        models: selected
          ? [
              {
                id: selected.id,
                name: selected.name,
                status: 'active' as const,
                sizeBytes: selected.sizeBytes,
                contextTokens: selected.runningContextTokens ?? selected.contextTokens,
                tools: selected.tools,
                thinking: selected.thinking,
                vision: selected.vision,
              },
            ]
          : [],
      },
    ],
  };
}

export class OpenCodeModelsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>
  ) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeModelCatalog> {
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('OpenCode model catalog does not accept query parameters.');
    }
    return readModelCatalog(this.db, this.config, params);
  }
}

export function createOpenCodeModelsService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>
) {
  return new OpenCodeModelsService(db, config);
}
