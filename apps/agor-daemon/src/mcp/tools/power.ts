import {
  hasMinimumRole,
  type PowerAdmissionStatus,
  type PowerManagementStatus,
  type PowerPolicyReason,
  type PowerPolicyState,
  powerAdmissionHoldsPriority,
  ROLES,
  type SessionID,
  type Task,
  toPowerAdmissionStatus,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

/**
 * What an agent should do about a power hold. Held prompts look like an
 * ordinary queue on the wire, and orchestrators that read "busy" retry, stop
 * or cancel their children — so every prompt/spawn response says this plainly.
 */
export const POWER_HOLD_NOTE =
  'Held by host power policy: new work is paused while the host is on battery or recovering. ' +
  'The prompt is durably queued and dispatches automatically after power recovers. ' +
  'Do not retry, re-send, stop, or cancel it because of this hold.';

export interface McpPowerHold {
  held: true;
  state: PowerPolicyState;
  reason: PowerPolicyReason;
  note: string;
}

function readAdmission(ctx: McpContext): Promise<PowerAdmissionStatus> {
  return ctx.app.service('power-management/admission').find(ctx.baseServiceParams);
}

/**
 * Accurate hold information for a prompt the caller just admitted.
 *
 * The prompt route annotates `power_hold` when it tried to dispatch and the
 * permit refused. A prompt queued behind active work never reached the permit,
 * so for those the current admission projection decides (Essential sessions
 * still dispatch while conserving). Failures to read the projection are not
 * holds: this is advisory and must never fail the prompt that already landed.
 */
export async function resolvePromptPowerHold(
  ctx: McpContext,
  task: Pick<Task, 'status' | 'power_hold'>,
  sessionId: SessionID
): Promise<McpPowerHold | undefined> {
  if (task.power_hold?.held) {
    return {
      held: true,
      state: task.power_hold.state,
      reason: task.power_hold.reason,
      note: POWER_HOLD_NOTE,
    };
  }
  if (task.status !== 'queued') return undefined;
  try {
    const admission = await readAdmission(ctx);
    if (!admission.held) return undefined;
    const session = await ctx.app.service('sessions').get(sessionId, ctx.baseServiceParams);
    if (!powerAdmissionHoldsPriority(admission, session.power_priority)) return undefined;
    return { held: true, state: admission.state, reason: admission.reason, note: POWER_HOLD_NOTE };
  } catch {
    return undefined;
  }
}

export function registerPowerTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_power_status',
    {
      description:
        'Read whether the host power policy (UPS-aware dispatch admission) is holding new work, with its state and reason. When held is true, queued prompts and spawned children wait and dispatch automatically after power recovers — do not retry, stop, or cancel them. Admins also receive the full policy status (mode, freshness, observation). Read-only: power policy cannot be changed over MCP.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({}),
    },
    async () => {
      // Admins read the full status and derive the admission fields from the
      // same snapshot; everyone else only ever reaches the redacted route.
      const status: PowerManagementStatus | undefined = hasMinimumRole(
        ctx.authenticatedUser?.role,
        ROLES.ADMIN
      )
        ? await ctx.app.service('power-management').find(ctx.baseServiceParams)
        : undefined;
      const admission = status ? toPowerAdmissionStatus(status) : await readAdmission(ctx);
      const note = admission.held ? POWER_HOLD_NOTE : 'New work dispatches normally.';
      return textResult({ ...admission, note, ...(status ? { status } : {}) });
    }
  );
}
