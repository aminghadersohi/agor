import { getBaseUrl } from '@agor/core/config';
import {
  assertTenantWritable,
  BranchRepository,
  GatewayChannelRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  ScheduleFailureNotificationRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotFound } from '@agor/core/feathers';
import { GatewayNotDispatchedError, isSlackWriteTargetAllowed } from '@agor/core/gateway';
import {
  type AuthenticatedParams,
  SCHEDULE_FAILURE_ALERT_PURPOSE,
  SCHEDULE_FAILURE_ALERT_TARGET,
  type ScheduleFailureNotification,
  type TenantID,
  type UserID,
} from '@agor/core/types';
import { getBranchUrl, getSessionUrl } from '@agor/core/utils/url';
import type { Application } from '../declarations.js';
import { hasBranchPermission } from '../utils/branch-authorization.js';
import {
  createTenantBoundDataAccess,
  type TenantBoundDataAccess,
} from '../utils/tenant-bound-data-access.js';
import type { GatewayService } from './gateway.js';

/** Only fixed, content-free copy is sent. No names, prompts, errors or provider logs. */
export function scheduleFailureAlertText(
  row: ScheduleFailureNotification,
  baseUrl: string
): string {
  if (baseUrl.length > 1024) throw new Error('base_url_unavailable');
  const base = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('base_url_unavailable');
  }
  const text =
    `Scheduled execution failed.\n` +
    `Failed Task ${row.task_id}: <${getSessionUrl(row.session_id, base.toString())}|Open run>\n` +
    `Schedule ${row.schedule_id}: <${getBranchUrl(row.branch_id, base.toString())}|Open branch>\n` +
    `Occurrence: ${new Date(row.scheduled_run_at).toISOString()}. The schedule was not paused and no job was replayed.`;
  if (Buffer.byteLength(text, 'utf8') > 4096) throw new Error('summary_too_large');
  return text;
}

/** Admin status + verified receipt reconciliation. Never exposes a resend operation. */
export class ScheduleFailureNotificationsService {
  private readonly data: TenantBoundDataAccess;
  constructor(
    db: TenantScopeAwareDatabase,
    private app?: Pick<Application, 'service'>
  ) {
    this.data = createTenantBoundDataAccess(db);
  }
  find(params?: { query?: { $skip?: number; $limit?: number } }) {
    return this.data.read((db) =>
      new ScheduleFailureNotificationRepository(db).findAll(
        params?.query?.$skip,
        params?.query?.$limit
      )
    );
  }
  async get(id: string) {
    const row = await this.data.read((db) =>
      new ScheduleFailureNotificationRepository(db).findById(id)
    );
    if (!row) throw new NotFound('Schedule failure notification not found');
    return row;
  }
  async patch(id: string, data: unknown, params: AuthenticatedParams) {
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).some((key) => !['action', 'platform_message_id'].includes(key)) ||
      (data as { action?: unknown }).action !== 'confirm_delivery' ||
      typeof (data as { platform_message_id?: unknown }).platform_message_id !== 'string' ||
      !/^\d+\.\d+$/.test((data as { platform_message_id: string }).platform_message_id) ||
      !params.user?.user_id
    ) {
      throw new BadRequest(
        'Use confirm_delivery with an observed Slack message timestamp; resends are not supported'
      );
    }
    const row = await this.get(id);
    const messageId = (data as { platform_message_id: string }).platform_message_id;
    if (row.status === 'delivered') {
      if (row.platform_message_id !== messageId)
        throw new BadRequest('A different delivery is already confirmed');
      return row;
    }
    const gateway = this.app?.service('gateway') as unknown as
      | Pick<GatewayService, 'confirmScheduleFailureReceipt'>
      | undefined;
    // Provider READ is outside all DB units. Absence never authorizes a resend.
    let verified: string | null | undefined;
    try {
      verified = await gateway?.confirmScheduleFailureReceipt(
        row.task_id,
        row.attempt_id,
        messageId,
        params.user.user_id as UserID
      );
    } catch {
      throw new BadRequest('Delivery lookup unavailable; notification remains unresolved');
    }
    if (verified !== messageId)
      throw new BadRequest('Delivery could not be verified; notification remains unresolved');
    await this.data.write((db) =>
      new ScheduleFailureNotificationRepository(db).finish(row.task_id, row.attempt_id, messageId)
    );
    const confirmed = await this.get(id);
    if (
      confirmed.status !== 'delivered' ||
      confirmed.attempt_id !== row.attempt_id ||
      confirmed.platform_message_id !== messageId
    )
      throw new BadRequest('Notification attempt changed; receipt was not applied');
    return confirmed;
  }
}

