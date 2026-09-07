import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('power-management API boundaries', () => {
  const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
  const statusStart = source.indexOf("'/power-management'");
  const priorityStart = source.indexOf('const powerPriorityView');
  const priorityEnd = source.indexOf('const registerLongAuthenticatedRoute', priorityStart);
  const status = source.slice(statusStart, priorityStart);
  const priority = source.slice(priorityStart, priorityEnd);

  it('keeps host status admin-only and emits only the redacted controller projection', () => {
    expect(statusStart).toBeGreaterThan(0);
    expect(status).toContain('return powerPolicyController.status()');
    expect(status).toContain("role: ROLES.ADMIN, action: 'view host power policy'");
    expect(status).toContain('data: transition.status');
    expect(status).not.toMatch(/device_name|hostname|raw_output|provider_output/);
  });

  it('composes tenant-scoped Session lookup, branch-all authority, and the atomic cap', () => {
    expect(priorityStart).toBeGreaterThan(statusStart);
    const sessionGet = priority.indexOf("app.service('sessions').get(id, params)");
    const branchLookup = priority.indexOf('branchRepository.findById(session.branch_id)');
    const branchAll = priority.indexOf("access.can === 'all'");
    const mutationFence = priority.indexOf('powerPolicyController.withPriorityMutation(');
    const sessionPatch = priority.indexOf("app.service('sessions').patch(", mutationFence);
    const capConflict = priority.indexOf('isDatabaseUniqueConstraintError(error)', sessionPatch);
    expect(sessionGet).toBeGreaterThan(0);
    expect(branchLookup).toBeGreaterThan(0);
    expect(branchAll).toBeGreaterThan(branchLookup);
    expect(mutationFence).toBeGreaterThan(branchAll);
    expect(sessionPatch).toBeGreaterThan(mutationFence);
    expect(capConflict).toBeGreaterThan(sessionPatch);
    expect(priority).toContain('provider: undefined');
  });
});
