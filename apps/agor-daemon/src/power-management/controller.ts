import type { ResolvedPowerManagementConfig } from '@agor/core/config';
import { powerManagementSettingsFromResolved } from '@agor/core/config';
import type { PowerManagementStatus, PowerTaskHold, SessionPowerPriority } from '@agor/core/types';
import type { DaemonMetrics } from '../metrics/index.js';
import { NOOP_METRICS } from '../metrics/index.js';
import { formatStructuredLog } from '../utils/structured-log.js';
import { PowerPolicyStateMachine, type PowerPolicyTransition } from './state-machine.js';
import type { PowerPolicyClock, PowerSourceProvider } from './types.js';
import { systemPowerPolicyClock } from './types.js';

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.tail;
    this.tail = prior.then(() => current);
    await prior;
    return release;
  }
}

export type PowerDispatchDecision =
  | { outcome: 'allowed'; wouldHold: boolean }
  | { outcome: 'held'; hold: PowerTaskHold };

export class PowerPolicyController {
  private readonly stateMachine: PowerPolicyStateMachine;
  private readonly mutex = new AsyncMutex();
  private readonly listeners = new Set<(transition: PowerPolicyTransition) => void>();
  private timer?: NodeJS.Timeout;
  private activePoll?: Promise<void>;
  private stopped = true;
  private draining = false;
  private observation?: PowerManagementStatus['observation'];
  private recoveryPacing = false;
  private nextRecoveryDispatchAt = 0;

  constructor(
    private readonly config: ResolvedPowerManagementConfig,
    private readonly provider: PowerSourceProvider | null,
    private readonly clock: PowerPolicyClock = systemPowerPolicyClock,
    private readonly metrics: DaemonMetrics = NOOP_METRICS,
    private readonly providerSupported = true
  ) {
    this.stateMachine = new PowerPolicyStateMachine(config, clock);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.draining = false;
    this.schedulePoll(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.config.mode !== 'off') this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.provider?.close();
    await this.activePoll;
    if (this.config.mode !== 'off') {
      const release = await this.mutex.acquire();
      release();
    }
  }

  status(): PowerManagementStatus {
    return {
      ...this.stateMachine.snapshot(),
      configuration: powerManagementSettingsFromResolved(this.config),
      provider_supported: this.providerSupported,
      ...(this.observation ? { observation: { ...this.observation } } : {}),
      recovery_pacing: this.recoveryPacing,
    };
  }

