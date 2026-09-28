import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  ProfileImageID,
  ProfileImagePatch,
  ProfileImageVariant,
} from '@agor/core/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import {
  createProfileImageManager,
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
    limits: { fileSize: PROFILE_IMAGE_MAX_BYTES, files: 1, fields: 4 },
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
        });
        res.status(201).json(created);
      } catch (error) {
        next(error instanceof multer.MulterError ? new BadRequest(error.message) : error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express methods are not declared on Feathers Application.
  (app as any).post(
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
