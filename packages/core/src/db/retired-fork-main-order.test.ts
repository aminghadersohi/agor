import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import {
  checkMigrationStatus,
  classifyMigrationWatermark,
  MigrationError,
  pendingOfflineCutoverMigrations,
  planRetiredForkMainOrderRewind,
  RETIRED_FORK_MAIN_ORDER,
  runMigrations,
} from './migrate';

/** Both journals, Postgres first, as the migrator reads them off disk. */
const readJournals = () =>
  Promise.all(
    [
      new URL('../../drizzle/postgres/meta/_journal.json', import.meta.url),
      new URL('../../drizzle/sqlite/meta/_journal.json', import.meta.url),
    ].map(
      async (url) =>
        JSON.parse(await readFile(url, 'utf8')) as {
          entries: Array<{ idx: number; tag: string; when: number }>;
        }
    )
  );

// A database that ran fork main's old order (front desk at the profile slot,
// then profile images at the callback slot) records both reconciled slots as
// applied under the retired files' hashes. Drizzle would skip profile images
// and callback storage there; runMigrations rewinds and replays instead.
describe('retired fork-main front desk / profile image order', () => {
  const DIALECTS = [
    ['postgres', RETIRED_FORK_MAIN_ORDER.postgresql],
    ['sqlite', RETIRED_FORK_MAIN_ORDER.sqlite],
  ] as const;
  const REPLAYED = [
    '9028_profile_image_galleries',
    '0113_callback_ownership_reconciliation',
    '0114_restore_session_indexes',
    '9030_branch_front_desk_sessions',
  ];

  it('recognises the retired files only by hashes no journalled migration has', async () => {
    const journals = await readJournals();
    for (const [index, [dialect, order]] of DIALECTS.entries()) {
      const hashes = new Set<string>();
      for (const { tag } of journals[index]!.entries) {
        const body = await readFile(
          new URL(`../../drizzle/${dialect}/${tag}.sql`, import.meta.url),
          'utf8'
        );
        hashes.add(createHash('sha256').update(body).digest('hex'));
      }
      expect(order.retired.map(({ tag }) => tag)).toEqual([
        '9028_branch_front_desk_sessions',
        '9029_profile_image_galleries',
      ]);
      for (const { hash } of order.retired) expect(hashes.has(hash)).toBe(false);
      // The rewind starts exactly at the reconciled profile slot.
      expect(journals[index]!.entries.find(({ when }) => when === order.from)?.tag).toBe(
        '9028_profile_image_galleries'
      );
    }
  });

  it('plans a rewind only for a ledger carrying the retired order', async () => {
    const journals = await readJournals();
    for (const [index, [dialect, order]] of DIALECTS.entries()) {
      const entries = journals[index]!.entries;
      const planDialect = dialect === 'postgres' ? 'postgresql' : 'sqlite';
      const [frontDesk, profile] = order.retired;
      const row = (hash: string, created_at: number) => ({ hash, created_at });
      const current = entries
        .filter(({ when }) => when >= order.from)
        .map(({ when }) => row('current', when));
      const frontDeskWhen = entries.find(
        ({ tag }) => tag === '9030_branch_front_desk_sessions'
      )!.when;

      // Deployed amin_dev / new main history: nothing to repair.
      expect(planRetiredForkMainOrderRewind(planDialect, entries, current)).toBeNull();
      expect(planRetiredForkMainOrderRewind(planDialect, entries, [])).toBeNull();

      // Fork main after front desk landed, before profile images.
      const stateB = [row(frontDesk!.hash, frontDesk!.createdAt)];
      expect(planRetiredForkMainOrderRewind(planDialect, entries, stateB)).toEqual({
        rewindFrom: order.from,
        retired: ['9028_branch_front_desk_sessions'],
      });
      // Fork main at 7fe364e72, and the same database after an amin_dev build
      // applied 9030 on top of it (which cannot restore callback storage).
      const stateC = [...stateB, row(profile!.hash, profile!.createdAt)];
      for (const ledger of [stateC, [...stateC, row('amin-dev-9030', frontDeskWhen)]]) {
        expect(planRetiredForkMainOrderRewind(planDialect, entries, ledger)).toEqual({
          rewindFrom: order.from,
          retired: ['9028_branch_front_desk_sessions', '9029_profile_image_galleries'],
        });
      }
      const replay = classifyMigrationWatermark(entries, order.from - 1).pending;
      expect(replay.slice(0, dialect === 'sqlite' ? 4 : 3)).toEqual(
        REPLAYED.filter((tag) => entries.some((entry) => entry.tag === tag))
      );

      // Anything the rewind could not replay idempotently is refused.
      expect(() =>
        planRetiredForkMainOrderRewind(planDialect, entries, [
          ...stateC,
          row('unknown', order.from + 3),
        ])
      ).toThrow(MigrationError);
      expect(() =>
        planRetiredForkMainOrderRewind(planDialect, entries, [
          row('current', order.from),
          row(profile!.hash, profile!.createdAt),
        ])
      ).toThrow(/retired front-desk\/profile-image order/);
      expect(() =>
        planRetiredForkMainOrderRewind(planDialect, entries, [
          row(frontDesk!.hash, profile!.createdAt),
        ])
      ).toThrow(MigrationError);
    }
  });

  async function withMigratedSQLite(
    run: (
      db: ReturnType<typeof createDatabase>,
      helpers: {
        ledger: () => Promise<Array<{ hash: string; created_at: number }>>;
        objects: () => Promise<string[]>;
      }
    ) => Promise<void>
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'agor-retired-fork-main-order-'));
    const db = createDatabase({ url: `file:${join(directory, 'migration.db')}` });
    const { from } = RETIRED_FORK_MAIN_ORDER.sqlite;
    try {
      await runMigrations(db);
      await run(db, {
        ledger: async () =>
          rawRows(
            await executeRaw(
              db,
              sql`SELECT hash, created_at FROM __drizzle_migrations WHERE created_at >= ${from} ORDER BY created_at`
            )
          ).map((row) => ({ hash: String(row.hash), created_at: Number(row.created_at) })),
        objects: async () =>
          rawRows(
            await executeRaw(
              db,
              sql`SELECT name FROM sqlite_master WHERE name IN (
                'profile_images', 'completion_subscriptions', 'branch_front_desk_sessions',
                'sessions_agentic_tool_idx', 'sessions_scheduled_flag_idx'
              ) ORDER BY name`
            )
          ).map((row) => String(row.name)),
      });
    } finally {
      (db as typeof db & { $client: { close(): void } }).$client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function recordRetiredOrder(db: ReturnType<typeof createDatabase>, count: 1 | 2) {
    const { from, retired } = RETIRED_FORK_MAIN_ORDER.sqlite;
    await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at >= ${from}`);
    for (const { hash, createdAt } of retired.slice(0, count)) {
      await executeRaw(
        db,
        sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${createdAt})`
      );
    }
  }

  // Upstream migrations this fork journals above the deployed tail. Neither
  // retired order ran them, so the repair replays them after the slice.
  const UPSTREAM_TAIL = ['0115_user_api_key_source'];
  const dropUpstreamTail = (db: ReturnType<typeof createDatabase>) =>
    executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);

  const ALL_OBJECTS = [
    'branch_front_desk_sessions',
    'completion_subscriptions',
    'profile_images',
    'sessions_agentic_tool_idx',
    'sessions_scheduled_flag_idx',
  ];

  it('repairs a SQLite database that ran fork main at 7fe364e72', async () => {
    await withMigratedSQLite(async (db, { ledger, objects }) => {
      const fresh = await ledger();
      expect(await objects()).toEqual(ALL_OBJECTS);
      // Fork main never created callback storage or the restored indexes.
      await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
      await executeRaw(db, sql`DROP INDEX sessions_agentic_tool_idx`);
      await executeRaw(db, sql`DROP INDEX sessions_scheduled_flag_idx`);
      await dropUpstreamTail(db);
      await recordRetiredOrder(db, 2);

      const status = await checkMigrationStatus(db);
      expect(status.ledgerRewind).toEqual({
        rewindFrom: RETIRED_FORK_MAIN_ORDER.sqlite.from,
        retired: ['9028_branch_front_desk_sessions', '9029_profile_image_galleries'],
      });
      expect(status.pending).toEqual([...REPLAYED, ...UPSTREAM_TAIL]);
      expect(pendingOfflineCutoverMigrations('sqlite', status)).toEqual([]);

      await runMigrations(db);
      expect(await objects()).toEqual(ALL_OBJECTS);
      // The repaired ledger is the deployed history, row for row.
      expect(await ledger()).toEqual(fresh);
      const after = await checkMigrationStatus(db);
      expect(after.pending).toEqual([]);
      expect(after.ledgerRewind).toBeUndefined();
    });
  }, 30000);

  it('repairs a SQLite database that stopped after fork main front desk', async () => {
    await withMigratedSQLite(async (db, { ledger, objects }) => {
      const fresh = await ledger();
      await executeRaw(db, sql`DROP TABLE profile_images`);
      await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
      await executeRaw(db, sql`DROP INDEX sessions_agentic_tool_idx`);
      await executeRaw(db, sql`DROP INDEX sessions_scheduled_flag_idx`);
      await dropUpstreamTail(db);
      await recordRetiredOrder(db, 1);
      // Without the repair the new journal would read profile images as applied.
      expect((await checkMigrationStatus(db)).pending).toEqual([...REPLAYED, ...UPSTREAM_TAIL]);

      await runMigrations(db);
      expect(await objects()).toEqual(ALL_OBJECTS);
      expect(await ledger()).toEqual(fresh);
    });
  }, 30000);

  it('refuses, without touching the ledger, a retired order it cannot replay', async () => {
    await withMigratedSQLite(async (db, { ledger }) => {
      await recordRetiredOrder(db, 2);
      await executeRaw(
        db,
        sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('unknown', ${RETIRED_FORK_MAIN_ORDER.sqlite.from + 3})`
      );
      const before = await ledger();
      await expect(runMigrations(db)).rejects.toMatchObject({
        cause: { message: expect.stringContaining('unrecognized rows') },
      });
      expect(await ledger()).toEqual(before);
    });
  }, 30000);
});
