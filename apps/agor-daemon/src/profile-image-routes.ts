import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  ProfileImageID,
  ProfileImagePatch,
  ProfileImageVariant,
} from '@agor/core/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import {
  createProfileImageManager,
  parseProfileImageIds,
  parseProfileImageSubjectId,
  parseProfileImageSubjectType,
  profileImageCallerFromParams,
  registerProfileImageManager,
} from './utils/profile-image-management.js';
import { PROFILE_IMAGE_MAX_BYTES } from './utils/profile-image-processing.js';

type AuthenticatedProfileImageRequest = Request & {
  feathers?: AuthenticatedParams;
  file?: Express.Multer.File;
};

interface RegisterProfileImageRoutesOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  authMiddleware: RequestHandler;
  allowSuperadmin: boolean;
}

/** Register authenticated, tenant-owned profile gallery and variant routes. */
export function registerProfileImageRoutes({
  app,
  db,
  authMiddleware,
  allowSuperadmin,
}: RegisterProfileImageRoutesOptions): void {
  const manager = createProfileImageManager({ app, db, allowSuperadmin });
  registerProfileImageManager(app, manager);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PROFILE_IMAGE_MAX_BYTES, files: 1, fields: 5 },
  }).single('image');

  const callerFor = (req: AuthenticatedProfileImageRequest) =>
    profileImageCallerFromParams(req.feathers);

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).get(
    '/profile-images',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const subjectType = parseProfileImageSubjectType(req.query.subjectType);
        const subjectId = parseProfileImageSubjectId(req.query.subjectId);
        res.json(await manager.list(callerFor(req), subjectType, subjectId));
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
        const created = await manager.upload(callerFor(req), {
          subjectType: parseProfileImageSubjectType(req.body?.subjectType),
          subjectId: parseProfileImageSubjectId(req.body?.subjectId),
          // An absent file is rejected after authorization, like an empty one.
          data: req.file?.buffer ?? Buffer.alloc(0),
          originalName: req.file?.originalname,
          altText: req.body?.altText,
          theme: req.body?.theme,
        });
        res.status(201).json(created);
      } catch (error) {
        next(error instanceof multer.MulterError ? new BadRequest(error.message) : error);
      }
    }
  );

  // GET, not POST: the UI loads variants with GET, and the ETag/immutable cache headers
  // below only work for a safe, cacheable read.
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
        const result = await manager.readVariant(callerFor(req), imageId, variant);
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
        const updated = await manager.update(
          callerFor(req),
          req.params.imageId as ProfileImageID,
          (req.body ?? {}) as ProfileImagePatch
        );
        res.json(updated);
      } catch (error) {
        next(error);
      }
    }
  );

  // Bulk and ordering routes use fixed single-segment paths, so they cannot
  // collide with `/profile-images/:imageId` (PATCH/DELETE) or the two-segment
  // variant GET above.
  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).put(
    '/profile-images/order',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        res.json(
          await manager.reorder(
            callerFor(req),
            parseProfileImageSubjectType(req.body?.subjectType),
            parseProfileImageSubjectId(req.body?.subjectId),
            parseProfileImageIds(req.body?.imageIds)
          )
        );
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).post(
    '/profile-images/bulk',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        const subjectType = parseProfileImageSubjectType(req.body?.subjectType);
        const subjectId = parseProfileImageSubjectId(req.body?.subjectId);
        const imageIds = parseProfileImageIds(req.body?.imageIds);
        const action = req.body?.action;
        if (action === 'delete') {
          res.json(await manager.bulkRemove(callerFor(req), subjectType, subjectId, imageIds));
        } else if (action === 'set-theme') {
          res.json(
            await manager.bulkSetTheme(
              callerFor(req),
              subjectType,
              subjectId,
              imageIds,
              typeof req.body?.theme === 'string' ? req.body.theme : null
            )
          );
        } else {
          throw new BadRequest('action must be delete or set-theme');
        }
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).put(
    '/profile-images/active-theme',
    authMiddleware,
    async (req: AuthenticatedProfileImageRequest, res: Response, next: NextFunction) => {
      try {
        res.json(
          await manager.setActiveTheme(
            callerFor(req),
            parseProfileImageSubjectId(req.body?.subjectId) as BranchID,
            typeof req.body?.theme === 'string' ? req.body.theme : null
          )
        );
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
        await manager.remove(callerFor(req), req.params.imageId as ProfileImageID);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );
}
