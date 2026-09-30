/**
 * The UI fetches profile-image variants with GET (`fetchProfileImageBlob`). A
 * method mismatch 404s every photo and every teammate surface falls back to its
 * emoji, so the variant read is pinned to GET over a real socket here.
 */

import type { Server } from 'node:http';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readVariant = vi.hoisted(() => vi.fn());

vi.mock('./utils/profile-image-management.js', () => ({
  createProfileImageManager: () => ({ readVariant }),
  registerProfileImageManager: () => {},
  parseProfileImageSubjectId: (value: unknown) => value,
  parseProfileImageSubjectType: (value: unknown) => value,
  profileImageCallerFromParams: (params: unknown) => params,
}));

import { registerProfileImageRoutes } from './profile-image-routes';

let server: Server | undefined;

async function start(): Promise<string> {
  const app = express();
  const authMiddleware: RequestHandler = (_req, _res, next) => next();
  registerProfileImageRoutes({
    app: app as unknown as Application,
    db: {} as TenantScopeAwareDatabase,
    authMiddleware,
    allowSuperadmin: false,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server?.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  readVariant.mockReset();
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('profile image variant route', () => {
  it('serves a variant to a GET, which is how the UI loads photos', async () => {
    readVariant.mockResolvedValue({ contentType: 'image/webp', data: Buffer.from('webp-bytes') });
    const base = await start();

    const response = await fetch(`${base}/profile-images/image-1/small`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('etag')).toBe('"profile-image-1-small"');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('webp-bytes');
    expect(readVariant).toHaveBeenCalledWith(undefined, 'image-1', 'small');
  });
});
