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
      'reason',
      'recovery_pacing',
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

  it('keeps off mode on the legacy zero-observation admission path', async () => {
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

it('exposes allowlisted current telemetry, clears charge on provider failure, and remains inert off', async () => {
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
  expect(disabled.status().observation).toBeUndefined();
});
