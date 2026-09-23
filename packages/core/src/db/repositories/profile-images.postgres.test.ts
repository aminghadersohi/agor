/** PostgreSQL RLS proof for private profile-image and identity-model bytes. */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { TenantID, UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { deleteFrom, isPostgresDatabase } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import * as pg from '../schema.postgres';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { ProfileImageRepository } from './profile-images';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)('profile identity models (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('does not expose or mutate another tenant model when its image ID is known', async () => {
    const tenantA = `profile-model-a-${generateId()}` as TenantID;
    const tenantB = `profile-model-b-${generateId()}` as TenantID;
    let imageId!: Awaited<ReturnType<ProfileImageRepository['create']>>['image_id'];
    let userId!: UserID;
    const glb = Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]);

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const user = await new UsersRepository(scoped).create({
        email: `${generateId()}@example.invalid`,
        name: 'Tenant A identity',
      });
      userId = user.user_id as UserID;
      const repository = new ProfileImageRepository(scoped);
      const image = await repository.create({
        tenantId: tenantA,
        subject: { type: 'user', id: userId },
        createdBy: userId,
        originalName: 'private.webp',
        small: { data: Buffer.from('small'), contentType: 'image/webp', width: 96, height: 96 },
        large: { data: Buffer.from('large'), contentType: 'image/webp', width: 768, height: 768 },
      });
      imageId = image.image_id;
      expect(await repository.claimIdentityModelGeneration(tenantA, imageId, 'meshy')).toBe(true);
      await repository.setIdentityModelTask(tenantA, imageId, 'tenant-a-task');
      await repository.completeIdentityModel(tenantA, imageId, 'tenant-a-task', glb);
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      const repository = new ProfileImageRepository(scoped);
      expect(await repository.findById(tenantB, imageId)).toBeNull();
      expect(await repository.readIdentityModelState(tenantB, imageId)).toBeNull();
      expect(await repository.claimIdentityModelGeneration(tenantB, imageId, 'meshy')).toBe(false);
    });

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      expect(
        (await new ProfileImageRepository(scoped).readIdentityModelState(tenantA, imageId))?.data
      ).toEqual(glb);
      await deleteFrom(scoped, pg.users).where(eq(pg.users.user_id, userId)).run();
    });
  });
});
