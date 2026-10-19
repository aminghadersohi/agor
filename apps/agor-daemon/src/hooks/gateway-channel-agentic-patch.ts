import { GATEWAY_REDACTED_SENTINEL, type GatewayChannel } from '@agor/core/types';

type EnvVar = { key: string; value: string; forceOverride: boolean };
type ExistingAgenticConfig = GatewayChannel['agentic_config'] | null | undefined;

/**
 * Resolve the agentic-config portion of a gateway-channel patch against the
 * stored channel, in place.
 *
 * - `agentic_config` omitted → nothing to resolve; the stored value stays
 *   untouched. A patch that only changes `config`, `enabled`, etc. must never
 *   rewrite (or re-materialize) agentic config as a side effect.
 * - `agentic_config === null` → explicit clear; do not resurrect env vars.
 * - `envVars` omitted → preserve the stored env vars.
 * - `envVars === []` → explicitly delete all env vars.
 * - `envVars` with redaction sentinels → substitute the stored value per key.
 *
 * `loadExisting` is only called when stored values are actually needed.
 */
export async function resolveGatewayAgenticConfigPatch(
  data: Record<string, unknown>,
  loadExisting: () => Promise<ExistingAgenticConfig>
): Promise<void> {
  const patch = data.agentic_config;
  if (patch === undefined || patch === null) return;
  const ac = patch as Record<string, unknown>;
  const incomingVars = ac.envVars as EnvVar[] | undefined;

  if (incomingVars === undefined) {
    const existing = await loadExisting();
    if (existing?.envVars) ac.envVars = existing.envVars;
    return;
  }
  if (incomingVars.length === 0) return;
  if (!incomingVars.some((v) => v.value === GATEWAY_REDACTED_SENTINEL)) return;

  const existingByKey = new Map(
    ((await loadExisting())?.envVars ?? []).map((v) => [v.key, v.value])
  );
  ac.envVars = incomingVars.map((v) =>
    v.value === GATEWAY_REDACTED_SENTINEL && existingByKey.has(v.key)
      ? { ...v, value: existingByKey.get(v.key)! }
      : v
  );
}
