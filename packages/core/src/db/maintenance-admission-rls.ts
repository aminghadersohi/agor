import { MAINTENANCE_POLICY } from './maintenance-admission-sql';

/**
 * One pg_policy row (or a policy-less table) as seen by the operator role.
 * Pure data so the visibility contract can be evaluated and counter-factually
 * tested without a database.
 */
export interface MaintenancePolicyRow {
  table: string;
  policy: string | null;
  /** pg_policy.polcmd: r SELECT, a INSERT, w UPDATE, d DELETE, * ALL. */
  command: string | null;
  permissive: boolean | null;
  /** polroles includes PUBLIC or a role the operator currently has the privileges of. */
  applies: boolean | null;
  using: string | null;
}

export const MAINTENANCE_VISIBILITY_TABLES = ['tasks', 'branches'] as const;
const POLICY_NAME = 'maintenance_admission_discovery';

/**
 * The global counts are only meaningful if the operator can actually see every
 * tenant's rows. PostgreSQL silently filters (never errors) when a policy does
 * not apply to the role or a RESTRICTIVE policy intersects the result, so a
 * policy that merely exists with the expected expression proves nothing. Require
 * the canonical policy to be PERMISSIVE, SELECT-only and applicable to this
 * role, and refuse any other applicable policy that could narrow SELECT
 * visibility. Anything unknown fails closed. Returns a reason, or null.
 */
export function maintenanceVisibilityViolation(
  rows: readonly MaintenancePolicyRow[]
): string | null {
  for (const table of MAINTENANCE_VISIBILITY_TABLES) {
    const mine = rows.filter((row) => row.table === table);
    if (mine.length === 0) return `${table}: no catalog row`;
    const canonical = mine.filter((row) => row.policy === POLICY_NAME);
    if (canonical.length !== 1) return `${table}: maintenance policy missing or duplicated`;
    const [policy] = canonical;
    if (policy.command !== 'r') return `${table}: maintenance policy is not SELECT-only`;
    if (policy.permissive !== true) return `${table}: maintenance policy is not PERMISSIVE`;
    if (policy.applies !== true)
      return `${table}: maintenance policy does not apply to the operator role`;
    if (policy.using !== MAINTENANCE_POLICY)
      return `${table}: maintenance policy expression changed`;
    for (const other of mine) {
      if (other.policy === null || other.policy === POLICY_NAME) continue;
      const mayNarrowSelect =
        other.command !== 'a' && other.command !== 'w' && other.command !== 'd';
      if (other.applies !== false && mayNarrowSelect && other.permissive !== true)
        return `${table}: applicable restrictive policy ${other.policy} could hide rows`;
    }
  }
  return null;
}
