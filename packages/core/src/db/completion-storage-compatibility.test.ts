import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { executeRaw, rawRows } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { dbTest } from './test-helpers';

dbTest('retains inert draft completion rows across SQLite initialization', async ({ db }) => {
  await executeRaw(
    db,
    sql`INSERT INTO completion_subscriptions
    (subscription_id, requested_by_user_id, origin_session_id, origin_task_id, path, created_at, updated_at)
    VALUES ('fixture-retained', 'fixture-user', 'fixture-session', 'fixture-task', '[]', 1, 1)`
  );
  // The draft had the same timestamp as main's ownership-transfer migration.
  await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at > 1789344000005`);
  await executeRaw(
    db,
    sql`CREATE TRIGGER boards_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON boards BEGIN SELECT RAISE(ABORT, 'immutable'); END`
  );
  await executeRaw(
    db,
    sql`CREATE TRIGGER branches_primary_owner_immutable BEFORE UPDATE OF primary_owner_user_id ON branches BEGIN SELECT RAISE(ABORT, 'immutable'); END`
  );
  await initializeDatabase(db);
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
  await executeRaw(db, sql`DELETE FROM __drizzle_migrations WHERE created_at > 1789344000005`);
  await initializeDatabase(db);
  expect(rawRows(await executeRaw(db, sql`SELECT * FROM completion_subscriptions`))).toEqual([]);
});
