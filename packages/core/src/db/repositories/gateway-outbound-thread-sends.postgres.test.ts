/**
 * PostgreSQL mirror of the SQLite outbound-thread-send coverage.
 *
 * The one-seed-per-thread index carries `tenant_id` here and not on SQLite, so
 * the conflict target this path relies on is dialect-specific and must be
 * exercised against a real PostgreSQL server.
 */

import type { BranchID, GatewayChannelID, TenantID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { GatewayOutboundMessageRepository } from './gateway-outbound-messages';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

const SLACK_CHANNEL = 'D0BHLE7HLBS';
const THREAD_TS = '1789949079.895189';
const THREAD_ID = `${SLACK_CHANNEL}-${THREAD_TS}`;

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'gateway outbound thread sends (PostgreSQL)',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET ||= 'gateway-outbound-postgres-test-secret';
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seedChannel(tenantId: TenantID) {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `outbound-${generateId()}@example.test`,
          name: 'Outbound thread sends',
          role: 'admin',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `outbound-${generateId()}`,
          name: 'Outbound thread sends',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/outbound.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: `outbound-${generateId()}`,
          ref: 'main',
          branch_unique_id: Date.now() % 1_000_000_000,
          path: `/tmp/${generateId()}`,
          created_by: user.user_id as UserID,
        });
        const channel = await new GatewayChannelRepository(scoped).create({
          id: generateId() as GatewayChannelID,
          name: 'Outbound thread sends',
          channel_type: 'slack',
          channel_key: `slack-${generateId()}`,
          enabled: true,
          target_branch_id: branch.branch_id,
          agor_user_id: user.user_id,
          created_by: user.user_id,
          config: { bot_token: 'xoxb-test', outbound_enabled: true },
        });
        return { branch, channel, user };
      });
    }

    function sendData(
      seeded: Awaited<ReturnType<typeof seedChannel>>,
      messageId: string,
      threadId = THREAD_ID
    ) {
      return {
        gateway_channel_id: seeded.channel.id,
        channel_type: 'slack' as const,
        platform_channel_id: SLACK_CHANNEL,
        platform_message_id: messageId,
        platform_thread_id: threadId,
        platform_permalink: `https://example.slack.test/archives/${SLACK_CHANNEL}/p${messageId.replace('.', '')}`,
        target_branch_id: seeded.branch.branch_id,
        emitted_by_user_id: seeded.user.user_id,
        message_text: `send ${messageId}`,
        message_preview: `send ${messageId}`,
      };
    }

    it('records a reply into a seeded thread instead of failing', async () => {
      const tenantId = `outbound-seq-${generateId()}` as TenantID;
      const seeded = await seedChannel(tenantId);

      const { first, second } = await runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const repo = new GatewayOutboundMessageRepository(scoped);
        return {
          first: await repo.recordSend(sendData(seeded, THREAD_TS)),
          second: await repo.recordSend(sendData(seeded, '1789949999.111111')),
        };
      });

      expect(first.role).toBe('thread_seed');
      expect(second.role).toBe('thread_followup');
      expect(second.message.platform_message_id).toBe('1789949999.111111');
      expect(second.message.platform_permalink).toContain('1789949999111111');
      expect(second.message.seed_thread_id).toBeNull();
      expect(first.message.seed_thread_id).toBe(THREAD_ID);
    });

    it('keeps the seed addressable when the thread has follow-ups', async () => {
      const tenantId = `outbound-admit-${generateId()}` as TenantID;
      const seeded = await seedChannel(tenantId);

      const { seed, admission } = await runWithTenantDatabaseScope(
        dbA,
        tenantId,
        async (scoped) => {
          const repo = new GatewayOutboundMessageRepository(scoped);
          const seed = await repo.recordSend(sendData(seeded, THREAD_TS));
          await repo.recordSend(sendData(seeded, '1789949999.111111'));
          return { seed, admission: await repo.admitReplySession(seeded.channel.id, THREAD_ID) };
        }
      );

      expect(admission?.message.id).toBe(seed.message.id);
      expect(admission?.admitted).toBe(true);
    });

    it('elects exactly one seed when independent connections race', async () => {
      const tenantId = `outbound-race-${generateId()}` as TenantID;
      const seeded = await seedChannel(tenantId);

      const records = await Promise.all(
        [dbA, dbB, dbA, dbB].map((db, index) =>
          runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            new GatewayOutboundMessageRepository(scoped).recordSend(
              sendData(seeded, `17899499${index}.000002`)
            )
          )
        )
      );

      expect(records.filter((record) => record.role === 'thread_seed')).toHaveLength(1);
      expect(records.filter((record) => record.role === 'thread_followup')).toHaveLength(3);
      expect(new Set(records.map((record) => record.message.id)).size).toBe(4);
      expect(new Set(records.map((record) => record.message.platform_message_id)).size).toBe(4);
    });

    it('scopes the seed to its own tenant', async () => {
      const tenantA = `outbound-tenant-a-${generateId()}` as TenantID;
      const tenantB = `outbound-tenant-b-${generateId()}` as TenantID;
      const seededA = await seedChannel(tenantA);
      const seededB = await seedChannel(tenantB);

      const roleA = await runWithTenantDatabaseScope(dbA, tenantA, (scoped) =>
        new GatewayOutboundMessageRepository(scoped).recordSend(sendData(seededA, THREAD_TS))
      );
      // The same thread id under another tenant is a different thread and must
      // still be allowed to seed.
      const roleB = await runWithTenantDatabaseScope(dbA, tenantB, (scoped) =>
        new GatewayOutboundMessageRepository(scoped).recordSend(sendData(seededB, THREAD_TS))
      );

      expect(roleA.role).toBe('thread_seed');
      expect(roleB.role).toBe('thread_seed');
    });
  }
);
