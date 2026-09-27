import type { OpenCodeCatalogProvider, OpenCodeModelCatalog } from '@agor/core/types';
import type { McpContext } from '../server.js';

const DISCOVERY_FAILURE = 'OpenCode provider readiness could not be read for this caller.';

/**
 * Caller-specific OpenCode readiness for `agor_models_list`.
 *
 * Reads the same `/opencode-models` catalog the Providers settings UI uses,
 * with the caller's own params, so configured providers and the experimental
 * Ollama preset report the caller's readiness. The catalog is already
 * secret-safe (no credentials or endpoint URLs); this only compacts it so
 * agents see selectable models and why other providers are unavailable.
 * Settings writes stay UI-only.
 */
export async function readOpenCodeModelReadiness(ctx: McpContext) {
  let catalog: OpenCodeModelCatalog;
  try {
    catalog = await ctx.app.service('opencode-models').find(ctx.baseServiceParams);
  } catch (error) {
    return { discovery: 'failed' as const, error: publicErrorMessage(error) };
  }
  const ready = catalog.providers.filter((provider) => provider.availableForSelection);
  const unavailable = catalog.providers.filter((provider) => !provider.availableForSelection);
  return {
    discovery: 'ok' as const,
    runtimeVersion: catalog.runtimeVersion,
    ...(catalog.suggestedSelection ? { suggestedSelection: catalog.suggestedSelection } : {}),
    readyProviders: ready.map((provider) => ({
      ...providerSummary(provider),
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        status: model.status,
        ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
        ...(model.tools === undefined ? {} : { tools: model.tools }),
      })),
    })),
    unavailableProviders: unavailable.map(providerSummary),
  };
}

function providerSummary(provider: OpenCodeCatalogProvider) {
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.availabilityStatus ? { availabilityStatus: provider.availabilityStatus } : {}),
    ...(provider.availabilityMessage ? { availabilityMessage: provider.availabilityMessage } : {}),
    ...(provider.suggestedModel ? { suggestedModel: provider.suggestedModel } : {}),
  };
}

/** Feathers errors carry reviewed user-facing text; anything else stays generic. */
function publicErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const { code, message } = error as { code: unknown; message: unknown };
    if (typeof code === 'number' && code >= 400 && code < 500 && typeof message === 'string') {
      return message;
    }
  }
  return DISCOVERY_FAILURE;
}
