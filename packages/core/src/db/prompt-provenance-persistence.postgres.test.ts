/**
 * PostgreSQL proof for the same assertions as the SQLite sibling.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/prompt-provenance-persistence.postgres.test.ts
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import { generateId } from '../lib/ids';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { assertStampedPromptRoundTrips } from './prompt-provenance-persistence.test-support';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'stamped prompt persistence (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('round-trips the rendered block and the graded stamp', async () => {
      await assertStampedPromptRoundTrips(db, `prompt-provenance-pg-${generateId()}`);
    });
  }
);
