import { generateId } from '@agor/core/db';
import type { ZoneWorkflowEntityRef } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { resolveBoardId, resolveBranchId, resolveCardId } from '../resolve-ids.js';
import { mcpOptionalString, mcpRequiredId, mcpRequiredString } from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

const behavior = z
  .enum(['guidance_only', 'target_zone_prompt'])
  .describe(
    'guidance_only only moves entities. target_zone_prompt additionally runs an existing always_new trigger on the target zone for advanced branches; picker triggers are never auto-authorized.'
  );

export function registerZoneWorkflowTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_zone_workflow_transitions_list',
    {
      description: 'List persistent directed workflow transitions for one board.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ boardId: mcpRequiredId('boardId', 'Board') }),
    },
    async (args) => {
      const boardId = await resolveBoardId(ctx, coerceString(args.boardId)!);
      const result = await ctx.app.service('zone-workflow-transitions').find({
        ...ctx.baseServiceParams,
        query: { board_id: boardId },
      });
      return textResult(result);
    }
  );

  server.registerTool(
    'agor_zone_workflow_transitions_create',
    {
      description:
        'Create a directed zone-to-zone workflow transition. Source and target must be distinct zones on the same active board; duplicate directed pairs are rejected and cycles are allowed.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        sourceZoneId: mcpRequiredString('sourceZoneId', 'Source zone object ID'),
        targetZoneId: mcpRequiredString('targetZoneId', 'Target zone object ID'),
        label: mcpRequiredString('label', 'Short transition label'),
        reason: mcpOptionalString('reason', 'Optional operator guidance/reason'),
        enabled: z.boolean().optional().describe('Whether the transition can be advanced'),
        behavior: behavior.optional(),
      }),
    },
    async (args) => {
      const boardId = await resolveBoardId(ctx, coerceString(args.boardId)!);
      const transition = await ctx.app.service('zone-workflow-transitions').create(
        {
          board_id: boardId,
          source_zone_id: coerceString(args.sourceZoneId)!,
          target_zone_id: coerceString(args.targetZoneId)!,
          label: coerceString(args.label)!,
          reason: coerceString(args.reason),
          enabled: args.enabled,
          behavior: args.behavior,
        },
        ctx.baseServiceParams
      );
      return textResult(transition);
    }
  );

  server.registerTool(
    'agor_zone_workflow_transitions_update',
    {
      description:
        'Edit a workflow transition label, reason, enabled state, or behavior. Endpoints are immutable; delete and recreate to change direction.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        transitionId: mcpRequiredId(
          'transitionId',
          'Workflow transition',
          'Canonical workflow transition UUID returned by create/list'
        ),
        label: mcpOptionalString('label', 'New non-empty label'),
        reason: mcpOptionalString('reason', 'New reason; empty string clears it'),
        enabled: z.boolean().optional(),
        behavior: behavior.optional(),
      }),
    },
    async (args) => {
      const patch: Record<string, unknown> = {};
      if (args.label !== undefined) patch.label = args.label;
      if (args.reason !== undefined) patch.reason = args.reason;
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.behavior !== undefined) patch.behavior = args.behavior;
      const transition = await ctx.app
        .service('zone-workflow-transitions')
        .patch(coerceString(args.transitionId)!, patch, ctx.baseServiceParams);
      return textResult(transition);
    }
  );

  server.registerTool(
    'agor_zone_workflow_transitions_delete',
    {
      description:
        'Delete a workflow transition. Historical advance audit rows remain until their board is deleted.',
      annotations: { destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        transitionId: mcpRequiredId(
          'transitionId',
          'Workflow transition',
          'Canonical workflow transition UUID returned by create/list'
        ),
      }),
    },
    async (args) => {
      const transition = await ctx.app
        .service('zone-workflow-transitions')
        .remove(coerceString(args.transitionId)!, ctx.baseServiceParams);
      return textResult(transition);
    }
  );

  server.registerTool(
    'agor_zone_workflow_advance',
    {
      description:
        'Explicitly and atomically advance selected branches/cards from a transition source zone to its target. The durable idempotency key guarantees retries never move or trigger twice. Manual zone moves remain separate and do not invoke this operation.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        transitionId: mcpRequiredId(
          'transitionId',
          'Workflow transition',
          'Canonical workflow transition UUID returned by create/list'
        ),
        idempotencyKey: mcpOptionalString(
          'idempotencyKey',
          'Caller-generated canonical UUID reused across retries; generated when omitted'
        ),
        entities: z
          .array(
            z.object({
              entityType: z.enum(['branch', 'card']),
              entityId: mcpRequiredId('entityId', 'Branch or card'),
            })
          )
          .min(1)
          .max(100),
      }),
    },
    async (args) => {
      const entities: ZoneWorkflowEntityRef[] = [];
      for (const entity of args.entities) {
        const entityId = coerceString(entity.entityId)!;
        entities.push(
          entity.entityType === 'branch'
            ? {
                entity_type: 'branch',
                entity_id: await resolveBranchId(ctx, entityId),
              }
            : {
                entity_type: 'card',
                entity_id: (await resolveCardId(ctx, entityId)) as never,
              }
        );
      }
      const audit = await ctx.app.service('zone-workflow-advances').create(
        {
          transition_id: coerceString(args.transitionId)!,
          idempotency_key: coerceString(args.idempotencyKey) ?? generateId(),
          entities,
        },
        ctx.baseServiceParams
      );
      return textResult(audit);
    }
  );
}
