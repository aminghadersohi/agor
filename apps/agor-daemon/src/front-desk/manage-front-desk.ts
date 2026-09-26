/**
 * Pin and clear a teammate's front desk.
 *
 * Pinning redirects other people's messages, so it is a branch-management act:
 * it requires `branch.policy.manage` — the Branch Manager preset, the same
 * capability that edits the branch permission policy — or superadmin. Trusted
 * service actors pass, as they do for every other branch-management command.
 *
 * Both commands expect to run inside one tenant transaction so that the
 * authorization fence, the actor reload, the capability check, and the
 * repository compare-and-swap observe the same committed state.
 */

import {
  BranchFrontDeskRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  type FrontDeskPromoteResult,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { Forbidden, NotFound } from '@agor/core/feathers';
import {
  type BranchFrontDeskSession,
  type BranchID,
  FRONT_DESK_PRIMARY_SLOT,
  FRONT_DESK_TEAMMATE_SCOPE,
  getTeammateConfig,
  type Params,
  type SessionID,
} from '@agor/core/types';
import {
  type CurrentTenantAuthorityActor,
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from '../services/tenant-authorization-fence.js';
import { isSuperAdmin } from '../utils/branch-authorization.js';

export interface FrontDeskCommandContext {
  /** Authenticated request params; the actor is reloaded from them under the fence. */
  params: Params;
  allowSuperadmin: boolean;
}

async function authorizeFrontDeskChange(
  db: TenantScopedDatabase,
  branchId: BranchID,
  context: FrontDeskCommandContext
): Promise<CurrentTenantAuthorityActor> {
  await lockTenantAuthorizationFence(db, context.params);
  const actor = await resolveCurrentTenantAuthorityActor(db, context.params);
  if (!actor) throw new Forbidden('Authentication required to change a front desk');

  // Row-level security already hides another tenant's branch; a missing
  // branch and a non-teammate branch get the same answer.
  const branch = await new BranchRepository(db).findById(branchId);
  if (!branch || !getTeammateConfig(branch)) throw new NotFound('Teammate not found');

  if (actor.service || isSuperAdmin(actor.role, context.allowSuperadmin)) return actor;
  const access = await new CapabilityPolicyRepository(db).resolveBranchAccess(
    branchId,
    actor.user_id
  );
  if (!access.capabilities.includes('branch.policy.manage')) {
    throw new Forbidden('Only a Branch Manager can change this teammate’s front desk');
  }
  return actor;
}

/** Pin `sessionId` as the teammate's front desk, replacing any current pin. */
export async function setTeammateFrontDesk(
  db: TenantScopedDatabase,
  input: { branchId: BranchID; sessionId: SessionID; expectedSessionId?: SessionID | null },
  context: FrontDeskCommandContext
): Promise<FrontDeskPromoteResult> {
  const actor = await authorizeFrontDeskChange(db, input.branchId, context);
  return new BranchFrontDeskRepository(db).promote({
    branchId: input.branchId,
    scope: FRONT_DESK_TEAMMATE_SCOPE,
    slot: FRONT_DESK_PRIMARY_SLOT,
    sessionId: input.sessionId,
    promotedBy: actor.user_id,
    expectedSessionId: input.expectedSessionId,
  });
}

/**
 * Remove the teammate's front desk. Returns the retired declaration, or `null`
 * when none was pinned. Addressing falls back to recency immediately.
 */
export async function clearTeammateFrontDesk(
  db: TenantScopedDatabase,
  input: { branchId: BranchID; expectedSessionId?: SessionID },
  context: FrontDeskCommandContext
): Promise<BranchFrontDeskSession | null> {
  await authorizeFrontDeskChange(db, input.branchId, context);
  return new BranchFrontDeskRepository(db).clear({
    branchId: input.branchId,
    scope: FRONT_DESK_TEAMMATE_SCOPE,
    slot: FRONT_DESK_PRIMARY_SLOT,
    expectedSessionId: input.expectedSessionId,
  });
}

/** The teammate's current front desk, if any (no authorization beyond tenant scope). */
export async function findTeammateFrontDesk(
  db: TenantScopeAwareDatabase,
  branchId: BranchID
): Promise<BranchFrontDeskSession | null> {
  return new BranchFrontDeskRepository(db).findOccupant({
    branchId,
    scope: FRONT_DESK_TEAMMATE_SCOPE,
    slot: FRONT_DESK_PRIMARY_SLOT,
  });
}
