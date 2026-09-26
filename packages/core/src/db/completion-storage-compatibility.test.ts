import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { executeRaw, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';
import { dbTest } from './test-helpers';

dbTest('retains inert draft completion rows across SQLite initialization', async ({ db }) => {
  await executeRaw(
    db,
    sql`INSERT INTO completion_subscriptions
    (subscription_id, requested_by_user_id, origin_session_id, origin_task_id, path, created_at, updated_at)
    VALUES ('fixture-retained', 'fixture-user', 'fixture-session', 'fixture-task', '[]', 1, 1)`
  );
  // Rewind to just below the callback reconciliation. Upstream rewinds to
  // main's ownership-transfer watermark (1789344000005), but this fork
  // renumbers every upstream migration into its own band, so that watermark
  // now has nine fork migrations above it — several of which are plain ADD
  // COLUMN and would fail on replay. The reconciliation itself, and the index
  // restore journalled after it, are both written IF NOT EXISTS.
  await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at >= 1790129000214`);
  await executeRaw(
    db,
    sql`CREATE TRIGGER boards_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON boards BEGIN SELECT RAISE(ABORT, 'immutable'); END`
  );
  await executeRaw(
    db,
    sql`CREATE TRIGGER branches_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON branches BEGIN SELECT RAISE(ABORT, 'immutable'); END`
  );
  await runMigrations(db, { allowOfflineCutover: true });
  expect(
    rawRows(
      await executeRaw(
        db,
        sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('boards_primary_owner_immutable', 'branches_primary_owner_immutable')`
      )
    )
  ).toEqual([]);
  expect(
    rawRows(
      await executeRaw(db, sql`SELECT subscription_id, state, path FROM completion_subscriptions`)
    )
  ).toEqual([{ subscription_id: 'fixture-retained', state: 'pending', path: '[]' }]);
});

dbTest('adds inert completion storage after main ownership transfer', async ({ db }) => {
  await executeRaw(db, sql`DROP TABLE completion_subscriptions`);
  // Same fork-renumbering rewind boundary as the test above.
  await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at >= 1790129000214`);
  await runMigrations(db, { allowOfflineCutover: true });
  expect(rawRows(await executeRaw(db, sql`SELECT * FROM completion_subscriptions`))).toEqual([]);
});
