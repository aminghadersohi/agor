/**
 * One seed per platform thread, one audit row per proactive send.
 *
 * Regression coverage for the emit path that delivered a threaded Slack reply
 * and then failed persisting it, because the thread's seed row already owned
 * the (channel, platform_thread_id) unique index.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { GatewayChannelID, UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { GatewayOutboundMessageRepository } from './gateway-outbound-messages';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

/**
 * The composite key a Slack send derives: `<channel>-<thread_ts || ts>`.
 * A reply into a thread derives exactly the same key as its root, which is
 * what made the second emit collide.
 */
const SLACK_CHANNEL = 'D0BHLE7HLBS';
const THREAD_TS = '1789949079.895189';
const THREAD_ID = `${SLACK_CHANNEL}-${THREAD_TS}`;

async function seedChannel(db: Database) {
  const user = await new UsersRepository(db).create({
    user_id: generateId() as UserID,
    email: `${generateId()}@example.test`,
    name: 'Outbound thread sends',
    role: 'admin',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `outbound-${generateId()}`,
    name: 'Outbound thread sends',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/outbound.git',
    local_path: join(tmpdir(), generateId()),
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: `outbound-${generateId()}`,
    ref: 'main',
    branch_unique_id: Date.now() % 1_000_000_000,
    path: join(tmpdir(), generateId()),
    created_by: user.user_id,
  });
  const channel = await new GatewayChannelRepository(db).create({
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
}

function sendData(
  seeded: Awaited<ReturnType<typeof seedChannel>>,
  messageId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    gateway_channel_id: seeded.channel.id,
    channel_type: 'slack' as const,
    platform_channel_id: SLACK_CHANNEL,
    platform_message_id: messageId,
    platform_thread_id: THREAD_ID,
    platform_permalink: `https://example.slack.test/archives/${SLACK_CHANNEL}/p${messageId.replace('.', '')}`,
    target_branch_id: seeded.branch.branch_id,
    emitted_by_user_id: seeded.user.user_id,
    message_text: `send ${messageId}`,
    message_preview: `send ${messageId}`,
    ...overrides,
  };
}

describe('gateway outbound thread sends (SQLite)', () => {
  dbTest('records a reply into a seeded thread instead of failing', async ({ db }) => {
    const seeded = await seedChannel(db);
    const repo = new GatewayOutboundMessageRepository(db);

    const first = await repo.recordSend(sendData(seeded, THREAD_TS));
    const second = await repo.recordSend(sendData(seeded, '1789949999.111111'));

    expect(first.role).toBe('thread_seed');
    expect(second.role).toBe('thread_followup');
    // Requirement: the second send is its own audit row carrying its own
    // delivery evidence, never the seed's.
    expect(second.message.id).not.toBe(first.message.id);
    expect(second.message.platform_message_id).toBe('1789949999.111111');
    expect(second.message.platform_permalink).toContain('1789949999111111');
    expect(second.message.seed_thread_id).toBeNull();
    expect(first.message.seed_thread_id).toBe(THREAD_ID);
    // Both rows still record which thread they went to.
    expect(second.message.platform_thread_id).toBe(THREAD_ID);
  });

  dbTest('keeps the seed addressable when the thread has follow-ups', async ({ db }) => {
    const seeded = await seedChannel(db);
    const repo = new GatewayOutboundMessageRepository(db);

    const first = await repo.recordSend(sendData(seeded, THREAD_TS));
    await repo.recordSend(sendData(seeded, '1789949999.111111'));
    await repo.recordSend(sendData(seeded, '1789950000.222222'));

    const admission = await repo.admitReplySession(seeded.channel.id, THREAD_ID);
    expect(admission?.message.id).toBe(first.message.id);
    expect(admission?.admitted).toBe(true);
  });

  dbTest('never admits a follow-up row through a reply alias', async ({ db }) => {
    const seeded = await seedChannel(db);
    const repo = new GatewayOutboundMessageRepository(db);

    const alias = `${SLACK_CHANNEL}-1789950111.333333`;
    const seed = await repo.recordSend(
      sendData(seeded, THREAD_TS, { metadata: { provider_reply_aliases: [alias] } })
    );
    // A follow-up that repeats the seed's aliases must not make the lookup
    // ambiguous or stand in for the seed.
    await repo.recordSend(
      sendData(seeded, '1789949999.111111', { metadata: { provider_reply_aliases: [alias] } })
    );

    const admission = await repo.admitReplySession(seeded.channel.id, alias);
    expect(admission?.message.id).toBe(seed.message.id);
  });

  dbTest('still refuses a second seed through create()', async ({ db }) => {
    const seeded = await seedChannel(db);
    const repo = new GatewayOutboundMessageRepository(db);

    await repo.create(sendData(seeded, THREAD_TS));
    await expect(repo.create(sendData(seeded, '1789949999.111111'))).rejects.toThrow(
      /Failed to create gateway outbound message/
    );
  });

  dbTest('elects exactly one seed when sends race on one connection', async ({ db }) => {
    const seeded = await seedChannel(db);
    const repo = new GatewayOutboundMessageRepository(db);

    const records = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repo.recordSend(sendData(seeded, `178994990${index}.000001`))
      )
    );

    expect(records.filter((record) => record.role === 'thread_seed')).toHaveLength(1);
    expect(records.filter((record) => record.role === 'thread_followup')).toHaveLength(7);
    // Every send kept its own row and its own provider message id.
    expect(new Set(records.map((record) => record.message.id)).size).toBe(8);
    expect(new Set(records.map((record) => record.message.platform_message_id)).size).toBe(8);
  });
});

describe('gateway outbound thread sends across connections (SQLite)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it('elects exactly one seed when independent writers race', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agor-outbound-race-'));
    dirs.push(dir);
    const url = `file:${join(dir, 'test.db')}`;
    const db = createDatabase({ url });
    await initializeDatabase(db);
    const seeded = await seedChannel(db);

    // Separate connections, so the unique index — not statement ordering on one
    // handle — is what decides which send seeds the thread.
    const writers = Array.from(
      { length: 4 },
      () => new GatewayOutboundMessageRepository(createDatabase({ url }))
    );
    const records = await Promise.all(
      writers.map((writer, index) => writer.recordSend(sendData(seeded, `17899499${index}.000002`)))
    );

    expect(records.filter((record) => record.role === 'thread_seed')).toHaveLength(1);
    expect(records.filter((record) => record.role === 'thread_followup')).toHaveLength(3);
    expect(new Set(records.map((record) => record.message.id)).size).toBe(4);
  });
});
