/**
 * Pinned front desks against a real migrated SQLite database.
 *
 * `front-desk.postgres.test.ts` runs the identical suite on PostgreSQL and
 * adds the properties only that engine can prove: concurrent promotion across
 * connections, and row-level security between tenants.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database, initializeDatabase } from '@agor/core/db';
import { afterAll, describe } from 'vitest';
import { frontDeskFixture, frontDeskSuite } from '../../test/front-desk-fixture';

const tempDirs: string[] = [];

/** File-backed, one per test — see `teammate-addressing.integration.test.ts`. */
async function migratedSqliteDatabase(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), 'agor-front-desk-'));
  tempDirs.push(dir);
  const db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
  await initializeDatabase(db);
  return db;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort; a leftover temp dir must not fail the run.
    }
  }
});

describe('pinned front desk (SQLite)', () =>
  frontDeskSuite(async () => frontDeskFixture(await migratedSqliteDatabase())));
