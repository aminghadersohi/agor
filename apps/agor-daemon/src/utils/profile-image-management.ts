import {
  assertTenantWritable,
  BoardRepository,
  BranchRepository,
  ProfileImageRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  TenantWriteGateActiveError,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotAuthenticated, NotFound, Unavailable } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Board,
  BoardID,
  Branch,
  BranchID,
  ProfileImage,
  ProfileImageID,
  ProfileImageListResult,
  ProfileImagePatch,
  ProfileImageSubjectType,
  ProfileImageVariant,
  TenantID,
  UserID,
  UUID,
} from '@agor/core/types';
import { getTeammateConfig, hasMinimumRole, isTeammate, ROLES } from '@agor/core/types';
import { markTrustedUserMutation } from '../services/user-mutation-trust.js';
import { ensureMinimumRole } from './authorization.js';
import { hasBranchPermission } from './branch-authorization.js';
import {
  PROFILE_IMAGE_MAX_GALLERY_ITEMS,
  processProfileImage,
  sanitizeProfileImageAlt,
  sanitizeProfileImageName,
} from './profile-image-processing.js';

/**
 * Shared authorization and mutation logic for profile galleries. The Express
 * routes (browser uploads) and the MCP tools (agent uploads) both go through
 * this module so a subject is authorized, capped, processed, and projected as
 * primary the same way whichever surface wrote it.
 */

export type ProfileImageSubjectId = UserID | BranchID | BoardID;

/** The authenticated caller of a profile-image operation, with trusted tenant identity. */
export interface ProfileImageCaller {
  params: AuthenticatedParams;
  tenantId: TenantID;
  userId: UserID;
}

export interface AuthorizedProfileImageSubject {
  type: ProfileImageSubjectType;
  id: ProfileImageSubjectId;
  branch?: Branch;
  board?: Board;
}

export interface ProfileImageUploadInput {
  subjectType: ProfileImageSubjectType;
  subjectId: ProfileImageSubjectId;
  data: Buffer;
  originalName?: unknown;
  altText?: unknown;
}

export interface ProfileImageManager {
  authorizeSubject(
    caller: ProfileImageCaller,
    subjectType: ProfileImageSubjectType,
    subjectId: ProfileImageSubjectId,
    mode: 'view' | 'manage'
  ): Promise<AuthorizedProfileImageSubject>;
  list(
    caller: ProfileImageCaller,
    subjectType: ProfileImageSubjectType,
    subjectId: ProfileImageSubjectId
  ): Promise<ProfileImageListResult>;
  readVariant(
    caller: ProfileImageCaller,
    imageId: ProfileImageID,
    variant: ProfileImageVariant
  ): Promise<{ image: ProfileImage; data: Buffer; contentType: string }>;
  upload(caller: ProfileImageCaller, input: ProfileImageUploadInput): Promise<ProfileImage>;
  update(
    caller: ProfileImageCaller,
    imageId: ProfileImageID,
    patch: ProfileImagePatch
  ): Promise<ProfileImage>;
  remove(caller: ProfileImageCaller, imageId: ProfileImageID): Promise<void>;
}

export function parseProfileImageSubjectType(value: unknown): ProfileImageSubjectType {
  if (value === 'user' || value === 'teammate' || value === 'board') return value;
  throw new BadRequest('subjectType must be user, teammate, or board');
}

export function parseProfileImageSubjectId(value: unknown): ProfileImageSubjectId {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequest('subjectId is required');
  return value.trim() as ProfileImageSubjectId;
}

/**
 * Resolve the caller from authenticated params. `fallbackTenantId` is only for
 * static single-tenant callers (MCP) whose params may omit a tenant claim.
 */
export function profileImageCallerFromParams(
  params: AuthenticatedParams | undefined,
  fallbackTenantId?: TenantID
): ProfileImageCaller {
  const tenantId = (params?.tenant?.tenant_id as TenantID | undefined) ?? fallbackTenantId;
  const userId = params?.user?.user_id as UserID | undefined;
  if (!params || !tenantId || !userId) throw new NotAuthenticated('Authentication required');
  return { params, tenantId, userId };
}

