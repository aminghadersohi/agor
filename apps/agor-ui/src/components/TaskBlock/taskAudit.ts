/**
 * Derive transcript tags from the durable audit on `task.metadata`.
 *
 * The daemon records where a turn came from (coordinator batches, merged
 * busy-session prompts, edits, interrupts, callback routing, reminders,
 * restart recovery, dropped gateway attachments) but none of it reaches the
 * prompt bubble on its own. This module is presentation only: it never
 * decides authority, it just says what the audit already says.
 */

import type { SessionID, Task, TaskMetadata } from '@agor-live/client';
import { shortId } from '@agor-live/client';

/** Ant Design Tag status presets, so tags follow the theme instead of fixed hues. */
export type TaskAuditTagStatus = 'processing' | 'success' | 'warning' | 'default';

export interface TaskAuditTag {
  key: string;
  label: string;
  status: TaskAuditTagStatus;
  tooltip?: string;
  /** Session rendered as a link after the label (title resolved from the store). */
  session?: SessionID;
}

type CallbackDelivery = NonNullable<TaskMetadata['callback_delivery']>;

const CALLBACK_FALLBACK_REASONS: Record<
  NonNullable<CallbackDelivery['fallback_reason']>,
  string
> = {
  unsupported_agent: 'the destination agent cannot fork a digest',
  missing_fork_state: 'the destination had no forkable state yet',
  destination_inactive: 'the destination session was inactive',
  branch_inactive: 'the branch was inactive',
  permission_denied: 'the digest fork was not permitted',
  loop_guard: 'a callback loop guard tripped',
  policy_direct: 'the callback policy requires direct delivery',
  creation_failed: 'the digest fork could not be created',
};

const RESTART_DISPOSITIONS: Record<
  NonNullable<NonNullable<TaskMetadata['restart_recovery']>['disposition_reason']>,
  string
