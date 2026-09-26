/**
 * MCP tools that pin and clear a teammate's front desk — the session that
 * `agor_sessions_prompt { teammate }` reaches instead of the most recently
 * active one. Both are thin: addressing lives in `teammate-addressing.ts`,
 * authorization and the compare-and-swap in `front-desk/manage-front-desk.ts`.
 */

import {
  FrontDeskConflictError,
  FrontDeskPinRefusedError,
  getCurrentTenantId,
  runWithTenantDatabaseTransaction,
} from '@agor/core/db';
import type { BranchFrontDeskSession, BranchID, SessionID } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  clearTeammateFrontDesk,
  findTeammateFrontDesk,
  setTeammateFrontDesk,
} from '../../front-desk/manage-front-desk.js';
import { resolveBranchId, resolveSessionId } from '../resolve-ids.js';
import { mcpOptionalId, mcpOptionalNonBlankString, mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';
import {
  resolveTeammateName,
  teammateAmbiguousPayload,
  teammateNotFoundPayload,
} from './teammate-addressing.js';

type ToolResult = ReturnType<typeof textResult> & { isError?: boolean };

const TEAMMATE_ARG_DESCRIPTION =
  'Teammate by name — branch slug or display name, matched case-insensitively. Provide exactly one of teammate or branchId.';

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

export function registerFrontDeskTools(server: McpServer, ctx: McpContext): void {
  const allowSuperadmin = () => ctx.app.get('config')?.execution?.allow_superadmin === true;
  const tenantId = () => ctx.baseServiceParams.tenant?.tenant_id ?? getCurrentTenantId();

  /** Exactly one of `teammate` / `branchId`, resolved to a branch id or an error result. */
  async function resolveTarget(args: {
    teammate?: string;
    branchId?: string;
  }): Promise<{ branchId: BranchID } | { result: ToolResult }> {
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

  server.registerTool(
    'agor_teammates_front_desk_set',
    {
      description:
        "Pin a session as a teammate's front desk: agor_sessions_prompt { teammate } then reaches that session instead of the teammate's most recently active one, so name addressing is deterministic. The session must belong to the teammate's branch and not be archived. Replaces any current pin atomically. Requires Branch Manager access. If the pinned session is later archived or dies, addressing falls back to the most recent session automatically.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        teammate: mcpOptionalNonBlankString('teammate', TEAMMATE_ARG_DESCRIPTION),
        branchId: mcpOptionalId(
          'branchId',
          'Branch',
          'Teammate branch ID (UUIDv7 or short ID). Provide exactly one of teammate or branchId.'
        ),
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          "Session to pin (UUIDv7 or short ID); must be in the teammate's branch."
        ),
        expectedSessionId: mcpOptionalId(
          'expectedSessionId',
          'Session',
          'Only replace the pin if this session is the current front desk. Guards against overwriting a change you have not seen.'
        ),
      }),
    },
    async (args) => {
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
    }
  );

  server.registerTool(
    'agor_teammates_front_desk_clear',
    {
      description:
        "Remove a teammate's front-desk pin. agor_sessions_prompt { teammate } goes back to reaching the teammate's most recently active session. No session is archived or changed. Requires Branch Manager access.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        teammate: mcpOptionalNonBlankString('teammate', TEAMMATE_ARG_DESCRIPTION),
        branchId: mcpOptionalId(
          'branchId',
          'Branch',
          'Teammate branch ID (UUIDv7 or short ID). Provide exactly one of teammate or branchId.'
        ),
        expectedSessionId: mcpOptionalId(
          'expectedSessionId',
          'Session',
          'Only clear the pin if this session is the current front desk.'
        ),
      }),
    },
    async (args) => {
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
    }
  );
}
