import type { ResolvedPowerManagementConfig } from '@agor/core/config';
import type { PowerManagementStatus, PowerPolicyReason, PowerPolicyState } from '@agor/core/types';
import type { PowerObservation, PowerPolicyClock } from './types.js';

export interface PowerPolicyTransition {
  previous: PowerPolicyState;
  current: PowerPolicyState;
  reason: PowerPolicyReason;
  status: PowerManagementStatus;
}

export class PowerPolicyStateMachine {
  private state: PowerPolicyState;
  private reason: PowerPolicyReason;
  private transitionedAt: Date;
  private lastNow: number;
  private lastObservationAt?: number;
  private lastTrustedCondition?: 'online' | 'battery';
  private batterySince?: number;
  private onlineSince?: number;
  private communicationLostSince?: number;
  private criticalSamples = 0;

  constructor(
    private readonly config: ResolvedPowerManagementConfig,
    private readonly clock: PowerPolicyClock
  ) {
    this.state = config.mode === 'off' ? 'disabled' : 'unknown';
    this.reason = config.mode === 'off' ? 'disabled' : 'startup';
    this.transitionedAt = clock.wallNow();
    this.lastNow = clock.monotonicMs();
  }

  ingest(observation: PowerObservation): PowerPolicyTransition | null {
    const now = this.clock.monotonicMs();
    this.handleClockDiscontinuity(now);
    this.lastNow = now;
    if (this.config.mode === 'off') {
      // Policy Off still permits privacy-bounded, read-only provider monitoring on
      // supported topologies. It never changes policy state or admission behavior.
      if (observation.communication === 'ok') this.lastObservationAt = now;
      return null;
    }

    if (observation.communication !== 'ok') {
      this.criticalSamples = 0;
      return this.handleCommunicationLoss(now, observation.reason ?? 'communication_lost');
    }

    this.lastObservationAt = now;
    this.communicationLostSince = undefined;
    if (observation.condition === 'unknown') {
      this.batterySince = undefined;
      this.onlineSince = undefined;
      this.criticalSamples = 0;
      return this.transition(
        this.lastTrustedCondition === 'battery' ? 'conserve' : 'unknown',
        observation.reason ?? 'contradictory_observation'
      );
    }

    this.lastTrustedCondition = observation.condition;
    if (observation.condition === 'online') {
      this.batterySince = undefined;
      this.criticalSamples = 0;
      if (this.state === 'normal') {
        this.onlineSince = now;
        return this.transition('normal', 'online');
      }
      this.onlineSince ??= now;
      if (now - this.onlineSince >= this.config.onlineStableMs) {
        return this.transition('normal', 'online');
      }
      return this.transition('recovering', 'recovering');
    }

    this.onlineSince = undefined;
    const thresholdCritical =
      (observation.chargePercent !== undefined &&
        observation.chargePercent <= (this.config.critical.chargePercent ?? -1)) ||
      (observation.runtimeSeconds !== undefined &&
        observation.runtimeSeconds <= (this.config.critical.runtimeSeconds ?? -1));
    this.criticalSamples = thresholdCritical ? this.criticalSamples + 1 : 0;
    if (observation.critical) return this.transition('critical', 'low_battery');
    if (this.criticalSamples >= this.config.critical.consecutiveSamples) {
      return this.transition('critical', 'critical_threshold');
    }
    if (this.state === 'critical') return null;
    this.batterySince ??= now;
    if (now - this.batterySince >= this.config.onBatteryDebounceMs) {
      return this.transition('conserve', 'on_battery');
    }
    return this.transition(this.state === 'normal' ? 'normal' : 'unknown', 'on_battery_debounce');
  }

  evaluateStaleness(): PowerPolicyTransition | null {
    const now = this.clock.monotonicMs();
    this.handleClockDiscontinuity(now);
    this.lastNow = now;
    if (
      this.config.mode === 'off' ||
      this.lastObservationAt === undefined ||
      now - this.lastObservationAt <= this.config.staleAfterMs
    ) {
      return null;
    }
    return this.handleCommunicationLoss(now, 'stale_observation');
  }

