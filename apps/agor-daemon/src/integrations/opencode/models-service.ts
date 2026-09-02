import { resolvePackagedOpenCodeBinary } from '@agor/agentic-tool-opencode/runtime/binary';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams, DeepReadonly, OpenCodeModelCatalog } from '@agor/core/types';
import type { ExecutorCommandResult } from '../../utils/spawn-executor.js';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import { blockOpenCodeNativeStateNamespace } from './native-state-coordinator.js';
import { discoverOpenCodeOllamaForSubject } from './ollama-service.js';

const MODEL_CATALOG_FAILURE = 'OpenCode model catalog could not be loaded. Try again.';

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, config, params);
  let result: ExecutorCommandResult;
  try {
    await resolvePackagedOpenCodeBinary();
    const handle = startOpenCodeExecutorInvocation(
      context.dataHome,
      { operation: 'read-model-catalog' },
      {
        env: context.executorEnv,
        logPrefix: '[OpenCode Models]',
      }
    );
    result = await handle.result;
    if (result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
  } catch {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  if (!result.success || !result.data) {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  const catalog = result.data as OpenCodeModelCatalog;
  const ollama = await discoverOpenCodeOllamaForSubject({ db, config, params });
  if (!ollama.configuration.enabled) return catalog;
  const selected = ollama.models.find((model) => model.id === ollama.configuration.model);
  return {
    ...catalog,
    providers: [
      ...catalog.providers.filter((provider) => provider.id !== 'ollama'),
      {
        id: 'ollama',
        name: 'Ollama (local via OpenCode)',
        availableForSelection: ollama.status === 'ready' && Boolean(selected),
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
