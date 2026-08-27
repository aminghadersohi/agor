import {
  BoardRepository,
  BranchRepository,
  ProfileImageRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Conflict, NotAuthenticated, NotFound, Unavailable } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Board,
  BoardID,
  Branch,
  BranchID,
  ProfileImage,
  ProfileImageID,
  ProfileImagePatch,
  ProfileImageSubjectType,
  ProfileImageVariant,
  TenantID,
  UserID,
  UUID,
} from '@agor/core/types';
import { getTeammateConfig, hasMinimumRole, isTeammate, ROLES } from '@agor/core/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { MeshyIdentityModelClient } from './services/meshy-identity-model.js';
import { markTrustedUserMutation } from './services/user-mutation-trust.js';
import { ensureMinimumRole } from './utils/authorization.js';
import { hasBranchPermission } from './utils/branch-authorization.js';
import {
  PROFILE_IMAGE_MAX_BYTES,
  PROFILE_IMAGE_MAX_GALLERY_ITEMS,
  processProfileImage,
  sanitizeProfileImageAlt,
  sanitizeProfileImageName,
} from './utils/profile-image-processing.js';

type AuthenticatedProfileImageRequest = Request & {
  feathers?: AuthenticatedParams;
  file?: Express.Multer.File;
};

interface RegisterProfileImageRoutesOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  authMiddleware: RequestHandler;
  branchRbacEnabled: boolean;
  allowSuperadmin: boolean;
  createIdentityModelClient?: () => MeshyIdentityModelClient;
}

interface AuthorizedSubject {
  type: ProfileImageSubjectType;
  id: UserID | BranchID | BoardID;
  branch?: Branch;
  board?: Board;
}

function parseSubjectType(value: unknown): ProfileImageSubjectType {
  if (value === 'user' || value === 'teammate' || value === 'board') return value;
  throw new BadRequest('subjectType must be user, teammate, or board');
}

function parseSubjectId(value: unknown): UserID | BranchID | BoardID {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequest('subjectId is required');
  return value.trim() as UserID | BranchID | BoardID;
}

function publicProfileImage(image: ProfileImage): ProfileImage {
  return image;
}

