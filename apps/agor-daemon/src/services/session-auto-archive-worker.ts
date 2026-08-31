import {
  assertTenantWritable,
  type DueSessionAutoArchiveCursor,
  type DueSessionAutoArchiveRef,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, TenantID } from '@agor/core/types';
import type { Application } from '../declarations.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import type { TasksService } from './tasks.js';

export interface SessionAutoArchiveWorkerOptions {
  app: Application;
  tenantId?: TenantID | string;
  scanBatchSize?: number;
  intervalMs?: number;
  random?: () => number;
  discover?: (after?: DueSessionAutoArchiveCursor) => Promise<DueSessionAutoArchiveRef[]>;
}

/** Durable, all-daemon cleanup scanner. The archive transition itself is the fence. */
export class SessionAutoArchiveWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private cursor: DueSessionAutoArchiveCursor | undefined;
  private readonly batchSize: number;
  private readonly intervalMs: number;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: SessionAutoArchiveWorkerOptions
  ) {
    this.batchSize = options.scanBatchSize ?? 25;
    this.intervalMs = options.intervalMs ?? 30_000;
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

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runIteration();
    }, delay);
    this.timer.unref?.();
  }

  private async runIteration(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let found = 0;
    try {
      found = await this.checkOnce();
    } catch (error) {
      console.warn(
        `[session-auto-archive] scan_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
    } finally {
      this.running = false;
    }
    this.schedule(found >= this.batchSize ? 150 : this.intervalMs);
  }

  private async discover(): Promise<DueSessionAutoArchiveRef[]> {
    if (this.options.discover) return this.options.discover(this.cursor);
    const find = (db: TenantScopedDatabase) =>
      new SessionRepository(db).findDueAutoArchiveRefs(this.batchSize, this.cursor);
    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.options.tenantId, find);
    }
    return runWithSystemDatabaseScope(
      this.db,
      'Session auto-archive discovery',
      (systemDb) =>
        new SessionRepository(systemDb).findDueAutoArchiveRefs(this.batchSize, this.cursor),
      { capability: 'session_auto_archive_discovery' }
    );
  }

  /** One bounded recovery pass; exposed for restart and HA tests. */
  async checkOnce(): Promise<number> {
    const refs = await this.discover();
    const last = refs.at(-1);
    this.cursor = last
      ? { session_id: last.session_id, auto_archive_at: last.auto_archive_at }
      : undefined;
    for (const ref of refs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      if (!tenantId) {
        console.error(
          `[session-auto-archive] route_missing_tenant session_id=${JSON.stringify(ref.session_id)}`
        );
        continue;
      }
      await runWithTenantContext(tenantId, async () => {
        const params: AuthenticatedParams = {
          tenant: { tenant_id: tenantId as TenantID, source: 'explicit' },
        };
        try {
          // Delivery is its own tenant-scoped commit. Do not hold this unit
          // across the archive claim: the callback Task/message and its source
          // marker must be durably visible before eligibility can succeed.
          await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
            await assertTenantWritable(tenantDb, tenantId);
            await (
              this.options.app.service('tasks') as unknown as Pick<
                TasksService,
                'ensureAutoArchiveDeliveries'
              >
            ).ensureAutoArchiveDeliveries(ref.session_id, params);
          });
          const archived = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
            await assertTenantWritable(tenantDb, tenantId);
            return new SessionRepository(tenantDb).archiveDueChildIfEligible(
              ref.session_id,
              ref.auto_archive_at
            );
          });
          if (archived) {
            emitServiceEvent(this.options.app, {
              path: 'sessions',
              event: 'patched',
              data: archived,
              id: archived.session_id,
              params,
            });
          }
        } catch (error) {
          console.warn(
            `[session-auto-archive] process_failed tenant_id=${JSON.stringify(tenantId)} session_id=${JSON.stringify(ref.session_id)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
          );
        }
      });
    }
    if (refs.length < this.batchSize) this.cursor = undefined;
    return refs.length;
  }
}
