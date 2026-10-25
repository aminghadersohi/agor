/**
 * Hard validation: is this model a curated model of a *different* agentic tool?
 *
 * `lintModelToolMatch` only warns, on purpose: users pin custom model strings
 * (BYOK proxies, fine-tunes, dated snapshots), so a family prefix alone is not
 * proof of a mistake. A model ID that Agor's own registry lists for another
 * first-party runtime is different: a Codex Session handed `claude-opus-5-5`,
 * or a Claude Code Session handed `gpt-6-astra`, can only fail at the SDK
 * (often as an opaque "turn failed"). That happens when configuration
 * materialized for one runtime is written onto a Session of another, e.g. a
 * gateway channel that switched runtimes refreshing an older thread Session.
 *
 * Only curated registry IDs are rejected, and only when the Session's own tool
 * does not also list the ID. Custom strings and proxy tools are never rejected.
 */

import type { AgenticToolName } from '../types/agentic-tool.js';
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
  modelConfig: { model?: string | null } | null | undefined
): string | undefined {
  const model = modelConfig?.model;
  const owner = findCrossAgenticToolModelOwner(model, tool);
  if (!owner) return undefined;
  return (
    `Model "${model}" is a ${owner} model and cannot run on a ${tool} session. ` +
    `Choose a ${tool} model; a session keeps the agent it was created with.`
  );
}
