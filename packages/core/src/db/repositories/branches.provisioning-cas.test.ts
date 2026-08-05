/**
 * Atomic compare-and-swap for provisioning state transitions.
 *
 * The retry/repair design leans on the state transition itself being the lock:
 * `failed → creating` (claim for retry) and `creating → failed` (interrupted
 * safety net) must each apply only when the row is still in the "from" state,
 * under a row lock, so two racing callers can never both act. These tests pin
 * that contract against a real database. Privacy: generic placeholder names.
 */
import type { UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

// biome-ignore lint/suspicious/noExplicitAny: dbTest hands us a loosely-typed Database fixture.
async function seedFailedBranch(
  db: any,
  over: Record<string, unknown> = {}
): Promise<{ branchRepo: BranchRepository; branchId: UUID }> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'local' as const,
    local_path: '/tmp/base',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/base/feature',
    base_ref: 'main',
    new_branch: true,
    created_by: 'user-1' as UUID,
    filesystem_status: 'failed',
    error_message: 'boom',
    ...over,
  });
  return { branchRepo, branchId: branch.branch_id as UUID };
}

describe('BranchRepository provisioning CAS', () => {
  dbTest(
    'claimFailedForProvisioningRetry flips failed→creating and clears the error',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db);

      const { claimed, branch } = await branchRepo.claimFailedForProvisioningRetry(branchId);

      expect(claimed).toBe(true);
      expect(branch.filesystem_status).toBe('creating');
      expect(branch.error_message ?? undefined).toBeUndefined();

      const reloaded = await branchRepo.findById(branchId);
      expect(reloaded?.filesystem_status).toBe('creating');
    }
  );

  dbTest('claim is a no-op when the branch is not failed (e.g. already ready)', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'ready',
      error_message: undefined,
    });

    const { claimed, branch } = await branchRepo.claimFailedForProvisioningRetry(branchId);

    expect(claimed).toBe(false);
    expect(branch.filesystem_status).toBe('ready');
  });

  dbTest(
    'two concurrent claims: exactly one wins (double-click cannot double-dispatch)',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db);

      // Postgres serializes via the row lock (loser observes `claimed: false`).
      // SQLite serializes via its global write lock (loser may reject with
      // SQLITE_BUSY). Either way the CAS guarantees at most one WINNER, so a
      // double-click / concurrent retry can never dispatch two materializers.
      const settled = await Promise.allSettled([
        branchRepo.claimFailedForProvisioningRetry(branchId),
        branchRepo.claimFailedForProvisioningRetry(branchId),
      ]);

      const winners = settled.filter((r) => r.status === 'fulfilled' && r.value.claimed);
      expect(winners).toHaveLength(1);

      // Whatever happened to the loser, the row is now exactly `creating`.
      const reloaded = await branchRepo.findById(branchId);
      expect(reloaded?.filesystem_status).toBe('creating');
    }
  );

  dbTest(
    'markProvisioningFailedIfCreating flips creating→failed with a message',
    async ({ db }) => {
      const { branchRepo, branchId } = await seedFailedBranch(db, {
        filesystem_status: 'creating',
        error_message: undefined,
      });

      const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
        branchId,
        'interrupted'
      );

      expect(changed).toBe(true);
      expect(branch.filesystem_status).toBe('failed');
      expect(branch.error_message).toBe('interrupted');
    }
  );

  dbTest('markProvisioningFailedIfCreating never clobbers a ready branch', async ({ db }) => {
    const { branchRepo, branchId } = await seedFailedBranch(db, {
      filesystem_status: 'ready',
      error_message: undefined,
    });

    const { changed, branch } = await branchRepo.markProvisioningFailedIfCreating(
      branchId,
      'interrupted'
    );

    expect(changed).toBe(false);
    expect(branch.filesystem_status).toBe('ready');
  });
});
