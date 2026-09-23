/**
 * Teammate name addressing against a real migrated SQLite database.
 *
 * The companion `teammate-addressing.test.ts` stubs `findTeammateBranches`;
 * this runs the same resolution rules over the real discovery SQL, the real
 * RBAC predicates and the real recency ordering. See
 * `test/teammate-addressing-fixture.ts` for why that distinction matters.
 *
 * `teammate-addressing.postgres.test.ts` runs the identical suites on
 * PostgreSQL, where `jsonExtract` emits a different operator entirely.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database, initializeDatabase } from '@agor/core/db';
import { afterAll, describe } from 'vitest';
import {
  teammateAddressingFixture,
  teammateNameResolutionSuite,
  teammateSessionRoutingSuite,
} from '../../../test/teammate-addressing-fixture';

const tempDirs: string[] = [];

/**
 * A file-backed database per test, not `:memory:`: the libsql client opens a
 * fresh connection per transaction and `:memory:` is connection-private, so
 * branch and session creation (which transact) would not see the schema. A
 * new database per test also keeps one test's teammates out of the next
 * one's discovery scan, which SQLite has no tenant predicate to do.
 */
async function migratedSqliteDatabase(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), 'agor-teammate-addressing-'));
  tempDirs.push(dir);
  const db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
  await initializeDatabase(db);
  return db;
}

const freshFixture = async () => teammateAddressingFixture(await migratedSqliteDatabase());

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort; a leftover temp dir must not fail the run.
    }
  }
});

describe('teammate name resolution (SQLite)', () => teammateNameResolutionSuite(freshFixture));
describe('teammate session routing (SQLite)', () => teammateSessionRoutingSuite(freshFixture));