  subscribe(listener: (transition: PowerPolicyTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Scheduler pre-materialization decision; observe never gates. */
  scheduleAdmission(): PowerDispatchDecision {
    return this.decisionFor('normal');
  }

  /** Serialize the scheduler's short occurrence insert against policy transitions. */
  async withScheduleMaterializationPermit<T>(
    materialize: () => Promise<T>
  ): Promise<{ decision: PowerDispatchDecision; value?: T }> {
    if (this.config.mode === 'off') {
      return { decision: { outcome: 'allowed', wouldHold: false }, value: await materialize() };
    }
    const release = await this.mutex.acquire();
    const decision = this.decisionFor('normal');
    if (decision.outcome === 'held') {
      release();
      this.metrics.increment('power.schedule_held', 1, { state: decision.hold.state });
      return { decision };
    }
    try {
      return { decision, value: await materialize() };
    } finally {
      release();
    }
  }

  /**
   * The process-local linearization fence. The short durable dispatch claim
   * executes while the same mutex excludes power state transitions.
   */
  async withDispatchPermit<T>(
    priorityInput: SessionPowerPriority | (() => Promise<SessionPowerPriority>),
    claim: () => Promise<T>
  ): Promise<{ decision: PowerDispatchDecision; value?: T }> {
    if (this.config.mode === 'off') {
      return { decision: { outcome: 'allowed', wouldHold: false }, value: await claim() };
    }
    for (;;) {
      const release = await this.mutex.acquire();
      let priority: SessionPowerPriority;
      try {
        priority = typeof priorityInput === 'function' ? await priorityInput() : priorityInput;
      } catch (error) {
        release();
        throw error;
      }
      const decision = this.decisionFor(priority);
      if (decision.outcome === 'held') {
        release();
        this.metrics.increment('power.dispatch_held', 1, {
          state: decision.hold.state,
          priority,
        });
        return { decision };
      }

      const now = this.clock.monotonicMs();
      if (this.recoveryPacing && priority === 'normal' && now < this.nextRecoveryDispatchAt) {
        const delay = this.nextRecoveryDispatchAt - now;
        release();
        await this.clock.sleep(delay);
        continue;
      }

      if (this.recoveryPacing && priority === 'normal') {
        this.nextRecoveryDispatchAt = now + this.config.recoveryDispatchIntervalMs;
      }
      try {
        return { decision, value: await claim() };
      } finally {
        release();
      }
    }
  }

  /** Priority writes share the dispatch fence so stale privilege cannot cross a claim. */
  async withPriorityMutation<T>(mutate: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await mutate();
    } finally {
      release();
    }
  }

  /** Queue worker calls this only after a complete empty recovery sweep. */
  markRecoveryQueueDrained(): void {
    this.recoveryPacing = false;
  }

  /** Exposed only to deterministic tests and the poll loop. */
  async ingestForTest(
    observation: Awaited<ReturnType<PowerSourceProvider['read']>>
  ): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      this.recordObservation(observation);
      this.publishTransition(this.stateMachine.ingest(observation));
    } finally {
      release();
    }
  }

  private decisionFor(priority: SessionPowerPriority): PowerDispatchDecision {
    const status = this.stateMachine.snapshot();
    if (this.draining && this.config.mode !== 'off') {
      return {
        outcome: 'held',
        hold: {
          state: 'unknown',
          reason: 'provider_unavailable',
          would_hold: true,
          held: true,
        },
      };
    }
    const wouldHold =
      status.state === 'critical' ||
      status.state === 'unknown' ||
      status.state === 'recovering' ||
      (priority === 'normal' && status.state === 'conserve');
    const held = this.config.mode === 'enforce' && wouldHold;
    if (!held) return { outcome: 'allowed', wouldHold };
    return {
      outcome: 'held',
      hold: {
        state: status.state,
        reason: status.reason,
        would_hold: true,
        held: true,
      },
    };
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped || !this.provider) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.activePoll = this.pollOnce().finally(() => {
        this.activePoll = undefined;
        this.schedulePoll(this.config.pollIntervalMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || !this.provider) return;
    const observation = await this.provider.read();
    if (this.stopped) return;
    const release = await this.mutex.acquire();
    try {
      this.recordObservation(observation);
      this.publishTransition(this.stateMachine.ingest(observation));
      this.publishTransition(this.stateMachine.evaluateStaleness());
    } finally {
      release();
    }
  }

  private recordObservation(observation: Awaited<ReturnType<PowerSourceProvider['read']>>): void {
    // Rebuild the allowlist: never spread provider data or retain old charge on failure.
    this.observation = {
      condition: observation.condition,
      communication: observation.communication,
      observed_at: this.clock.wallNow().toISOString(),
      ...(observation.communication === 'ok' && observation.condition !== 'unknown'
        ? {
            ...(observation.chargePercent !== undefined
              ? { charge_percent: observation.chargePercent }
              : {}),
            ...(observation.runtimeSeconds !== undefined
              ? { runtime_seconds: observation.runtimeSeconds }
              : {}),
          }
        : {}),
    };
  }

  private publishTransition(transition: PowerPolicyTransition | null): void {
    if (!transition) return;
    if (
      this.config.mode === 'enforce' &&
      transition.previous !== transition.current &&
      transition.current === 'normal'
    ) {
      this.recoveryPacing = true;
      this.nextRecoveryDispatchAt = this.clock.monotonicMs();
    }
    this.metrics.increment('power.policy_transitions', 1, {
      from: transition.previous,
      to: transition.current,
      reason: transition.reason,
    });
    console.info(
      formatStructuredLog('[power-policy]', {
        event: 'transition',
        previous: transition.previous,
        current: transition.current,
        reason: transition.reason,
        mode: transition.status.mode,
      })
    );
    for (const listener of this.listeners) listener(transition);
  }
}
