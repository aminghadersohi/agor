import type { PowerManagementMode } from '../types/power-management';
import type { AgorConfig, AgorPowerManagementSettings } from './types';

export interface ResolvedPowerManagementConfig {
  mode: PowerManagementMode;
  provider: 'macos';
  pollIntervalMs: number;
  providerTimeoutMs: number;
  staleAfterMs: number;
  onBatteryDebounceMs: number;
  onlineStableMs: number;
  recoveryDispatchIntervalMs: number;
  maxEssentialSessions: 1;
  critical: {
    chargePercent?: number;
    runtimeSeconds?: number;
    consecutiveSamples: number;
  };
  communicationLoss: {
    lastOnBatteryCriticalAfterMs: number;
  };
}

const DEFAULTS = {
  pollIntervalMs: 5_000,
  providerTimeoutMs: 2_000,
  staleAfterMs: 20_000,
  onBatteryDebounceMs: 10_000,
  onlineStableMs: 60_000,
  recoveryDispatchIntervalMs: 2_000,
  maxEssentialSessions: 1 as const,
  criticalChargePercent: 20,
  criticalRuntimeSeconds: 300,
  criticalConsecutiveSamples: 2,
  lastOnBatteryCriticalAfterMs: 30_000,
} as const;

function integerInRange(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Config error: ${path} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

export function resolvePowerManagementConfig(
  input: AgorPowerManagementSettings | undefined
): ResolvedPowerManagementConfig {
  const mode = input?.mode ?? 'off';
  if (!['off', 'observe', 'enforce'].includes(mode)) {
    throw new Error(
      'Config error: execution.power_management.mode must be off, observe, or enforce'
    );
  }
  const provider = input?.provider ?? 'macos';
  if (provider !== 'macos') {
    throw new Error('Config error: execution.power_management.provider must be macos');
  }
  const pollIntervalMs = integerInRange(
    input?.poll_interval_ms ?? DEFAULTS.pollIntervalMs,
    'execution.power_management.poll_interval_ms',
    1_000,
    60_000
  );
  const providerTimeoutMs = integerInRange(
    input?.provider_timeout_ms ?? DEFAULTS.providerTimeoutMs,
    'execution.power_management.provider_timeout_ms',
    100,
    30_000
  );
  const staleAfterMs = integerInRange(
    input?.stale_after_ms ?? DEFAULTS.staleAfterMs,
    'execution.power_management.stale_after_ms',
    2_000,
    300_000
  );
  const onBatteryDebounceMs = integerInRange(
    input?.on_battery_debounce_ms ?? DEFAULTS.onBatteryDebounceMs,
    'execution.power_management.on_battery_debounce_ms',
    0,
    300_000
  );
  const onlineStableMs = integerInRange(
    input?.online_stable_ms ?? DEFAULTS.onlineStableMs,
    'execution.power_management.online_stable_ms',
    1_000,
    600_000
  );
  const recoveryDispatchIntervalMs = integerInRange(
    input?.recovery_dispatch_interval_ms ?? DEFAULTS.recoveryDispatchIntervalMs,
    'execution.power_management.recovery_dispatch_interval_ms',
    0,
    60_000
  );
  const maxEssentialSessions = integerInRange(
    input?.max_essential_sessions ?? DEFAULTS.maxEssentialSessions,
    'execution.power_management.max_essential_sessions',
    1,
    1
  ) as 1;
  const chargePercent = integerInRange(
    input?.critical?.charge_percent ?? DEFAULTS.criticalChargePercent,
    'execution.power_management.critical.charge_percent',
    1,
    100
  );
  const runtimeSeconds = integerInRange(
    input?.critical?.runtime_seconds ?? DEFAULTS.criticalRuntimeSeconds,
    'execution.power_management.critical.runtime_seconds',
    1,
    86_400
  );
  const consecutiveSamples = integerInRange(
    input?.critical?.consecutive_samples ?? DEFAULTS.criticalConsecutiveSamples,
    'execution.power_management.critical.consecutive_samples',
    1,
    10
  );
  const lastOnBatteryCriticalAfterMs = integerInRange(
    input?.communication_loss?.last_on_battery_critical_after_ms ??
      DEFAULTS.lastOnBatteryCriticalAfterMs,
    'execution.power_management.communication_loss.last_on_battery_critical_after_ms',
    0,
    600_000
  );

  if (providerTimeoutMs >= pollIntervalMs) {
    throw new Error(
      'Config error: execution.power_management.provider_timeout_ms must be less than poll_interval_ms'
    );
  }
  if (staleAfterMs < pollIntervalMs * 2) {
    throw new Error(
      'Config error: execution.power_management.stale_after_ms must be at least two poll intervals'
    );
  }
  if (onlineStableMs < onBatteryDebounceMs) {
    throw new Error(
      'Config error: execution.power_management.online_stable_ms must be at least on_battery_debounce_ms'
    );
  }

  return {
    mode,
    provider,
    pollIntervalMs,
    providerTimeoutMs,
    staleAfterMs,
    onBatteryDebounceMs,
    onlineStableMs,
    recoveryDispatchIntervalMs,
    maxEssentialSessions,
    critical: { chargePercent, runtimeSeconds, consecutiveSamples },
    communicationLoss: { lastOnBatteryCriticalAfterMs },
  };
}

/** Reject configurations whose host-local observation cannot fence all executors. */
export function assertPowerManagementActivationSupported(
  config: AgorConfig,
  platform: NodeJS.Platform = process.platform
): void {
  const resolved = resolvePowerManagementConfig(config.execution?.power_management);
  if (resolved.mode === 'off') return;
  if (platform !== 'darwin') {
    throw new Error(
      'Config error: execution.power_management is active but provider macos requires macOS'
    );
  }
  if ((config.deployment?.mode ?? 'standalone') !== 'standalone') {
    throw new Error('Config error: execution.power_management requires deployment.mode standalone');
  }
  if ((config.multi_tenancy?.mode ?? 'static') !== 'static') {
    throw new Error('Config error: execution.power_management requires multi_tenancy.mode static');
  }
  if ((config.database?.dialect ?? 'sqlite') !== 'sqlite') {
    throw new Error('Config error: execution.power_management V1 requires database.dialect sqlite');
  }
  if ((config.execution?.unix_user_mode ?? 'simple') !== 'simple') {
    throw new Error('Config error: execution.power_management V1 requires unix_user_mode simple');
  }
  if (config.execution?.executor_command_template) {
    throw new Error(
      'Config error: execution.power_management cannot protect templated or remote executors'
    );
  }
}

/** Whether read-only host observation is truthful for the V1 process-local topology. */
export function isPowerManagementObservationSupported(
  config: AgorConfig,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    platform === 'darwin' &&
    (config.deployment?.mode ?? 'standalone') === 'standalone' &&
    (config.multi_tenancy?.mode ?? 'static') === 'static' &&
    (config.database?.dialect ?? 'sqlite') === 'sqlite' &&
    (config.execution?.unix_user_mode ?? 'simple') === 'simple' &&
    !config.execution?.executor_command_template
  );
}

/** Explicit, credential-free configuration projection for the admin UI and YAML drafts. */
export function powerManagementSettingsFromResolved(
  config: ResolvedPowerManagementConfig
): AgorPowerManagementSettings {
  return {
    mode: config.mode,
    provider: config.provider,
    poll_interval_ms: config.pollIntervalMs,
    provider_timeout_ms: config.providerTimeoutMs,
    stale_after_ms: config.staleAfterMs,
    on_battery_debounce_ms: config.onBatteryDebounceMs,
    online_stable_ms: config.onlineStableMs,
    recovery_dispatch_interval_ms: config.recoveryDispatchIntervalMs,
    max_essential_sessions: config.maxEssentialSessions,
    critical: {
      charge_percent: config.critical.chargePercent,
      runtime_seconds: config.critical.runtimeSeconds,
      consecutive_samples: config.critical.consecutiveSamples,
    },
    communication_loss: {
      last_on_battery_critical_after_ms: config.communicationLoss.lastOnBatteryCriticalAfterMs,
    },
  };
}
