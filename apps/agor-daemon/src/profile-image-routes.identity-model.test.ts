import type { Server } from 'node:http';
import { ProfileImageRepository, UsersRepository } from '@agor/core/db';
import type { ProfileImageID, TenantID, UserID } from '@agor/core/types';
import express from 'express';
import sharp from 'sharp';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers';
import { registerProfileImageRoutes } from './profile-image-routes.js';
import type { MeshyIdentityModelClient } from './services/meshy-identity-model.js';

const tenantId = 'default' as TenantID;
let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe('profile identity model routes', () => {
  dbTest(
    'requires consent and stores completed GLB bytes behind subject authorization',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `identity-model-${Date.now()}@example.com`,
        name: 'Identity model test',
      });
      const source = await sharp({
        create: { width: 4, height: 4, channels: 4, background: '#336699' },
      })
        .webp()
        .toBuffer();
      const image = await new ProfileImageRepository(db).create({
        tenantId,
        subject: { type: 'user', id: user.user_id as UserID },
        createdBy: user.user_id as UserID,
        originalName: 'portrait.webp',
        small: { data: source, contentType: 'image/webp', width: 4, height: 4 },
        large: { data: source, contentType: 'image/webp', width: 4, height: 4 },
      });
      const glb = Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);
      const provider = {
        create: vi.fn(async () => 'provider-task-1'),
        get: vi.fn(async () => ({
          id: 'provider-task-1',
          status: 'SUCCEEDED' as const,
          progress: 100,
          modelUrl: 'https://assets.meshy.ai/model.glb?signature=private',
        })),
        downloadGlb: vi.fn(async () => glb),
        delete: vi.fn(async () => undefined),
      } as unknown as MeshyIdentityModelClient;

      const app = express();
      app.use(express.json());
      const authMiddleware: express.RequestHandler = (request, _response, next) => {
        (request as typeof request & { feathers: unknown }).feathers = {
          provider: 'rest',
          tenant: { tenant_id: tenantId },
          user: { ...user, role: 'admin' },
        };
        next();
      };
      registerProfileImageRoutes({
        app: app as never,
        db,
        authMiddleware,
        branchRbacEnabled: false,
        allowSuperadmin: false,
        createIdentityModelClient: () => provider,
      });
      app.use(
        (
          error: { code?: number; message?: string },
          _request: express.Request,
          response: express.Response,
          _next: express.NextFunction
        ) => response.status(error.code ?? 500).json({ message: error.message ?? 'failed' })
      );
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      const address = server?.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const origin = `http://127.0.0.1:${address.port}`;
      const path = `/profile-images/${image.image_id as ProfileImageID}/identity-model`;

      const denied = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: false }),
      });
      expect(denied.status).toBe(400);
      expect(provider.create).not.toHaveBeenCalled();

      const started = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true }),
      });
      expect(started.status).toBe(202);
      expect(await started.json()).toMatchObject({
        image_id: image.image_id,
        identity_model: { provider: 'meshy', status: 'pending', model_available: false },
      });

      const reconciled = await fetch(`${origin}${path}`);
      expect(reconciled.status).toBe(200);
      expect(await reconciled.json()).toMatchObject({
        identity_model: { status: 'succeeded', progress: 100, model_available: true },
      });

      const downloaded = await fetch(`${origin}${path}/file`);
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-type')).toBe('model/gltf-binary');
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(glb);
      expect(provider.downloadGlb).toHaveBeenCalledWith(
        'https://assets.meshy.ai/model.glb?signature=private'
      );
      expect(provider.delete).toHaveBeenCalledWith('provider-task-1');
    }
  );
});
