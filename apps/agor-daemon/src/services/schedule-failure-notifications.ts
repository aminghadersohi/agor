import { getBaseUrl } from '@agor/core/config';
import {
  assertTenantWritable,
  BranchRepository,
  GatewayChannelRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleFailureNotificationRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import { isSlackWriteTargetAllowed } from '@agor/core/gateway';
import {
  SCHEDULE_FAILURE_ALERT_PURPOSE,
  SCHEDULE_FAILURE_ALERT_TARGET,
  type ScheduleFailureNotification,
  type TenantID,
} from '@agor/core/types';
import { getBranchUrl, getSessionUrl } from '@agor/core/utils/url';
import type { Application } from '../declarations.js';
import { hasBranchPermission } from '../utils/branch-authorization.js';
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

/** Read-only, admin-gated operational status; never accepts delivery/retry writes. */
export class ScheduleFailureNotificationsService {
  constructor(private db: TenantScopeAwareDatabase) {}
  find(params?: { query?: { $skip?: number; $limit?: number } }) {
    return new ScheduleFailureNotificationRepository(this.db).findAll(
      params?.query?.$skip,
      params?.query?.$limit
    );
  }
  async get(id: string) {
    const row = await new ScheduleFailureNotificationRepository(this.db).findById(id);
    if (!row) throw new NotFound('Schedule failure notification not found');
    return row;
  }
}

/** Durable at-most-once dispatch. Uncertain provider effects are NEVER blindly resent. */
export class ScheduleFailureNotificationWorker {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
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
    const discover = (db: ConstructorParameters<typeof ScheduleFailureNotificationRepository>[0]) =>
      new ScheduleFailureNotificationRepository(db).findDueRefs(now);
    const refs = this.options.tenantId
      ? await runWithTenantDatabaseScope(this.db, this.options.tenantId, discover)
      : await runWithSystemDatabaseScope(
          this.db,
          'Schedule failure notification discovery',
          discover,
          { capability: 'scheduler_discovery' }
        );
    for (const ref of refs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      if (!tenantId) continue; // Never infer a tenant from a provider payload or another row.
      try {
        await runWithTenantContext(tenantId, () => this.processOne(tenantId, ref.task_id, now));
      } catch {
        console.warn('[schedule-failure-notifications] occurrence_processing_failed');
      }
    }
    return refs.length;
  }
  private async processOne(tenantId: string, taskId: string, now: Date): Promise<void> {
    const ready = await runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
      await assertTenantWritable(db, tenantId);
      const repo = new ScheduleFailureNotificationRepository(db);
      const row = await repo.findById(taskId);
      if (!row || row.status === 'delivered' || row.status === 'uncertain') return null;
      if (row.status === 'sending') {
        if (Date.parse(row.next_attempt_at) <= now.getTime()) await repo.uncertain(taskId);
        return null;
      }
      const channels = (await new GatewayChannelRepository(db).findAll()).filter(
        (channel) =>
          channel.channel_type === 'slack' &&
          channel.config[SCHEDULE_FAILURE_ALERT_TARGET] !== undefined
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
    const began = await runWithTenantDatabaseScope(this.db, tenantId, async (db) => {
      await assertTenantWritable(db, tenantId);
      return new ScheduleFailureNotificationRepository(db).beginSend(
        taskId,
        ready.channelId,
        ready.target,
        now
      );
    });
    if (!began) return;
    try {
      // Identity remains ambient; GatewayService's tenant-bound repository facade
      // opens short DB units. No DB transaction spans the provider send.
      const gateway = this.app.service('gateway') as unknown as Pick<GatewayService, 'emitMessage'>;
      const sent = await gateway.emitMessage({
        gatewayChannelId: ready.channelId,
        target: ready.target,
        message: ready.text,
        purpose: SCHEDULE_FAILURE_ALERT_PURPOSE,
        emittedByUserId: ready.sender.user_id,
        userRole: ready.sender.role,
        emittedByTaskId: taskId,
        emittedByScheduleId: ready.row.schedule_id,
      });
      await runWithTenantDatabaseScope(this.db, tenantId, (db) =>
        new ScheduleFailureNotificationRepository(db).finish(taskId, sent.platform_message_id)
      );
    } catch {
      // The gateway may have posted before losing its receipt. A crash after
      // beginSend has the same ambiguity. Park visibly, do not post duplicates.
      await runWithTenantDatabaseScope(this.db, tenantId, (db) =>
        new ScheduleFailureNotificationRepository(db).uncertain(taskId)
      );
    }
  }
}
