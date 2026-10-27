import {
  acquireTenantWriteGate,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  insert,
  isPostgresDatabase,
  RepoRepository,
  releaseTenantWriteGate,
  runMigrations,
  runWithTenantDatabaseScope,
  ScheduleFailureNotificationRepository,
  UsersRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { scheduleFailureNotifications } from '../../../../packages/core/src/db/schema';
import type { Application } from '../declarations';
import { ScheduleFailureNotificationWorker } from './schedule-failure-notifications';

vi.mock('@agor/core/config', async (original) => ({
  ...(await original<typeof import('@agor/core/config')>()),
  getBaseUrl: async () => 'https://example.invalid',
}));
const url = process.env.AGOR_TEST_POSTGRES_URL;
const pg = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!url || !pg)(
  'schedule failure worker tenant gates and fairness (PostgreSQL)',
  () => {
    let raw: Database;
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: url! });
      await runMigrations(raw);
    });
    afterAll(async () => {
      if (isPostgresDatabase(raw))
        await (raw as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    const scoped = <T>(tenant: string, fn: (db: Database) => Promise<T>) =>
      runWithTenantDatabaseScope(raw, tenant, fn);
    async function seed(tenant: string, ids: string[]) {
      return scoped(tenant, async (db) => {
        const user = await new UsersRepository(db).create({
          email: `${generateId()}@example.invalid`,
          name: 'Fixture',
          role: 'admin',
        });
        const repo = await new RepoRepository(db).create({
          repo_id: generateId(),
          slug: `alert-${generateId()}`,
          name: 'Fixture',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/repo',
          local_path: '/tmp/unused',
          default_branch: 'main',
        });
        const branch = await new BranchRepository(db).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          created_by: user.user_id,
          name: 'Fixture',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: '/tmp/unused',
        });
        const channel = await new GatewayChannelRepository(db).create({
          channel_type: 'slack',
          target_branch_id: branch.branch_id,
          created_by: user.user_id,
          enabled: true,
          name: 'Fixture',
          config: {
            bot_token: 'xoxb-fixture',
            app_token: 'xapp-fixture',
            outbound_enabled: true,
            allowed_channel_ids: ['C123'],
            schedule_failure_alert_target: 'channel:C123',
          },
        });
        // Soft retained identities: this is the legitimate post-retention outbox shape.
        const due = new Date(Date.now() - 60_000);
        for (const taskId of ids)
          await insert(db, scheduleFailureNotifications)
            .values({
              task_id: taskId,
              session_id: generateId(),
              schedule_id: generateId(),
              branch_id: branch.branch_id,
              created_by: user.user_id,
              scheduled_run_at: due.getTime(),
              status: 'pending',
              next_attempt_at: due,
              created_at: due,
              updated_at: due,
            })
            .run();
        return { branch, channel };
      });
    }

    it('advances beyond 25 frozen-A rows to healthy B, wraps, and never mutates the frozen tenant', async () => {
      const a = `frozen-a-${generateId()}`,
        b = `healthy-b-${generateId()}`;
      const ids = Array.from({ length: 26 }, () => generateId()).sort();
      await seed(a, ids.slice(0, 25));
      await seed(b, [ids[25]]);
      const gate = await acquireTenantWriteGate(raw, a, { holder: 'offline fixture' });
      const emitMessage = vi.fn(async () => {
        expect(getCurrentTenantId()).toBe(b);
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        return { platform_message_id: '123.456', delivered: true, recorded: true };
      });
      const worker = new ScheduleFailureNotificationWorker(
        createTenantScopedDatabaseProxy(raw),
        { service: () => ({ emitMessage }) } as unknown as Application,
        { now: () => new Date(Date.now() + 1000) }
      );
      try {
        await worker.checkOnce();
        expect(emitMessage).not.toHaveBeenCalled();
        await worker.checkOnce();
        expect(emitMessage).toHaveBeenCalledTimes(1);
        // Subsequent cycles still advance; an already delivered B is never posted again.
        await worker.checkOnce();
        await worker.checkOnce();
        expect(emitMessage).toHaveBeenCalledTimes(1);
        await scoped(a, async (db) => {
          const notices = await new ScheduleFailureNotificationRepository(db).findAll();
          expect(notices).toHaveLength(25);
          expect(
            notices.every((row) => row.status === 'pending' && row.last_error_code === null)
          ).toBe(true);
          expect(await new ScheduleFailureNotificationRepository(db).findById(ids[25])).toBeNull();
        });
        await scoped(b, async (db) => {
          expect(
            await new ScheduleFailureNotificationRepository(db).findById(ids[25])
          ).toMatchObject({ status: 'delivered' });
          expect(await new ScheduleFailureNotificationRepository(db).findById(ids[0])).toBeNull();
        });
      } finally {
        await releaseTenantWriteGate(raw, a, { generation: gate.generation });
      }
    });

    it('a gate acquired in provider IO prevents every post-IO mutation; known receipt resumes without resend', async () => {
      const tenant = `late-gate-${generateId()}`,
        id = generateId();
      const seeded = await seed(tenant, [id]);
      let generation = '';
      const emitMessage = vi.fn(async () => {
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        generation = (await acquireTenantWriteGate(raw, tenant, { holder: 'offline fixture' }))
          .generation;
        return { platform_message_id: '123.456', delivered: true, recorded: false };
      });
      const worker = new ScheduleFailureNotificationWorker(
        createTenantScopedDatabaseProxy(raw),
        { service: () => ({ emitMessage }) } as unknown as Application,
        { tenantId: tenant, now: () => new Date(Date.now() + 1000) }
      );
      try {
        await worker.checkOnce();
        await worker.checkOnce();
        await scoped(tenant, async (db) => {
          expect(await new ScheduleFailureNotificationRepository(db).findById(id)).toMatchObject({
            status: 'sending',
            platform_message_id: null,
          });
          expect(await new BranchRepository(db).findById(seeded.branch.branch_id)).toMatchObject({
            needs_attention: false,
          });
        });
      } finally {
        if (generation) await releaseTenantWriteGate(raw, tenant, { generation });
      }
      await worker.checkOnce();
      expect(emitMessage).toHaveBeenCalledTimes(1);
      await scoped(tenant, async (db) =>
        expect(await new ScheduleFailureNotificationRepository(db).findById(id)).toMatchObject({
          status: 'delivered',
          platform_message_id: '123.456',
        })
      );
    });
  }
);
