import { describe, expect, it } from 'vitest';
import { resolveRestartRecoverySettings } from './restart-recovery';

describe('restart recovery configuration', () => {
  it('is opt-in and keeps abrupt-crash recovery separately disabled', () => {
    expect(resolveRestartRecoverySettings()).toEqual({
      enabled: false,
      delayMs: 2_000,
      maxTasksPerStart: 50,
      resumeAfterCrash: false,
    });
  });

  it('resolves explicit pacing and crash recovery settings', () => {
    expect(
      resolveRestartRecoverySettings({
        restart_recovery: {
          enabled: true,
          delay_ms: 750,
          max_tasks_per_start: 12,
          resume_after_crash: true,
        },
      })
    ).toEqual({ enabled: true, delayMs: 750, maxTasksPerStart: 12, resumeAfterCrash: true });
  });

  it.each([
    [{ delay_ms: 249 }, 'delay_ms'],
    [{ delay_ms: 60_001 }, 'delay_ms'],
    [{ max_tasks_per_start: 0 }, 'max_tasks_per_start'],
    [{ max_tasks_per_start: 501 }, 'max_tasks_per_start'],
  ])('rejects unsafe bounds in %s', (restartRecovery, expectedKey) => {
    expect(() => resolveRestartRecoverySettings({ restart_recovery: restartRecovery })).toThrow(
      expectedKey
    );
  });
});
