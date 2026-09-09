import { expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { SessionRepository } from './sessions';
import { exerciseSessionInventory } from './sessions.inventory-test-helpers';

dbTest(
  'session inventory preserves policy precedence, filtering, mapping and pages (SQLite)',
  async ({ db }) => {
    await exerciseSessionInventory(db);
  }
);

dbTest('power Session search stays bounded across 800+ eligible rows (SQLite)', async ({ db }) => {
  const fixture = await exerciseSessionInventory(db);
  const sessions = new SessionRepository(db);
  // Root-cause reproduction for the reported UI: the former component fetched
  // `$limit: 50`, counted every authorized row, and rendered Ant Pagination,
  // so 801 eligible rows deterministically produced the observed 17 pages.
  expect(Math.ceil(801 / 50)).toBe(17);
  for (let index = 0; index < 801; index += 1) {
    await sessions.create({
      branch_id: fixture.branchId,
      created_by: fixture.owner,
      status: 'idle',
      archived: false,
      title: `Picker scale fixture ${String(index).padStart(3, '0')}`,
    });
  }
  const recent = await sessions.findPowerEssentialCandidates({
    userId: fixture.owner,
    limit: 30,
  });
  expect(recent).toHaveLength(30);
  const searched = await sessions.findPowerEssentialCandidates({
    userId: fixture.owner,
    search: 'fixture 042',
    limit: 30,
  });
  expect(searched).toEqual([expect.objectContaining({ title: 'Picker scale fixture 042' })]);
  await sessions.create({
    branch_id: fixture.branchId,
    created_by: fixture.owner,
    status: 'idle',
    archived: true,
    title: 'Picker archived leak sentinel',
  });
  await expect(
    sessions.findPowerEssentialCandidates({
      userId: fixture.owner,
      search: 'archived leak sentinel',
      limit: 30,
    })
  ).resolves.toEqual([]);
});
