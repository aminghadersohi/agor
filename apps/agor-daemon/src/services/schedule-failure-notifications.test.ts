import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  RepoRepository,
  runWithTenantDatabaseScope,
  ScheduleFailureNotificationRepository,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { SCHEDULE_FAILURE_ALERT_TARGET, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import type { Application } from '../declarations';
import {
  ScheduleFailureNotificationsService,
  ScheduleFailureNotificationWorker,
  scheduleFailureAlertText,
} from './schedule-failure-notifications';

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
  const app = { service: () => ({ emitMessage }) } as unknown as Application;
  let now = new Date(Date.now() + 1000);
  const worker = () =>
    new ScheduleFailureNotificationWorker(db, app, { tenantId: tenant, now: () => now });
  const read = (id: string) =>
    scoped((unit) => new ScheduleFailureNotificationRepository(unit).findById(id));
  return {
    ...seed,
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
        last_error_code: 'target_not_allowed',
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
  });
});
