import { assertNoEgress } from '../../../../packages/core/src/test/no-egress';

assertNoEgress();

import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  executeRaw,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleFailureNotificationRepository,
  ScheduleRepository,
  SessionRepository,
  sql,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { GatewayNotDispatchedError } from '@agor/core/gateway';
import {
  type AuthenticatedParams,
  SCHEDULE_FAILURE_ALERT_TARGET,
  TaskStatus,
} from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import type { Application } from '../declarations';
import {
  ScheduleFailureNotificationsService,
  ScheduleFailureNotificationWorker,
  scheduleFailureAlertText,
} from './schedule-failure-notifications';

const frozen = vi.hoisted(() => new Set<string>());
const commitFault = vi.hoisted(() => ({ loseAck: false }));
vi.mock('@agor/core/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...original,
    runWithTenantDatabaseTransaction: vi.fn(
      async (...args: Parameters<typeof original.runWithTenantDatabaseTransaction>) => {
        const result = await original.runWithTenantDatabaseTransaction(...args);
        if (commitFault.loseAck) {
          commitFault.loseAck = false;
          throw new Error('fixture committed, acknowledgement lost');
        }
        return result;
      }
    ),
    assertTenantWritable: vi.fn(async (db, tenantId) => {
      if (frozen.has(tenantId)) throw new Error('fixture tenant frozen');
      return original.assertTenantWritable(db, tenantId);
    }),
  };
});
afterEach(() => {
  frozen.clear();
  commitFault.loseAck = false;
});

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  getBaseUrl: vi.fn(async () => 'https://example.invalid'),
}));