export function createProfileImageManager({
  app,
  db,
  allowSuperadmin,
}: {
  app: Application;
  db: TenantScopeAwareDatabase;
  allowSuperadmin: boolean;
}): ProfileImageManager {
  const repository = new ProfileImageRepository(db);
  const branches = new BranchRepository(db);
  const boards = new BoardRepository(db);
  const users = new UsersRepository(db);

  const inTenant = <T>(caller: ProfileImageCaller, work: () => Promise<T>) =>
    runWithTenantDatabaseScope(db, caller.tenantId, work);

  /** Gallery rows are written by the repository directly, outside a service write gate. */
  const assertWritable = async (caller: ProfileImageCaller): Promise<void> => {
    ensureMinimumRole(caller.params, ROLES.MEMBER, 'manage profile images');
    try {
      await inTenant(caller, () => assertTenantWritable(db, caller.tenantId));
    } catch (error) {
      if (error instanceof TenantWriteGateActiveError) throw new Unavailable(error.message);
      throw error;
    }
  };

  const authorizeSubject: ProfileImageManager['authorizeSubject'] = async (
    caller,
    subjectType,
    subjectId,
    mode
  ) => {
    const { params, userId } = caller;
    if (subjectType === 'user') {
      const target = await inTenant(caller, () => users.findById(subjectId as UserID));
      if (!target) throw new NotFound('Profile unavailable');
      if (
        mode === 'manage' &&
        target.user_id !== userId &&
        !hasMinimumRole(params.user?.role, ROLES.ADMIN)
      ) {
        throw new NotFound('Profile unavailable');
      }
      return { type: 'user', id: target.user_id as UserID };
    }

    if (subjectType === 'board') {
      const board = await inTenant(caller, () => boards.findById(subjectId as BoardID));
      if (!board) throw new NotFound('Profile unavailable');
      const bypassAccess =
        params.user?._isServiceAccount || hasMinimumRole(params.user?.role, ROLES.ADMIN);
      if (!bypassAccess) {
        const allowed = await inTenant(caller, () =>
          mode === 'manage'
            ? boards.canMutate(board.board_id, userId as UUID)
            : boards.canView(board.board_id, userId as UUID)
        ).catch(() => false);
        if (!allowed) throw new NotFound('Profile unavailable');
      }
      return { type: 'board', id: board.board_id, board };
    }

    const branch = await inTenant(caller, () => branches.findById(subjectId as BranchID));
    if (!branch || !isTeammate(branch)) throw new NotFound('Profile unavailable');
    const allowed = await inTenant(caller, async () => {
      const isOwner = await branches.isOwner(branch.branch_id, userId as UUID);
      const effectivePermission = await branches.resolveUserPermission(branch, userId as UUID);
      return hasBranchPermission(
        branch,
        userId as UUID,
        isOwner,
        mode === 'manage' ? 'all' : 'view',
        params.user?.role,
        allowSuperadmin,
        effectivePermission
      );
    });
    if (!allowed) throw new NotFound('Profile unavailable');
    return { type: 'teammate', id: branch.branch_id, branch };
  };

  /** Mirror the gallery's primary onto the subject so avatars resolve without a gallery read. */
  const syncPrimaryProjection = async (
    caller: ProfileImageCaller,
    subject: AuthorizedProfileImageSubject,
    imageId: ProfileImageID | null
  ): Promise<void> => {
    const { params } = caller;
    if (subject.type === 'user') {
      const mutationParams = { ...params, provider: undefined };
      markTrustedUserMutation(mutationParams, 'profile-image-projection');
      await inTenant(caller, () =>
        app.service('users').patch(subject.id, { profile_image_id: imageId }, mutationParams)
      );
      return;
    }
    if (subject.type === 'board') {
      await inTenant(caller, () =>
        app
          .service('boards')
          .patch(subject.id as BoardID, { profile_image_id: imageId ?? undefined }, params)
      );
      return;
    }
    const branch =
      subject.branch ?? (await inTenant(caller, () => branches.findById(subject.id as BranchID)));
    if (!branch) throw new NotFound('Profile unavailable');
    const current = getTeammateConfig(branch);
    if (!current) throw new NotFound('Profile unavailable');
    const { profileImageId: _previous, ...withoutPrimary } = current;
    const customContext = {
      ...(branch.custom_context ?? {}),
      teammate: imageId ? { ...withoutPrimary, profileImageId: imageId } : withoutPrimary,
    };
    await inTenant(caller, () =>
      app.service('branches').patch(branch.branch_id, { custom_context: customContext }, params)
    );
  };

  const loadImageAndSubject = async (
    caller: ProfileImageCaller,
    imageId: ProfileImageID,
    mode: 'view' | 'manage'
  ) => {
    const image = await inTenant(caller, () => repository.findById(caller.tenantId, imageId));
    if (!image) throw new NotFound('Profile image unavailable');
    const subject = await authorizeSubject(caller, image.subject_type, image.subject_id, mode);
    return { image, subject };
  };

  return {
    authorizeSubject,

    async list(caller, subjectType, subjectId) {
      const subject = await authorizeSubject(caller, subjectType, subjectId, 'view');
      const images = await inTenant(caller, () =>
        repository.listForSubject(caller.tenantId, subject)
      );
      return { images, max_images: PROFILE_IMAGE_MAX_GALLERY_ITEMS };
    },

    async readVariant(caller, imageId, variant) {
      await loadImageAndSubject(caller, imageId, 'view');
      const result = await inTenant(caller, () =>
        repository.readVariant(caller.tenantId, imageId, variant)
      );
      if (!result) throw new NotFound('Profile image unavailable');
      return result;
    },

    async upload(caller, input) {
      await assertWritable(caller);
      const subject = await authorizeSubject(caller, input.subjectType, input.subjectId, 'manage');
      if (input.data.byteLength === 0) throw new BadRequest('Choose an image to upload');
      const existing = await inTenant(caller, () =>
        repository.listForSubject(caller.tenantId, subject)
      );
      if (existing.length >= PROFILE_IMAGE_MAX_GALLERY_ITEMS) {
        throw new BadRequest(
          `A profile can contain up to ${PROFILE_IMAGE_MAX_GALLERY_ITEMS} images`
        );
      }
      let processed: Awaited<ReturnType<typeof processProfileImage>>;
      try {
        processed = await processProfileImage(input.data);
      } catch (error) {
        throw new BadRequest(
          error instanceof Error ? error.message : 'The profile image could not be processed'
        );
      }
      const created = await inTenant(caller, () =>
        repository.create({
          tenantId: caller.tenantId,
          subject,
          createdBy: caller.userId,
          originalName: sanitizeProfileImageName(input.originalName),
          altText: sanitizeProfileImageAlt(input.altText),
          small: processed.small,
          large: processed.large,
        })
      );
      if (created.is_primary) {
        try {
          await syncPrimaryProjection(caller, subject, created.image_id);
        } catch (error) {
          await inTenant(caller, () => repository.remove(caller.tenantId, created.image_id));
          throw error;
        }
      }
      return created;
    },

    async update(caller, imageId, body) {
      await assertWritable(caller);
      const { image, subject } = await loadImageAndSubject(caller, imageId, 'manage');
      const patch = {
        ...(Object.hasOwn(body, 'alt_text')
          ? { altText: sanitizeProfileImageAlt(body.alt_text) ?? null }
          : {}),
        ...(Number.isInteger(body.position) && Number(body.position) >= 0
          ? { position: Number(body.position) }
          : {}),
        ...(body.is_primary === true ? { isPrimary: true } : {}),
      };
      if (Object.keys(patch).length === 0) throw new BadRequest('No supported changes provided');
      const previousPrimary = body.is_primary
        ? (await inTenant(caller, () => repository.listForSubject(caller.tenantId, subject))).find(
            (candidate) => candidate.is_primary
          )
        : undefined;
      const updated = await inTenant(caller, () =>
        repository.patch(caller.tenantId, imageId, patch)
      );
      if (!updated) throw new NotFound('Profile image unavailable');
      if (body.is_primary === true && !image.is_primary) {
        try {
          await syncPrimaryProjection(caller, subject, imageId);
        } catch (error) {
          if (previousPrimary) {
            await inTenant(caller, () =>
              repository.patch(caller.tenantId, previousPrimary.image_id, { isPrimary: true })
            );
          }
          throw error;
        }
      }
      return updated;
    },

    async remove(caller, imageId) {
      await assertWritable(caller);
      const { image, subject } = await loadImageAndSubject(caller, imageId, 'manage');
      const replacementPrimary = image.is_primary
        ? (await inTenant(caller, () => repository.listForSubject(caller.tenantId, subject))).find(
            (candidate) => candidate.image_id !== imageId
          )
        : undefined;
      if (image.is_primary) {
        await syncPrimaryProjection(caller, subject, replacementPrimary?.image_id ?? null);
      }
      let removed: Awaited<ReturnType<ProfileImageRepository['remove']>>;
      try {
        removed = await inTenant(caller, () => repository.remove(caller.tenantId, imageId));
      } catch (error) {
        if (image.is_primary) await syncPrimaryProjection(caller, subject, imageId);
        throw error;
      }
      if (!removed) throw new NotFound('Profile image unavailable');
    },
  };
}
