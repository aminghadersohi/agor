import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { inspectMaintenanceAdmission } from './maintenance-admission';
import { MAINTENANCE_POLICY, MAINTENANCE_TRIGGER_BODY } from './maintenance-admission-sql';

// Inert: the database layer is an in-process script. No connection, no SQL runs.
const state = vi.hoisted(() => ({
  executed: [] as string[],
  policies: [] as Array<Record<string, unknown>>,
}));
vi.mock('./database-wrapper', async (original) => ({
  ...(await original<typeof import('./database-wrapper')>()),
  isPostgresDatabase: () => true,
  runDatabaseTransaction: async (db: Database, work: (tx: Database) => Promise<unknown>) =>
    work(db),
  executeRaw: async (_db: Database, query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const text = new PgDialect().sqlToQuery(query).sql;
    state.executed.push(text);
    if (text.includes("'public.tasks'::regclass") && text.includes('relowner'))
      return [{ owner: true, tenant: null }];
    if (text.includes('p.prosrc'))
      return [{ owner: true, body: MAINTENANCE_TRIGGER_BODY, version: 1, triggers: 3 }];
    if (text.includes('pg_catalog.pg_policy')) return state.policies;
    return [];
  },
}));
vi.mock('./tenant-scope', async (original) => ({
  ...(await original<typeof import('./tenant-scope')>()),
  runWithSystemDatabaseScope: async (
    db: Database,
    _reason: string,
    work: (db: Database) => Promise<unknown>
  ) => work(db),
}));

const row = (table: string, over: Record<string, unknown> = {}) => ({
  table_name: table,
  policy: 'maintenance_admission_discovery',
  command: 'r',
  permissive: true,
  applies: true,
  using_expression: MAINTENANCE_POLICY,
  ...over,
});
const countsIssued = () =>
  state.executed.some((q) => q.includes('FROM agor_maintenance.control c'));

describe('maintenance RLS proof is enforced before any global count (inert wiring)', () => {
  beforeEach(() => {
    state.executed.length = 0;
  });

  it('proceeds to the counts only when visibility is canonical (positive control)', async () => {
    state.policies = [row('tasks'), row('branches')];
    // The scripted layer returns no control row, so the count step fails closed
    // AFTER the proof passed; that distinguishes it from the refusals below.
    await expect(inspectMaintenanceAdmission({} as Database)).rejects.toThrow(
      'Maintenance control is absent'
    );
    expect(countsIssued()).toBe(true);
  });

  for (const [name, rows] of [
    ['wrong-role policy', [row('tasks', { applies: false }), row('branches')]],
    ['restrictive maintenance policy', [row('tasks'), row('branches', { permissive: false })]],
    [
      'extra applicable restrictive policy',
      [
        row('tasks'),
        row('branches'),
        row('tasks', { policy: 'hide', command: '*', permissive: false }),
      ],
    ],
  ] as const)
    it(`refuses ${name} without ever issuing the zero-prone counts`, async () => {
      state.policies = [...rows];
      await expect(inspectMaintenanceAdmission({} as Database)).rejects.toThrow(
        /installation row-level security/
      );
      expect(countsIssued()).toBe(false);
    });
});
