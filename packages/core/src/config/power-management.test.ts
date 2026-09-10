import { describe, expect, it } from 'vitest';
import {
  assertPowerManagementActivationSupported,
  assertStandalonePowerOwnershipConfig,
  isPowerManagementObservationSupported,
  powerManagementMutableSettingsFromResolved,
  powerManagementSettingsFromResolved,
  resolvePowerManagementConfig,
  resolvePowerManagementRuntimeOverlay,
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

  it('marks read-only observation unsupported outside the complete V1 topology', () => {
    expect(isPowerManagementObservationSupported(base, 'darwin')).toBe(true);
    expect(isPowerManagementObservationSupported(base, 'linux')).toBe(false);
    expect(
      isPowerManagementObservationSupported(
        { ...base, multi_tenancy: { mode: 'required_from_auth' } },
        'darwin'
      )
    ).toBe(false);
    expect(
      isPowerManagementObservationSupported(
        { ...base, execution: { ...base.execution, executor_command_template: 'remote' } },
        'darwin'
      )
    ).toBe(false);
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
    ).toThrow(/standalone_power_host_id/);
  });
});

it('round-trips only supported power configuration into the admin YAML projection', () => {
  const resolved = resolvePowerManagementConfig({ mode: 'observe' });
  const projection = powerManagementSettingsFromResolved({
    ...resolved,
    privateValue: 'never expose',
  } as typeof resolved);
  expect(resolvePowerManagementConfig(projection)).toEqual(resolved);
  expect(projection).not.toHaveProperty('privateValue');
});

it('gives a normalized runtime policy explicit precedence without making provider mutable', () => {
  const operator = resolvePowerManagementConfig({
    mode: 'off',
    provider: 'macos',
    online_stable_ms: 60_000,
  });
  const effective = resolvePowerManagementRuntimeOverlay(operator, {
    mode: 'enforce',
    online_stable_ms: 90_000,
  });
  expect(effective).toMatchObject({
    mode: 'enforce',
    provider: 'macos',
    onlineStableMs: 90_000,
    maxEssentialSessions: 1,
  });
  expect(powerManagementMutableSettingsFromResolved(effective)).not.toHaveProperty('provider');
});

describe('standalone PostgreSQL ownership topology', () => {
  const supported = {
    deployment: {
      mode: 'standalone',
      standalone_power_host_id: '00000000-0000-4000-8000-000000000001',
    },
    database: { dialect: 'postgresql' },
    multi_tenancy: { mode: 'static' },
    execution: { unix_user_mode: 'simple', power_management: { mode: 'off' } },
  } as AgorConfig;
  it.each(['off', 'observe', 'enforce'] as const)(
    'supports %s only with the full immutable topology',
    (mode) => {
      const config = {
        ...supported,
        execution: { ...supported.execution, power_management: { mode } },
      };
      expect(() => assertStandalonePowerOwnershipConfig(config, 'darwin')).not.toThrow();
      expect(() => assertPowerManagementActivationSupported(config, 'darwin')).not.toThrow();
      expect(isPowerManagementObservationSupported(config, 'darwin')).toBe(true);
    }
  );
  it.each([
    { deployment: { ...supported.deployment, mode: 'ha' } },
    { multi_tenancy: { mode: 'required_from_auth' } },
    { database: { dialect: 'sqlite' } },
    { execution: { ...supported.execution, unix_user_mode: 'sandbox' } },
    { execution: { ...supported.execution, unix_user_mode: 'delegated' } },
    { execution: { ...supported.execution, executor_command_template: 'fictional-remote' } },
  ])('rejects unsupported topology even while Off: %j', (override) => {
    expect(() =>
      assertStandalonePowerOwnershipConfig({ ...supported, ...override } as AgorConfig, 'darwin')
    ).toThrow(/requires macOS/);
  });
  it('rejects nonmacOS and invalid or absent operator identity for active PG policy', () => {
    expect(() => assertStandalonePowerOwnershipConfig(supported, 'linux')).toThrow(
      /requires macOS/
    );
    expect(() =>
      assertStandalonePowerOwnershipConfig(
        { ...supported, deployment: { standalone_power_host_id: 'copied-hostname' } },
        'darwin'
      )
    ).toThrow(/UUID/);
    const missing = {
      ...supported,
      deployment: { mode: 'standalone' as const },
      execution: { power_management: { mode: 'observe' as const } },
    };
    expect(isPowerManagementObservationSupported(missing, 'darwin')).toBe(false);
    expect(() => assertPowerManagementActivationSupported(missing, 'darwin')).toThrow(
      /standalone_power_host_id/
    );
  });
});
