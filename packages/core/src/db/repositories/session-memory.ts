import type {
  SessionID,
  SessionMemory,
  SessionMemoryID,
  SessionReminder,
  SessionReminderFailureCode,
  SessionReminderID,
  SessionReminderStatus,
  SessionReminderWakeCondition,
  TaskID,
  UserID,
} from '@agor/core/types';
import {
  SESSION_MEMORY_MAX_LIMIT,
  SESSION_MEMORY_MAX_ROWS_PER_SESSION,
  SESSION_REMINDER_MAX_LIMIT,
  SESSION_REMINDER_MAX_SCHEDULED_PER_SESSION,
  SessionMemoryRevisionConflictError,
  SessionReminderRevisionConflictError,
} from '@agor/core/types';
import { and, asc, count, desc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { lockSessionBranchForAdmission } from '../branch-admission';
import type { Database } from '../client';
import { insert, runDatabaseTransaction, select, update } from '../database-wrapper';
import {
  type SessionMemoryInsert,
  type SessionMemoryRow,
  type SessionReminderInsert,
  type SessionReminderRow,
  sessionMemories,
  sessionReminders,
  sessions,
} from '../schema';
import { attachHiddenTenant, EntityNotFoundError, RepositoryError } from './base';

function tagsFromRow(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((tag): tag is string => typeof tag === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function memoryFromRow(row: SessionMemoryRow): SessionMemory {
  return attachHiddenTenant(
    {
      memory_id: row.memory_id as SessionMemoryID,
      session_id: row.session_id as SessionID,
      title: row.title ?? undefined,
      text: row.text,
      tags: tagsFromRow(row.tags),
      archived: Boolean(row.archived),
      created_by: row.created_by as UserID,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      revision: row.revision,
    },
    row
  );
}

function reminderFromRow(row: SessionReminderRow): SessionReminder {
  return attachHiddenTenant(
    {
      reminder_id: row.reminder_id as SessionReminderID,
      session_id: row.session_id as SessionID,
      text: row.text,
      due_at: new Date(row.due_at).toISOString(),
      display_timezone: row.display_timezone,
      status: row.status as SessionReminderStatus,
      created_by: row.created_by as UserID,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      revision: row.revision,
      claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : undefined,
      claim_expires_at: row.claim_expires_at
        ? new Date(row.claim_expires_at).toISOString()
        : undefined,
      attempt_count: row.attempt_count,
      queued_at: row.queued_at ? new Date(row.queued_at).toISOString() : undefined,
      task_id: (row.task_id as TaskID | null) ?? undefined,
      failure_code: (row.failure_code as SessionReminderFailureCode | null) ?? undefined,
      // Wake fields are omitted entirely on time-only reminders.
      ...(row.wake_when
        ? {
            wake_when: wakeConditionFromRow(row.wake_when),
            check_every_minutes: row.check_every_minutes ?? undefined,
            next_check_at: row.next_check_at
              ? new Date(row.next_check_at).toISOString()
              : undefined,
            wake_outcome: row.wake_outcome ?? undefined,
          }
        : {}),
    },
    row
  );
}

function wakeConditionFromRow(value: unknown): SessionReminderWakeCondition {
  const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as
    | SessionReminderWakeCondition
    | undefined;
  return {
    kind: 'github_pr',
    repo: String(parsed?.repo ?? ''),
    number: Number(parsed?.number),
    state: parsed?.state === 'closed' ? 'closed' : 'merged',
  };
}

function minutesFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

function boundedPage(limit: number, skip: number, maxLimit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new RepositoryError(`Page limit must be an integer between 1 and ${maxLimit}`);
  }
  if (!Number.isInteger(skip) || skip < 0 || skip > SESSION_MEMORY_MAX_ROWS_PER_SESSION) {
    throw new RepositoryError(
      `Page offset must be between 0 and ${SESSION_MEMORY_MAX_ROWS_PER_SESSION}`
    );
  }
}

export class SessionMemoryRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    session_id: SessionID;
    title?: string;
    text: string;
    tags: string[];
    created_by: UserID;
  }): Promise<SessionMemory> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, input.session_id);
        const parent = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, input.session_id))
          .one();
        if (!parent) throw new EntityNotFoundError('Session', input.session_id);
        const existing = await select(tx, { value: count() })
          .from(sessionMemories)
          .where(eq(sessionMemories.session_id, input.session_id))
          .one();
        if (Number(existing?.value ?? 0) >= SESSION_MEMORY_MAX_ROWS_PER_SESSION) {
          throw new RepositoryError(
            `A Session may contain at most ${SESSION_MEMORY_MAX_ROWS_PER_SESSION} memory entries`
          );
        }
        const now = new Date();
        const values: SessionMemoryInsert = {
          memory_id: generateId(),
          session_id: input.session_id,
          title: input.title ?? null,
          text: input.text,
          tags: input.tags,
          archived: false,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
          revision: 1,
        };
        return memoryFromRow(await insert(tx, sessionMemories).values(values).returning().one());
      },
      { sqliteImmediate: true }
    );
  }

  async findPage(input: {
    session_id: SessionID;
    archived?: boolean;
    search?: string;
    limit: number;
    skip: number;
  }): Promise<{ data: SessionMemory[]; total: number }> {
    boundedPage(input.limit, input.skip, SESSION_MEMORY_MAX_LIMIT);
    const conditions = [eq(sessionMemories.session_id, input.session_id)];
    if (input.archived !== undefined) conditions.push(eq(sessionMemories.archived, input.archived));
    const search = input.search?.trim().toLowerCase();
    if (search) {
      const escaped = search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      const pattern = `%${escaped}%`;
      conditions.push(
        sql`(
          lower(coalesce(${sessionMemories.title}, '')) LIKE ${pattern} ESCAPE '\\'
          OR lower(${sessionMemories.text}) LIKE ${pattern} ESCAPE '\\'
          OR lower(cast(${sessionMemories.tags} as text)) LIKE ${pattern} ESCAPE '\\'
        )`
      );
    }
    const where = and(...conditions);
    const totalRow = await select(this.db, { value: count() })
      .from(sessionMemories)
      .where(where)
      .one();
    const rows = await select(this.db)
      .from(sessionMemories)
      .where(where)
      .orderBy(desc(sessionMemories.updated_at), desc(sessionMemories.memory_id))
      .limit(input.limit)
      .offset(input.skip)
      .all();
    return { data: rows.map(memoryFromRow), total: Number(totalRow?.value ?? 0) };
  }

  async updateInSession(
    sessionId: SessionID,
    memoryId: SessionMemoryID | string,
    expectedRevision: number,
    patch: { title?: string | null; text?: string; tags?: string[]; archived?: boolean }
  ): Promise<SessionMemory> {
    const current = await select(this.db)
      .from(sessionMemories)
      .where(
        and(eq(sessionMemories.memory_id, memoryId), eq(sessionMemories.session_id, sessionId))
      )
      .one();
    if (!current) throw new EntityNotFoundError('SessionMemory', memoryId);
    const result = await update(this.db, sessionMemories)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        updated_at: new Date(),
        revision: expectedRevision + 1,
      })
      .where(
        and(
          eq(sessionMemories.memory_id, current.memory_id),
          eq(sessionMemories.session_id, sessionId),
          eq(sessionMemories.revision, expectedRevision)
        )
      )
      .run();
    if (result.rowsAffected !== 1) throw new SessionMemoryRevisionConflictError();
    const row = await select(this.db)
      .from(sessionMemories)
      .where(eq(sessionMemories.memory_id, current.memory_id))
      .one();
    if (!row) throw new EntityNotFoundError('SessionMemory', memoryId);
    return memoryFromRow(row);
  }
}

