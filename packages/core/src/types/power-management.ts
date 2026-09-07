import type { AgorPowerManagementSettings } from '../config/types';
import type { SessionID, UserID } from './id';

export const POWER_MANAGEMENT_MODES = ['off', 'observe', 'enforce'] as const;
export type PowerManagementMode = (typeof POWER_MANAGEMENT_MODES)[number];

export const POWER_POLICY_STATES = [
  'disabled',
  'unknown',
  'normal',
  'conserve',
  'critical',
  'recovering',
] as const;
export type PowerPolicyState = (typeof POWER_POLICY_STATES)[number];

export const POWER_POLICY_REASONS = [
  'disabled',
  'startup',
  'online',
  'on_battery_debounce',
  'on_battery',
  'low_battery',
  'critical_threshold',
  'communication_lost',
  'stale_observation',
  'contradictory_observation',
  'provider_unavailable',
  'recovering',
] as const;
export type PowerPolicyReason = (typeof POWER_POLICY_REASONS)[number];

export const SESSION_POWER_PRIORITIES = ['normal', 'essential'] as const;
export type SessionPowerPriority = (typeof SESSION_POWER_PRIORITIES)[number];

export interface PowerManagementStatus {
  /** Admin-only allowlisted configuration; never contains host identity or credentials. */
  configuration?: AgorPowerManagementSettings;
  observation?: {
    condition: 'online' | 'battery' | 'unknown';
    communication: 'ok' | 'lost';
    observed_at: string;
    charge_percent?: number;
    runtime_seconds?: number;
  };
  recovery_pacing?: boolean;
  mode: PowerManagementMode;
  state: PowerPolicyState;
  freshness: 'fresh' | 'stale' | 'unavailable';
  reason: PowerPolicyReason;
  transitioned_at: string;
  observation_age_ms?: number;
  recovery_remaining_ms?: number;
  /** Whether ordinary work would be held if enforcement were active. */
  would_hold: boolean;
  /** Whether ordinary work is actually held in the current mode. */
  held: boolean;
}

/** Transient response annotation. The durable Task itself remains queued. */
export interface PowerTaskHold {
  state: PowerPolicyState;
  reason: PowerPolicyReason;
  would_hold: boolean;
  held: boolean;
}

export interface SessionPowerPriorityView {
  session_id: SessionID;
  requested: SessionPowerPriority;
  effective: boolean;
  can_manage: boolean;
  max_essential_sessions: number;
  updated_at?: string;
  updated_by?: UserID;
}

export interface SetSessionPowerPriorityRequest {
  priority: SessionPowerPriority;
}
