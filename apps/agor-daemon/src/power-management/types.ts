import type { PowerPolicyReason } from '@agor/core/types';

export type PowerObservationCondition = 'online' | 'battery' | 'unknown';
export type PowerObservationCommunication = 'ok' | 'lost';

/** Provider output deliberately excludes device identity and raw payloads. */
export interface PowerObservation {
  condition: PowerObservationCondition;
  communication: PowerObservationCommunication;
  reason?: PowerPolicyReason;
  chargePercent?: number;
  runtimeSeconds?: number;
  critical?: boolean;
}

export interface PowerSourceProvider {
  read(): Promise<PowerObservation>;
  close(): Promise<void>;
}

export interface PowerPolicyClock {
  monotonicMs(): number;
  wallNow(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemPowerPolicyClock: PowerPolicyClock = {
  monotonicMs: () => performance.now(),
  wallNow: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
