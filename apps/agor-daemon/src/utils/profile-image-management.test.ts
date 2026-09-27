import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  writeGateActive: false,
  images: {
    listForSubject: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    readVariant: vi.fn(),
  },
  users: { findById: vi.fn() },
  boards: { findById: vi.fn(), canMutate: vi.fn(), canView: vi.fn() },
  branches: { findById: vi.fn(), isOwner: vi.fn(), resolveUserPermission: vi.fn() },
  hasBranchPermission: vi.fn(),
  processProfileImage: vi.fn(),
}));

vi.mock('@agor/core/db', () => {
  class TenantWriteGateActiveError extends Error {}
  return {
    TenantWriteGateActiveError,
    assertTenantWritable: async () => {
      if (mocks.writeGateActive) throw new TenantWriteGateActiveError('Tenant is frozen');
    },
    runWithTenantDatabaseScope: async (_db: unknown, tenantId: string, work: () => unknown) => {
      mocks.scopes.push(tenantId);
      return work();
    },
    ProfileImageRepository: class {
      listForSubject = mocks.images.listForSubject;
      findById = mocks.images.findById;
      create = mocks.images.create;
      patch = mocks.images.patch;
      remove = mocks.images.remove;
      readVariant = mocks.images.readVariant;
    },
    UsersRepository: class {
      findById = mocks.users.findById;
    },
    BoardRepository: class {
      findById = mocks.boards.findById;
      canMutate = mocks.boards.canMutate;
      canView = mocks.boards.canView;
    },
    BranchRepository: class {
      findById = mocks.branches.findById;
      isOwner = mocks.branches.isOwner;
      resolveUserPermission = mocks.branches.resolveUserPermission;
    },
  };
});

vi.mock('./branch-authorization.js', () => ({
  hasBranchPermission: mocks.hasBranchPermission,
}));

vi.mock('./profile-image-processing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./profile-image-processing.js')>()),
  processProfileImage: mocks.processProfileImage,
}));

const { createProfileImageManager, profileImageCallerFromParams } = await import(
  './profile-image-management.js'
);

const TENANT = 'tenant-a';

function makeCaller(role = 'member', userId = 'user-1') {
  return profileImageCallerFromParams({
    authenticated: true,
    provider: 'rest',
    tenant: { tenant_id: TENANT, source: 'auth_claim' },
    user: { user_id: userId, role },
  } as never);
}

function makeManager() {
  const patches = {
    users: vi.fn(async () => ({})),
    boards: vi.fn(async () => ({})),
    branches: vi.fn(async () => ({})),
  };
  const app = {
    service: (name: 'users' | 'boards' | 'branches') => ({ patch: patches[name] }),
  };
  const manager = createProfileImageManager({
    app: app as never,
    db: {} as never,
    allowSuperadmin: false,
  });
  return { manager, patches };
}

const image = (overrides: Record<string, unknown> = {}) => ({
  image_id: 'image-1',
  subject_type: 'board',
  subject_id: 'board-1',
  is_primary: true,
  position: 0,
  ...overrides,
});

