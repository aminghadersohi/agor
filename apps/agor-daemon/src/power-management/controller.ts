import type { ResolvedPowerManagementConfig } from '@agor/core/config';
import { powerManagementSettingsFromResolved } from '@agor/core/config';
import type {
  PowerManagementRuntimeSettingsView,
  PowerManagementStatus,
  PowerTaskHold,
  SessionPowerPriority,
} from '@agor/core/types';
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
  private stateMachine: PowerPolicyStateMachine;
  private readonly mutex = new AsyncMutex();
  private readonly listeners = new Set<(transition: PowerPolicyTransition) => void>();
  private timer?: NodeJS.Timeout;
  private activePoll?: Promise<void>;
  private stopped = true;
  private draining = false;
  private observation?: PowerManagementStatus['observation'];
  private recoveryPacing = false;
  private nextRecoveryDispatchAt = 0;
  private lastProviderObservation?: Awaited<ReturnType<PowerSourceProvider['read']>>;
  private runtimeSettings: PowerManagementRuntimeSettingsView;

  constructor(
    private config: ResolvedPowerManagementConfig,
    private readonly provider: PowerSourceProvider | null,
    private readonly clock: PowerPolicyClock = systemPowerPolicyClock,
    private readonly metrics: DaemonMetrics = NOOP_METRICS,
    private readonly providerSupported = true,
    runtimeSettings?: PowerManagementRuntimeSettingsView
  ) {
    this.stateMachine = new PowerPolicyStateMachine(config, clock);
    this.runtimeSettings =
      runtimeSettings ??
      ({
        revision: 0,
        source: 'operator_defaults',
        operator_defaults: powerManagementSettingsFromResolved(config),
        can_rollback: false,
      } satisfies PowerManagementRuntimeSettingsView);
  }

  /** Load the durable overlay before admission workers or provider polling start. */
  configureBeforeStart(
    config: ResolvedPowerManagementConfig,
    runtimeSettings: PowerManagementRuntimeSettingsView
  ): void {
    if (!this.stopped || this.activePoll || this.timer) {
      throw new Error('Initial power policy configuration must be loaded before controller start');
    }
    this.assertActivationSupported(config);
    this.replaceConfiguration(config, runtimeSettings);
  }

  assertCanApply(config: ResolvedPowerManagementConfig): void {
    this.assertActivationSupported(config);
  }

  /**
   * Hold the same mutex as Task/schedule claims across durable CAS and the
   * in-memory swap. Once the database commit is visible, no admission can
   * observe the old policy in this process.
   */
  async applyRuntimeMutation(
    persist: () => Promise<{
      effective: ResolvedPowerManagementConfig;
      view: PowerManagementRuntimeSettingsView;
    }>
  ): Promise<PowerManagementStatus> {
    const release = await this.mutex.acquire();
    try {
      const next = await persist();
      this.assertActivationSupported(next.effective);
      const previous = this.stateMachine.snapshot();
      this.replaceConfiguration(next.effective, next.view);
      const current = this.stateMachine.snapshot();
      this.publishTransition({
        previous: previous.state,
        current: current.state,
        reason: current.reason,
        status: current,
      });
      return this.status();
    } finally {
      release();
    }
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
      runtime_settings: this.runtimeSettings,
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
    const release = await this.mutex.acquire();
    if (this.config.mode === 'off') {
      try {
        return { decision: { outcome: 'allowed', wouldHold: false }, value: await materialize() };
      } finally {
        release();
      }
    }
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
    for (;;) {
      const release = await this.mutex.acquire();
      if (this.config.mode === 'off') {
        try {
          return { decision: { outcome: 'allowed', wouldHold: false }, value: await claim() };
        } finally {
          release();
        }
      }
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
    this.lastProviderObservation = observation;
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
    const published = { ...transition, status: this.status() };
    this.metrics.increment('power.policy_transitions', 1, {
      from: published.previous,
      to: published.current,
      reason: published.reason,
    });
    console.info(
      formatStructuredLog('[power-policy]', {
        event: 'transition',
        previous: published.previous,
        current: published.current,
        reason: published.reason,
        mode: published.status.mode,
      })
    );
    for (const listener of this.listeners) listener(published);
  }

  private assertActivationSupported(config: ResolvedPowerManagementConfig): void {
    if (config.mode !== 'off' && !this.providerSupported) {
      throw new Error('Power conservation cannot be activated on this deployment topology');
    }
  }

  private replaceConfiguration(
    config: ResolvedPowerManagementConfig,
    runtimeSettings: PowerManagementRuntimeSettingsView
  ): void {
    this.config = config;
    this.runtimeSettings = runtimeSettings;
    this.provider?.setTimeoutMs?.(config.providerTimeoutMs);
    this.stateMachine = new PowerPolicyStateMachine(config, this.clock);
    if (this.lastProviderObservation) {
      // A policy swap intentionally discards debounce/recovery history. Reusing
      // only the last allowlisted observation is conservative: online enters
      // stable recovery and battery re-enters debounce before Enforce admits.
      this.stateMachine.ingest(this.lastProviderObservation);
    }
    this.draining = false;
    this.recoveryPacing = false;
    this.nextRecoveryDispatchAt = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stopped && !this.activePoll) this.schedulePoll(0);
  }
}
