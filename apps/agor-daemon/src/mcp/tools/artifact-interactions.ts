/**
 * MCP authoring shape for artifact interaction bindings.
 *
 * Agents declare bindings in a flat, camelCase shape with short ids; this
 * module resolves the ids and converts to the canonical
 * `ArtifactInteractionConfig` persisted under `agor_runtime.interactions`.
 * It checks only what the conversion needs. The artifacts service validates
 * the result — shape and branch membership — before anything is written, for
 * this surface and REST alike. See
 * `context/explorations/artifact-interaction-bindings.md`.
 *
 * Kept free of service imports so the tool entry stays light.
 */

import type {
  ArtifactActionBinding,
  ArtifactChatBinding,
  ArtifactDataBinding,
  ArtifactInteractionConfig,
  ScheduleID,
  SessionID,
} from '@agor/core/types';
import { z } from 'zod';
import { resolveScheduleId, resolveSessionId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';

const bindingEnvelope = {
  id: z
    .string()
    .describe(
      'Artifact-local binding id (1-64 letters, digits, "_" or "-"). The only thing artifact JS ever passes, e.g. window.agor.runAction("run-now").'
    ),
  label: z.string().describe('Human-readable label shown on the control and in confirmations.'),
  description: z.string().optional().describe('Optional longer explanation.'),
};

export const ArtifactInteractionConfigInputSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            ...bindingEnvelope,
            kind: z
              .enum(['schedule_status', 'session_status'])
              .describe('What to read. Returns a fixed, non-secret projection.'),
            scheduleId: z
              .string()
              .optional()
              .describe('Schedule to read (required for schedule_status). Short id ok.'),
            sessionId: z
              .string()
              .optional()
              .describe('Session to read (required for session_status). Short id ok.'),
          })
          .strict()
      )
      .optional()
      .describe('Reads: window.agor.fetchData(id).'),
    actions: z
      .array(
        z
          .object({
            ...bindingEnvelope,
            scheduleId: z.string().describe('Schedule the action applies to. Short id ok.'),
            effect: z
              .enum(['run', 'enable', 'disable'])
              .optional()
              .describe(
                'run = run the schedule once now (default); enable / disable = arm or disarm it. A toggle is two bindings.'
              ),
            confirm: z
              .boolean()
              .optional()
              .describe('Require a parent-page confirmation before the action runs.'),
          })
          .strict()
      )
      .optional()
      .describe('Writes: window.agor.runAction(id). Runs as the viewer, never the author.'),
    chats: z
      .array(
        z
          .object({
            ...bindingEnvelope,
            sessionId: z.string().describe('Session to open. Short id ok.'),
          })
          .strict()
      )
      .optional()
      .describe('Sessions openable in Agor: window.agor.openChat(id).'),
  })
  .strict()
  .nullable()
  .optional();

export type ArtifactInteractionConfigInput = z.infer<typeof ArtifactInteractionConfigInputSchema>;

export const ARTIFACT_INTERACTION_CONFIG_DESCRIPTION =
  "Declared interaction bindings: the only things this artifact's JavaScript can ask Agor to do. Every schedule and session named must be on the artifact's branch; invalid bindings are rejected. Replaces all existing bindings; null clears them; omit to leave them unchanged.";

async function resolveTarget(
  kind: 'schedule' | 'session',
  ctx: McpContext,
  id: string,
  path: string
): Promise<string> {
  try {
    return kind === 'schedule' ? await resolveScheduleId(ctx, id) : await resolveSessionId(ctx, id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`interactionConfig.${path}: ${kind} "${id}" could not be resolved: ${reason}`);
  }
}

/** Convert MCP input to the canonical config. `null` clears; `undefined` leaves unchanged. */
export async function toArtifactInteractionConfig(
  ctx: McpContext,
  input: ArtifactInteractionConfigInput
): Promise<ArtifactInteractionConfig | null | undefined> {
  if (input === undefined || input === null) return input;
  const at = (family: string, index: number, id: string) => `${family}[${index}] ("${id}")`;

  const data: ArtifactDataBinding[] = [];
  for (const [index, binding] of (input.data ?? []).entries()) {
    const path = at('data', index, binding.id);
    const { kind, scheduleId, sessionId, ...envelope } = binding;
    if (kind === 'schedule_status') {
      if (!scheduleId || sessionId) {
        throw new Error(`interactionConfig.${path}: schedule_status takes scheduleId only`);
      }
      const schedule_id = (await resolveTarget('schedule', ctx, scheduleId, path)) as ScheduleID;
      data.push({ ...envelope, source: { kind, schedule_id } });
    } else {
      if (!sessionId || scheduleId) {
        throw new Error(`interactionConfig.${path}: session_status takes sessionId only`);
      }
      const session_id = (await resolveTarget('session', ctx, sessionId, path)) as SessionID;
      data.push({ ...envelope, source: { kind, session_id } });
    }
  }

  const actions: ArtifactActionBinding[] = [];
  for (const [index, binding] of (input.actions ?? []).entries()) {
    const { scheduleId, effect = 'run', confirm, ...envelope } = binding;
    const path = at('actions', index, binding.id);
    const schedule_id = (await resolveTarget('schedule', ctx, scheduleId, path)) as ScheduleID;
    actions.push({
      ...envelope,
      effect:
        effect === 'run'
          ? { kind: 'schedule_run', schedule_id }
          : { kind: 'schedule_set_enabled', schedule_id, enabled: effect === 'enable' },
      ...(confirm !== undefined ? { confirm } : {}),
    });
  }

  const chats: ArtifactChatBinding[] = [];
  for (const [index, binding] of (input.chats ?? []).entries()) {
    const { sessionId, ...envelope } = binding;
    const path = at('chats', index, binding.id);
    const session_id = (await resolveTarget('session', ctx, sessionId, path)) as SessionID;
    chats.push({ ...envelope, session_id });
  }

  return {
    ...(actions.length > 0 ? { actions } : {}),
    ...(data.length > 0 ? { data } : {}),
    ...(chats.length > 0 ? { chats } : {}),
  };
}
