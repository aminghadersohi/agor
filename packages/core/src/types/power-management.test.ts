import { describe, expect, it } from 'vitest';
import {
  type PowerManagementStatus,
  powerAdmissionHoldsPriority,
  toPowerAdmissionStatus,
} from './power-management';

describe('toPowerAdmissionStatus', () => {
  it('keeps only held/state/reason/transitioned_at from the admin status', () => {
    const status: PowerManagementStatus = {
      ownership: 'owned',
      configuration: { mode: 'enforce' },
      provider_supported: true,
      observation: {
        condition: 'battery',
        communication: 'ok',
        observed_at: '2026-09-27T00:00:00.000Z',
        charge_percent: 42,
        runtime_seconds: 900,
      },
      recovery_pacing: false,
      mode: 'enforce',
      state: 'conserve',
      freshness: 'fresh',
      reason: 'on_battery',
      transitioned_at: '2026-09-27T00:00:00.000Z',
      observation_age_ms: 10,
      would_hold: true,
      held: true,
    };
    expect(toPowerAdmissionStatus(status)).toEqual({
      held: true,
      state: 'conserve',
      reason: 'on_battery',
      transitioned_at: '2026-09-27T00:00:00.000Z',
    });
  });
});

describe('powerAdmissionHoldsPriority', () => {
  it('holds nothing when admission is not held', () => {
    expect(powerAdmissionHoldsPriority({ held: false, state: 'critical' }, 'normal')).toBe(false);
  });

  it('exempts only the Essential session, and only while conserving', () => {
    expect(powerAdmissionHoldsPriority({ held: true, state: 'conserve' }, 'normal')).toBe(true);
    expect(powerAdmissionHoldsPriority({ held: true, state: 'conserve' }, undefined)).toBe(true);
    expect(powerAdmissionHoldsPriority({ held: true, state: 'conserve' }, 'essential')).toBe(false);
    expect(powerAdmissionHoldsPriority({ held: true, state: 'critical' }, 'essential')).toBe(true);
  });
});
