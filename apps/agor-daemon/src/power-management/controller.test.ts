import { resolvePowerManagementConfig } from '@agor/core/config';
import { describe, expect, it, vi } from 'vitest';
import { PowerPolicyController } from './controller.js';
import type { PowerPolicyClock } from './types.js';

class FakeClock implements PowerPolicyClock {
  monotonic = 0;
  monotonicMs = () => this.monotonic;
  wallNow = () => new Date(Date.UTC(2026, 0, 1) + this.monotonic);
  sleep = vi.fn(async (ms: number) => {
    this.monotonic += ms;
  });
}

const config = () =>
  resolvePowerManagementConfig({
    mode: 'enforce',
    provider: 'macos',
    online_stable_ms: 10_000,
    on_battery_debounce_ms: 1_000,
    stale_after_ms: 10_000,
    poll_interval_ms: 2_000,
    provider_timeout_ms: 500,
    recovery_dispatch_interval_ms: 2_000,
  });

describe('PowerPolicyController admission fence', () => {
  it('holds all work while unknown, ordinary work in conserve, and all work in critical', async () => {
    const clock = new FakeClock();
    const controller = new PowerPolicyController(config(), null, clock);
    expect((await controller.withDispatchPermit('essential', async () => 1)).decision.outcome).toBe(
      'held'
    );
    await controller.ingestForTest({ condition: 'battery', communication: 'ok' });
    clock.monotonic += 1_000;
    await controller.ingestForTest({ condition: 'battery', communication: 'ok' });
    expect((await controller.withDispatchPermit('normal', async () => 1)).decision.outcome).toBe(
      'held'
    );
    await expect(
      controller.withDispatchPermit('essential', async () => 'essential')
    ).resolves.toMatchObject({ decision: { outcome: 'allowed' }, value: 'essential' });
    await controller.ingestForTest({ condition: 'battery', communication: 'ok', critical: true });
    expect((await controller.withDispatchPermit('essential', async () => 1)).decision.outcome).toBe(
      'held'
    );
  });

  it('serializes a critical transition against the exact claim and never loses held work', async () => {
    const clock = new FakeClock();
    const controller = new PowerPolicyController(config(), null, clock);
    await controller.ingestForTest({ condition: 'online', communication: 'ok' });
    clock.monotonic += 10_000;
    await controller.ingestForTest({ condition: 'online', communication: 'ok' });

    let releaseClaim!: () => void;
    const claimBlocked = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claim = vi.fn(async () => {
      await claimBlocked;
      return 'claimed';
    });
    const first = controller.withDispatchPermit('normal', claim);
    await Promise.resolve();
    const transition = controller.ingestForTest({
      condition: 'battery',
      communication: 'ok',
      critical: true,
    });
    releaseClaim();
    await expect(first).resolves.toMatchObject({ value: 'claimed' });
    await transition;

    const secondClaim = vi.fn(async () => 'must-not-run');
    const held = await controller.withDispatchPermit('normal', secondClaim);
    expect(held.decision.outcome).toBe('held');
    expect(secondClaim).not.toHaveBeenCalled();
  });

  it('re-reads effective priority inside the same fence as the dispatch claim', async () => {
    const clock = new FakeClock();
    const controller = new PowerPolicyController(config(), null, clock);
    await controller.ingestForTest({ condition: 'battery', communication: 'ok' });
    clock.monotonic += 1_000;
    await controller.ingestForTest({ condition: 'battery', communication: 'ok' });
    let priority: 'normal' | 'essential' = 'essential';
    await controller.withPriorityMutation(async () => {
      priority = 'normal';
    });
    const claim = vi.fn(async () => 'must-not-run');
    const outcome = await controller.withDispatchPermit(async () => priority, claim);
    expect(outcome.decision.outcome).toBe('held');
    expect(claim).not.toHaveBeenCalled();
  });

  it('observe mode reports would-hold but never gates', async () => {
    const clock = new FakeClock();
    const observe = new PowerPolicyController({ ...config(), mode: 'observe' }, null, clock);
    const result = await observe.withDispatchPermit(
      'normal',
      async () => 'queued-prompt-preserved'
    );
    expect(result).toMatchObject({
      decision: { outcome: 'allowed', wouldHold: true },
      value: 'queued-prompt-preserved',
    });
    expect(Object.keys(observe.status()).sort()).toEqual([
      'configuration',
      'freshness',
      'held',
      'mode',
      'provider_supported',
      'reason',
      'recovery_pacing',
      'runtime_settings',
      'state',
      'transitioned_at',
      'would_hold',
    ]);
    await observe.ingestForTest({ condition: 'online', communication: 'ok' });
    clock.monotonic += 10_000;
    await observe.ingestForTest({ condition: 'online', communication: 'ok' });
    await observe.withDispatchPermit('normal', async () => 'unpaced');
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('keeps off mode on the legacy admission path', async () => {
    const off = new PowerPolicyController({ ...config(), mode: 'off' }, null, new FakeClock());
    const priorityRead = vi.fn(async () => 'normal' as const);
    const claim = vi.fn(async () => 'claimed');
    await expect(off.withDispatchPermit(priorityRead, claim)).resolves.toMatchObject({
      value: 'claimed',
    });
    expect(priorityRead).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledOnce();
  });
});

it('applies Off → Observe → Enforce → Off behind the admission fence without restart', async () => {
  const clock = new FakeClock();
  const controller = new PowerPolicyController(
    resolvePowerManagementConfig({ mode: 'off' }),
    null,
    clock
  );
  let revision = 0;
  const apply = (mode: 'off' | 'observe' | 'enforce') => {
    const effective = resolvePowerManagementConfig({
      mode,
      poll_interval_ms: 2_000,
      provider_timeout_ms: 500,
      stale_after_ms: 10_000,
      on_battery_debounce_ms: 1_000,
      online_stable_ms: 10_000,
    });
    revision += 1;
    return controller.applyRuntimeMutation(async () => ({
      effective,
      view: {
        revision,
        source: 'runtime_override',
        operator_defaults: { mode: 'off', provider: 'macos' },
        runtime_override: { mode },
        can_rollback: true,
        rollback_target: revision === 1 ? 'operator_defaults' : 'runtime_override',
      },
    }));
  };

  expect((await apply('observe')).mode).toBe('observe');
  expect((await controller.withDispatchPermit('normal', async () => 'observe')).value).toBe(
    'observe'
  );
  expect((await apply('enforce')).mode).toBe('enforce');
  expect((await controller.withDispatchPermit('normal', async () => 'held')).decision.outcome).toBe(
    'held'
  );
  const off = await apply('off');
  expect(off).toMatchObject({ mode: 'off', state: 'disabled', held: false });
  expect((await controller.withDispatchPermit('normal', async () => 'resumed')).value).toBe(
    'resumed'
  );
});

it('does not admit work between a durable Enforce commit and its in-memory swap', async () => {
  const controller = new PowerPolicyController(
    resolvePowerManagementConfig({ mode: 'off' }),
    null,
    new FakeClock()
  );
  let committed = false;
  let releasePersistence!: () => void;
  const persistenceBlocked = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const mutation = controller.applyRuntimeMutation(async () => {
    committed = true;
    await persistenceBlocked;
    return {
      effective: config(),
      view: {
        revision: 1,
        source: 'runtime_override',
        operator_defaults: { mode: 'off', provider: 'macos' },
        runtime_override: { mode: 'enforce' },
        can_rollback: true,
        rollback_target: 'operator_defaults',
      },
    };
  });
  await vi.waitFor(() => expect(committed).toBe(true));

  const claim = vi.fn(async () => 'must-not-run');
  const dispatch = controller.withDispatchPermit('normal', claim);
  await Promise.resolve();
  expect(claim).not.toHaveBeenCalled();
  releasePersistence();
  await mutation;
  await expect(dispatch).resolves.toMatchObject({ decision: { outcome: 'held' } });
  expect(claim).not.toHaveBeenCalled();
});

it('refuses active runtime policy when provider topology is unsupported', () => {
  const controller = new PowerPolicyController(
    resolvePowerManagementConfig({ mode: 'off' }),
    null,
    new FakeClock(),
    undefined,
    false
  );
  expect(() =>
    controller.assertCanApply(resolvePowerManagementConfig({ mode: 'enforce' }))
  ).toThrow(/cannot be activated/);
});

it('exposes allowlisted current telemetry and clears charge on provider failure', async () => {
  const clock = new FakeClock();
  const controller = new PowerPolicyController(config(), null, clock);
  await controller.ingestForTest({
    condition: 'battery',
    communication: 'ok',
    chargePercent: 72,
    runtimeSeconds: 1200,
  });
  expect(controller.status()).toMatchObject({
    configuration: { mode: 'enforce', critical: { charge_percent: 20 }, max_essential_sessions: 1 },
    observation: {
      condition: 'battery',
      communication: 'ok',
      charge_percent: 72,
      runtime_seconds: 1200,
      observed_at: clock.wallNow().toISOString(),
    },
    recovery_pacing: false,
  });
  await controller.ingestForTest({ condition: 'unknown', communication: 'lost' });
  expect(controller.status().observation).toEqual({
    condition: 'unknown',
    communication: 'lost',
    observed_at: clock.wallNow().toISOString(),
  });
  const disabled = new PowerPolicyController(resolvePowerManagementConfig(undefined), null, clock);
  await disabled.ingestForTest({ condition: 'battery', communication: 'ok', chargePercent: 72 });
  expect(disabled.status()).toMatchObject({
    mode: 'off',
    state: 'disabled',
    reason: 'disabled',
    freshness: 'fresh',
    provider_supported: true,
    held: false,
    would_hold: false,
    observation: { condition: 'battery', communication: 'ok', charge_percent: 72 },
  });
});

it('polls the privacy-filtered provider while policy is off without gating work', async () => {
  vi.useFakeTimers();
  const clock = new FakeClock();
  const provider = {
    read: vi.fn(async () => ({ condition: 'online' as const, communication: 'ok' as const })),
    close: vi.fn(async () => undefined),
  };
  const disabled = new PowerPolicyController(
    resolvePowerManagementConfig(undefined),
    provider,
    clock
  );
  disabled.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(disabled.status()).toMatchObject({
    mode: 'off',
    state: 'disabled',
    provider_supported: true,
    freshness: 'fresh',
    observation: { condition: 'online', communication: 'ok' },
  });
  await disabled.stop();
  expect(provider.close).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it('reports unsupported observation without probing or weakening off-mode admission', async () => {
  const disabled = new PowerPolicyController(
    resolvePowerManagementConfig(undefined),
    null,
    new FakeClock(),
    undefined,
    false
  );
  disabled.start();
  expect(disabled.status()).toMatchObject({
    mode: 'off',
    state: 'disabled',
    provider_supported: false,
    freshness: 'unavailable',
  });
  const claim = vi.fn(async () => 'claimed');
  await expect(disabled.withDispatchPermit('normal', claim)).resolves.toMatchObject({
    value: 'claimed',
  });
  expect(claim).toHaveBeenCalledOnce();
  await disabled.stop();
});
