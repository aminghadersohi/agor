import { describe, expect, it } from 'vitest';
import {
  type MaintenancePolicyRow,
  maintenanceVisibilityViolation,
} from './maintenance-admission-rls';
import { MAINTENANCE_POLICY } from './maintenance-admission-sql';

const canonical = (table: string): MaintenancePolicyRow => ({
  table,
  policy: 'maintenance_admission_discovery',
  command: 'r',
  permissive: true,
  applies: true,
  using: MAINTENANCE_POLICY,
});
const tenant = (table: string): MaintenancePolicyRow => ({
  table,
  policy: `tenant_isolation_${table}`,
  command: '*',
  permissive: true,
  applies: true,
  using: "(tenant_id = current_setting('agor.tenant_id'::text, true))",
});
const good = (): MaintenancePolicyRow[] =>
  ['tasks', 'branches'].flatMap((table) => [tenant(table), canonical(table)]);
const mutate = (
  table: string,
  policy: string,
  patch: Partial<MaintenancePolicyRow>
): MaintenancePolicyRow[] =>
  good().map((row) => (row.table === table && row.policy === policy ? { ...row, ...patch } : row));

describe('maintenance RLS visibility contract (pure, inert)', () => {
  it('accepts the canonical permissive global-visibility shape', () => {
    expect(maintenanceVisibilityViolation(good())).toBeNull();
  });

  const counterfactuals: Array<[string, MaintenancePolicyRow[], RegExp]> = [
    [
      'policy scoped to a role excluding the operator',
      mutate('tasks', 'maintenance_admission_discovery', { applies: false }),
      /does not apply/,
    ],
    [
      'policy recreated RESTRICTIVE',
      mutate('branches', 'maintenance_admission_discovery', { permissive: false }),
      /not PERMISSIVE/,
    ],
    [
      'policy command widened to ALL',
      mutate('tasks', 'maintenance_admission_discovery', { command: '*' }),
      /SELECT-only/,
    ],
    [
      'policy expression changed',
      mutate('tasks', 'maintenance_admission_discovery', { using: 'true' }),
      /expression changed/,
    ],
    [
      'unknown applicability',
      mutate('tasks', 'maintenance_admission_discovery', { applies: null }),
      /does not apply/,
    ],
    [
      'unknown permissiveness',
      mutate('tasks', 'maintenance_admission_discovery', { permissive: null }),
      /not PERMISSIVE/,
    ],
    [
      'extra applicable restrictive ALL policy',
      [...good(), { ...tenant('tasks'), policy: 'hide_all', permissive: false }],
      /restrictive policy hide_all/,
    ],
    [
      'extra applicable restrictive SELECT policy',
      [...good(), { ...tenant('branches'), policy: 'hide_sel', command: 'r', permissive: false }],
      /restrictive policy hide_sel/,
    ],
    [
      'restrictive policy with unknown command',
      [...good(), { ...tenant('branches'), policy: 'odd', command: null, permissive: false }],
      /restrictive policy odd/,
    ],
    [
      'restrictive policy with unknown applicability',
      [...good(), { ...tenant('tasks'), policy: 'odd', permissive: false, applies: null }],
      /restrictive policy odd/,
    ],
    [
      'policy missing on one table',
      good().filter(
        (r) => !(r.table === 'branches' && r.policy === 'maintenance_admission_discovery')
      ),
      /missing or duplicated/,
    ],
    [
      'policy-less table row only',
      [
        ...good().filter((r) => r.table === 'tasks'),
        {
          ...tenant('branches'),
          policy: null,
          command: null,
          permissive: null,
          applies: null,
          using: null,
        },
      ],
      /missing or duplicated/,
    ],
    [
      'table absent from catalog result',
      good().filter((r) => r.table === 'tasks'),
      /no catalog row/,
    ],
    ['duplicate canonical row', [...good(), canonical('tasks')], /missing or duplicated/],
  ];
  for (const [name, rows, reason] of counterfactuals)
    it(`refuses: ${name}`, () => {
      expect(maintenanceVisibilityViolation(rows)).toMatch(reason);
    });

  it('does not over-refuse policies that cannot narrow SELECT visibility', () => {
    expect(
      maintenanceVisibilityViolation([
        ...good(),
        { ...tenant('tasks'), policy: 'write_guard', command: 'w', permissive: false },
        {
          ...tenant('tasks'),
          policy: 'other_role_only',
          command: 'r',
          permissive: false,
          applies: false,
        },
        { ...tenant('branches'), policy: 'extra_permissive', command: 'r', permissive: true },
      ])
    ).toBeNull();
  });
});
