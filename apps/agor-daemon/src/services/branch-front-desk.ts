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
 */

import {
  FrontDeskConflictError,
  FrontDeskPinRefusedError,
  requireCurrentTenantId,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict } from '@agor/core/feathers';
import type {
  BranchID,
  Params,
  SessionID,
  SetTeammateFrontDeskRequest,
  TeammateFrontDeskView,
} from '@agor/core/types';
import {
  clearTeammateFrontDesk,
  type FrontDeskCommandContext,
  getTeammateFrontDeskView,
  setTeammateFrontDesk,
} from '../front-desk/manage-front-desk.js';

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

  return {
    async find(params: RouteParams): Promise<TeammateFrontDeskView> {
      return getTeammateFrontDeskView(db, routeBranchId(params), context(params));
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
