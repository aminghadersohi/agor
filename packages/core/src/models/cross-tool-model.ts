/** Registry ownership is a selection hint, not a custom provider capability catalog. */

import type { AgenticToolName } from '../types/agentic-tool.js';
import type { Session } from '../types/session.js';
import type { ProviderConnection } from '../types/tenant-agentic-tool.js';
import { AVAILABLE_CLAUDE_MODEL_ALIASES } from './claude.js';
import { CODEX_MODEL_REGISTRY } from './codex.js';
import { GEMINI_MODELS } from './gemini-shared.js';

type FirstPartyModelTool = Extract<AgenticToolName, 'claude-code' | 'codex' | 'gemini'>;

const FIRST_PARTY_MODEL_IDS: Record<FirstPartyModelTool, ReadonlySet<string>> = {
  'claude-code': new Set(
    AVAILABLE_CLAUDE_MODEL_ALIASES.map((model) => normalizeRegistryModelId(model.id))
  ),
  codex: new Set(Object.keys(CODEX_MODEL_REGISTRY).map(normalizeRegistryModelId)),
  gemini: new Set(Object.keys(GEMINI_MODELS).map(normalizeRegistryModelId)),
};

/** Lowercase, drop Google's `models/` prefix and Claude Code's `[1m]` suffix. */
function normalizeRegistryModelId(model: string): string {
  const lower = model.trim().toLowerCase();
  const unprefixed = lower.startsWith('models/') ? lower.slice('models/'.length) : lower;
  return unprefixed.endsWith('[1m]') ? unprefixed.slice(0, -'[1m]'.length) : unprefixed;
}

/** Stored Sessions can still name retired tools, which get no opinion. */
type StoredAgenticToolName = AgenticToolName | (string & {});

function isFirstPartyModelTool(tool: StoredAgenticToolName): tool is FirstPartyModelTool {
  return Object.hasOwn(FIRST_PARTY_MODEL_IDS, tool);
}

/**
 * The first-party tool whose curated registry owns `model`, when that is not
 * `tool` itself. `undefined` when the pair is fine or there is no opinion.
 */
export function findCrossAgenticToolModelOwner(
  model: string | undefined | null,
  tool: StoredAgenticToolName
): FirstPartyModelTool | undefined {
  if (!model || !isFirstPartyModelTool(tool)) return undefined;
  const normalized = normalizeRegistryModelId(model);
  if (FIRST_PARTY_MODEL_IDS[tool].has(normalized)) return undefined;
  for (const [owner, ids] of Object.entries(FIRST_PARTY_MODEL_IDS) as Array<
    [FirstPartyModelTool, ReadonlySet<string>]
  >) {
    if (owner !== tool && ids.has(normalized)) return owner;
  }
  return undefined;
}

/**
 * User-facing error for a model that belongs to another first-party tool, or
 * `undefined` when the selection is acceptable for `tool`.
 */
export function getCrossAgenticToolModelError(
  tool: StoredAgenticToolName,
  modelConfig:
    | (Pick<NonNullable<Session['model_config']>, 'model'> &
        Partial<Pick<NonNullable<Session['model_config']>, 'mode'>>)
    | null
    | undefined,
  provider?: { connection?: ProviderConnection; useNativeAuth: boolean }
): string | undefined {
  const model = modelConfig?.model;
  const owner = findCrossAgenticToolModelOwner(model, tool);
  if (!owner) return undefined;
  // Exact IDs are intentionally provider-specific. Selection/launch preparation
  // cannot know the next Task's provider (especially on a shared Session).
  // Defer to SDK consumption with task-scoped credentials, never the Session creator.
  if (modelConfig?.mode === 'exact') {
    if (!provider) return undefined;
    const connection = provider.connection;
    const endpoint =
      tool === 'codex'
        ? (connection as ProviderConnection<'codex'> | undefined)?.OPENAI_BASE_URL
        : tool === 'claude-code'
          ? (connection as ProviderConnection<'claude-code'> | undefined)?.ANTHROPIC_BASE_URL
          : undefined;
    if (!provider.useNativeAuth && endpoint?.trim()) {
      try {
        const url = new URL(endpoint.trim());
        const nativeHost = tool === 'codex' ? 'api.openai.com' : 'api.anthropic.com';
        if (['http:', 'https:'].includes(url.protocol) && url.hostname !== nativeHost) {
          return undefined;
        }
      } catch {
        /* Invalid endpoints do not establish custom-provider intent. */
      }
    }
  }
  return (
    `Model "${model}" is a ${owner} model and cannot run on a ${tool} session. ` +
    `Choose a ${tool} model; a session keeps the agent it was created with.`
  );
}