/** Durable per-occurrence fence. Only proven nonacceptance permits another attempt. */
export class ScheduleFailureNotificationWorker {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private cursor: string | undefined;
  private cycleUpper: string | undefined;
  // Positive receipts and typed nonacceptance survive DB/gate failures in this
  // process. Bounded; restart recovery verifies durable provider metadata through
  // the operator API. No cache entry ever causes a second provider send.
  private settlements = new Map<
    string,
    {
      tenantId: string;
      taskId: string;
      attemptId: string;
      outcome: 'receipt' | 'not_dispatched' | 'uncertain';
      messageId?: string;
    }
  >();
  constructor(
    private db: TenantScopeAwareDatabase,
    private app: Application,
    private options: { tenantId?: TenantID | string; now?: () => Date } = {}
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.checkOnce()
        .catch(() => console.warn('[schedule-failure-notifications] worker_failed'))
        .finally(() => this.schedule());
    }, 30_000);
    this.timer.unref();
  }
  async checkOnce(): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    for (const [key, settlement] of this.settlements) {
      try {
        await runWithTenantContext(settlement.tenantId, () =>
          this.persistSettlement(settlement, now)
        );
        if (this.settlements.get(key) === settlement) this.settlements.delete(key);
      } catch {
        /* Write gate / transient DB failure: preserve the evidence, not another send. */
      }
    }
    const discover = async (
      db: ConstructorParameters<typeof ScheduleFailureNotificationRepository>[0]
    ) => {
      const repo = new ScheduleFailureNotificationRepository(db);
      this.cycleUpper ??= await repo.discoveryUpperBound(now);
      if (!this.cycleUpper) return [];
      return repo.findDueRefs(now, this.cursor, this.cycleUpper);
    };
    const refs = this.options.tenantId
      ? await runWithTenantDatabaseScope(this.db, this.options.tenantId, discover)
      : await runWithSystemDatabaseScope(
          this.db,
          'Schedule failure notification discovery',
          discover,
          { capability: 'scheduler_discovery' }
        );
    // Advance even if the tenant is frozen. Never mutate that tenant to achieve fairness.
    if (refs.length < 25) {
      this.cursor = undefined;
      this.cycleUpper = undefined;
    } else this.cursor = refs.at(-1)?.task_id;
    for (const ref of refs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      if (!tenantId || this.settlements.has(`${tenantId}:${ref.task_id}`)) continue; // Never infer a tenant from a provider payload or another row.
      try {
        await runWithTenantContext(tenantId, () => this.processOne(tenantId, ref.task_id, now));
      } catch {
        console.warn('[schedule-failure-notifications] occurrence_processing_failed');
      }
    }
    return refs.length;
  }
  private async processOne(tenantId: string, taskId: string, now: Date): Promise<void> {
    const ready = await runWithTenantDatabaseTransaction(this.db, tenantId, async (db) => {
      await assertTenantWritable(db, tenantId);
      const repo = new ScheduleFailureNotificationRepository(db);
      const row = await repo.findById(taskId);
      if (!row || row.status === 'delivered' || row.status === 'uncertain') return null;
      if (row.status === 'sending') {
        if (Date.parse(row.next_attempt_at) <= now.getTime()) {
          const changed = await repo.uncertain(taskId, row.attempt_id);
          if (changed && (await new BranchRepository(db).findById(row.branch_id)))
            await new BranchRepository(db).update(row.branch_id, { needs_attention: true });
        }
        return null;
      }
      const channels = (await new GatewayChannelRepository(db).findAll()).filter(
        (channel) =>
          channel.channel_type === 'slack' && channel.config[SCHEDULE_FAILURE_ALERT_TARGET] != null
      );
      if (channels.length !== 1) {
        await repo.defer(taskId, channels.length ? 'target_ambiguous' : 'target_unconfigured', now);
        return null;
      }
      const channel = channels[0];
      const target = channel.config[SCHEDULE_FAILURE_ALERT_TARGET];
      if (
        !channel.enabled ||
        channel.config.outbound_enabled !== true ||
        typeof target !== 'string' ||
        !/^channel:[CG][A-Z0-9]+$/.test(target) ||
        !isSlackWriteTargetAllowed(channel.config, target.slice(8))
      ) {
        await repo.defer(taskId, 'target_not_allowed', now);
        return null;
      }
      // This is an explicit admin-configured daemon notification, NOT a Session
      // emit or a fabricated Session credential. Use the gateway's real creator;
      // require current read access to the failed branch, then the gateway's
      // existing emit path checks outbound authority/allowlists again.
      const sender = await new UsersRepository(db).findById(channel.created_by);
      const branch = await new BranchRepository(db).findById(row.branch_id);
      if (
        !sender ||
        !branch ||
        !hasBranchPermission(
          branch,
          sender.user_id,
          await new BranchRepository(db).isOwner(branch.branch_id, sender.user_id),
          'view',
          sender.role,
          this.app.get?.('config')?.execution?.allow_superadmin === true,
          await new BranchRepository(db).resolveUserPermission(branch, sender.user_id)
        )
      ) {
        await repo.defer(taskId, 'access_revoked', now);
        return null;
      }
      let text: string;
      try {
        text = scheduleFailureAlertText(row, await getBaseUrl(db));
      } catch {
        await repo.defer(taskId, 'base_url_unavailable', now);
        return null;
      }
      return { channelId: channel.id, target, text, sender, row };
    });
    if (!ready) return;
    const attemptId = await runWithTenantDatabaseTransaction(this.db, tenantId, async (db) => {
      await assertTenantWritable(db, tenantId);
      return new ScheduleFailureNotificationRepository(db).beginSend(
        taskId,
        ready.channelId,
        ready.target,
        now
      );
    });
    if (!attemptId) return;
    let settlement: {
      tenantId: string;
      taskId: string;
      attemptId: string;
      outcome: 'receipt' | 'not_dispatched' | 'uncertain';
      messageId?: string;
    };
    try {
      const gateway = this.app.service('gateway') as unknown as Pick<GatewayService, 'emitMessage'>;
      const sent = await gateway.emitMessage({
        gatewayChannelId: ready.channelId,
        target: ready.target,
        message: ready.text,
        purpose: SCHEDULE_FAILURE_ALERT_PURPOSE,
        emittedByUserId: ready.sender.user_id,
        userRole: ready.sender.role,
        emittedByTaskId: taskId,
        emittedByScheduleAttemptId: attemptId,
        emittedByScheduleId: ready.row.schedule_id,
      });
      settlement = {
        tenantId,
        taskId,
        attemptId,
        outcome: 'receipt',
        messageId: sent.platform_message_id,
      };
    } catch (error) {
      settlement = {
        tenantId,
        taskId,
        attemptId,
        outcome: error instanceof GatewayNotDispatchedError ? 'not_dispatched' : 'uncertain',
      };
    }
    const key = `${tenantId}:${taskId}`;
    if (this.settlements.size >= 256 && !this.settlements.has(key)) {
      this.settlements.delete(this.settlements.keys().next().value!);
      console.warn('[schedule-failure-notifications] operator_receipt_reconciliation_required');
    }
    this.settlements.set(key, settlement);
    try {
      await this.persistSettlement(settlement, now);
      if (this.settlements.get(key) === settlement) this.settlements.delete(key);
    } catch {
      console.warn('[schedule-failure-notifications] settlement_deferred');
    }
  }
  private async persistSettlement(
    settlement: {
      tenantId: string;
      taskId: string;
      attemptId: string;
      outcome: 'receipt' | 'not_dispatched' | 'uncertain';
      messageId?: string;
    },
    now: Date
  ): Promise<void> {
    await runWithTenantDatabaseTransaction(this.db, settlement.tenantId, async (db) => {
      await assertTenantWritable(db, settlement.tenantId);
      const repo = new ScheduleFailureNotificationRepository(db);
      if (settlement.outcome === 'receipt')
        await repo.finish(settlement.taskId, settlement.attemptId, settlement.messageId!);
      else if (settlement.outcome === 'not_dispatched')
        await repo.notDispatched(settlement.taskId, settlement.attemptId, now);
      else {
        await repo.uncertain(settlement.taskId, settlement.attemptId);
        const row = await repo.findById(settlement.taskId);
        if (
          row?.status === 'uncertain' &&
          row.attempt_id === settlement.attemptId &&
          (await new BranchRepository(db).findById(row.branch_id))
        ) {
          await new BranchRepository(db).update(row.branch_id, { needs_attention: true });
        }
      }
    });
  }
}
