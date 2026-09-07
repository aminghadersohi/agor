import type { AgorConfig } from '@agor/core/config';
import {
  type ResolvedPowerManagementConfig,
  resolvePowerManagementConfig,
} from '@agor/core/config';
import type { DaemonMetrics } from '../metrics/index.js';
import { PowerPolicyController } from './controller.js';
import { MacOSPowerSourceProvider } from './macos-provider.js';

export function createPowerPolicyController(
  config: AgorConfig,
  metrics?: DaemonMetrics
): PowerPolicyController {
  const resolved: ResolvedPowerManagementConfig = resolvePowerManagementConfig(
    config.execution?.power_management
  );
  const provider =
    resolved.mode === 'off' ? null : new MacOSPowerSourceProvider(resolved.providerTimeoutMs);
  return new PowerPolicyController(resolved, provider, undefined, metrics);
}

export * from './controller.js';
export * from './macos-provider.js';
export * from './state-machine.js';
export * from './types.js';
