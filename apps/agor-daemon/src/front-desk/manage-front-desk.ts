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
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  type BranchFrontDeskSession,
  type BranchID,
  FRONT_DESK_PRIMARY_SLOT,
  FRONT_DESK_TEAMMATE_SCOPE,
  getTeammateConfig,
  type Params,
  type SessionID,
  type TeammateFrontDeskView,
  type UserID,
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

/** Branch Manager preset capability — the same one that edits the branch permission policy. */
const FRONT_DESK_MANAGE_CAPABILITY = 'branch.policy.manage';

interface FrontDeskActor {
  user_id: UserID;
  role?: string;
  service: boolean;
}

/**
 * The one rule for who may pin or clear: a trusted service actor, a
 * superadmin (when the bypass is enabled), or a holder of
 * `branch.policy.manage`. The read view reports the same answer as
 * `can_manage`, so a UI never offers a control the command would refuse.
 */
async function actorManagesFrontDesk(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  branchId: BranchID,
  actor: FrontDeskActor,
  allowSuperadmin: boolean
): Promise<boolean> {
  if (actor.service || isSuperAdmin(actor.role, allowSuperadmin)) return true;
  const access = await new CapabilityPolicyRepository(db).resolveBranchAccess(
    branchId,
    actor.user_id
  );
  return access.capabilities.includes(FRONT_DESK_MANAGE_CAPABILITY);
}

/** Row-level security already hides another tenant's branch; missing and non-teammate answer alike. */
async function requireTeammateBranch(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  branchId: BranchID
): Promise<void> {
  const branch = await new BranchRepository(db).findById(branchId);
  if (!branch || !getTeammateConfig(branch)) throw new NotFound('Teammate not found');
}

async function authorizeFrontDeskChange(
  db: TenantScopedDatabase,
  branchId: BranchID,
  context: FrontDeskCommandContext
): Promise<CurrentTenantAuthorityActor> {
  await lockTenantAuthorizationFence(db, context.params);
  const actor = await resolveCurrentTenantAuthorityActor(db, context.params);
  if (!actor) throw new Forbidden('Authentication required to change a front desk');

  await requireTeammateBranch(db, branchId);
  if (!(await actorManagesFrontDesk(db, branchId, actor, context.allowSuperadmin))) {
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

/**
 * The teammate's front desk as the caller may see it, with whether they may
 * change it. Requires `branch.view`; a caller without it gets the same
 * "not found" as for a branch that does not exist.
 */
export async function getTeammateFrontDeskView(
  db: TenantScopeAwareDatabase,
  branchId: BranchID,
  context: FrontDeskCommandContext
): Promise<TeammateFrontDeskView> {
  const user = (context.params as AuthenticatedParams | undefined)?.user;
  if (!user?.user_id) throw new NotAuthenticated('Authentication required');
  const actor: FrontDeskActor = {
    user_id: user.user_id as UserID,
    role: user.role,
    service: user._isServiceAccount === true,
  };

  await requireTeammateBranch(db, branchId);
  let canManage = actor.service || isSuperAdmin(actor.role, context.allowSuperadmin);
  if (!canManage) {
    const access = await new CapabilityPolicyRepository(db).resolveBranchAccess(
      branchId,
      actor.user_id
    );
    if (!access.capabilities.includes('branch.view')) throw new NotFound('Teammate not found');
    canManage = access.capabilities.includes(FRONT_DESK_MANAGE_CAPABILITY);
  }

  return {
    branch_id: branchId,
    front_desk: await findTeammateFrontDesk(db, branchId),
    can_manage: canManage,
  };
}
