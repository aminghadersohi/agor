/** Schedule outcomes are committed with the initial Task, never inferred from Session status. */
import { TaskStatus } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { lockRowForUpdate, select, update } from '../database-wrapper';
import { type SessionRow, schedules } from '../schema';

/** Caller owns the Session/Task locks and the terminal transition transaction. */
export async function recordScheduledTaskOutcome(
  db: Database,
  session: SessionRow,
  taskId: string,
  status: TaskStatus
): Promise<void> {
  const run = session.data.custom_context?.scheduled_run;
  if (
    !session.scheduled_from_branch ||
    !session.schedule_id ||
    !run?.initial_task_id ||
    run.initial_task_id !== taskId ||
    run.triggered_manually
  )
    return;
  const failed = status === TaskStatus.FAILED || status === TaskStatus.TIMED_OUT;
  // Stops/cancellations are not execution failures or successful executions.
  if (!failed && status !== TaskStatus.COMPLETED) return;

  const condition = and(
    eq(schedules.schedule_id, session.schedule_id),
    eq(schedules.branch_id, session.branch_id),
    eq(schedules.created_by, session.created_by)
  )!;
  // Same tenant transaction as Task settlement; RLS remains authoritative.
  // This serializes concurrent outcomes with config changes and human pauses.
  await lockRowForUpdate(db, db, schedules, condition);
  const schedule = await select(db).from(schedules).where(condition).one();
  if (!schedule) return; // Deleted schedules are not resurrected from the snapshot.
  const failures = failed ? Math.min(schedule.consecutive_failures + 1, 2147483647) : 0;
  const pause =
    schedule.enabled && schedule.failure_threshold > 0 && failures >= schedule.failure_threshold;
  await update(db, schedules)
    .set({
      consecutive_failures: failures,
      ...(pause
        ? {
            enabled: false,
            pause_reason: 'repeated_failures',
            attention_required: true,
          }
        : {}),
      updated_at: new Date(),
    })
    .where(condition)
    .run();
}
