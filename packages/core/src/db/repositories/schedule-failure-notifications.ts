import type { ScheduleFailureNotification, TaskStatus } from '@agor/core/types';
import { TaskStatus as Status } from '@agor/core/types';
import { and, asc, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { scheduleFailureNotifications as notifications, type SessionRow } from '../schema';

type Row = typeof notifications.$inferSelect;
function notification(row: Row): ScheduleFailureNotification {
  return {
    ...row,
    task_id: row.task_id as ScheduleFailureNotification['task_id'],
    session_id: row.session_id as ScheduleFailureNotification['session_id'],
    schedule_id: row.schedule_id as ScheduleFailureNotification['schedule_id'],
    branch_id: row.branch_id as ScheduleFailureNotification['branch_id'],
    created_by: row.created_by as ScheduleFailureNotification['created_by'],
    gateway_channel_id: row.gateway_channel_id as ScheduleFailureNotification['gateway_channel_id'],
    status: row.status as ScheduleFailureNotification['status'],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    next_attempt_at: row.next_attempt_at.toISOString(),
  };
}

/** Called only in the winning Task terminal transaction; no provider work here. */
export async function enqueueScheduledFailure(
  db: Database,
  session: SessionRow,
  taskId: string,
  status: TaskStatus
): Promise<void> {
  if (status !== Status.FAILED && status !== Status.TIMED_OUT) return;
  const run = session.data.custom_context?.scheduled_run;
  const scheduleId = session.schedule_id ?? run?.schedule_config_snapshot?.schedule_id;
  if (
    !session.scheduled_from_branch ||
    session.scheduled_run_at === null ||
    !scheduleId ||
    run?.initial_task_id !== taskId
  )
    return;
  const now = new Date();
  // No FK to retained runs: deleting a Session must not erase an unsent alert.
  await insert(db, notifications)
    .values({
      task_id: taskId,
      session_id: session.session_id,
      schedule_id: scheduleId,
      branch_id: session.branch_id,
      created_by: session.created_by,
      scheduled_run_at: session.scheduled_run_at,
      status: 'pending',
      created_at: now,
      updated_at: now,
      next_attempt_at: now,
    })
    .onConflictDoNothing()
    .run();
}

export class ScheduleFailureNotificationRepository {
  constructor(private db: Database) {}
  async findById(taskId: string): Promise<ScheduleFailureNotification | null> {
    const row = await select(this.db)
      .from(notifications)
      .where(eq(notifications.task_id, taskId))
      .one();
    return row ? notification(row) : null;
  }
  async findAll(skip = 0, limit = 100): Promise<ScheduleFailureNotification[]> {
    const offset = Number.isFinite(Number(skip)) ? Math.max(0, Math.floor(Number(skip))) : 0;
    const size = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(100, Math.floor(Number(limit))))
      : 100;
    return (
      await select(this.db)
        .from(notifications)
        .orderBy(desc(notifications.created_at), desc(notifications.task_id))
        .limit(size)
        .offset(offset)
        .all()
    ).map(notification);
  }
  /** System scope returns routing identities only; the worker re-enters tenant scope. */
  async findDueRefs(
    now = new Date(),
    afterTaskId?: string,
    throughTaskId?: string
  ): Promise<Array<{ task_id: string; tenant_id?: string }>> {
    const tenantColumn = (notifications as unknown as { tenant_id?: unknown }).tenant_id;
    const columns =
      isPostgresDatabase(this.db) && tenantColumn
        ? { task_id: notifications.task_id, tenant_id: tenantColumn }
        : { task_id: notifications.task_id };
    return (await select(this.db, columns)
      .from(notifications)
      .where(
        and(
          or(eq(notifications.status, 'pending'), eq(notifications.status, 'sending')),
          lte(notifications.next_attempt_at, now),
          afterTaskId ? gt(notifications.task_id, afterTaskId) : undefined,
          throughTaskId ? lte(notifications.task_id, throughTaskId) : undefined
        )
      )
      .orderBy(asc(notifications.task_id))
      .limit(25)
      .all()) as Array<{ task_id: string; tenant_id?: string }>;
  }
  /** A finite cycle watermark prevents an endless stream of newer rows postponing wrap. */
  async discoveryUpperBound(now = new Date()): Promise<string | undefined> {
    const row = await select(this.db, { task_id: notifications.task_id })
      .from(notifications)
      .where(
        and(
          or(eq(notifications.status, 'pending'), eq(notifications.status, 'sending')),
          lte(notifications.next_attempt_at, now)
        )
      )
      .orderBy(desc(notifications.task_id))
      .limit(1)
      .one();
    return row?.task_id;
  }

  /** Only a typed, proven zero-provider-effect rejection may release the fence. */
  async notDispatched(taskId: string, attemptId: string, now = new Date()): Promise<boolean> {
    if (typeof attemptId !== 'string' || !attemptId) return false;
    const result = await update(this.db, notifications)
      .set({
        status: 'pending',
        attempt_id: null,
        gateway_channel_id: null,
        target: null,
        last_error_code: 'not_dispatched',
        updated_at: now,
        next_attempt_at: new Date(now.getTime() + 30_000),
      })
      .where(
        and(
          eq(notifications.task_id, taskId),
          attemptId === null
            ? isNull(notifications.attempt_id)
            : eq(notifications.attempt_id, attemptId),
          or(eq(notifications.status, 'sending'), eq(notifications.status, 'uncertain'))
        )
      )
      .run();
    return result.rowsAffected === 1;
  }

  /** One durable provider-attempt fence, never a process-local dedup cache. */
  async beginSend(
    taskId: string,
    gatewayId: string,
    target: string,
    now = new Date()
  ): Promise<string | null> {
    const attemptId = generateId();
    const result = await update(this.db, notifications)
      .set({
        status: 'sending',
        attempt_id: attemptId,
        gateway_channel_id: gatewayId,
        target,
        last_error_code: null,
        updated_at: now,
        next_attempt_at: new Date(now.getTime() + 120_000),
      })
      .where(and(eq(notifications.task_id, taskId), eq(notifications.status, 'pending')))
      .run();
    return result.rowsAffected === 1 ? attemptId : null;
  }
  async defer(taskId: string, code: string, now = new Date()): Promise<void> {
    await update(this.db, notifications)
      .set({
        last_error_code: code,
        updated_at: now,
        next_attempt_at: new Date(now.getTime() + 30_000),
      })
      .where(and(eq(notifications.task_id, taskId), eq(notifications.status, 'pending')))
      .run();
  }
  async finish(taskId: string, attemptId: string | null, messageId: string): Promise<boolean> {
    if (attemptId !== null && (typeof attemptId !== 'string' || !attemptId)) return false;
    // A late receipt belongs to one claim, never to a later attempt.
    const result = await update(this.db, notifications)
      .set({
        status: 'delivered',
        platform_message_id: messageId,
        last_error_code: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(notifications.task_id, taskId),
          attemptId === null
            ? isNull(notifications.attempt_id)
            : eq(notifications.attempt_id, attemptId),
          or(eq(notifications.status, 'sending'), eq(notifications.status, 'uncertain'))
        )
      )
      .run();
    return result.rowsAffected === 1;
  }
  async uncertain(taskId: string, attemptId: string | null): Promise<boolean> {
    if (attemptId !== null && (typeof attemptId !== 'string' || !attemptId)) return false;
    const result = await update(this.db, notifications)
      .set({ status: 'uncertain', last_error_code: 'delivery_unconfirmed', updated_at: new Date() })
      .where(
        and(
          eq(notifications.task_id, taskId),
          attemptId === null
            ? isNull(notifications.attempt_id)
            : eq(notifications.attempt_id, attemptId),
          eq(notifications.status, 'sending')
        )
      )
      .run();
    return result.rowsAffected === 1;
  }
}
