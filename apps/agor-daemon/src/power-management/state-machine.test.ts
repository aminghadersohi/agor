import { resolvePowerManagementConfig } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import { PowerPolicyStateMachine } from './state-machine.js';
import type { PowerPolicyClock } from './types.js';

class FakeClock implements PowerPolicyClock {
  monotonic = 0;
  wall = Date.UTC(2026, 0, 1);
  monotonicMs(): number {
    return this.monotonic;
  }
  wallNow(): Date {
    return new Date(this.wall);
  }
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
  advance(ms: number): void {
    this.monotonic += ms;
    this.wall += ms;
  }
}

const observation = (condition: 'online' | 'battery') => ({
  condition,
  communication: 'ok' as const,
});

function machine(clock: FakeClock) {
  return new PowerPolicyStateMachine(
    resolvePowerManagementConfig({ mode: 'enforce', provider: 'macos' }),
    clock
  );
}

describe('PowerPolicyStateMachine', () => {
  it('starts unknown, debounces battery, bypasses debounce for low battery, and stabilizes recovery', () => {
    const clock = new FakeClock();
    const policy = machine(clock);
    expect(policy.snapshot().state).toBe('unknown');

    policy.ingest(observation('online'));
    expect(policy.snapshot().state).toBe('recovering');
    for (let sample = 0; sample < 12; sample += 1) {
      clock.advance(5_000);
      policy.ingest(observation('online'));
    }
    expect(policy.snapshot().state).toBe('normal');

    policy.ingest(observation('battery'));
    expect(policy.snapshot().state).toBe('normal');
    clock.advance(9_999);
    policy.ingest(observation('battery'));
    expect(policy.snapshot().state).toBe('normal');
    clock.advance(1);
    policy.ingest(observation('battery'));
    expect(policy.snapshot().state).toBe('conserve');

    policy.ingest({ ...observation('battery'), critical: true });
    expect(policy.snapshot()).toMatchObject({ state: 'critical', reason: 'low_battery' });
    policy.ingest(observation('online'));
    expect(policy.snapshot().state).toBe('recovering');
    for (let sample = 0; sample < 11; sample += 1) {
      clock.advance(5_000);
      policy.ingest(observation('online'));
    }
    clock.advance(4_999);
    policy.ingest(observation('online'));
    expect(policy.snapshot().state).toBe('recovering');
    clock.advance(1);
    policy.ingest(observation('online'));
    expect(policy.snapshot().state).toBe('normal');
  });

  it('requires consecutive critical threshold samples only when metrics exist', () => {
    const clock = new FakeClock();
    const policy = machine(clock);
    policy.ingest({ ...observation('battery'), chargePercent: 19 });
    expect(policy.snapshot().state).toBe('unknown');
    policy.ingest({ ...observation('battery'), chargePercent: 19 });
    expect(policy.snapshot()).toMatchObject({
      state: 'critical',
      reason: 'critical_threshold',
    });
  });

  it('fails closed for stale, lost, contradictory and flapping observations without terminating work', () => {
    const clock = new FakeClock();
    const policy = machine(clock);
    policy.ingest(observation('online'));
    for (let sample = 0; sample < 12; sample += 1) {
      clock.advance(5_000);
      policy.ingest(observation('online'));
    }
    clock.advance(20_001);
    policy.evaluateStaleness();
    expect(policy.snapshot()).toMatchObject({ state: 'unknown', reason: 'stale_observation' });

    policy.ingest(observation('battery'));
    clock.advance(10_000);
    policy.ingest(observation('battery'));
    expect(policy.snapshot().state).toBe('conserve');
    policy.ingest({ condition: 'unknown', communication: 'lost', reason: 'communication_lost' });
    expect(policy.snapshot().state).toBe('conserve');
    for (let sample = 0; sample < 6; sample += 1) {
      clock.advance(5_000);
      policy.ingest({ condition: 'unknown', communication: 'lost', reason: 'communication_lost' });
    }
    expect(policy.snapshot().state).toBe('critical');

    policy.ingest(observation('online'));
    clock.advance(5_000);
    policy.ingest(observation('battery'));
    expect(policy.snapshot().state).not.toBe('normal');
  });

  it('resets debounce timers on monotonic discontinuity or host suspend-sized gaps', () => {
    const clock = new FakeClock();
    const policy = machine(clock);
    policy.ingest(observation('battery'));
    clock.monotonic = -1;
    policy.ingest(observation('battery'));
    expect(policy.snapshot()).toMatchObject({ state: 'unknown', reason: 'on_battery_debounce' });

    clock.monotonic = 1_000_000;
    policy.ingest(observation('online'));
    expect(policy.snapshot().state).toBe('recovering');
  });
});
