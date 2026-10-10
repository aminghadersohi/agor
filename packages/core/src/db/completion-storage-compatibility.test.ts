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
  // Upstream's user_api_keys.source is journalled above that boundary, so the
  // rewound ledger replays its plain ADD COLUMN.
  await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
  // Likewise profile_images.theme, journalled above that boundary.
  await executeRaw(db, sql`ALTER TABLE profile_images DROP COLUMN theme`);
  // And upstream's OpenCode checkpoint table, re-stamped above it.
  await executeRaw(db, sql`DROP TABLE opencode_checkpoint_attempts`);
  // And the restored session attention (SQLite cannot ADD COLUMN conditionally).
  await executeRaw(db, sql`DROP TABLE session_attention_states`);
  await executeRaw(db, sql`ALTER TABLE sessions DROP COLUMN attention_generation`);
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
  // Upstream's user_api_keys.source is journalled above that boundary, so the
  // rewound ledger replays its plain ADD COLUMN.
  await executeRaw(db, sql`ALTER TABLE user_api_keys DROP COLUMN source`);
  // Likewise profile_images.theme, journalled above that boundary.
  await executeRaw(db, sql`ALTER TABLE profile_images DROP COLUMN theme`);
  // And upstream's OpenCode checkpoint table, re-stamped above it.
  await executeRaw(db, sql`DROP TABLE opencode_checkpoint_attempts`);
  // And the restored session attention (SQLite cannot ADD COLUMN conditionally).
  await executeRaw(db, sql`DROP TABLE session_attention_states`);
  await executeRaw(db, sql`ALTER TABLE sessions DROP COLUMN attention_generation`);
  await runMigrations(db, { allowOfflineCutover: true });
  expect(rawRows(await executeRaw(db, sql`SELECT * FROM completion_subscriptions`))).toEqual([]);
});
