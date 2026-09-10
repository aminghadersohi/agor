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
  /** Deployment authority, independent of UPS policy. Omitted outside the owned topology. */
  ownership?: 'owned' | 'lost';
  /** Admin-only allowlisted configuration; never contains host identity or credentials. */
  configuration?: AgorPowerManagementSettings;
  /**
   * Whether this deployment topology can safely use the configured host provider.
   * Older daemons omit this field; consumers must treat omission as unknown.
   */
  provider_supported?: boolean;
  /** Bounded capability explanation; never operator identities or configuration values. */
  provider_support_reason?: string;
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
  /** Durable mutable-policy precedence and CAS metadata for the admin editor. */
  runtime_settings?: PowerManagementRuntimeSettingsView;
}

/** Provider identity/topology stay operator-owned; only these policy values are live-mutable. */
export type PowerManagementMutableSettings = Omit<
  AgorPowerManagementSettings,
  'provider' | 'max_essential_sessions'
>;

export interface PowerManagementRuntimeSettingsView {
  /** Monotonic tenant-owned compare-and-swap revision. Zero means no mutation has occurred. */
  revision: number;
  source: 'operator_defaults' | 'runtime_override';
  operator_defaults: AgorPowerManagementSettings;
  runtime_override?: PowerManagementMutableSettings;
  updated_at?: string;
  updated_by?: UserID;
  can_rollback: boolean;
  rollback_target?: 'operator_defaults' | 'runtime_override';
}

export type UpdatePowerManagementRuntimeSettingsRequest =
  | {
      expected_revision: number;
      configuration: PowerManagementMutableSettings;
      reset_to_operator_defaults?: never;
      rollback_last_change?: never;
    }
  | {
      expected_revision: number;
      reset_to_operator_defaults: true;
      configuration?: never;
      rollback_last_change?: never;
    }
  | {
      expected_revision: number;
      rollback_last_change: true;
      configuration?: never;
      reset_to_operator_defaults?: never;
    };

export interface PowerEssentialSessionOption {
  session_id: SessionID;
  title?: string;
  power_priority: SessionPowerPriority;
}

/** Bounded, authorization-filtered picker projection; no statuses or tenant metadata. */
export interface PowerEssentialSessionSearchResult {
  data: PowerEssentialSessionOption[];
  limit: number;
  /** True when an Essential row exists but is not eligible/visible to this caller. */
  slot_occupied: boolean;
  selected?: PowerEssentialSessionOption;
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