/** Register authenticated, tenant-owned profile gallery and variant routes. */
export function registerProfileImageRoutes({
  app,
  db,
  authMiddleware,
  branchRbacEnabled,
  allowSuperadmin,
  createIdentityModelClient = () =>
    new MeshyIdentityModelClient(process.env.MESHY_API_KEY?.trim() ?? ''),
}: RegisterProfileImageRoutesOptions): void {
  const repository = new ProfileImageRepository(db);
  const branches = new BranchRepository(db);
  const boards = new BoardRepository(db);
  const users = new UsersRepository(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PROFILE_IMAGE_MAX_BYTES, files: 1, fields: 4 },
  }).single('image');

  const authContext = (req: AuthenticatedProfileImageRequest) => {
    const params = req.feathers as AuthenticatedParams | undefined;
    const tenantId = params?.tenant?.tenant_id as TenantID | undefined;
    const userId = params?.user?.user_id as UserID | undefined;
    if (!params || !tenantId || !userId) throw new NotAuthenticated('Authentication required');
    return { params, tenantId, userId };
  };

  const authorizeSubject = async (
    req: AuthenticatedProfileImageRequest,
    subjectType: ProfileImageSubjectType,
    subjectId: UserID | BranchID | BoardID,
    mode: 'view' | 'manage'
  ): Promise<AuthorizedSubject> => {
    const { params, tenantId, userId } = authContext(req);
    if (subjectType === 'user') {
      const target = await runWithTenantDatabaseScope(db, tenantId, () =>
        users.findById(subjectId as UserID)
      );
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
      const board = await runWithTenantDatabaseScope(db, tenantId, () =>
        boards.findById(subjectId as BoardID)
      );
      if (!board) throw new NotFound('Profile unavailable');
      const bypassAccess =
        params.user?._isServiceAccount || hasMinimumRole(params.user?.role, ROLES.ADMIN);
      if (branchRbacEnabled && !bypassAccess) {
        const allowed = await runWithTenantDatabaseScope(db, tenantId, () =>
          mode === 'manage'
            ? boards.canMutate(board.board_id, userId as UUID)
            : boards.canView(board.board_id, userId as UUID)
        ).catch(() => false);
        if (!allowed) throw new NotFound('Profile unavailable');
      }
      return { type: 'board', id: board.board_id, board };
    }

    const branch = await runWithTenantDatabaseScope(db, tenantId, () =>
      branches.findById(subjectId as BranchID)
    );
    if (!branch || !isTeammate(branch)) throw new NotFound('Profile unavailable');
    if (branchRbacEnabled) {
      const allowed = await runWithTenantDatabaseScope(db, tenantId, async () => {
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
    }
    return { type: 'teammate', id: branch.branch_id, branch };
  };

  const syncPrimaryProjection = async (
    req: AuthenticatedProfileImageRequest,
    subject: AuthorizedSubject,
    imageId: ProfileImageID | null
  ): Promise<void> => {
    const { params, tenantId } = authContext(req);
    if (subject.type === 'user') {
      const mutationParams = { ...params, provider: undefined };
      markTrustedUserMutation(mutationParams, 'profile-image-projection');
      await runWithTenantDatabaseScope(db, tenantId, () =>
        app.service('users').patch(subject.id, { profile_image_id: imageId }, mutationParams)
      );
      return;
    }
    if (subject.type === 'board') {
      await runWithTenantDatabaseScope(db, tenantId, () =>
        app
          .service('boards')
          .patch(subject.id as BoardID, { profile_image_id: imageId ?? undefined }, params)
      );
      return;
    }
    const branch =
      subject.branch ??
      (await runWithTenantDatabaseScope(db, tenantId, () =>
        branches.findById(subject.id as BranchID)
      ));
    if (!branch) throw new NotFound('Profile unavailable');
    const current = getTeammateConfig(branch);
    if (!current) throw new NotFound('Profile unavailable');
    const { profileImageId: _previous, ...withoutPrimary } = current;
    const customContext = {
      ...(branch.custom_context ?? {}),
      teammate: imageId ? { ...withoutPrimary, profileImageId: imageId } : withoutPrimary,
    };
    await runWithTenantDatabaseScope(db, tenantId, () =>
      app.service('branches').patch(branch.branch_id, { custom_context: customContext }, params)
    );
  };

  const loadImageAndSubject = async (
    req: AuthenticatedProfileImageRequest,
    imageId: ProfileImageID,
    mode: 'view' | 'manage'
  ) => {
    const { tenantId } = authContext(req);
    const image = await runWithTenantDatabaseScope(db, tenantId, () =>
      repository.findById(tenantId, imageId)
    );
    if (!image) throw new NotFound('Profile image unavailable');
    const subject = await authorizeSubject(req, image.subject_type, image.subject_id, mode);
    return { image, subject, tenantId };
  };

  const loadIdentityModelClient = () => {
    try {
      return createIdentityModelClient();
    } catch {
      throw new Unavailable(
        '3D identity generation is not configured. Set MESHY_API_KEY on the daemon.'
      );
    }
  };

  const safeGenerationStartError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : '';
    if (
      message.startsWith('Meshy ') ||
      message.startsWith('The 3D generation provider ') ||
      message.startsWith('Meshy is rate limiting')
    ) {
      return message;
    }
    return '3D generation could not start';
  };

  const reconcileIdentityModel = async (
    tenantId: TenantID,
    imageId: ProfileImageID,
    client: MeshyIdentityModelClient
  ): Promise<ProfileImage> => {
    const current = await runWithTenantDatabaseScope(db, tenantId, () =>
      repository.readIdentityModelState(tenantId, imageId)
    );
    if (!current) throw new NotFound('Profile image unavailable');
    const model = current.image.identity_model;
    const cleanupProviderTask = async () => {
      if (!current.providerTaskId) return;
      try {
        await client.delete(current.providerTaskId);
        await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.clearIdentityModelTask(tenantId, imageId, current.providerTaskId!)
        );
      } catch {
        // The GLB is already private and usable. Keep the task ID so a later
        // authenticated status read can retry provider-side deletion.
      }
    };
    if (model?.status === 'succeeded' && model.model_available) {
      await cleanupProviderTask();
      return current.image;
    }
    if (!model || !current.providerTaskId || !['pending', 'in_progress'].includes(model.status)) {
      return current.image;
    }

    const providerTask = await client.get(current.providerTaskId);
    if (providerTask.status === 'PENDING' || providerTask.status === 'IN_PROGRESS') {
      await runWithTenantDatabaseScope(db, tenantId, () =>
        repository.updateIdentityModelProgress(
          tenantId,
          imageId,
          current.providerTaskId!,
          providerTask.status === 'PENDING' ? 'pending' : 'in_progress',
          providerTask.progress
        )
      );
    } else if (providerTask.status === 'FAILED' || providerTask.status === 'CANCELED') {
      await runWithTenantDatabaseScope(db, tenantId, () =>
        repository.failIdentityModel(
          tenantId,
          imageId,
          current.providerTaskId,
          providerTask.status === 'CANCELED' ? 'canceled' : 'failed',
          providerTask.status === 'CANCELED'
            ? '3D generation was canceled'
            : '3D generation failed at the provider'
        )
      );
    } else if (providerTask.status === 'SUCCEEDED') {
      if (!providerTask.modelUrl) {
        await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.failIdentityModel(
            tenantId,
            imageId,
            current.providerTaskId,
            'failed',
            'The 3D provider completed without a GLB model'
          )
        );
      } else {
        try {
          const data = await client.downloadGlb(providerTask.modelUrl);
          await runWithTenantDatabaseScope(db, tenantId, () =>
            repository.completeIdentityModel(tenantId, imageId, current.providerTaskId!, data)
          );
          await cleanupProviderTask();
        } catch {
          await runWithTenantDatabaseScope(db, tenantId, () =>
            repository.updateIdentityModelProgress(
              tenantId,
              imageId,
              current.providerTaskId!,
              'in_progress',
              99
            )
          );
        }
      }
    }

    const updated = await runWithTenantDatabaseScope(db, tenantId, () =>
      repository.findById(tenantId, imageId)
    );
    if (!updated) throw new NotFound('Profile image unavailable');
    return updated;
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).get(
    '/profile-images',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const subjectType = parseSubjectType(req.query.subjectType);
        const subjectId = parseSubjectId(req.query.subjectId);
        const { tenantId } = authContext(req);
        const subject = await authorizeSubject(req, subjectType, subjectId, 'view');
        const images = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.listForSubject(tenantId, subject)
        );
        res.json({
          images: images.map(publicProfileImage),
          max_images: PROFILE_IMAGE_MAX_GALLERY_ITEMS,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).post(
    '/profile-images',
    authMiddleware,
    upload,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const { params, tenantId, userId } = authContext(req);
        ensureMinimumRole(params, ROLES.MEMBER, 'manage profile images');
        const subjectType = parseSubjectType(req.body?.subjectType);
        const subjectId = parseSubjectId(req.body?.subjectId);
        const subject = await authorizeSubject(req, subjectType, subjectId, 'manage');
        if (!req.file?.buffer) throw new BadRequest('Choose an image to upload');
        const existing = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.listForSubject(tenantId, subject)
        );
        if (existing.length >= PROFILE_IMAGE_MAX_GALLERY_ITEMS) {
          throw new BadRequest(
            `A profile can contain up to ${PROFILE_IMAGE_MAX_GALLERY_ITEMS} images`
          );
        }
        let processed: Awaited<ReturnType<typeof processProfileImage>>;
        try {
          processed = await processProfileImage(req.file.buffer);
        } catch (error) {
          throw new BadRequest(
            error instanceof Error ? error.message : 'The profile image could not be processed'
          );
        }
        const created = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.create({
            tenantId,
            subject,
            createdBy: userId,
            originalName: sanitizeProfileImageName(req.file?.originalname),
            altText: sanitizeProfileImageAlt(req.body?.altText),
            small: processed.small,
            large: processed.large,
          })
        );
        if (created.is_primary) {
          try {
            await syncPrimaryProjection(req, subject, created.image_id);
          } catch (error) {
            await runWithTenantDatabaseScope(db, tenantId, () =>
              repository.remove(tenantId, created.image_id)
            );
            throw error;
          }
        }
        res.status(201).json(publicProfileImage(created));
      } catch (error) {
        next(error instanceof multer.MulterError ? new BadRequest(error.message) : error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).post(
    '/profile-images/:imageId/identity-model',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const { params, tenantId } = authContext(req);
        ensureMinimumRole(params, ROLES.ADMIN, 'generate 3D identity models');
        if (req.body?.consent !== true) {
          throw new BadRequest('Explicit consent is required before sending a photo to Meshy');
        }
        const imageId = req.params.imageId as ProfileImageID;
        await loadImageAndSubject(req, imageId, 'manage');
        const client = loadIdentityModelClient();
        const claimed = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.claimIdentityModelGeneration(tenantId, imageId, 'meshy')
        );
        if (!claimed) throw new Conflict('A 3D model is already being generated for this photo');

        let providerTaskId: string | undefined;
        try {
          const source = await runWithTenantDatabaseScope(db, tenantId, () =>
            repository.readVariant(tenantId, imageId, 'large')
          );
          if (!source) throw new NotFound('Profile image unavailable');
          const png = await sharp(source.data, { animated: false }).png().toBuffer();
          const submittedTaskId = await client.create(png);
          providerTaskId = submittedTaskId;
          await runWithTenantDatabaseScope(db, tenantId, () =>
            repository.setIdentityModelTask(tenantId, imageId, submittedTaskId)
          );
        } catch (error) {
          if (providerTaskId) {
            try {
              await client.delete(providerTaskId);
            } catch {
              // The submission never became a usable Agor model. Do not mask
              // the original failure if best-effort provider cleanup also fails.
            }
          }
          const message = safeGenerationStartError(error);
          await runWithTenantDatabaseScope(db, tenantId, () =>
            repository.failIdentityModel(tenantId, imageId, null, 'failed', message)
          );
          throw new Unavailable(message);
        }

        const image = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.findById(tenantId, imageId)
        );
        if (!image) throw new NotFound('Profile image unavailable');
        res.status(202).json(image);
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).get(
    '/profile-images/:imageId/identity-model',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const imageId = req.params.imageId as ProfileImageID;
        const { image, tenantId } = await loadImageAndSubject(req, imageId, 'view');
        if (!image.identity_model) throw new NotFound('3D identity model unavailable');
        const active = ['pending', 'in_progress'].includes(image.identity_model.status);
        let updated = image;
        if (active) {
          updated = await reconcileIdentityModel(tenantId, imageId, loadIdentityModelClient());
        } else if (
          image.identity_model.status === 'succeeded' &&
          image.identity_model.model_available
        ) {
          try {
            updated = await reconcileIdentityModel(tenantId, imageId, loadIdentityModelClient());
          } catch (error) {
            if (!(error instanceof Unavailable)) throw error;
          }
        }
        res.json(updated);
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).get(
    '/profile-images/:imageId/identity-model/file',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const imageId = req.params.imageId as ProfileImageID;
        const { tenantId } = await loadImageAndSubject(req, imageId, 'view');
        const model = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.readIdentityModelState(tenantId, imageId)
        );
        if (!model?.data || !model.contentType) {
          throw new NotFound('3D identity model unavailable');
        }
        const modelVersion = model.image.identity_model?.updated_at ?? 'unknown';
        const etag = `"identity-model-${imageId}-${model.data.byteLength}-${Buffer.from(modelVersion).toString('base64url')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader('Content-Type', model.contentType);
        res.setHeader('Content-Length', String(model.data.byteLength));
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('ETag', etag);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(model.data);
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).get(
    '/profile-images/:imageId/:variant',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const imageId = req.params.imageId as ProfileImageID;
        const variant = req.params.variant as ProfileImageVariant;
        if (variant !== 'small' && variant !== 'large') {
          throw new NotFound('Profile image unavailable');
        }
        const { tenantId } = await loadImageAndSubject(req, imageId, 'view');
        const result = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.readVariant(tenantId, imageId, variant)
        );
        if (!result) throw new NotFound('Profile image unavailable');
        const etag = `"profile-${imageId}-${variant}"`;
        if (req.headers['if-none-match'] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Length', String(result.data.byteLength));
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('ETag', etag);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(result.data);
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).patch(
    '/profile-images/:imageId',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const { params } = authContext(req);
        ensureMinimumRole(params, ROLES.MEMBER, 'manage profile images');
        const imageId = req.params.imageId as ProfileImageID;
        const { image, subject, tenantId } = await loadImageAndSubject(req, imageId, 'manage');
        const body = (req.body ?? {}) as ProfileImagePatch;
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
          ? (
              await runWithTenantDatabaseScope(db, tenantId, () =>
                repository.listForSubject(tenantId, subject)
              )
            ).find((candidate) => candidate.is_primary)
          : undefined;
        const updated = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.patch(tenantId, imageId, patch)
        );
        if (!updated) throw new NotFound('Profile image unavailable');
        if (body.is_primary === true && !image.is_primary) {
          try {
            await syncPrimaryProjection(req, subject, imageId);
          } catch (error) {
            if (previousPrimary) {
              await runWithTenantDatabaseScope(db, tenantId, () =>
                repository.patch(tenantId, previousPrimary.image_id, { isPrimary: true })
              );
            }
            throw error;
          }
        }
        res.json(publicProfileImage(updated));
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).delete(
    '/profile-images/:imageId',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const { params } = authContext(req);
        ensureMinimumRole(params, ROLES.MEMBER, 'manage profile images');
        const imageId = req.params.imageId as ProfileImageID;
        const { image, subject, tenantId } = await loadImageAndSubject(req, imageId, 'manage');
        const identityState = await runWithTenantDatabaseScope(db, tenantId, () =>
          repository.readIdentityModelState(tenantId, imageId)
        );
        if (identityState?.providerTaskId) {
          try {
            await loadIdentityModelClient().delete(identityState.providerTaskId);
          } catch {
            throw new Unavailable(
              'The profile photo was not deleted because its provider data could not be removed. Try again when Meshy is available.'
            );
          }
        }
        const replacementPrimary = image.is_primary
          ? (
              await runWithTenantDatabaseScope(db, tenantId, () =>
                repository.listForSubject(tenantId, subject)
              )
            ).find((candidate) => candidate.image_id !== imageId)
          : undefined;
        if (image.is_primary) {
          await syncPrimaryProjection(req, subject, replacementPrimary?.image_id ?? null);
        }
        let removed: Awaited<ReturnType<ProfileImageRepository['remove']>>;
        try {
          removed = await runWithTenantDatabaseScope(db, tenantId, () =>
            repository.remove(tenantId, imageId)
          );
        } catch (error) {
          if (image.is_primary) await syncPrimaryProjection(req, subject, imageId);
          throw error;
        }
        if (!removed) throw new NotFound('Profile image unavailable');
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );
}
