import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { checkMigrationStatus, RETIRED_FORK_MAIN_ORDER, runMigrations } from './migrate';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const { from, retired } = RETIRED_FORK_MAIN_ORDER.postgresql;
const REPLAYED = [
  '9028_profile_image_galleries',
  '0113_callback_ownership_reconciliation',
  // Upstream's reconciliation, journalled directly after 0113 on this fork.
  '0117_callback_ownership_reconciliation',
  '9030_branch_front_desk_sessions',
];
// Upstream migrations this fork journals above the deployed tail. Neither
// retired order ran them, so the repair replays them after the slice.
const UPSTREAM_TAIL = ['0115_api_key_host_tenant_discovery', '0116_user_api_key_source'];

// Fork main journalled front desk at 1790129000214 and profile images at
// 1790129000215, the slots deployed amin_dev history uses for profile images
// and callback storage. A database that ran that order must be repaired by
// replaying the reconciled slice, never left without either table.
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'Retired fork-main migration order (PostgreSQL)',
  () => {
    let db: Database;
    let fresh: Array<{ hash: string; created_at: number }>;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await runMigrations(db);
      fresh = await ledger();
    });
    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    async function ledger() {
      return rawRows(
        await executeRaw(
          db,
          sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations
            WHERE created_at >= ${from} ORDER BY created_at`
        )
      ).map((row) => ({ hash: String(row.hash), created_at: Number(row.created_at) }));
    }

    async function dropUpstreamTail() {
      await executeRaw(
        db,
        sql`DROP POLICY IF EXISTS "api_key_host_tenant_discovery" ON app_variables`
      );
      await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
    }

    async function recordRetiredOrder(count: 1 | 2) {
      await executeRaw(
        db,
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${from}`
      );
      for (const { hash, createdAt } of retired.slice(0, count)) {
        await executeRaw(
          db,
          sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${createdAt})`
        );
      }
    }

    async function relations() {
      return Object.fromEntries(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT c.relname, c.oid::bigint AS oid, c.relforcerowsecurity AS forced,
                  EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                    AND p.polname = 'tenant_isolation_' || c.relname) AS isolated
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN (
                  'profile_images', 'completion_subscriptions', 'branch_front_desk_sessions'
                )`
          )
        ).map((row) => [
          String(row.relname),
          { oid: Number(row.oid), forced: row.forced === true, isolated: row.isolated === true },
        ])
      );
    }

    it('repairs a database that ran fork main at 7fe364e72', async () => {
      const before = await relations();
      await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
      await dropUpstreamTail();
      await recordRetiredOrder(2);

      const status = await checkMigrationStatus(db);
      expect(status.ledgerRewind?.retired).toEqual([
        '9028_branch_front_desk_sessions',
        '9029_profile_image_galleries',
      ]);
      expect(status.pending).toEqual([...REPLAYED, ...UPSTREAM_TAIL]);

      await runMigrations(db);
      const after = await relations();
      // Existing tables are verified in place, not recreated; callback storage
      // is created with forced tenant isolation.
      expect(after.profile_images).toEqual(before.profile_images);
      expect(after.branch_front_desk_sessions).toEqual(before.branch_front_desk_sessions);
      expect(after.completion_subscriptions).toMatchObject({ forced: true, isolated: true });
      expect(await ledger()).toEqual(fresh);
      expect((await checkMigrationStatus(db)).pending).toEqual([]);
    });

    it('repairs a database that stopped after fork main front desk', async () => {
      await executeRaw(db, sql`DROP TABLE profile_images`);
      await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
      await dropUpstreamTail();
      await recordRetiredOrder(1);
      expect((await checkMigrationStatus(db)).pending).toEqual([...REPLAYED, ...UPSTREAM_TAIL]);

      await runMigrations(db);
      const after = await relations();
      for (const table of [
        'profile_images',
        'completion_subscriptions',
        'branch_front_desk_sessions',
      ]) {
        expect(after[table]).toMatchObject({ forced: true, isolated: true });
      }
      expect(await ledger()).toEqual(fresh);
    });

    it('fails loudly when a replayed table has a different shape', async () => {
      await executeRaw(db, sql`ALTER TABLE branch_front_desk_sessions DROP COLUMN retired_reason`);
      await dropUpstreamTail();
      await recordRetiredOrder(2);
      await expect(runMigrations(db)).rejects.toMatchObject({
        cause: { cause: { message: expect.stringContaining('retired_reason') } },
      });
      // The batch rolled back; the rewound ledger keeps reporting the replay.
      expect((await checkMigrationStatus(db)).pending).toEqual([...REPLAYED, ...UPSTREAM_TAIL]);
    });
  }
);
