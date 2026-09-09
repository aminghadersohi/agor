/** PostgreSQL non-owner RLS and HA claim proof for Session memory/reminders. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchID, SessionID, UserID, UUID } from '../types';
import { createDatabase, type Database } from './client';
import { insert } from './database-wrapper';
import { initializeDatabase } from './migrate';
import {
  BranchRepository,
  RepoRepository,
  SessionMemoryRepository,
  SessionReminderRepository,
  SessionRepository,
  UsersRepository,
} from './repositories';
import { sessionMemories } from './schema';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const enabled = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = 800_000;

async function seed(db: Database, tenantId: string) {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.test`,
      name: 'Fictional RLS user',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `memory-rls-${generateId()}`,
      name: 'Fictional RLS repo',
      repo_type: 'remote',
      remote_url: 'https://example.test/rls.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'rls-memory',
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id as UUID,
    });
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      created_by: user.user_id as UUID,
    });
    const memory = await new SessionMemoryRepository(scoped).create({
      session_id: session.session_id,
      text: `private-${tenantId}`,
      tags: [],
      created_by: user.user_id as UserID,
    });
    const reminder = await new SessionReminderRepository(scoped).create({
      session_id: session.session_id,
      text: `remind-${tenantId}`,
      due_at: new Date(Date.now() - 1_000).toISOString(),
      display_timezone: 'UTC',
      created_by: user.user_id as UserID,
    });
    return { user, session, memory, reminder };
  });
}

describe.skipIf(!postgresUrl || !enabled)('Session memory/reminder RLS (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('does not reveal another tenant and rejects a cross-tenant parent FK', async () => {
    const tenantA = `memory-a-${generateId()}`;
    const tenantB = `memory-b-${generateId()}`;
    const a = await seed(db, tenantA);
    const b = await seed(db, tenantB);
    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      await expect(
        new SessionMemoryRepository(scoped).findPage({
          session_id: b.session.session_id,
          search: 'private',
          limit: 25,
          skip: 0,
        })
      ).resolves.toEqual({ total: 0, data: [] });
      await expect(
        insert(scoped, sessionMemories)
          .values({
            memory_id: generateId(),
            session_id: b.session.session_id,
            text: 'cross-tenant probe',
            tags: [],
            archived: false,
            created_by: a.user.user_id,
            created_at: new Date(),
            updated_at: new Date(),
            revision: 1,
          })
          .run()
      ).rejects.toThrow();
    });
  });

  it('system discovery returns only overdue routing refs and tenant CAS elects one claimant', async () => {
    const tenantId = `memory-ha-${generateId()}`;
    const seeded = await seed(db, tenantId);
    const refs = await runWithSystemDatabaseScope(
      db,
      'Session reminder test discovery',
      (systemDb) => new SessionReminderRepository(systemDb).findDueRefs(new Date(), 100),
      { capability: 'session_reminder_discovery' }
    );
    expect(refs).toContainEqual({ reminder_id: seeded.reminder.reminder_id, tenant_id: tenantId });
    expect(JSON.stringify(refs)).not.toContain(`remind-${tenantId}`);

    const claims = await Promise.all([
      runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new SessionReminderRepository(scoped).claimDue(
          seeded.reminder.reminder_id,
          new Date(),
          'claim-a',
          60_000
        )
      ),
      runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new SessionReminderRepository(scoped).claimDue(
          seeded.reminder.reminder_id,
          new Date(),
          'claim-b',
          60_000
        )
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
