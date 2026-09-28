/**
 * Teammate name addressing against a real migrated PostgreSQL database.
 *
 * This is the engine the feature actually ships on, and the one the SQLite
 * suite cannot stand in for: teammate discovery filters on
 * `custom_context.teammate.kind`, which `jsonExtract` compiles to
 * `json_extract(col, '$.a.b')` on SQLite but `col->'a'->>'b'` here. Same
 * assertions, different SQL underneath.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run src/mcp/tools/teammate-addressing.postgres.test.ts
 */

import {
  createDatabase,
  type Database,
  executeRaw,
  initializeDatabase,
  isPostgresDatabase,
  sql,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { generateId } from '../../../../../packages/core/src/lib/ids';
import {
  teammateAddressingFixture,
  teammateNameResolutionSuite,
  teammateSessionRoutingSuite,
} from '../../../test/teammate-addressing-fixture';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'teammate name addressing (PostgreSQL)',
  () => {
    let rawDb: Database;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
      // Discovery leans on tenant scoping for isolation between tests, which
      // is only real if the connected role cannot step over row-level
      // security. Assert that rather than assume it.
      const result = await executeRaw(
        rawDb,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    // One tenant per test: RLS then keeps each test's teammates out of the
    // next one's discovery scan, on the same connection.
    const freshFixture = () =>
      teammateAddressingFixture(rawDb, `teammate-addr-${generateId()}` as TenantID);

    describe('name resolution', () => teammateNameResolutionSuite(freshFixture));
    describe('session routing', () => teammateSessionRoutingSuite(freshFixture));
  }
);
