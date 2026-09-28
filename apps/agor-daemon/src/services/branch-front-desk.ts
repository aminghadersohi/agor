/**
 * `branches/:id/front-desk` — the UI's view of a teammate's pinned front desk.
 *
 * A transport adapter only. Authorization, the actor reload under the tenant
 * fence, and the compare-and-swap all live in
 * `front-desk/manage-front-desk.ts`, which the MCP tools
 * `agor_teammates_front_desk_set` / `_clear` call too, so both surfaces
 * enforce one rule. Every method answers with the fresh
 * {@link TeammateFrontDeskView}, so a client re-renders from the response.
 *
 * Registered through `createTenantScopedAuthenticatedRouteRegistrar`: the
 * request already runs in the caller's tenant scope, and each mutation opens
 * its own tenant transaction (re-entering the request's) for the fence.
 *
 * `find` with `?include_addressing=true` also answers "who would a name
 * address reach right now, for me?" by running the MCP dry run
 * (`previewTeammateAddress`) as the caller. It is opt-in because it scans the
 * caller's addressable teammates, which the session header does not need.
 */

import {
  BranchRepository,
  FrontDeskConflictError,
  FrontDeskPinRefusedError,
  requireCurrentTenantId,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  Params,
  SessionID,
  SetTeammateFrontDeskRequest,
  TeammateAddressingPreview,
  TeammateFrontDeskView,
  UserID,
} from '@agor/core/types';
import {
  clearTeammateFrontDesk,
  type FrontDeskCommandContext,
  getTeammateFrontDeskView,
  setTeammateFrontDesk,
} from '../front-desk/manage-front-desk.js';
import {
  previewTeammateAddress,
  type TeammateAddressingContext,
} from '../mcp/tools/teammate-addressing.js';

type RouteParams = Params & { route?: { id?: string } };

function routeBranchId(params: RouteParams): BranchID {
  const id = params.route?.id;
  if (!id) throw new BadRequest('Branch ID required');
  return id as BranchID;
}

function optionalSessionId(value: unknown, field: string): SessionID | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`${field} must be a session id`);
  }
  return value as SessionID;
}

function wantsAddressing(params: RouteParams): boolean {
  const value = params.query?.include_addressing;
  return value === true || value === 'true';
}

/** Project the shared dry run onto the view's wire shape. */
async function previewAddressing(
  app: TeammateAddressingContext['app'],
  db: TenantScopeAwareDatabase,
  branchId: BranchID,
  params: RouteParams
): Promise<TeammateAddressingPreview> {
  // `getTeammateFrontDeskView` has already required an authenticated caller
  // with `branch.view` on this teammate branch.
  const { user, provider, tenant } = params as AuthenticatedParams;
  if (!user) throw new NotFound('Teammate not found');
  const branch = await new BranchRepository(db).findById(branchId);
  if (!branch) throw new NotFound('Teammate not found');
  const ctx: TeammateAddressingContext = {
    app,
    db,
    userId: user.user_id as UserID,
    authenticatedUser: user,
    baseServiceParams: { user, authenticated: true, provider, tenant },
  };
  const { nameAddressing, target } = await previewTeammateAddress(ctx, branch);
  if (target.via !== 'front_desk' && target.via !== 'recency' && target.via !== 'needs_session') {
    // Explicit and thread-mapping targets are not produced for this preview.
    throw new Error(`Unexpected teammate addressing preview: ${target.via}`);
  }
  const bypassed = target.via === 'front_desk' ? undefined : target.bypassedFrontDesk;
  return {
    via: target.via,
    session_id: target.via === 'needs_session' ? null : target.sessionId,
    name_addressing: nameAddressing,
    bypassed_front_desk: bypassed
      ? { session_id: bypassed.sessionId, reason: bypassed.reason }
      : null,
  };
}

/** Expected refusals become client errors; anything else propagates. */
function mapFrontDeskError(error: unknown): never {
  if (error instanceof FrontDeskPinRefusedError) {
    throw new BadRequest(error.message, { reason: error.reason });
  }
  if (error instanceof FrontDeskConflictError) throw new Conflict(error.message);
  throw error;
}

export function createBranchFrontDeskRoute(options: {
  db: TenantScopeAwareDatabase;
  /** Read per request, like every other route's superadmin check. */
  allowSuperadmin: () => boolean;
}) {
  const { db, allowSuperadmin } = options;
  const context = (params: Params): FrontDeskCommandContext => ({
    params,
    allowSuperadmin: allowSuperadmin(),
  });
  let app: TeammateAddressingContext['app'] | undefined;

  return {
    /** Feathers calls this on registration; the addressing preview needs `sessions`. */
    async setup(featherApp: TeammateAddressingContext['app']): Promise<void> {
      app = featherApp;
    },

    async find(params: RouteParams): Promise<TeammateFrontDeskView> {
      const branchId = routeBranchId(params);
      const view = await getTeammateFrontDeskView(db, branchId, context(params));
      if (!wantsAddressing(params)) return view;
      if (!app) throw new Error('branches/:id/front-desk used before setup');
      return { ...view, addressing: await previewAddressing(app, db, branchId, params) };
    },

    /** Pin `session_id`, replacing any current pin. */
    async create(
      data: SetTeammateFrontDeskRequest,
      params: RouteParams
    ): Promise<TeammateFrontDeskView> {
      const branchId = routeBranchId(params);
      const sessionId = optionalSessionId(data?.session_id, 'session_id');
      if (!sessionId) throw new BadRequest('session_id is required');
      const expectedSessionId =
        data.expected_session_id === null
          ? null
          : optionalSessionId(data.expected_session_id, 'expected_session_id');
      try {
        await runWithTenantDatabaseTransaction(db, requireCurrentTenantId(), (operationDb) =>
          setTeammateFrontDesk(
            operationDb,
            { branchId, sessionId, expectedSessionId },
            context(params)
          )
        );
      } catch (error) {
        mapFrontDeskError(error);
      }
      return getTeammateFrontDeskView(db, branchId, context(params));
    },

    /**
     * Clear the pin. `DELETE /branches/:id/front-desk?expected_session_id=…`
     * refuses with 409 when a different session holds the slot.
     */
    async remove(_id: null, params: RouteParams): Promise<TeammateFrontDeskView> {
      const branchId = routeBranchId(params);
      const expectedSessionId = optionalSessionId(
        params.query?.expected_session_id,
        'expected_session_id'
      );
      try {
        await runWithTenantDatabaseTransaction(db, requireCurrentTenantId(), (operationDb) =>
          clearTeammateFrontDesk(operationDb, { branchId, expectedSessionId }, context(params))
        );
      } catch (error) {
        mapFrontDeskError(error);
      }
      return getTeammateFrontDeskView(db, branchId, context(params));
    },
  };
}