  snapshot(): PowerManagementStatus {
    const now = this.clock.monotonicMs();
    const observationAge =
      this.lastObservationAt === undefined ? undefined : Math.max(0, now - this.lastObservationAt);
    const freshness =
      observationAge === undefined
        ? 'unavailable'
        : observationAge > this.config.staleAfterMs
          ? 'stale'
          : 'fresh';
    const recoveryRemaining =
      this.state === 'recovering' && this.onlineSince !== undefined
        ? Math.max(0, this.config.onlineStableMs - (now - this.onlineSince))
        : undefined;
    const wouldHold = !['disabled', 'normal'].includes(this.state);
    return {
      mode: this.config.mode,
      state: this.state,
      freshness,
      reason: this.reason,
      transitioned_at: this.transitionedAt.toISOString(),
      ...(observationAge !== undefined ? { observation_age_ms: Math.round(observationAge) } : {}),
      ...(recoveryRemaining !== undefined
        ? { recovery_remaining_ms: Math.round(recoveryRemaining) }
        : {}),
      would_hold: wouldHold,
      held: this.config.mode === 'enforce' && wouldHold,
    };
  }

  private handleClockDiscontinuity(now: number): void {
    const elapsed = now - this.lastNow;
    if (elapsed >= 0 && elapsed <= this.config.staleAfterMs) return;
    this.batterySince = undefined;
    this.onlineSince = undefined;
    this.criticalSamples = 0;
    this.communicationLostSince = now;
    if (this.config.mode !== 'off') {
      this.transition(
        this.lastTrustedCondition === 'battery' ? 'conserve' : 'unknown',
        'stale_observation'
      );
    }
  }

  private handleCommunicationLoss(
    now: number,
    reason: PowerPolicyReason
  ): PowerPolicyTransition | null {
    this.communicationLostSince ??= now;
    this.onlineSince = undefined;
    this.batterySince = undefined;
    if (this.state === 'critical') return this.transition('critical', reason);
    if (this.lastTrustedCondition === 'battery') {
      if (
        now - this.communicationLostSince >=
        this.config.communicationLoss.lastOnBatteryCriticalAfterMs
      ) {
        return this.transition('critical', 'communication_lost');
      }
      return this.transition('conserve', reason);
    }
    return this.transition('unknown', reason);
  }

  private transition(
    next: PowerPolicyState,
    reason: PowerPolicyReason
  ): PowerPolicyTransition | null {
    const previous = this.state;
    const changed = previous !== next || this.reason !== reason;
    this.state = next;
    this.reason = reason;
    if (previous !== next) this.transitionedAt = this.clock.wallNow();
    return changed
      ? { previous, current: next, reason, status: this.snapshotWithoutEvaluation() }
      : null;
  }

  private snapshotWithoutEvaluation(): PowerManagementStatus {
    const now = this.clock.monotonicMs();
    const observationAge =
      this.lastObservationAt === undefined ? undefined : Math.max(0, now - this.lastObservationAt);
    const recoveryRemaining =
      this.state === 'recovering' && this.onlineSince !== undefined
        ? Math.max(0, this.config.onlineStableMs - (now - this.onlineSince))
        : undefined;
    const wouldHold = !['disabled', 'normal'].includes(this.state);
    return {
      mode: this.config.mode,
      state: this.state,
      freshness:
        observationAge === undefined
          ? 'unavailable'
          : observationAge > this.config.staleAfterMs
            ? 'stale'
            : 'fresh',
      reason: this.reason,
      transitioned_at: this.transitionedAt.toISOString(),
      ...(observationAge !== undefined ? { observation_age_ms: Math.round(observationAge) } : {}),
      ...(recoveryRemaining !== undefined
        ? { recovery_remaining_ms: Math.round(recoveryRemaining) }
        : {}),
      would_hold: wouldHold,
      held: this.config.mode === 'enforce' && wouldHold,
    };
  }
}
