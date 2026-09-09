import { randomUUID } from 'node:crypto';
import {
  assertTenantWritable,
  BranchRepository,
  type DueSessionReminderRef,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionReminderRepository,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  type AuthenticatedParams,
  classifyBranchFilesystemReadiness,
  type SessionReminder,
  type SessionReminderFailureCode,
  type Task,
  type TenantID,
  type UUID,
} from '@agor/core/types';
import type { Application } from '../declarations.js';
import { sessionReminderTaskId } from '../utils/durable-task-id.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

const DEFAULT_BATCH = 25;
const DEFAULT_INTERVAL_MS = 30_000;
const CLAIM_LEASE_MS = 2 * 60_000;
const RETRY_MS = 30_000;

export interface SessionReminderWorkerOptions {
  tenantId?: TenantID | string;
  scanBatchSize?: number;
  intervalMs?: number;
  random?: () => number;
  now?: () => Date;
  discover?: (now: Date, limit: number) => Promise<DueSessionReminderRef[]>;
}

/**
 * Bounded, all-daemon reconciler for one-shot Session reminders.
 * Discovery is intentionally redundant; claim-token CAS and a stable Task ID
 * are the HA/restart fences. No transaction spans prompt admission.
 */
export class SessionReminderWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;
  private readonly batchSize: number;
  private readonly intervalMs: number;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly options: SessionReminderWorkerOptions = {}
  ) {
    this.batchSize = options.scanBatchSize ?? DEFAULT_BATCH;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(Math.floor((this.options.random ?? Math.random)() * 15_000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runIteration();
    }, delay);
    this.timer.unref?.();
  }

  private async runIteration(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let count = 0;
    try {
      count = await this.checkOnce();
    } catch (error) {
      console.warn(
        `[session-reminders] scan_failed error_type=${JSON.stringify(error instanceof Error ? error.name : 'unknown')}`
      );
    } finally {
      this.running = false;
    }
    this.schedule(count >= this.batchSize ? 150 : this.intervalMs);
  }

  private async discover(now: Date): Promise<DueSessionReminderRef[]> {
    if (this.options.discover) return this.options.discover(now, this.batchSize);
    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.options.tenantId, (tenantDb) =>
        new SessionReminderRepository(tenantDb).findDueRefs(now, this.batchSize)
      );
    }
    return runWithSystemDatabaseScope(
      this.db,
      'Session reminder discovery',
      (systemDb) => new SessionReminderRepository(systemDb).findDueRefs(now, this.batchSize),
      { capability: 'session_reminder_discovery' }
    );
  }

  /** One bounded overdue/restart recovery pass, also used by HA tests. */
  async checkOnce(): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    const refs = await this.discover(now);
    for (const ref of refs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      if (!tenantId) {
        console.error(
          `[session-reminders] route_missing_tenant reminder_id=${JSON.stringify(ref.reminder_id)}`
        );
        continue;
      }
      await runWithTenantContext(tenantId, () => this.processOne(tenantId, ref, now));
    }
    return refs.length;
  }

  private async processOne(
    tenantId: TenantID | string,
    ref: DueSessionReminderRef,
    now: Date
  ): Promise<void> {
    const token = randomUUID();
    const claimed = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
      await assertTenantWritable(tenantDb, tenantId);
      return new SessionReminderRepository(tenantDb).claimDue(
        ref.reminder_id,
        now,
        token,
        CLAIM_LEASE_MS
      );
    });
    if (!claimed) return;
    this.publish(claimed, tenantId);

    try {
      const preparation = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
        const sessions = new SessionRepository(tenantDb);
        const session = await sessions.findById(claimed.session_id);
        if (!session) return { failure: 'session_missing' as const };
        const expectedTaskId = sessionReminderTaskId(claimed.reminder_id);
        const existing = await new TaskRepository(tenantDb).findById(expectedTaskId);
        if (existing) {
          if (!this.taskMatches(existing, claimed)) {
            return { failure: 'dispatch_failed' as const };
          }
          // A matching Task is the durable dispatch fence. Lifecycle or RBAC
          // changes after that point cannot retroactively make it a duplicate.
          return { session, existing, admitted: true as const };
        }
        if (session.archived) return { failure: 'session_archived' as const };
        const branchRepository = new BranchRepository(tenantDb);
        const branch = await branchRepository.findById(session.branch_id);
        if (!branch) return { failure: 'branch_unavailable' as const };
        if (branch.archived) return { failure: 'branch_archived' as const };
        if (classifyBranchFilesystemReadiness(branch) !== 'ready') {
          return { failure: 'branch_unavailable' as const };
        }
        const user = await new UsersRepository(tenantDb).findById(claimed.created_by);
        if (!user) return { failure: 'authorization_revoked' as const };
        const authority = await branchRepository.resolveSessionPromptAuthority(
          branch.branch_id,
          claimed.created_by as UUID,
          session.created_by as UUID,
          session.sdk_home_scope
        );
        if (!authority.allowed) return { failure: 'authorization_revoked' as const };
        return { session, user, admitted: false as const };
      });

      if ('failure' in preparation) {
        await this.block(
          claimed,
          token,
          tenantId,
          preparation.failure as SessionReminderFailureCode,
          now
        );
        return;
      }

      const taskId = sessionReminderTaskId(claimed.reminder_id);
      let task: Task;
      if (preparation.admitted) {
        task = preparation.existing;
      } else {
        const params: AuthenticatedParams & { route: { id: string } } = {
          route: { id: preparation.session.session_id },
          provider: undefined,
          user: preparation.user,
          authenticated: true,
          tenant: { tenant_id: tenantId as TenantID, source: 'explicit' },
        };
        task = (await this.app.service('/sessions/:id/prompt').create(
          {
            prompt: this.promptFor(claimed),
            stream: true,
            idempotencyTaskId: taskId,
            requireActiveSession: true,
            metadata: {
              system_authored: true,
              session_reminder: {
                reminder_id: claimed.reminder_id,
                due_at: claimed.due_at,
                created_at: claimed.created_at,
                one_shot: true,
              },
            },
          },
          params
        )) as Task;
      }

      // Re-validate the durable fence returned by prompt admission. Another
      // internal producer could have raced the stable ID between preparation
      // and admission; never attach a reminder to mismatched provenance.
      if (!this.taskMatches(task, claimed)) {
        await this.block(claimed, token, tenantId, 'dispatch_failed', now);
        return;
      }

      const queued = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
        await assertTenantWritable(tenantDb, tenantId);
        return new SessionReminderRepository(tenantDb).markQueued(
          claimed.reminder_id,
          token,
          task!.task_id,
          this.options.now?.() ?? new Date()
        );
      });
      if (queued) this.publish(queued, tenantId);
    } catch (error) {
      // Mutable lifecycle races are rechecked after the lease. Other failures
      // retain the durable claim with a short retry deadline; content is never logged.
      await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
        await new SessionReminderRepository(tenantDb).deferClaim(
          claimed.reminder_id,
          token,
          new Date((this.options.now?.() ?? new Date()).getTime() + RETRY_MS)
        );
      });
      console.warn(
        `[session-reminders] dispatch_deferred tenant_id=${JSON.stringify(tenantId)} reminder_id=${JSON.stringify(claimed.reminder_id)} error_type=${JSON.stringify(error instanceof Error ? error.name : 'unknown')}`
      );
    }
  }

  private promptFor(reminder: SessionReminder): string {
    return `<session_reminder id="${reminder.reminder_id}" one_shot="true" due_at="${reminder.due_at}">
This is a durable one-shot reminder for this same Agor Session. It does not reschedule itself. Creating another reminder requires an explicit agor_session_reminders_create tool call.

${reminder.text}
</session_reminder>`;
  }

  private taskMatches(task: Task, reminder: SessionReminder): boolean {
    const provenance = task.metadata?.session_reminder;
    return (
      task.task_id === sessionReminderTaskId(reminder.reminder_id) &&
      task.session_id === reminder.session_id &&
      task.created_by === reminder.created_by &&
      task.full_prompt === this.promptFor(reminder) &&
      provenance?.reminder_id === reminder.reminder_id &&
      provenance.one_shot === true
    );
  }

  private async block(
    reminder: SessionReminder,
    token: string,
    tenantId: TenantID | string,
    code: SessionReminderFailureCode,
    now: Date
  ): Promise<void> {
    const blocked = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
      await assertTenantWritable(tenantDb, tenantId);
      return new SessionReminderRepository(tenantDb).markBlocked(
        reminder.reminder_id,
        token,
        code,
        now
      );
    });
    if (blocked) this.publish(blocked, tenantId);
  }

  private publish(reminder: SessionReminder, tenantId: TenantID | string): void {
    emitServiceEvent(this.app, {
      path: 'session-reminders',
      event: 'patched',
      id: reminder.reminder_id,
      data: reminder,
      params: { tenant: { tenant_id: tenantId as TenantID, source: 'explicit' } },
    });
  }
}
