import { describe, expect, it } from 'vitest';
import {
  assertPowerManagementActivationSupported,
  resolvePowerManagementConfig,
} from './power-management';
import type { AgorConfig } from './types';

describe('resolvePowerManagementConfig', () => {
  it('is disabled by default and applies conservative bounded defaults', () => {
    expect(resolvePowerManagementConfig(undefined)).toMatchObject({
      mode: 'off',
      provider: 'macos',
      pollIntervalMs: 5_000,
      providerTimeoutMs: 2_000,
      staleAfterMs: 20_000,
      onBatteryDebounceMs: 10_000,
      onlineStableMs: 60_000,
      maxEssentialSessions: 1,
    });
  });

  it('validates timing relationships and the V1 essential cap', () => {
    expect(() =>
      resolvePowerManagementConfig({
        mode: 'observe',
        poll_interval_ms: 5_000,
        provider_timeout_ms: 5_000,
      })
    ).toThrow(/provider_timeout_ms/);
    expect(() =>
      resolvePowerManagementConfig({ mode: 'observe', max_essential_sessions: 2 })
    ).toThrow(/max_essential_sessions/);
  });
});

describe('assertPowerManagementActivationSupported', () => {
  const base = {
    execution: { power_management: { mode: 'enforce' as const, provider: 'macos' as const } },
    deployment: { mode: 'standalone' as const },
    multi_tenancy: { mode: 'static' as const },
    database: { dialect: 'sqlite' as const },
  } as AgorConfig;

  it('allows disabled mode on every platform with negligible runtime requirements', () => {
    expect(() =>
      assertPowerManagementActivationSupported(
        { execution: { power_management: { mode: 'off' } } } as AgorConfig,
        'linux'
      )
    ).not.toThrow();
  });

  it('rejects unsupported platform and executor/topology activation explicitly', () => {
    expect(() => assertPowerManagementActivationSupported(base, 'linux')).toThrow(/requires macOS/);
    expect(() =>
      assertPowerManagementActivationSupported(
        { ...base, execution: { ...base.execution, unix_user_mode: 'delegated' } },
        'darwin'
      )
    ).toThrow(/unix_user_mode simple/);
    expect(() =>
      assertPowerManagementActivationSupported(
        { ...base, database: { dialect: 'postgresql' } } as AgorConfig,
        'darwin'
      )
    ).toThrow(/database.dialect sqlite/);
  });
});