async function fixture(raw: Database) {
  const db = createTenantScopedDatabaseProxy(raw);
  const tenant = 'default';
  const scoped = <T>(fn: (db: Database) => Promise<T>) =>
    runWithTenantDatabaseScope(db, tenant, fn);
  const seed = await scoped(async (unit) => {
    const user = await new UsersRepository(unit).create({
      email: `${generateId()}@example.invalid`,
      name: 'Test owner',
      role: 'admin',
    });
    const repo = await new RepoRepository(unit).create({
      repo_id: generateId(),
      slug: `alert-${generateId()}`,
      name: 'Test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/repo.git',
      local_path: '/tmp/unused',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(unit).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      created_by: user.user_id,
      name: 'test',
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: '/tmp/unused',
    });
    const schedule = await new ScheduleRepository(unit).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      name: 'SECRET NAME',
      prompt: 'SECRET PROMPT',
      cron_expression: '* * * * *',
      timezone_mode: 'utc',
      agentic_tool_config: { agentic_tool: 'codex' },
      enabled: true,
    });
    const channel = await new GatewayChannelRepository(unit).create({
      channel_type: 'slack',
      created_by: user.user_id,
      target_branch_id: branch.branch_id,
      name: 'Test alert',
      enabled: true,
      config: {
        bot_token: 'xoxb-fixture-not-a-secret',
        app_token: 'xapp-fixture-not-a-secret',
        outbound_enabled: true,
        allowed_channel_ids: ['C123'],
        [SCHEDULE_FAILURE_ALERT_TARGET]: 'channel:C123',
      },
    });
    return { user, branch, schedule, channel };
  });
  let occurrence = Date.now();
  const fail = () =>
    scoped(async (unit) => {
      const id = generateId();
      const session = await new SessionRepository(unit).create({
        branch_id: seed.branch.branch_id,
        created_by: seed.user.user_id,
        agentic_tool: 'codex',
        schedule_id: seed.schedule.schedule_id,
        scheduled_from_branch: true,
        scheduled_run_at: occurrence++,
        custom_context: {
          scheduled_run: { run_index: 1, initial_task_id: id, rendered_prompt: 'SECRET PROMPT' },
        },
      });
      const tasks = new TaskRepository(unit);
      const task = await tasks.create({
        task_id: id,
        session_id: session.session_id,
        created_by: seed.user.user_id,
        full_prompt: 'SECRET PROMPT',
        status: TaskStatus.RUNNING,
      });
      await tasks.update(id, { status: TaskStatus.FAILED, error_message: 'SECRET PROVIDER LOG' });
      return task;
    });
  const emitMessage = vi.fn(async (_data: unknown) => {
    expect(getCurrentTenantId()).toBe(tenant);
    expect(getCurrentTenantDatabaseScope()).toBeUndefined(); // Never hold a DB transaction during provider IO.
    return {
      delivered: true,
      recorded: true,
      platform_message_id: `receipt-${emitMessage.mock.calls.length}`,
    };
  });
  const confirmScheduleFailureReceipt = vi.fn(
    async (_task: string, _attempt: string | null, message: string, _operator: string) =>
      message as string | null
  );
  const app = {
    service: () => ({ emitMessage, confirmScheduleFailureReceipt }),
  } as unknown as Application;
  let now = new Date(Date.now() + 1000);
  const worker = () =>
    new ScheduleFailureNotificationWorker(db, app, { tenantId: tenant, now: () => now });
  const read = (id: string) =>
    scoped((unit) => new ScheduleFailureNotificationRepository(unit).findById(id));
  return {
    ...seed,
    app,
    confirmScheduleFailureReceipt,
    db,
    scoped,
    fail,
    emitMessage,
    worker,
    read,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('schedule failure notifications (offline gateway)', () => {
  dbTest(
    'committed release with lost ACK cannot reopen a concurrently claimed newer attempt',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      const workerA = f.worker();
      const release = ScheduleFailureNotificationRepository.prototype.notDispatched;
      const released = vi
        .spyOn(ScheduleFailureNotificationRepository.prototype, 'notDispatched')
        .mockImplementationOnce(async function (
          this: ScheduleFailureNotificationRepository,
          ...args
        ) {
          const changed = await release.apply(this, args);
          commitFault.loseAck = true; // Wrapper throws only AFTER the actual transaction commits.
          return changed;
        });
      let rejectAccepted!: (error: Error) => void;
      let runningB: Promise<number> | undefined;
      const accepted = new Promise<never>((_resolve, reject) => {
        rejectAccepted = reject;
      });
      let acceptedEffects = 0;
      f.emitMessage.mockImplementation(async () => {
        acceptedEffects++;
        return { delivered: true, recorded: true, platform_message_id: 'inert-extra-effect' };
      });
      f.emitMessage.mockRejectedValueOnce(new GatewayNotDispatchedError());
      f.emitMessage.mockImplementationOnce(() => {
        acceptedEffects++;
        return accepted;
      });
      try {
        await workerA.checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({ status: 'pending', attempt_id: null });
        const attemptA = released.mock.calls[0][1];
        f.advance(31_000);
        const workerB = f.worker();
        runningB = workerB.checkOnce();
        await vi.waitFor(() => expect(f.emitMessage).toHaveBeenCalledTimes(2));
        const attemptB = (await f.read(task.task_id))!.attempt_id!;
        expect(attemptB).not.toBe(attemptA);
        await workerA.checkOnce(); // Cached A retries after B has been accepted, but before B's receipt.
        const stateAfterOldRelease = await f.read(task.task_id);
        // Settle within the same clock instant, not after the real transport deadline.
        rejectAccepted(new Error('inert accepted but receipt lost'));
        await runningB;
        f.advance(31_000);
        await f.worker().checkOnce();
        expect(acceptedEffects).toBe(1); // Real committed A release + lost ACK must not permit a second accepted B/C effect.
        expect(f.emitMessage).toHaveBeenCalledTimes(2);
        expect(stateAfterOldRelease).toMatchObject({ status: 'sending', attempt_id: attemptB });
        expect(await f.read(task.task_id)).toMatchObject({
          status: 'uncertain',
          attempt_id: attemptB,
        });
        await f.scoped(async (unit) => {
          const repo = new ScheduleFailureNotificationRepository(unit);
          expect(await repo.finish(task.task_id, attemptB, '123.456')).toBe(true);
          expect(await repo.notDispatched(task.task_id, attemptA)).toBe(false);
          expect(await repo.uncertain(task.task_id, attemptA)).toBe(false);
        });
        expect(await f.read(task.task_id)).toMatchObject({
          status: 'delivered',
          attempt_id: attemptB,
          platform_message_id: '123.456',
        });
      } finally {
        if (runningB) {
          rejectAccepted(new Error('inert cleanup'));
          await runningB;
        }
        released.mockRestore();
      }
    }
  );

  dbTest(
    'stale settlement generations cannot mutate any terminal or release boundary',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      await f.scoped(async (unit) => {
        const repo = new ScheduleFailureNotificationRepository(unit);
        const a = (await repo.beginSend(task.task_id, f.channel.id, 'channel:C123'))!;
        expect(await repo.notDispatched(task.task_id, a)).toBe(true);
        const b = (await repo.beginSend(task.task_id, f.channel.id, 'channel:C123'))!;
        expect(b).not.toBe(a);
        expect(await repo.uncertain(task.task_id, a)).toBe(false);
        expect(await repo.finish(task.task_id, a, 'old')).toBe(false);
        expect(await repo.finish(task.task_id, null, 'legacy')).toBe(false);
        expect(await repo.notDispatched(task.task_id, a)).toBe(false);
        expect(await repo.findById(task.task_id)).toMatchObject({
          status: 'sending',
          attempt_id: b,
        });
        expect(await repo.uncertain(task.task_id, b)).toBe(true);
        expect(await repo.finish(task.task_id, b, '123.456')).toBe(true);
        expect(await repo.notDispatched(task.task_id, a)).toBe(false);
        expect(await repo.findById(task.task_id)).toMatchObject({
          status: 'delivered',
          attempt_id: b,
        });
      });
      expect(f.emitMessage).not.toHaveBeenCalled();
    }
  );
  for (const phase of ['ambiguous-outcome', 'expired-lease'] as const) {
    dbTest(
      `SQLite attention abort rolls back uncertainty and a replacement worker repairs ${phase} without resend`,
      async ({ db }) => {
        const f = await fixture(db);
        const task = await f.fail();
        await f.scoped((unit) =>
          new BranchRepository(unit).update(f.branch.branch_id, { needs_attention: false })
        );
        await executeRaw(
          db,
          sql`CREATE TRIGGER attention_abort BEFORE UPDATE OF needs_attention ON branches WHEN NEW.needs_attention = 1 BEGIN SELECT RAISE(ABORT, 'injected attention abort'); END`
        );
        if (phase === 'expired-lease') {
          await f.scoped((unit) =>
            new ScheduleFailureNotificationRepository(unit).beginSend(
              task.task_id,
              f.channel.id,
              'channel:C123'
            )
          );
          f.advance(150_000);
        } else f.emitMessage.mockRejectedValueOnce(new Error('inert lost receipt'));
        await f.worker().checkOnce(); // Its cache is intentionally discarded on replacement.
        expect(await f.read(task.task_id)).toMatchObject({ status: 'sending' });
        expect(
          await f.scoped((unit) => new BranchRepository(unit).findById(f.branch.branch_id))
        ).toMatchObject({ needs_attention: false });
        await executeRaw(db, sql`DROP TRIGGER attention_abort`);
        f.advance(150_000);
        await f.worker().checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({ status: 'uncertain' });
        expect(
          await f.scoped((unit) => new BranchRepository(unit).findById(f.branch.branch_id))
        ).toMatchObject({ needs_attention: true });
        expect(f.emitMessage).toHaveBeenCalledTimes(phase === 'expired-lease' ? 0 : 1);
        expect(
          await f.scoped((unit) => new ScheduleRepository(unit).findById(f.schedule.schedule_id))
        ).toMatchObject({ enabled: true });
      }
    );
  }

  dbTest(
    'operator reconciliation is fenced to its pre-read attempt, including a concurrent new claim',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      const old = await f.scoped((unit) =>
        new ScheduleFailureNotificationRepository(unit).beginSend(
          task.task_id,
          f.channel.id,
          'channel:C123'
        )
      );
      let newer: string | null = null;
      f.confirmScheduleFailureReceipt.mockImplementationOnce(async (_task, expected, message) => {
        expect(expected).toBe(old);
        await f.scoped(async (unit) => {
          const repo = new ScheduleFailureNotificationRepository(unit);
          await repo.notDispatched(task.task_id, old!);
          newer = await repo.beginSend(task.task_id, f.channel.id, 'channel:C123');
        });
        return message; // An old positive lookup cannot settle the newer attempt.
      });
      const service = new ScheduleFailureNotificationsService(f.db, f.app);
      await runWithTenantContext('default', () =>
        expect(
          service.patch(
            task.task_id,
            { action: 'confirm_delivery', platform_message_id: '123.456' },
            { user: f.user } as unknown as AuthenticatedParams
          )
        ).rejects.toThrow('attempt changed')
      );
      expect(await f.read(task.task_id)).toMatchObject({
        status: 'sending',
        attempt_id: newer,
        platform_message_id: null,
      });
      expect(f.emitMessage).not.toHaveBeenCalled();
    }
  );

  dbTest(
    'a saturated frozen discovery page cannot starve the next healthy tenant and cycle wraps',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      const held = Array.from({ length: 25 }, (_, i) => ({
        task_id: `held-${i}`,
        tenant_id: 'frozen-A',
      }));
      const discovery = vi
        .spyOn(ScheduleFailureNotificationRepository.prototype, 'findDueRefs')
        .mockImplementation(async (_now, after) =>
          after === 'held-24' ? [{ task_id: task.task_id, tenant_id: 'default' }] : held
        );
      const upper = vi
        .spyOn(ScheduleFailureNotificationRepository.prototype, 'discoveryUpperBound')
        .mockResolvedValue('cycle-upper');
      frozen.add('frozen-A');
      const worker = new ScheduleFailureNotificationWorker(f.db, f.app);
      try {
        await worker.checkOnce();
        expect(f.emitMessage).not.toHaveBeenCalled();
        await worker.checkOnce();
        expect(f.emitMessage).toHaveBeenCalledTimes(1);
        expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
        await worker.checkOnce();
        expect(discovery.mock.calls.map((call) => call.slice(1))).toEqual([
          [undefined, 'cycle-upper'],
          ['held-24', 'cycle-upper'],
          [undefined, 'cycle-upper'],
        ]);
        expect(f.emitMessage).toHaveBeenCalledTimes(1);
      } finally {
        discovery.mockRestore();
        upper.mockRestore();
      }
    }
  );

  dbTest(
    'operator receipt confirmation rechecks the tenant gate after its provider read, without resending',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      f.emitMessage.mockRejectedValueOnce(new Error('lost receipt'));
      await f.worker().checkOnce();
      const service = new ScheduleFailureNotificationsService(f.db, f.app);
      f.confirmScheduleFailureReceipt.mockImplementationOnce(async (_task, _attempt, id) => {
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        frozen.add('default');
        return id;
      });
      await runWithTenantContext('default', async () => {
        const data = { action: 'confirm_delivery', platform_message_id: '123.456' };
        const params = { user: f.user } as unknown as AuthenticatedParams;
        await expect(service.patch(task.task_id, data, params)).rejects.toThrow('frozen');
        expect(await service.get(task.task_id)).toMatchObject({
          status: 'uncertain',
          platform_message_id: null,
        });
        frozen.clear();
        expect(await service.patch(task.task_id, data, params)).toMatchObject({
          status: 'delivered',
        });
      });
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      expect(f.confirmScheduleFailureReceipt).toHaveBeenCalledWith(
        task.task_id,
        expect.any(String),
        '123.456',
        f.user.user_id
      );
    }
  );

  dbTest(
    'every distinct failure alerts once across worker restart; redacted content and manual hold preserved',
    async ({ db }) => {
      const f = await fixture(db);
      const tasks = await Promise.all([f.fail(), f.fail()]);
      await f.scoped((unit) =>
        new ScheduleRepository(unit).update(f.schedule.schedule_id, { enabled: false })
      );
      await f.worker().checkOnce();
      await f.worker().checkOnce();
      expect(f.emitMessage).toHaveBeenCalledTimes(2);
      for (const task of tasks)
        expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
      for (const [data] of f.emitMessage.mock.calls) {
        expect(data).toMatchObject({
          target: 'channel:C123',
          purpose: 'schedule_failure',
          emittedByUserId: f.user.user_id,
        });
        expect(JSON.stringify(data)).not.toContain('SECRET');
        expect(JSON.stringify(data)).toContain('https://example.invalid/ui/s/');
        expect(JSON.stringify(data)).toContain('https://example.invalid/ui/w/');
        expect(JSON.stringify(data).length).toBeLessThan(1500);
      }
      expect(
        await f.scoped((unit) => new ScheduleRepository(unit).findById(f.schedule.schedule_id))
      ).toMatchObject({ enabled: false });
    }
  );

  dbTest(
    'missing target remains pending and recovers when configured, without replaying the job',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      await f.scoped((unit) =>
        new GatewayChannelRepository(unit).update(f.channel.id, {
          config: { [SCHEDULE_FAILURE_ALERT_TARGET]: null },
        })
      );
      await f.worker().checkOnce();
      expect(await f.read(task.task_id)).toMatchObject({
        status: 'pending',
        last_error_code: 'target_unconfigured',
      });
      expect(f.emitMessage).not.toHaveBeenCalled();
      await f.scoped((unit) =>
        new GatewayChannelRepository(unit).update(f.channel.id, {
          config: { [SCHEDULE_FAILURE_ALERT_TARGET]: 'channel:C123' },
        })
      );
      f.advance(31_000);
      await f.worker().checkOnce();
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
    }
  );

  for (const variant of [
    'disabled',
    'outbound-disabled',
    'not-allowlisted',
    'ambiguous',
  ] as const) {
    dbTest(`fails closed for ${variant} target without changing schedule state`, async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      await f.scoped(async (unit) => {
        const channels = new GatewayChannelRepository(unit);
        if (variant === 'disabled') await channels.update(f.channel.id, { enabled: false });
        else if (variant === 'outbound-disabled')
          await channels.update(f.channel.id, { config: { outbound_enabled: false } });
        else if (variant === 'not-allowlisted')
          await channels.update(f.channel.id, { config: { allowed_channel_ids: ['C999'] } });
        else
          await channels.create({
            ...f.channel,
            id: generateId(),
            channel_key: generateId(),
            name: 'Other',
          });
      });
      await f.worker().checkOnce();
      expect(f.emitMessage).not.toHaveBeenCalled();
      expect(await f.read(task.task_id)).toMatchObject({
        status: 'pending',
        last_error_code: variant === 'ambiguous' ? 'target_ambiguous' : 'target_not_allowed',
      });
      expect(
        await f.scoped((unit) => new ScheduleRepository(unit).findById(f.schedule.schedule_id))
      ).toMatchObject({ enabled: true });
    });
  }

  dbTest('gateway creator must retain access to the failed branch', async ({ db }) => {
    const f = await fixture(db);
    const task = await f.fail();
    await f.scoped(async (unit) => {
      const stranger = await new UsersRepository(unit).create({
        email: `${generateId()}@example.invalid`,
        name: 'Other',
        role: 'member',
      });
      await new GatewayChannelRepository(unit).delete(f.channel.id);
      await new GatewayChannelRepository(unit).create({
        ...f.channel,
        created_by: stranger.user_id,
      });
    });
    await f.worker().checkOnce();
    expect(f.emitMessage).not.toHaveBeenCalled();
    expect(await f.read(task.task_id)).toMatchObject({
      status: 'pending',
      last_error_code: 'access_revoked',
    });
  });

  dbTest(
    'concurrent workers cannot steal or duplicate an in-flight provider attempt',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.emitMessage.mockImplementationOnce(async () => {
        entered();
        await gate;
        return { delivered: true, recorded: true, platform_message_id: 'receipt' };
      });
      const first = f.worker().checkOnce();
      await started;
      await f.worker().checkOnce();
      expect(await f.read(task.task_id)).toMatchObject({ status: 'sending' });
      finish();
      await first;
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
    }
  );

  dbTest(
    'lost receipt is visibly uncertain and never blindly resent after restart',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      f.emitMessage.mockRejectedValueOnce(new Error('SECRET transport error after possible post'));
      await f.worker().checkOnce();
      f.advance(150_000);
      await f.worker().checkOnce();
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      expect(await f.read(task.task_id)).toMatchObject({
        status: 'uncertain',
        last_error_code: 'delivery_unconfirmed',
      });
      expect(JSON.stringify(await f.read(task.task_id))).not.toContain('SECRET');
    }
  );

  dbTest(
    'pre-send crash lease is not stolen; expired attempt becomes uncertain, not replayed',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      await f.scoped((unit) =>
        new ScheduleFailureNotificationRepository(unit).beginSend(
          task.task_id,
          f.channel.id,
          'channel:C123'
        )
      );
      await f.worker().checkOnce();
      expect(await f.read(task.task_id)).toMatchObject({ status: 'sending' });
      f.advance(150_000);
      await f.worker().checkOnce();
      expect(f.emitMessage).not.toHaveBeenCalled();
      expect(await f.read(task.task_id)).toMatchObject({ status: 'uncertain' });
    }
  );

  dbTest('delivery with failed gateway audit is delivered, not retried', async ({ db }) => {
    const f = await fixture(db);
    const task = await f.fail();
    f.emitMessage.mockResolvedValueOnce({
      delivered: true,
      recorded: false,
      platform_message_id: 'receipt',
    });
    await f.worker().checkOnce();
    await f.worker().checkOnce();
    expect(f.emitMessage).toHaveBeenCalledTimes(1);
    expect(await f.read(task.task_id)).toMatchObject({
      status: 'delivered',
      platform_message_id: 'receipt',
    });
  });

  dbTest('read-only status survives restart and unknown IDs fail closed', async ({ db }) => {
    const f = await fixture(db);
    const task = await f.fail();
    await f.scoped(async (unit) => {
      const service = new ScheduleFailureNotificationsService(unit);
      expect(await service.find()).toHaveLength(1);
      expect(await service.get(task.task_id)).toMatchObject({ status: 'pending' });
      await expect(service.get(generateId())).rejects.toThrow('not found');
    });
    const row = (await f.read(task.task_id))!;
    expect(() => scheduleFailureAlertText(row, 'https://user:password@example.invalid')).toThrow();
    expect(() => scheduleFailureAlertText(row, 'javascript:alert(1)')).toThrow();
    expect(() =>
      scheduleFailureAlertText(row, `https://example.invalid/${'x'.repeat(1024)}`)
    ).toThrow();
    expect(() =>
      scheduleFailureAlertText(
        { ...row, task_id: 'x'.repeat(4096) as typeof row.task_id },
        'https://example.invalid'
      )
    ).toThrow();
  });
  dbTest(
    'typed pre-provider rejection retries only after fresh target/authority checks',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      const worker = f.worker();
      f.emitMessage.mockRejectedValueOnce(new GatewayNotDispatchedError());
      await worker.checkOnce();
      expect(await f.read(task.task_id)).toMatchObject({
        status: 'pending',
        last_error_code: 'not_dispatched',
      });
      await f.scoped((unit) =>
        new GatewayChannelRepository(unit).update(f.channel.id, { enabled: false })
      );
      f.advance(31_000);
      await worker.checkOnce();
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      await f.scoped((unit) =>
        new GatewayChannelRepository(unit).update(f.channel.id, { enabled: true })
      );
      f.advance(31_000);
      await worker.checkOnce();
      expect(f.emitMessage).toHaveBeenCalledTimes(2);
      expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
    }
  );

  for (const result of ['receipt', 'ambiguous', 'not_dispatched'] as const) {
    dbTest(
      `a gate acquired during provider IO fences ${result} settlement; resume never sends again`,
      async ({ db }) => {
        const f = await fixture(db);
        const task = await f.fail();
        const worker = f.worker();
        f.emitMessage.mockImplementationOnce(async () => {
          frozen.add('default');
          if (result === 'ambiguous') throw new Error('lost receipt');
          if (result === 'not_dispatched') throw new GatewayNotDispatchedError();
          return { delivered: true, recorded: false, platform_message_id: '123.456' };
        });
        await worker.checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({ status: 'sending' });
        await worker.checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({ status: 'sending' });
        expect(f.emitMessage).toHaveBeenCalledTimes(1);
        frozen.clear();
        await worker.checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({
          status:
            result === 'receipt' ? 'delivered' : result === 'ambiguous' ? 'uncertain' : 'pending',
        });
        expect(f.emitMessage).toHaveBeenCalledTimes(1);
      }
    );
  }

  dbTest(
    'trusted zero-effect evidence can recover after another worker expires the lease, never overwrite a receipt',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      const worker = f.worker();
      f.emitMessage.mockImplementationOnce(async () => {
        frozen.add('default');
        throw new GatewayNotDispatchedError();
      });
      await worker.checkOnce();
      frozen.clear();
      f.advance(150_000);
      await f.worker().checkOnce(); // Another process cannot know the first outcome.
      expect(await f.read(task.task_id)).toMatchObject({ status: 'uncertain' });
      await worker.checkOnce(); // Original process retains proof of nonacceptance.
      expect(await f.read(task.task_id)).toMatchObject({ status: 'pending' });
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      f.advance(31_000);
      await worker.checkOnce();
      expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
      await f.scoped(async (unit) =>
        new ScheduleFailureNotificationRepository(unit).notDispatched(
          task.task_id,
          (await f.read(task.task_id))!.attempt_id!
        )
      );
      expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
    }
  );
  dbTest(
    'a positive receipt persistence failure is retried idempotently, never a provider failure',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      const worker = f.worker();
      const original = ScheduleFailureNotificationRepository.prototype.finish;
      const write = vi
        .spyOn(ScheduleFailureNotificationRepository.prototype, 'finish')
        .mockRejectedValueOnce(new Error('fixture DB outage'));
      try {
        await worker.checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({ status: 'sending' });
        await worker.checkOnce();
        expect(await f.read(task.task_id)).toMatchObject({ status: 'delivered' });
        expect(f.emitMessage).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(2);
      } finally {
        write.mockRestore();
        expect(ScheduleFailureNotificationRepository.prototype.finish).toBe(original);
      }
    }
  );

  dbTest(
    'restart ambiguity has a verified operator receipt path, never blind resend or automatic attention clear',
    async ({ db }) => {
      const f = await fixture(db);
      const task = await f.fail();
      f.emitMessage.mockRejectedValueOnce(new Error('lost receipt'));
      await f.worker().checkOnce();
      expect(
        await f.scoped((unit) => new BranchRepository(unit).findById(f.branch.branch_id))
      ).toMatchObject({ needs_attention: true });
      const service = new ScheduleFailureNotificationsService(f.db, f.app);
      const params = { user: f.user } as unknown as AuthenticatedParams;
      await runWithTenantContext('default', async () => {
        f.confirmScheduleFailureReceipt.mockResolvedValueOnce(null);
        await expect(
          service.patch(
            task.task_id,
            { action: 'confirm_delivery', platform_message_id: '123.456' },
            params
          )
        ).rejects.toThrow('could not be verified');
        expect(await service.get(task.task_id)).toMatchObject({ status: 'uncertain' });
        await expect(service.patch(task.task_id, { action: 'resend' }, params)).rejects.toThrow(
          'resends are not supported'
        );
        expect(
          await service.patch(
            task.task_id,
            { action: 'confirm_delivery', platform_message_id: '123.456' },
            params
          )
        ).toMatchObject({ status: 'delivered' });
        expect(
          await service.patch(
            task.task_id,
            { action: 'confirm_delivery', platform_message_id: '123.456' },
            params
          )
        ).toMatchObject({ status: 'delivered' });
      });
      expect(f.emitMessage).toHaveBeenCalledTimes(1);
      expect(f.confirmScheduleFailureReceipt).toHaveBeenCalledTimes(2);
      expect(
        await f.scoped((unit) => new BranchRepository(unit).findById(f.branch.branch_id))
      ).toMatchObject({ needs_attention: true });
    }
  );
});
