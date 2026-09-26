/**
 * Pinned front desks against a real migrated PostgreSQL database, connected as
 * a role that cannot bypass row-level security.
 *
 * Runs the shared Slice 1 suite, then the two properties SQLite cannot stand
 * in for: promotion racing across real concurrent connections, and tenant
 * isolation enforced by RLS rather than by the query.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/daemon exec vitest run src/front-desk/front-desk.postgres.test.ts
 */

import {
  BranchFrontDeskRepository,
  branchFrontDeskSessions,
  createDatabase,
  type Database,
  EntityNotFoundError,
  executeRaw,
  FrontDeskConflictError,
  initializeDatabase,
  insert,
  isPostgresDatabase,
  runWithTenantDatabaseTransaction,
  sql,
} from '@agor/core/db';
import {
  FRONT_DESK_TEAMMATE_SCOPE,
  type SessionID,
  type TenantID,
  type UserID,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { frontDeskFixture, frontDeskSuite } from '../../test/front-desk-fixture';
import { resolveTeammateSession } from '../mcp/tools/teammate-addressing';
import { setTeammateFrontDesk } from './manage-front-desk';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<
    Record<string, unknown>
  >;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('pinned front desk (PostgreSQL)', () => {
  let rawDb: Database;

  beforeAll(async () => {
    rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(rawDb);
    if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
    // Every isolation claim below is only real if this role cannot step over
    // row-level security. Assert it rather than assume it.
    const result = await executeRaw(
      rawDb,
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(rowsOf(result)[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const policy = await executeRaw(
      rawDb,
      sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'branch_front_desk_sessions'`
    );
    expect(rowsOf(policy)[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  }, 60_000);

  afterAll(async () => {
    await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  const tenant = () => `front-desk-${generateId()}` as TenantID;
  const freshFixture = () => frontDeskFixture(rawDb, tenant());

  describe('shared suite', () => frontDeskSuite(freshFixture));

  it('never produces two occupants under concurrent promotion', async () => {
    const f = await freshFixture();
    const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
    const candidates = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        f.createSession({
          branchId: branch.branch_id,
          updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
        })
      )
    );
    const promote = (sessionId: SessionID, expectedSessionId?: SessionID | null) =>
      runWithTenantDatabaseTransaction(f.db, f.tenantId, (db) =>
        new BranchFrontDeskRepository(db).promote({
          branchId: branch.branch_id,
          scope: FRONT_DESK_TEAMMATE_SCOPE,
          sessionId,
          promotedBy: f.owner.user_id as UserID,
          expectedSessionId,
        })
      );

    // "Only if empty", from eight connections at once: exactly one may win.
    const racedEmpty = await Promise.allSettled(candidates.map((s) => promote(s.session_id, null)));
    const winners = racedEmpty.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    for (const loser of racedEmpty.filter((r) => r.status === 'rejected')) {
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(FrontDeskConflictError);
    }

    // Unconditional replacement, from eight connections at once: each call
    // either replaces atomically or loses cleanly — never a second occupant.
    const racedReplace = await Promise.allSettled(candidates.map((s) => promote(s.session_id)));
    for (const result of racedReplace) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(FrontDeskConflictError);
      }
    }

    const occupants = rowsOf(
      await runWithTenantDatabaseTransaction(f.db, f.tenantId, (db) =>
        executeRaw(
          db,
          sql`SELECT count(*)::int AS n FROM branch_front_desk_sessions
              WHERE branch_id = ${branch.branch_id} AND status IN ('active', 'retiring')`
        )
      )
    );
    expect(occupants[0]).toMatchObject({ n: 1 });
    const history = await f.declarations(branch.branch_id);
    expect(history.filter((d) => d.status === 'retired')).not.toHaveLength(0);
    expect(history.every((d) => d.status !== 'retired' || d.retired_reason === 'replaced')).toBe(
      true
    );
  });

  it('keeps a front desk in tenant X invisible to, and unpinnable from, tenant Y', async () => {
    const x = await freshFixture();
    const y = await freshFixture();
    const branch = await x.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
    const pinned = await x.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const desk = await x.pinDirect(branch.branch_id, pinned.session_id);

    // Invisible: not by id, not by branch, not by a raw scan.
    expect(await y.declarations(branch.branch_id)).toEqual([]);
    const scanned = rowsOf(
      await runWithTenantDatabaseTransaction(y.db, y.tenantId, (db) =>
        executeRaw(db, sql`SELECT id FROM branch_front_desk_sessions WHERE id = ${desk.id}`)
      )
    );
    expect(scanned).toEqual([]);

    // Unaddressable: tenant Y cannot even resolve X's teammate by name.
    const addressed = await y.handlersFor().agor_sessions_prompt({
      teammate: 'front-desk',
      prompt: 'cross-tenant probe',
    });
    expect(addressed.isError).toBe(true);
    expect(y.payloadOf(addressed).error).toMatch(/No teammate matches/);

    // Unpinnable and unclearable, even handed X's exact ids — at the command
    // layer (Y's own owner, fully authenticated in Y) and at the repository.
    await expect(
      runWithTenantDatabaseTransaction(y.db, y.tenantId, (db) =>
        setTeammateFrontDesk(
          db,
          { branchId: branch.branch_id, sessionId: pinned.session_id },
          {
            params: y.contextFor().baseServiceParams,
            allowSuperadmin: false,
          }
        )
      )
    ).rejects.toThrow(/Teammate not found/);
    await expect(
      runWithTenantDatabaseTransaction(y.db, y.tenantId, (db) =>
        new BranchFrontDeskRepository(db).promote({
          branchId: branch.branch_id,
          scope: FRONT_DESK_TEAMMATE_SCOPE,
          sessionId: pinned.session_id,
        })
      )
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(
      runWithTenantDatabaseTransaction(y.db, y.tenantId, (db) =>
        new BranchFrontDeskRepository(db).demote({
          id: desk.id,
          expectedStatus: 'active',
          toStatus: 'retired',
          reason: 'manual',
        })
      )
    ).resolves.toBe(false);

    // RLS WITH CHECK refuses a row forged into X from Y's scope.
    await expect(
      runWithTenantDatabaseTransaction(y.db, y.tenantId, (db) =>
        insert(db, branchFrontDeskSessions)
          .values({
            tenant_id: x.tenantId,
            id: generateId(),
            branch_id: branch.branch_id,
            scope: FRONT_DESK_TEAMMATE_SCOPE,
            slot: 0,
            session_id: pinned.session_id,
            status: 'retired',
            promoted_at: new Date(),
          } as never)
          .run()
      )
    ).rejects.toThrow();

    // X is untouched and still routes to its pin.
    expect(await x.declarations(branch.branch_id)).toEqual([
      expect.objectContaining({ id: desk.id, status: 'active' }),
    ]);
    await expect(resolveTeammateSession(x.contextFor(), branch)).resolves.toMatchObject({
      via: 'front_desk',
      session: { session_id: pinned.session_id },
    });
  });
});
