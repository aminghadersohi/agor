import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BoardID, UUID } from '../types';
import { createDatabase, type Database } from './client';
import { runMigrations } from './migrate';
import { BoardRepository } from './repositories/boards';
import { UsersRepository } from './repositories/users';
import { ZoneWorkflowRepository } from './repositories/zone-workflow';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const enabled = process.env.AGOR_DB_DIALECT === 'postgresql' && Boolean(postgresUrl);
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle/postgres');

describe.skipIf(!enabled)('zone workflow PostgreSQL 0099 -> 0101 upgrade', () => {
  let db: Database;
  let priorFolder: string;
  let tenantId: string;
  let boardId: BoardID;
  let ownerId: UUID;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    priorFolder = await mkdtemp(join(tmpdir(), 'agor-pg-migrations-through-0099-'));
    await cp(migrationsFolder, priorFolder, { recursive: true });
    await unlink(join(priorFolder, '0102_zone_workflow_transitions.sql'));
    const journalPath = join(priorFolder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 99);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await migratePostgres(db as never, { migrationsFolder: priorFolder });

    tenantId = `zone-upgrade-${generateId()}`;
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const owner = await new UsersRepository(scoped).create({
        email: `zone-upgrade-${generateId()}@example.test`,
        role: 'member',
      });
      ownerId = owner.user_id as UUID;
      const board = await new BoardRepository(scoped).create({
        name: 'Pre-workflow board',
        created_by: ownerId,
        objects: {
          before: { type: 'zone', x: 0, y: 0, width: 300, height: 200, label: 'Before' },
          after: { type: 'zone', x: 400, y: 0, width: 300, height: 200, label: 'After' },
        },
      });
      boardId = board.board_id as BoardID;
    });
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    await rm(priorFolder, { recursive: true, force: true });
  });

  it('preserves existing tenant data and installs usable forced-RLS workflow tables', async () => {
    await runMigrations(db);
    await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const board = await new BoardRepository(scoped).findById(boardId);
      expect(board?.name).toBe('Pre-workflow board');
      const transition = await new ZoneWorkflowRepository(scoped).createTransition(
        {
          board_id: boardId,
          source_zone_id: 'before',
          target_zone_id: 'after',
          label: 'Upgraded',
        },
        ownerId
      );
      expect(transition).toMatchObject({ board_id: boardId, label: 'Upgraded' });
    });
  });
});
