import type { BranchID, TenantID, UserID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { ProfileImageRepository, type ProfileImageSubject } from './profile-images';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const tenantId = 'default' as TenantID;

function variants(marker: number) {
  return {
    small: {
      data: Buffer.from([marker, 1]),
      contentType: 'image/webp',
      width: 96,
      height: 96,
    },
    large: {
      data: Buffer.from([marker, 2]),
      contentType: 'image/webp',
      width: 768,
      height: 768,
    },
  };
}

async function makeSubjects(db: Database): Promise<{
  userId: UserID;
  user: ProfileImageSubject;
  teammate: ProfileImageSubject;
}> {
  const users = new UsersRepository(db);
  const user = await users.create({
    email: `profile-gallery-${Date.now()}-${Math.random()}@example.com`,
    name: 'Profile Gallery Test',
  });
  const userId = user.user_id as UserID;
  const repos = new RepoRepository(db);
  const repo = await repos.create({
    repo_id: generateId() as UUID,
    slug: `profile-gallery-${Date.now()}-${Math.random()}`,
    name: 'profile-gallery',
    repo_type: 'remote',
    remote_url: 'https://example.com/profile-gallery.git',
    local_path: '/tmp/profile-gallery',
    default_branch: 'main',
  });
  const branches = new BranchRepository(db);
  const branch = await branches.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'profile-gallery-teammate',
    ref: 'refs/heads/profile-gallery-teammate',
    branch_unique_id: 991,
    path: '/tmp/profile-gallery/profile-gallery-teammate',
    new_branch: false,
    last_used: new Date().toISOString(),
    created_by: userId,
    custom_context: {
      teammate: { displayName: 'Gallery Teammate', emoji: '🖼️', roleDescription: 'Test' },
    },
  });
  return {
    userId,
    user: { type: 'user', id: userId },
    teammate: { type: 'teammate', id: branch.branch_id as BranchID },
  };
}

describe('ProfileImageRepository galleries', () => {
  dbTest(
    'keeps galleries isolated by subject and stores no pixels in public metadata',
    async ({ db }) => {
      const subjects = await makeSubjects(db);
      const repository = new ProfileImageRepository(db);

      const userImage = await repository.create({
        tenantId,
        subject: subjects.user,
        createdBy: subjects.userId,
        originalName: 'user.webp',
        altText: 'User portrait',
        ...variants(11),
      });
      const teammateImage = await repository.create({
        tenantId,
        subject: subjects.teammate,
        createdBy: subjects.userId,
        originalName: 'teammate.webp',
        ...variants(22),
      });

      expect(await repository.listForSubject(tenantId, subjects.user)).toEqual([userImage]);
      expect(await repository.listForSubject(tenantId, subjects.teammate)).toEqual([teammateImage]);
      expect(userImage).not.toHaveProperty('small_data');
      expect(userImage).not.toHaveProperty('large_data');

      const variant = await repository.readVariant(tenantId, userImage.image_id, 'small');
      expect(variant?.data).toEqual(Buffer.from([11, 1]));
      expect(variant?.contentType).toBe('image/webp');
    }
  );

  dbTest('maintains one primary image and promotes the next image on deletion', async ({ db }) => {
    const subjects = await makeSubjects(db);
    const repository = new ProfileImageRepository(db);
    const first = await repository.create({
      tenantId,
      subject: subjects.user,
      createdBy: subjects.userId,
      originalName: 'first.webp',
      ...variants(1),
    });
    const second = await repository.create({
      tenantId,
      subject: subjects.user,
      createdBy: subjects.userId,
      originalName: 'second.webp',
      ...variants(2),
    });

    expect(first.is_primary).toBe(true);
    expect(second.is_primary).toBe(false);
    expect(second.position).toBe(1);

    const selected = await repository.patch(tenantId, second.image_id, {
      isPrimary: true,
      altText: 'New primary',
    });
    expect(selected).toMatchObject({ is_primary: true, alt_text: 'New primary' });
    expect((await repository.findById(tenantId, first.image_id))?.is_primary).toBe(false);

    const removed = await repository.remove(tenantId, second.image_id);
    expect(removed?.replacementPrimary?.image_id).toBe(first.image_id);
    expect((await repository.findById(tenantId, first.image_id))?.is_primary).toBe(true);
  });
});
