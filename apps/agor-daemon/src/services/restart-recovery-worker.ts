import type { AgorConfig } from '@agor/core/config';
import { resolveMultiTenancyConfig, resolveRestartRecoverySettings } from '@agor/core/config';
import {
  runWithTenantContext,
  runWithTenantDatabaseScope,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, Task, TaskID, User } from '@agor/core/types';
import { restartRecoveryTaskId } from '../utils/durable-task-id.js';

export const RESTART_RECOVERY_PROMPT =
  'Continue from the interrupted task. Inspect the previous task state first, then continue safely.';

type RecoveryDisposition = 'admitted' | 'superseded';

interface RestartRecoveryWorkerContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
}

interface RestartRecoveryWorkerDependencies {
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => Date;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function recoveryMetadata(
  source: Task,
  state: RecoveryDisposition,
  now: Date,
  options?: {
    admittedTaskId?: TaskID;
    reason?: 'session_advanced' | 'session_archived';
  }
): NonNullable<Task['metadata']>['restart_recovery'] {
  const existing = source.metadata?.restart_recovery;
  return {
    source_task_id: source.task_id,
    state,
    requested_at: existing?.requested_at ?? now.toISOString(),
    ...(options?.admittedTaskId
      ? { admitted_task_id: options.admittedTaskId, admitted_at: now.toISOString() }
      : {}),
    ...(options?.reason ? { disposition_reason: options.reason } : {}),
  };
}

async function loadSessionAndUser(
  ctx: RestartRecoveryWorkerContext,
  tenantId: string,
  source: Task
): Promise<{ session: Session; user: User }> {
  const params = { tenant: { tenant_id: tenantId, source: 'static' as const } };
  return runWithTenantDatabaseScope(ctx.db, tenantId, async () => {
    const [session, user] = await Promise.all([
      ctx.app.service('sessions').get(source.session_id, params),
      ctx.app.service('users').get(source.created_by, params),
    ]);
    return { session: session as Session, user: user as User };
  });
}

async function updateDisposition(
  ctx: RestartRecoveryWorkerContext,
  tenantId: string,
  source: Task,
  restartRecovery: NonNullable<Task['metadata']>['restart_recovery']
): Promise<void> {
  await runWithTenantDatabaseScope(ctx.db, tenantId, async () => {
    const repository = new TaskRepository(ctx.db);
    await repository.update(source.task_id, {
      metadata: { ...(source.metadata ?? {}), restart_recovery: restartRecovery },
    });
  });
}

/**
 * Admit deterministic restart continuations one at a time.
 *
 * Pending state lives on the terminal source Task, so a daemon death before
 * admission is retried on the next boot. A death after admission reuses the
 * same deterministic Task ID and therefore cannot create a duplicate turn.
 */
export async function drainRestartRecoveries(
  ctx: RestartRecoveryWorkerContext,
  dependencies: RestartRecoveryWorkerDependencies = {}
): Promise<{ admitted: number; superseded: number; failed: number }> {
  const settings = resolveRestartRecoverySettings(ctx.config.execution);
  if (!settings.enabled) return { admitted: 0, superseded: 0, failed: 0 };

  const tenantId = resolveMultiTenancyConfig(ctx.config).static_tenant_id;
  const pending = await runWithTenantDatabaseScope(ctx.db, tenantId, () =>
    new TaskRepository(ctx.db).findPendingRestartRecoveries(settings.maxTasksPerStart)
  );
  const sleep = dependencies.sleep ?? wait;
  const now = dependencies.now ?? (() => new Date());
  let admitted = 0;
  let superseded = 0;
  let failed = 0;

  for (const [index, source] of pending.entries()) {
    try {
      const { session, user } = await loadSessionAndUser(ctx, tenantId, source);
      const latestTaskId = session.tasks?.at(-1);
      if (session.archived) {
        await updateDisposition(
          ctx,
          tenantId,
          source,
          recoveryMetadata(source, 'superseded', now(), { reason: 'session_archived' })
        );
        superseded++;
      } else if (latestTaskId !== source.task_id) {
        await updateDisposition(
          ctx,
          tenantId,
          source,
          recoveryMetadata(source, 'superseded', now(), { reason: 'session_advanced' })
        );
        superseded++;
      } else {
        const continuationTaskId = restartRecoveryTaskId(source.task_id);
        await runWithTenantContext(tenantId, () =>
          ctx.app.service('/sessions/:id/prompt').create(
            {
              prompt: RESTART_RECOVERY_PROMPT,
              stream: true,
              messageSource: 'agor',
              idempotencyTaskId: continuationTaskId,
              metadata: {
                system_authored: true,
                restart_recovery: recoveryMetadata(source, 'admitted', now(), {
                  admittedTaskId: continuationTaskId,
                }),
              },
            },
            {
              route: { id: session.session_id },
              provider: undefined,
              user,
              tenant: { tenant_id: tenantId, source: 'static' as const },
            } as never
          )
        );
        await updateDisposition(
          ctx,
          tenantId,
          source,
          recoveryMetadata(source, 'admitted', now(), { admittedTaskId: continuationTaskId })
        );
        admitted++;
        console.log(
          `[restart-recovery] admitted task=${shortId(continuationTaskId)} source_task=${shortId(source.task_id)} session=${shortId(source.session_id)}`
        );
      }
    } catch (error) {
      failed++;
      console.warn(
        `[restart-recovery] admission failed source_task=${shortId(source.task_id)} session=${shortId(source.session_id)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (index < pending.length - 1) await sleep(settings.delayMs);
  }

  console.log(
    `[restart-recovery] settled admitted=${admitted} superseded=${superseded} failed=${failed} pending_scanned=${pending.length}`
  );
  return { admitted, superseded, failed };
}