const teammate = {
  branch_id: 'branch-1',
  custom_context: { teammate: { kind: 'teammate', displayName: 'Designer', emoji: '🎨' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scopes.length = 0;
  mocks.writeGateActive = false;
  mocks.boards.findById.mockResolvedValue({ board_id: 'board-1' });
  mocks.boards.canMutate.mockResolvedValue(true);
  mocks.boards.canView.mockResolvedValue(true);
  mocks.images.listForSubject.mockResolvedValue([]);
  mocks.processProfileImage.mockResolvedValue({ small: {}, large: {} });
  mocks.images.create.mockResolvedValue(image());
});

describe('profile image manager', () => {
  it('uploads into a board gallery and projects the first image as the board primary', async () => {
    const { manager, patches } = makeManager();

    const created = await manager.upload(makeCaller(), {
      subjectType: 'board',
      subjectId: 'board-1',
      data: Buffer.from('pixels'),
      originalName: 'cover.png',
      altText: 'Board cover',
    });

    expect(created.image_id).toBe('image-1');
    expect(mocks.boards.canMutate).toHaveBeenCalledWith('board-1', 'user-1');
    expect(mocks.images.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        subject: expect.objectContaining({ type: 'board', id: 'board-1' }),
        createdBy: 'user-1',
        originalName: 'cover.png',
        altText: 'Board cover',
      })
    );
    expect(patches.boards).toHaveBeenCalledWith(
      'board-1',
      { profile_image_id: 'image-1' },
      expect.objectContaining({ provider: 'rest' })
    );
  });

  it('hides a board the caller cannot edit and writes nothing', async () => {
    mocks.boards.canMutate.mockResolvedValue(false);
    const { manager, patches } = makeManager();

    await expect(
      manager.upload(makeCaller(), {
        subjectType: 'board',
        subjectId: 'board-1',
        data: Buffer.from('pixels'),
      })
    ).rejects.toThrow('Profile unavailable');
    expect(mocks.images.create).not.toHaveBeenCalled();
    expect(patches.boards).not.toHaveBeenCalled();
  });

  it("refuses another user's gallery for members but allows admins", async () => {
    mocks.users.findById.mockResolvedValue({ user_id: 'user-2' });
    mocks.images.create.mockResolvedValue(
      image({ subject_type: 'user', subject_id: 'user-2', is_primary: false })
    );
    const { manager } = makeManager();
    const input = { subjectType: 'user' as const, subjectId: 'user-2', data: Buffer.from('x') };

    await expect(manager.upload(makeCaller('member'), input)).rejects.toThrow(
      'Profile unavailable'
    );
    await expect(manager.upload(makeCaller('admin'), input)).resolves.toMatchObject({
      subject_id: 'user-2',
    });
  });

  it('rejects viewers before touching the gallery', async () => {
    const { manager } = makeManager();

    await expect(
      manager.upload(makeCaller('viewer'), {
        subjectType: 'board',
        subjectId: 'board-1',
        data: Buffer.from('pixels'),
      })
    ).rejects.toThrow(/manage profile images/);
    expect(mocks.boards.findById).not.toHaveBeenCalled();
  });

  it('refuses writes while the tenant write gate is active', async () => {
    mocks.writeGateActive = true;
    const { manager } = makeManager();

    await expect(
      manager.upload(makeCaller(), {
        subjectType: 'board',
        subjectId: 'board-1',
        data: Buffer.from('pixels'),
      })
    ).rejects.toMatchObject({ name: 'Unavailable' });
    expect(mocks.images.create).not.toHaveBeenCalled();
  });

  it('enforces the gallery cap and rejects empty uploads', async () => {
    const { manager } = makeManager();
    await expect(
      manager.upload(makeCaller(), {
        subjectType: 'board',
        subjectId: 'board-1',
        data: Buffer.alloc(0),
      })
    ).rejects.toThrow('Choose an image to upload');

    mocks.images.listForSubject.mockResolvedValue(Array.from({ length: 24 }, () => image()));
    await expect(
      manager.upload(makeCaller(), {
        subjectType: 'board',
        subjectId: 'board-1',
        data: Buffer.from('pixels'),
      })
    ).rejects.toThrow('up to 24 images');
    expect(mocks.images.create).not.toHaveBeenCalled();
  });

  it('removes the new image when the primary projection fails', async () => {
    const { manager, patches } = makeManager();
    patches.boards.mockRejectedValueOnce(new Error('projection failed'));

    await expect(
      manager.upload(makeCaller(), {
        subjectType: 'board',
        subjectId: 'board-1',
        data: Buffer.from('pixels'),
      })
    ).rejects.toThrow('projection failed');
    expect(mocks.images.remove).toHaveBeenCalledWith(TENANT, 'image-1');
  });

  it('makes a teammate image primary through the teammate config projection', async () => {
    mocks.branches.findById.mockResolvedValue(teammate);
    mocks.hasBranchPermission.mockReturnValue(true);
    const target = image({
      image_id: 'image-2',
      subject_type: 'teammate',
      subject_id: 'branch-1',
      is_primary: false,
    });
    mocks.images.findById.mockResolvedValue(target);
    mocks.images.patch.mockResolvedValue({ ...target, is_primary: true });
    const { manager, patches } = makeManager();

    await manager.update(makeCaller(), 'image-2', { is_primary: true, alt_text: 'Portrait' });

    expect(mocks.hasBranchPermission).toHaveBeenCalledWith(
      teammate,
      'user-1',
      undefined,
      'all',
      'member',
      false,
      undefined
    );
    expect(mocks.images.patch).toHaveBeenCalledWith(TENANT, 'image-2', {
      altText: 'Portrait',
      isPrimary: true,
    });
    expect(patches.branches).toHaveBeenCalledWith(
      'branch-1',
      {
        custom_context: {
          teammate: {
            kind: 'teammate',
            displayName: 'Designer',
            emoji: '🎨',
            profileImageId: 'image-2',
          },
        },
      },
      expect.anything()
    );
  });

  it('promotes the next image when the primary is deleted', async () => {
    mocks.images.findById.mockResolvedValue(image());
    mocks.images.listForSubject.mockResolvedValue([
      image(),
      image({ image_id: 'image-2', is_primary: false }),
    ]);
    mocks.images.remove.mockResolvedValue({ removed: image(), replacementPrimary: null });
    const { manager, patches } = makeManager();

    await manager.remove(makeCaller(), 'image-1');

    expect(patches.boards).toHaveBeenCalledWith(
      'board-1',
      { profile_image_id: 'image-2' },
      expect.anything()
    );
    expect(mocks.images.remove).toHaveBeenCalledWith(TENANT, 'image-1');
  });

  it('scopes every read to the caller tenant and treats foreign images as missing', async () => {
    // Under tenant RLS an image owned by another tenant is simply not visible.
    mocks.images.findById.mockResolvedValue(null);
    const { manager, patches } = makeManager();

    await expect(
      manager.update(makeCaller(), 'foreign-image', { is_primary: true })
    ).rejects.toThrow('Profile image unavailable');
    await expect(manager.remove(makeCaller(), 'foreign-image')).rejects.toThrow(
      'Profile image unavailable'
    );
    await expect(manager.readVariant(makeCaller(), 'foreign-image', 'small')).rejects.toThrow(
      'Profile image unavailable'
    );
    expect(mocks.images.findById).toHaveBeenCalledWith(TENANT, 'foreign-image');
    expect(new Set(mocks.scopes)).toEqual(new Set([TENANT]));
    expect(mocks.images.patch).not.toHaveBeenCalled();
    expect(mocks.images.remove).not.toHaveBeenCalled();
    expect(mocks.images.readVariant).not.toHaveBeenCalled();
    expect(patches.boards).not.toHaveBeenCalled();
  });

  it('requires an authenticated caller with tenant identity', () => {
    expect(() => profileImageCallerFromParams(undefined)).toThrow('Authentication required');
    expect(() => profileImageCallerFromParams({ user: { user_id: 'user-1' } } as never)).toThrow(
      'Authentication required'
    );
    expect(
      profileImageCallerFromParams({ user: { user_id: 'user-1' } } as never, 'fallback' as never)
        .tenantId
    ).toBe('fallback');
  });
});
