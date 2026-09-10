import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'MCP OAuth upgrade from main environment-discovery watermark',
  () => {
    let db: Database;
    let mainFolder: string;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      mainFolder = await mkdtemp(join(tmpdir(), 'agor-oauth-main-upgrade-'));
      await cp(migrationsFolder, mainFolder, { recursive: true });
      const journalPath = join(mainFolder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      journal.entries = journal.entries.filter(({ when }) => when <= 1788800000001);
      expect(journal.entries.at(-1)).toMatchObject({
        tag: '9014_environment_command_discovery',
        when: 1788800000001,
      });
      await writeFile(journalPath, JSON.stringify(journal));
      await migratePostgres(db as never, { migrationsFolder: mainFolder });
    });
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
      if (mainFolder) await rm(mainFolder, { recursive: true, force: true });
    });

    it('requires offline cutover, retains main discovery policy, and creates forced-RLS DCR authority', async () => {
      const policy = () =>
        executeRaw(
          db,
          sql`SELECT pg_get_expr(polqual, polrelid) AS expression FROM pg_policy
              WHERE polname = 'environment_health_discovery'`
        ).then(rawRows);
      const beforePolicy = await policy();
      const identityIndex = () =>
        executeRaw(
          db,
          sql`SELECT 'public.sessions_tenant_session_id_unique'::regclass::oid AS oid`
        ).then(rawRows);
      const beforeIndex = await identityIndex();
      expect(beforePolicy[0]?.expression).toContain('stopping');
      await expect(checkMigrationStatus(db)).resolves.toMatchObject({
        pending: [
          '9015_mcp_oauth_client_registrations',
          '9016_oauth_authority_watermark_reconciliation',
          '9017_fork_migration_collision_repair',
          '9018_session_memory_reminders',
          '9019_mcp_slack_recovery_due',
          '9020_standalone_power_ownership',
        ],
        dbAheadOfBinary: false,
      });
      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      await runMigrations(db, { allowOfflineCutover: true });
      expect(await identityIndex()).toEqual(beforeIndex);
      expect(await policy()).toEqual(beforePolicy);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                WHERE oid = 'public.mcp_oauth_client_registrations'::regclass`
          )
        )
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      await expect(checkMigrationStatus(db)).resolves.toMatchObject({ hasPending: false });
    });

    it('rejects an incompatible pre-existing identity index without modifying it', async () => {
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL required');
      const migration = await readFile(
        join(migrationsFolder, '9018_session_memory_reminders.sql'),
        'utf8'
      );
      const guard = migration.split('--> statement-breakpoint')[1]!;
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`ALTER INDEX sessions_tenant_session_id_unique RENAME TO test_saved_session_identity`
          );
          await tx.execute(
            sql`CREATE INDEX sessions_tenant_session_id_unique ON sessions (session_id)`
          );
          await tx.execute(sql.raw(guard));
        })
      ).rejects.toMatchObject({
        cause: {
          message: 'incompatible sessions tenant identity index; refusing reminder migration',
        },
      });
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT indisunique FROM pg_index WHERE indexrelid = 'public.sessions_tenant_session_id_unique'::regclass`
          )
        )
      ).toEqual([{ indisunique: true }]);
    });
  }
);