export interface DueSessionReminderRef {
  reminder_id: SessionReminderID;
  tenant_id?: string;
}

export class SessionReminderRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    session_id: SessionID;
    text: string;
    due_at: string;
    display_timezone: string;
    created_by: UserID;
    wake_when?: SessionReminderWakeCondition;
    check_every_minutes?: number;
  }): Promise<SessionReminder> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, input.session_id);
        const parent = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, input.session_id))
          .one();
        if (!parent) throw new EntityNotFoundError('Session', input.session_id);
        const active = await select(tx, { value: count() })
          .from(sessionReminders)
          .where(
            and(
              eq(sessionReminders.session_id, input.session_id),
              or(eq(sessionReminders.status, 'scheduled'), eq(sessionReminders.status, 'claimed'))
            )
          )
          .one();
        if (Number(active?.value ?? 0) >= SESSION_REMINDER_MAX_SCHEDULED_PER_SESSION) {
          throw new RepositoryError(
            `A Session may have at most ${SESSION_REMINDER_MAX_SCHEDULED_PER_SESSION} pending reminders`
          );
        }
        const now = new Date();
        const values: SessionReminderInsert = {
          reminder_id: generateId(),
          session_id: input.session_id,
          text: input.text,
          due_at: new Date(input.due_at),
          display_timezone: input.display_timezone,
          status: 'scheduled',
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
          revision: 1,
          claim_token: null,
          claimed_at: null,
          claim_expires_at: null,
          attempt_count: 0,
          queued_at: null,
          task_id: null,
          failure_code: null,
          ...(input.wake_when && input.check_every_minutes
            ? {
                wake_when: input.wake_when,
                check_every_minutes: input.check_every_minutes,
                next_check_at: minutesFrom(now, input.check_every_minutes),
              }
            : {}),
        };
        return reminderFromRow(await insert(tx, sessionReminders).values(values).returning().one());
      },
      { sqliteImmediate: true }
    );
  }

  async findPage(input: {
    session_id: SessionID;
    statuses?: SessionReminderStatus[];
    limit: number;
    skip: number;
  }): Promise<{ data: SessionReminder[]; total: number }> {
    boundedPage(input.limit, input.skip, SESSION_REMINDER_MAX_LIMIT);
    const conditions = [eq(sessionReminders.session_id, input.session_id)];
    if (input.statuses?.length) {
      conditions.push(or(...input.statuses.map((status) => eq(sessionReminders.status, status)))!);
    }
    const where = and(...conditions);
    const totalRow = await select(this.db, { value: count() })
      .from(sessionReminders)
      .where(where)
      .one();
    const rows = await select(this.db)
      .from(sessionReminders)
      .where(where)
      .orderBy(desc(sessionReminders.due_at), desc(sessionReminders.reminder_id))
      .limit(input.limit)
      .offset(input.skip)
      .all();
    return { data: rows.map(reminderFromRow), total: Number(totalRow?.value ?? 0) };
  }

  async updateScheduledInSession(
    sessionId: SessionID,
    reminderId: SessionReminderID | string,
    expectedRevision: number,
    patch: {
      text?: string;
      due_at?: string;
      display_timezone?: string;
      /** Final condition and cadence; `null` makes the reminder time-only. */
      wake?: { wake_when: SessionReminderWakeCondition; check_every_minutes: number } | null;
      cancel?: boolean;
    }
  ): Promise<SessionReminder> {
    const now = new Date();
    const wake =
      patch.wake === undefined
        ? {}
        : patch.wake === null
          ? { wake_when: null, check_every_minutes: null, next_check_at: null, wake_outcome: null }
          : {
              wake_when: patch.wake.wake_when,
              check_every_minutes: patch.wake.check_every_minutes,
              next_check_at: minutesFrom(now, patch.wake.check_every_minutes),
            };
    const values = patch.cancel
      ? { status: 'cancelled' as const }
      : {
          ...(patch.text !== undefined ? { text: patch.text } : {}),
          ...(patch.due_at !== undefined ? { due_at: new Date(patch.due_at) } : {}),
          ...(patch.display_timezone !== undefined
            ? { display_timezone: patch.display_timezone }
            : {}),
          ...wake,
        };
    const result = await update(this.db, sessionReminders)
      .set({ ...values, updated_at: now, revision: expectedRevision + 1 })
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.session_id, sessionId),
          eq(sessionReminders.status, 'scheduled'),
          eq(sessionReminders.revision, expectedRevision)
        )
      )
      .run();
    if (result.rowsAffected !== 1) throw new SessionReminderRevisionConflictError();
    const row = await select(this.db)
      .from(sessionReminders)
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.session_id, sessionId)
        )
      )
      .one();
    if (!row) throw new EntityNotFoundError('SessionReminder', reminderId);
    return reminderFromRow(row);
  }

  /** Scheduled settings of one reminder, for merging a partial wake edit. */
  async findScheduledWakeInSession(
    sessionId: SessionID,
    reminderId: SessionReminderID | string
  ): Promise<Pick<SessionReminder, 'wake_when' | 'check_every_minutes'> | null> {
    const row = await select(this.db)
      .from(sessionReminders)
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.session_id, sessionId)
        )
      )
      .one();
    if (!row) return null;
    const reminder = reminderFromRow(row);
    return { wake_when: reminder.wake_when, check_every_minutes: reminder.check_every_minutes };
  }

  private dueCondition(now: Date) {
    return or(
      and(eq(sessionReminders.status, 'scheduled'), lte(sessionReminders.due_at, now)),
      // A conditional reminder is also due for its next condition check.
      and(eq(sessionReminders.status, 'scheduled'), lte(sessionReminders.next_check_at, now)),
      and(eq(sessionReminders.status, 'claimed'), lte(sessionReminders.claim_expires_at, now))
    );
  }

  async findDueRefs(now: Date, limit: number): Promise<DueSessionReminderRef[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RepositoryError('Due reminder discovery limit must be between 1 and 1000');
    }
    const tenantColumn = (sessionReminders as unknown as { tenant_id?: unknown }).tenant_id;
    const rows = await select(this.db, {
      reminder_id: sessionReminders.reminder_id,
      ...(tenantColumn ? { tenant_id: tenantColumn } : {}),
    })
      .from(sessionReminders)
      .where(this.dueCondition(now))
      .orderBy(asc(sessionReminders.due_at), asc(sessionReminders.reminder_id))
      .limit(limit)
      .all();
    return rows as DueSessionReminderRef[];
  }

  async claimDue(
    reminderId: SessionReminderID,
    now: Date,
    claimToken: string,
    leaseMs: number
  ): Promise<SessionReminder | null> {
    const result = await update(this.db, sessionReminders)
      .set({
        status: 'claimed',
        claim_token: claimToken,
        claimed_at: now,
        claim_expires_at: new Date(now.getTime() + leaseMs),
        attempt_count: sql`${sessionReminders.attempt_count} + 1`,
        updated_at: now,
        revision: sql`${sessionReminders.revision} + 1`,
      })
      .where(and(eq(sessionReminders.reminder_id, reminderId), this.dueCondition(now)))
      .run();
    if (result.rowsAffected !== 1) return null;
    const row = await select(this.db)
      .from(sessionReminders)
      .where(eq(sessionReminders.reminder_id, reminderId))
      .one();
    return row ? reminderFromRow(row) : null;
  }

  async markQueued(
    reminderId: SessionReminderID,
    claimToken: string,
    taskId: TaskID,
    now: Date
  ): Promise<SessionReminder | null> {
    const result = await update(this.db, sessionReminders)
      .set({
        status: 'queued',
        queued_at: now,
        task_id: taskId,
        claim_token: null,
        claim_expires_at: null,
        failure_code: null,
        updated_at: now,
        revision: sql`${sessionReminders.revision} + 1`,
      })
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.status, 'claimed'),
          eq(sessionReminders.claim_token, claimToken)
        )
      )
      .run();
    if (result.rowsAffected !== 1) return null;
    const row = await select(this.db)
      .from(sessionReminders)
      .where(eq(sessionReminders.reminder_id, reminderId))
      .one();
    return row ? reminderFromRow(row) : null;
  }

  /**
   * Release a claim whose condition check found nothing yet. The check was not
   * a delivery attempt, so its claim no longer counts toward the attempt cap.
   */
  async rescheduleCheck(
    reminderId: SessionReminderID,
    claimToken: string,
    nextCheckAt: Date,
    now: Date
  ): Promise<SessionReminder | null> {
    const result = await update(this.db, sessionReminders)
      .set({
        status: 'scheduled',
        next_check_at: nextCheckAt,
        claim_token: null,
        claimed_at: null,
        claim_expires_at: null,
        attempt_count: sql`CASE WHEN ${sessionReminders.attempt_count} > 0 THEN ${sessionReminders.attempt_count} - 1 ELSE 0 END`,
        updated_at: now,
        revision: sql`${sessionReminders.revision} + 1`,
      })
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.status, 'claimed'),
          eq(sessionReminders.claim_token, claimToken),
          isNotNull(sessionReminders.wake_when),
          isNull(sessionReminders.wake_outcome)
        )
      )
      .run();
    if (result.rowsAffected !== 1) return null;
    const row = await select(this.db)
      .from(sessionReminders)
      .where(eq(sessionReminders.reminder_id, reminderId))
      .one();
    return row ? reminderFromRow(row) : null;
  }

  /**
   * Fix the observed outcome before dispatch so a crash-recovered claim renders
   * the identical prompt (the stable Task fence compares it).
   */
  async recordWakeOutcome(
    reminderId: SessionReminderID,
    claimToken: string,
    outcome: string,
    now: Date
  ): Promise<SessionReminder | null> {
    const result = await update(this.db, sessionReminders)
      .set({
        wake_outcome: outcome,
        next_check_at: null,
        updated_at: now,
        revision: sql`${sessionReminders.revision} + 1`,
      })
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.status, 'claimed'),
          eq(sessionReminders.claim_token, claimToken),
          isNotNull(sessionReminders.wake_when),
          isNull(sessionReminders.wake_outcome)
        )
      )
      .run();
    if (result.rowsAffected !== 1) return null;
    const row = await select(this.db)
      .from(sessionReminders)
      .where(eq(sessionReminders.reminder_id, reminderId))
      .one();
    return row ? reminderFromRow(row) : null;
  }

  async markBlocked(
    reminderId: SessionReminderID,
    claimToken: string,
    code: SessionReminderFailureCode,
    now: Date
  ): Promise<SessionReminder | null> {
    const result = await update(this.db, sessionReminders)
      .set({
        status: 'blocked',
        failure_code: code,
        claim_token: null,
        claim_expires_at: null,
        updated_at: now,
        revision: sql`${sessionReminders.revision} + 1`,
      })
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.status, 'claimed'),
          eq(sessionReminders.claim_token, claimToken)
        )
      )
      .run();
    if (result.rowsAffected !== 1) return null;
    const row = await select(this.db)
      .from(sessionReminders)
      .where(eq(sessionReminders.reminder_id, reminderId))
      .one();
    return row ? reminderFromRow(row) : null;
  }

  async deferClaim(
    reminderId: SessionReminderID,
    claimToken: string,
    retryAt: Date
  ): Promise<boolean> {
    const result = await update(this.db, sessionReminders)
      .set({ claim_token: null, claim_expires_at: retryAt, updated_at: new Date() })
      .where(
        and(
          eq(sessionReminders.reminder_id, reminderId),
          eq(sessionReminders.status, 'claimed'),
          eq(sessionReminders.claim_token, claimToken)
        )
      )
      .run();
    return result.rowsAffected === 1;
  }
}
