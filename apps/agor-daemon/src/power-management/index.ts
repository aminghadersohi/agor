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

/**
 * A controller pinned to `mode: 'off'`, with no provider and no host ownership.
 *
 * Route registration substitutes this when an upstream-owned caller builds a
 * route context without the fork's power policy. Every fencing method then
 * takes its already-tested disabled path — dispatch is allowed, nothing reads
 * as held, and no transition is ever published — so fork-only fencing degrades
 * to upstream behaviour rather than throwing. It observes nothing and starts
 * no timers unless `start()` is called, which route registration never does.
 *
 * This is not a substitute for real wiring: production constructs a genuine
 * controller and asserts it, so a wiring regression still fails loudly.
 */
export function createDisabledPowerPolicyController(): PowerPolicyController {
  return new PowerPolicyController(
    resolvePowerManagementConfig(undefined),
    null,
    undefined,
    undefined,
    false
  );
}

export * from './controller.js';
export * from './macos-provider.js';
export * from './state-machine.js';
export * from './types.js';
