import type { AgorConfig } from '@agor/core/config';
import {
  isPowerManagementObservationSupported,
  type ResolvedPowerManagementConfig,
  resolvePowerManagementConfig,
} from '@agor/core/config';
import type { DaemonMetrics } from '../metrics/index.js';
import { PowerPolicyController } from './controller.js';
import { MacOSPowerSourceProvider } from './macos-provider.js';

export function createPowerPolicyController(
  config: AgorConfig,
  metrics?: DaemonMetrics,
  platform: NodeJS.Platform = process.platform
): PowerPolicyController {
  const resolved: ResolvedPowerManagementConfig = resolvePowerManagementConfig(
    config.execution?.power_management
  );
  const providerSupported = isPowerManagementObservationSupported(config, platform);
  const provider = providerSupported
    ? new MacOSPowerSourceProvider(resolved.providerTimeoutMs, undefined, platform)
    : null;
  return new PowerPolicyController(resolved, provider, undefined, metrics, providerSupported);
}

export * from './controller.js';
export * from './macos-provider.js';
export * from './state-machine.js';
export * from './types.js';
