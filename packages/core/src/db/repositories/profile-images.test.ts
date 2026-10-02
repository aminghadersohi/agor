import type { BoardID, BranchID, TenantID, UserID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BoardRepository } from './boards';
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
  board: ProfileImageSubject;
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
  const board = await new BoardRepository(db).create({
    board_id: generateId() as BoardID,
    name: 'Profile Gallery Board',
    created_by: userId,
  });
  return {
    userId,
    user: { type: 'user', id: userId },
    teammate: { type: 'teammate', id: branch.branch_id as BranchID },
    board: { type: 'board', id: board.board_id as BoardID },
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
      const boardImage = await repository.create({
        tenantId,
        subject: subjects.board,
        createdBy: subjects.userId,
        originalName: 'board.webp',
        ...variants(33),
      });

      expect(await repository.listForSubject(tenantId, subjects.user)).toEqual([userImage]);
      expect(await repository.listForSubject(tenantId, subjects.teammate)).toEqual([teammateImage]);
      expect(await repository.listForSubject(tenantId, subjects.board)).toEqual([boardImage]);
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

  dbTest('stores a normalized theme and lets a patch set, change, or clear it', async ({ db }) => {
    const subjects = await makeSubjects(db);
    const repository = new ProfileImageRepository(db);
    const created = await repository.create({
      tenantId,
      subject: subjects.teammate,
      createdBy: subjects.userId,
      originalName: 'winter.webp',
      theme: '  Winter   Holiday ',
      ...variants(1),
    });
    expect(created.theme).toBe('Winter Holiday');
    const unlabeled = await repository.create({
      tenantId,
      subject: subjects.teammate,
      createdBy: subjects.userId,
      originalName: 'plain.webp',
      ...variants(2),
    });
    expect(unlabeled.theme).toBeUndefined();

    expect((await repository.patch(tenantId, unlabeled.image_id, { theme: 'Summer' }))?.theme).toBe(
      'Summer'
    );
    // A patch that does not mention the theme leaves it alone; blank clears it.
    expect((await repository.patch(tenantId, unlabeled.image_id, { altText: 'x' }))?.theme).toBe(
      'Summer'
    );
    expect(
      (await repository.patch(tenantId, unlabeled.image_id, { theme: '  ' }))?.theme
    ).toBeUndefined();
    expect(
      (await repository.patch(tenantId, created.image_id, { theme: null }))?.theme
    ).toBeUndefined();
  });

  dbTest('reorders a gallery, ignoring unknown ids and keeping omitted images', async ({ db }) => {
    const subjects = await makeSubjects(db);
    const repository = new ProfileImageRepository(db);
    const created = [];
    for (const marker of [1, 2, 3, 4]) {
      created.push(
        await repository.create({
          tenantId,
          subject: subjects.teammate,
          createdBy: subjects.userId,
          originalName: `${marker}.webp`,
          ...variants(marker),
        })
      );
    }
    const [a, b, c, d] = created;
    const other = await repository.create({
      tenantId,
      subject: subjects.user,
      createdBy: subjects.userId,
      originalName: 'other.webp',
      ...variants(9),
    });

    const reordered = await repository.reorder(tenantId, subjects.teammate, [
      d.image_id,
      other.image_id,
      b.image_id,
      d.image_id,
    ]);
    expect(reordered.map((image) => image.image_id)).toEqual([
      d.image_id,
      b.image_id,
      a.image_id,
      c.image_id,
    ]);
    expect(reordered.map((image) => image.position)).toEqual([0, 1, 2, 3]);
    // Another subject's gallery is untouched.
    expect((await repository.findById(tenantId, other.image_id))?.position).toBe(0);
  });

  dbTest('bulk-sets themes only within the named subject', async ({ db }) => {
    const subjects = await makeSubjects(db);
    const repository = new ProfileImageRepository(db);
    const mine = [];
    for (const marker of [1, 2, 3]) {
      mine.push(
        await repository.create({
          tenantId,
          subject: subjects.teammate,
          createdBy: subjects.userId,
          originalName: `${marker}.webp`,
          ...variants(marker),
        })
      );
    }
    const foreign = await repository.create({
      tenantId,
      subject: subjects.user,
      createdBy: subjects.userId,
      originalName: 'foreign.webp',
      ...variants(7),
    });

    const labeled = await repository.setThemes(
      tenantId,
      subjects.teammate,
      [mine[0].image_id, mine[2].image_id, foreign.image_id],
      ' Winter '
    );
    expect(labeled.map((image) => image.theme)).toEqual(['Winter', undefined, 'Winter']);
    expect((await repository.findById(tenantId, foreign.image_id))?.theme).toBeUndefined();

    const cleared = await repository.setThemes(
      tenantId,
      subjects.teammate,
      [mine[0].image_id],
      null
    );
    expect(cleared.map((image) => image.theme)).toEqual([undefined, undefined, 'Winter']);
  });

  dbTest(
    'bulk-removes images and promotes the first survivor when the primary goes',
    async ({ db }) => {
      const subjects = await makeSubjects(db);
      const repository = new ProfileImageRepository(db);
      const created = [];
      for (const marker of [1, 2, 3, 4]) {
        created.push(
          await repository.create({
            tenantId,
            subject: subjects.teammate,
            createdBy: subjects.userId,
            originalName: `${marker}.webp`,
            ...variants(marker),
          })
        );
      }
      const foreign = await repository.create({
        tenantId,
        subject: subjects.user,
        createdBy: subjects.userId,
        originalName: 'foreign.webp',
        ...variants(8),
      });

      const result = await repository.removeMany(tenantId, subjects.teammate, [
        created[0].image_id,
        created[1].image_id,
        foreign.image_id,
      ]);
      expect(result.removed.map((image) => image.image_id)).toEqual([
        created[0].image_id,
        created[1].image_id,
      ]);
      expect(result.replacementPrimary?.image_id).toBe(created[2].image_id);
      const remaining = await repository.listForSubject(tenantId, subjects.teammate);
      expect(remaining.map((image) => [image.image_id, image.is_primary])).toEqual([
        [created[2].image_id, true],
        [created[3].image_id, false],
      ]);
      expect(await repository.findById(tenantId, foreign.image_id)).not.toBeNull();

      const all = await repository.removeMany(
        tenantId,
        subjects.teammate,
        remaining.map((image) => image.image_id)
      );
      expect(all.replacementPrimary).toBeNull();
      expect(await repository.listForSubject(tenantId, subjects.teammate)).toEqual([]);
    }
  );
});
