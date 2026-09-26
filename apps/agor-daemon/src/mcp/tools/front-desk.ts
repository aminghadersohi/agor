/**
 * Handlers for the MCP tools that pin and clear a teammate's front desk — the
 * session that `agor_sessions_prompt { teammate }` reaches instead of the most
 * recently active one. Both are thin: addressing lives in
 * `teammate-addressing.ts`, authorization and the compare-and-swap in
 * `front-desk/manage-front-desk.ts`.
 *
 * The tools are registered, with their zod input schemas, by
 * `registerFrontDeskTools` in `branches.ts`. This module deliberately imports
 * neither zod nor `../server.js`: every `src/**` file is its own tsup entry
 * with code splitting off, so either import would inline a full private copy
 * of zod (~750 KB) or of the whole MCP server into this entry.
 */

import {
  FrontDeskConflictError,
  FrontDeskPinRefusedError,
  getCurrentTenantId,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import type { BranchFrontDeskSession, BranchID, SessionID } from '@agor/core/types';
import {
  clearTeammateFrontDesk,
  findTeammateFrontDesk,
  setTeammateFrontDesk,
} from '../../front-desk/manage-front-desk.js';
import { resolveBranchId, resolveSessionId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';
import { textResult } from '../tool-result.js';
import {
  resolveTeammateName,
  teammateAmbiguousPayload,
  teammateNotFoundPayload,
} from './teammate-addressing.js';

type ToolResult = ReturnType<typeof textResult> & { isError?: boolean };

export const FRONT_DESK_TEAMMATE_ARG_DESCRIPTION =
  'Teammate by name — branch slug or display name, matched case-insensitively. Provide exactly one of teammate or branchId.';

export const FRONT_DESK_SET_DESCRIPTION =
  "Pin a session as a teammate's front desk: agor_sessions_prompt { teammate } then reaches that session instead of the teammate's most recently active one, so name addressing is deterministic. The session must belong to the teammate's branch and not be archived. Replaces any current pin atomically. Requires Branch Manager access. If the pinned session is later archived or dies, addressing falls back to the most recent session automatically.";

export const FRONT_DESK_CLEAR_DESCRIPTION =
  "Remove a teammate's front-desk pin. agor_sessions_prompt { teammate } goes back to reaching the teammate's most recently active session. No session is archived or changed. Requires Branch Manager access.";

export interface FrontDeskTargetArgs {
  teammate?: string;
  branchId?: string;
}

function errorResult(payload: Record<string, unknown>): ToolResult {
  return { ...textResult(payload), isError: true };
}

/** Project a declaration to the fields a caller acts on. */
function describeFrontDesk(desk: BranchFrontDeskSession | null) {
  return desk
    ? {
        front_desk_id: desk.id,
        branch_id: desk.branch_id,
        session_id: desk.session_id,
        status: desk.status,
        promoted_at: desk.promoted_at,
        promoted_by: desk.promoted_by ?? null,
      }
    : null;
}

export function createFrontDeskToolHandlers(ctx: McpContext) {
  const allowSuperadmin = () => ctx.app.get('config')?.execution?.allow_superadmin === true;
  const tenantId = () => ctx.baseServiceParams.tenant?.tenant_id ?? getCurrentTenantId();

  /** Exactly one of `teammate` / `branchId`, resolved to a branch id or an error result. */
  async function resolveTarget(
    args: FrontDeskTargetArgs
  ): Promise<{ branchId: BranchID } | { result: ToolResult }> {
    if (Boolean(args.teammate) === Boolean(args.branchId)) {
      return {
        result: errorResult({
          error: 'Provide exactly one of teammate or branchId.',
          how_to_fix:
            'Pass teammate: "<name>" (see agor_teammates_list) or branchId: "<id>" of the teammate branch.',
        }),
      };
    }
    if (args.branchId) return { branchId: await resolveBranchId(ctx, args.branchId) };
    const resolution = await resolveTeammateName(ctx, args.teammate!);
    if (resolution.outcome === 'ambiguous') {
      return { result: errorResult(teammateAmbiguousPayload(args.teammate!, resolution)) };
    }
    if (resolution.outcome === 'not_found') {
      return { result: errorResult(teammateNotFoundPayload(args.teammate!, resolution)) };
    }
    return { branchId: resolution.branch.branch_id };
  }

  /** Expected refusals become caller-facing payloads; anything else propagates. */
  async function refusalResult(error: unknown, branchId: BranchID): Promise<ToolResult> {
    if (error instanceof FrontDeskPinRefusedError) {
      return errorResult({ error: error.message, reason: error.reason });
    }
    if (error instanceof FrontDeskConflictError) {
      const current = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        findTeammateFrontDesk(db, branchId)
      );
      return errorResult({
        error: error.message,
        conflict: true,
        current_front_desk: describeFrontDesk(current),
        how_to_fix:
          'Re-check current_front_desk, then retry with expectedSessionId set to its session_id if you still want to replace it.',
      });
    }
    throw error;
  }

  return {
    /** `agor_teammates_front_desk_set` */
    async set(
      args: FrontDeskTargetArgs & { sessionId: string; expectedSessionId?: string }
    ): Promise<ToolResult> {
      const target = await resolveTarget(args);
      if ('result' in target) return target.result;
      const sessionId: SessionID = await resolveSessionId(ctx, args.sessionId);
      const expectedSessionId = args.expectedSessionId
        ? await resolveSessionId(ctx, args.expectedSessionId)
        : undefined;
      try {
        const result = await runWithMcpTenantDatabaseWrite(ctx, (db) =>
          runWithTenantDatabaseTransaction(db, tenantId(), (operationDb) =>
            setTeammateFrontDesk(
              operationDb,
              { branchId: target.branchId, sessionId, expectedSessionId },
              { params: ctx.baseServiceParams, allowSuperadmin: allowSuperadmin() }
            )
          )
        );
        return textResult({
          front_desk: describeFrontDesk(result.desk),
          replaced: describeFrontDesk(result.replaced ?? null),
          unchanged: result.unchanged,
        });
      } catch (error) {
        return refusalResult(error, target.branchId);
      }
    },

    /** `agor_teammates_front_desk_clear` */
    async clear(args: FrontDeskTargetArgs & { expectedSessionId?: string }): Promise<ToolResult> {
      const target = await resolveTarget(args);
      if ('result' in target) return target.result;
      const expectedSessionId = args.expectedSessionId
        ? await resolveSessionId(ctx, args.expectedSessionId)
        : undefined;
      try {
        const cleared = await runWithMcpTenantDatabaseWrite(ctx, (db) =>
          runWithTenantDatabaseTransaction(db, tenantId(), (operationDb) =>
            clearTeammateFrontDesk(
              operationDb,
              { branchId: target.branchId, expectedSessionId },
              { params: ctx.baseServiceParams, allowSuperadmin: allowSuperadmin() }
            )
          )
        );
        return textResult({ cleared: describeFrontDesk(cleared) });
      } catch (error) {
        return refusalResult(error, target.branchId);
      }
    },
  };
}