> = {
  session_advanced: 'the session had already moved on',
  session_archived: 'the session was archived',
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Number of distinct prompt requests sharing this one queued/executed turn. */
export function mergedRequestCount(task: Pick<Task, 'metadata'>): number {
  return task.metadata?.prompt_compaction?.requests.length ?? 0;
}

export function getTaskAuditTags(task: Pick<Task, 'task_id' | 'metadata'>): TaskAuditTag[] {
  const metadata = task.metadata;
  if (!metadata) return [];
  const tags: TaskAuditTag[] = [];

  const batch = metadata.coordinator_queue_batch;
  if (batch) {
    tags.push({
      key: 'coordinator-batch',
      label: `${batch.source_request_count} requests → 1 turn (${batch.strategy})`,
      status: 'processing',
      tooltip: `A ${batch.relationship} session collapsed ${plural(batch.source_task_count, 'queued task')} into this turn.`,
      session: batch.coordinator_session_id,
    });
  }

  const batchMember = metadata.coordinator_queue_batch_member;
  if (batchMember) {
    tags.push({
      key: 'coordinator-batch-member',
      label: `Batched into ${shortId(batchMember.execution_task_id)}`,
      status: 'default',
      tooltip: 'Not executed on its own; this prompt ran as part of a coordinator batch.',
    });
  }

  const compaction = metadata.prompt_compaction;
  if (compaction && compaction.requests.length > 1) {
    const duplicates = compaction.duplicate_request_count;
    tags.push({
      key: 'prompt-compaction',
      label: `${compaction.requests.length} requests merged`,
      status: 'processing',
      tooltip: `Prompts sent while the session was busy were merged into this turn${
        duplicates > 0 ? ` (${plural(duplicates, 'duplicate')} not repeated)` : ''
      }.`,
    });
  }

  const amendment = metadata.queued_prompt_amendment;
  if (amendment?.cancellation) {
    tags.push({
      key: 'queued-prompt-cancelled',
      label: 'Cancelled before dispatch',
      status: 'default',
      tooltip: `Withdrawn by its ${amendment.cancellation.authority} before an executor claimed it.`,
    });
  } else if (amendment && amendment.current_revision > 0) {
    const last = amendment.revisions[amendment.revisions.length - 1];
    tags.push({
      key: 'queued-prompt-edited',
      label: `Edited r${amendment.current_revision}`,
      status: 'default',
      tooltip: `Prompt edited ${plural(amendment.current_revision, 'time')} while queued${
        last ? `; last edit by its ${last.authority}` : ''
      }.`,
    });
  }

  const interruptions = metadata.interruptions;
  const latestInterruption = interruptions?.[interruptions.length - 1];
  if (interruptions && latestInterruption) {
    tags.push({
      key: 'interrupted',
      label:
        interruptions.length > 1 ? `Interrupted ×${interruptions.length} by` : 'Interrupted by',
      status: 'warning',
      tooltip: `Stopped by its ${latestInterruption.relationship} session, which queued corrective task ${shortId(latestInterruption.corrective_task_id)}.`,
      session: latestInterruption.requested_by_session_id,
    });
  }

  const correction = metadata.interrupt_correction;
  if (correction) {
    tags.push({
      key: 'interrupt-correction',
      label: 'Correction from',
      status: 'warning',
      tooltip: `Queued by the ${correction.relationship} session after it interrupted${
        correction.target_task_id ? ` task ${shortId(correction.target_task_id)}` : ' this session'
      }.`,
      session: correction.requested_by_session_id,
    });
  }

  const delivery = metadata.callback_delivery;
  if (delivery) {
    const fellBack =
      delivery.requested_delivery !== delivery.resolved_delivery && !!delivery.fallback_reason;
    const reason = delivery.fallback_reason
      ? CALLBACK_FALLBACK_REASONS[delivery.fallback_reason]
      : undefined;
    tags.push({
      key: 'callback-delivery',
      label:
        delivery.resolved_delivery === 'btw' && delivery.btw_session_id
          ? 'Callback via digest'
          : `Callback · ${delivery.resolved_delivery}`,
      status: fellBack ? 'warning' : 'default',
      tooltip: [
        `Completion callback from session ${shortId(delivery.source_session_id)} (task ${shortId(delivery.source_task_id)}).`,
        `Requested ${delivery.requested_delivery}, delivered ${delivery.resolved_delivery}.`,
        reason ? `Fell back because ${reason}.` : undefined,
      ]
        .filter(Boolean)
        .join(' '),
      session: delivery.resolved_delivery === 'btw' ? delivery.btw_session_id : undefined,
    });
  }

  const reminder = metadata.session_reminder;
  if (reminder) {
    tags.push({
      key: 'session-reminder',
      label: 'Reminder',
      status: 'processing',
      tooltip: `Fired by a one-shot session reminder due ${new Date(reminder.due_at).toLocaleString()}.`,
    });
  }

  const recovery = metadata.restart_recovery;
  if (recovery) {
    if (recovery.source_task_id !== task.task_id) {
      tags.push({
        key: 'restart-recovered',
        label: 'Recovered after restart',
        status: 'success',
        tooltip: `Continues task ${shortId(recovery.source_task_id)}, which a daemon restart interrupted.`,
      });
    } else if (recovery.state === 'admitted') {
      tags.push({
        key: 'restart-resumed',
        label: 'Resumed after restart',
        status: 'success',
        tooltip: recovery.admitted_task_id
          ? `A daemon restart interrupted this turn; it continued in task ${shortId(recovery.admitted_task_id)}.`
          : 'A daemon restart interrupted this turn; it was continued automatically.',
      });
    } else if (recovery.state === 'pending') {
      tags.push({
        key: 'restart-pending',
        label: 'Recovery pending',
        status: 'processing',
        tooltip: 'A daemon restart interrupted this turn; a continuation is waiting to be queued.',
      });
    } else {
      const disposition = recovery.disposition_reason
        ? RESTART_DISPOSITIONS[recovery.disposition_reason]
        : undefined;
      tags.push({
        key: 'restart-superseded',
        label: 'Recovery skipped',
        status: 'default',
        tooltip: `A daemon restart interrupted this turn; it was not continued${
          disposition ? ` because ${disposition}` : ''
        }.`,
      });
    }
  }

  const dropped = metadata.gateway_skipped_attachments;
  const droppedCount = dropped ? dropped.skipped + dropped.failed : 0;
  if (dropped && droppedCount > 0) {
    const types = [...new Set(dropped.skipped_mime_types)];
    tags.push({
      key: 'gateway-attachments-dropped',
      label: `${plural(droppedCount, 'attachment')} not delivered`,
      status: 'warning',
      tooltip: [
        dropped.skipped > 0
          ? `${dropped.skipped} unsupported${types.length > 0 ? ` (${types.join(', ')})` : ''}.`
          : undefined,
        dropped.failed > 0 ? `${dropped.failed} could not be fetched.` : undefined,
        'The agent was told in its prompt.',
      ]
        .filter(Boolean)
        .join(' '),
    });
  }

  // Seam for "Relayed by agent": server-stamped prompt provenance (upstream
  // #2893, `metadata.prompt_provenance`) is not on this branch yet. When it
  // lands, push a tag here linking the origin session with its tool/mode and
  // `authenticated_by`, and a tooltip stating it attests the hop, not human
  // approval.

  return tags;
}
