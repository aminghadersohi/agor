import { describe, expect, it } from 'vitest';
import type { Database } from './client';
import { createDatabase } from './client';
import {
  acquireMaintenanceAdmission,
  inspectMaintenanceAdmission,
  sealMaintenanceAdmission,
} from './maintenance-admission';
import { runWithTenantContext } from './tenant-scope';

describe('operator maintenance preconditions', () => {
  for (const ttlMs of [0, 59999, 14400001, NaN, Infinity, 90000.5]) {
    it(`refuses invalid deadline ${ttlMs} before database access`, async () => {
      await expect(
        acquireMaintenanceAdmission(undefined as unknown as Database, { ttlMs })
      ).rejects.toThrow('lease must');
    });
  }
  it('does not treat SQLite/no DB fence as supported', async () => {
    const db = createDatabase({ url: 'file::memory:' });
    await expect(inspectMaintenanceAdmission(db)).rejects.toThrow('requires PostgreSQL');
    await expect(
      sealMaintenanceAdmission(db, {
        database: 'fake',
        generation: 'fake',
        expiresAt: new Date().toISOString(),
      })
    ).rejects.toThrow('requires PostgreSQL');
  });
  it('rejects trusted tenant ambient authority before touching the operator database', async () => {
    await expect(
      runWithTenantContext('foreign', () =>
        inspectMaintenanceAdmission(undefined as unknown as Database)
      )
    ).rejects.toThrow('operator connection');
  });
});
