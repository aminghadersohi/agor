import type { GatewayChannelID } from './gateway';
import type { BranchFrontDeskID, BranchID, SessionID, UserID } from './id';

/**
 * Front-desk sessions: a declared, warm session that addressing routes to
 * instead of inferring one from recency.
 *
 * A row pins one session to one `(branch, scope, slot)`. Retired rows stay as
 * rotation history; at most one row per `(branch, scope, slot)` may be
 * `active` or `retiring`, enforced by a partial unique index on both engines.
 * Having no row is the opt-out: resolution then falls through to recency.
 */

/** Target for teammate-to-teammate `agor_sessions_prompt { teammate }`. */
export const FRONT_DESK_TEAMMATE_SCOPE = 'teammate' as const;

/** Prefix of the per-gateway-channel scope key (not written until gateway opt-in ships). */
export const FRONT_DESK_GATEWAY_SCOPE_PREFIX = 'gateway:' as const;

/** Persisted scope discriminator. */
export type FrontDeskScopeKey =
  | typeof FRONT_DESK_TEAMMATE_SCOPE
  | `${typeof FRONT_DESK_GATEWAY_SCOPE_PREFIX}${GatewayChannelID}`;

/**
 * The only slot any shipped path accepts. The column exists so a pool is a
 * value rather than a schema rewrite; sessions cannot share a context window,
 * so a second slot is deliberately not offered.
 */
export const FRONT_DESK_PRIMARY_SLOT = 0 as const;

export const FRONT_DESK_STATUSES = ['active', 'retiring', 'retired', 'failed'] as const;
export type FrontDeskStatus = (typeof FRONT_DESK_STATUSES)[number];

/** Statuses that occupy the slot (and the partial unique index). */
export const FRONT_DESK_OCCUPYING_STATUSES = [
  'active',
  'retiring',
] as const satisfies readonly FrontDeskStatus[];

export const FRONT_DESK_RETIRED_REASONS = [
  'context',
  'dead',
  'manual',
  'archived',
  'replaced',
] as const;
export type FrontDeskRetiredReason = (typeof FRONT_DESK_RETIRED_REASONS)[number];

export interface BranchFrontDeskSession {
  id: BranchFrontDeskID;
  branch_id: BranchID;
  scope: FrontDeskScopeKey;
  slot: number;
  session_id: SessionID;
  status: FrontDeskStatus;
  promoted_at: string;
  promoted_by?: UserID;
  retired_at?: string;
  retired_reason?: FrontDeskRetiredReason;
  metadata?: Record<string, unknown>;
}
