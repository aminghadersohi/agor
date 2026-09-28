/**
 * `branches/:id/front-desk` against a real migrated SQLite database, reusing
 * the Slice 1 front-desk fixture so the route is proven against the same
 * capability policy and resolver the MCP tools use — not a stub.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database, initializeDatabase } from '@agor/core/db';
import type { BranchID, SessionID, User } from '@agor/core/types';
import { afterAll, describe, expect, it } from 'vitest';
import { type FrontDeskFixture, frontDeskFixture } from '../../test/front-desk-fixture';
import { resolveTeammateSession } from '../mcp/tools/teammate-addressing';
import { createBranchFrontDeskRoute } from './branch-front-desk';

const tempDirs: string[] = [];

async function migratedSqliteDatabase(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), 'agor-front-desk-route-'));
  tempDirs.push(dir);
  const db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
  await initializeDatabase(db);
  return db;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort; a leftover temp dir must not fail the run.
    }
  }
});

const OLDER = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-05-01T00:00:00.000Z');

async function setup() {
  const f = await frontDeskFixture(await migratedSqliteDatabase());
  const branch = await f.createTeammate({ name: 'front-desk', displayName: 'Front Desk' });
  const pinned = await f.createSession({ branchId: branch.branch_id, updatedAt: OLDER });
  const recent = await f.createSession({ branchId: branch.branch_id, updatedAt: NEWER });
  const route = createBranchFrontDeskRoute({ db: f.db, allowSuperadmin: () => false });
  return { f, branch, pinned, recent, route };
}

function paramsFor(
  f: FrontDeskFixture,
  user: User,
  branchId: BranchID,
  query?: Record<string, unknown>
) {
  return {
    provider: 'rest',
    user,
    route: { id: branchId },
    tenant: { tenant_id: f.tenantId, source: 'explicit' as const },
    ...(query ? { query } : {}),
  } as never;
}

describe('branches/:id/front-desk', () => {
  it('previews who name addressing reaches only when include_addressing is asked for', async () => {
    const { f, branch, pinned, recent, route } = await setup();
    await route.setup(f.contextFor().app);
    const withAddressing = (user: User) =>
      f.inTenant(() =>
        route.find(paramsFor(f, user, branch.branch_id, { include_addressing: 'true' }))
      );

    await expect(
      f.inTenant(() => route.find(paramsFor(f, f.owner, branch.branch_id)))
    ).resolves.not.toHaveProperty('addressing');
    await expect(withAddressing(f.owner)).resolves.toMatchObject({
      addressing: {
        via: 'recency',
        session_id: recent.session_id,
        name_addressing: { addressable: true, address: 'front-desk' },
        bypassed_front_desk: null,
      },
    });

    await f.pinDirect(branch.branch_id, pinned.session_id);
    await expect(withAddressing(f.owner)).resolves.toMatchObject({
      addressing: { via: 'front_desk', session_id: pinned.session_id },
    });

    // A Viewer sees the desk but cannot prompt, so a name would not reach it for them.
    await expect(withAddressing(f.viewer)).resolves.toMatchObject({
      addressing: { name_addressing: { addressable: false, reason: 'no_prompt_permission' } },
    });

    // The preview reports an archived pin it skipped but leaves demotion to a real address.
    await f.archiveSession(pinned.session_id);
    await expect(withAddressing(f.owner)).resolves.toMatchObject({
      front_desk: { session_id: pinned.session_id, status: 'active' },
      addressing: {
        via: 'recency',
        session_id: recent.session_id,
        bypassed_front_desk: { session_id: pinned.session_id, reason: 'archived' },
      },
    });
  });

  it('reports no pin and the caller’s manage capability', async () => {
    const { f, branch, route } = await setup();

    await expect(
      f.inTenant(() => route.find(paramsFor(f, f.owner, branch.branch_id)))
    ).resolves.toEqual({ branch_id: branch.branch_id, front_desk: null, can_manage: true });
    await expect(
      f.inTenant(() => route.find(paramsFor(f, f.collaborator, branch.branch_id)))
    ).resolves.toMatchObject({ front_desk: null, can_manage: false });
  });

  it('hides the teammate from a caller without branch.view, and refuses non-teammate branches', async () => {
    const { f, branch, route } = await setup();
    const plain = await f.createTeammate({ name: 'plain-branch', plainBranch: true });

    await expect(
      f.inTenant(() => route.find(paramsFor(f, f.outsider, branch.branch_id)))
    ).rejects.toMatchObject({ code: 404 });
    await expect(
      f.inTenant(() => route.find(paramsFor(f, f.owner, plain.branch_id)))
    ).rejects.toMatchObject({ code: 404 });
  });

  it('pins a session so teammate addressing reaches it, and returns the fresh view', async () => {
    const { f, branch, pinned, route } = await setup();

    const view = await f.inTenant(() =>
      route.create({ session_id: pinned.session_id }, paramsFor(f, f.owner, branch.branch_id))
    );
    expect(view).toMatchObject({
      branch_id: branch.branch_id,
      can_manage: true,
      front_desk: {
        session_id: pinned.session_id,
        status: 'active',
        promoted_by: f.owner.user_id,
      },
    });
    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'front_desk',
      session: { session_id: pinned.session_id },
    });
  });

  it('lets only a Branch Manager pin or clear', async () => {
    const { f, branch, pinned, recent, route } = await setup();

    await expect(
      f.inTenant(() =>
        route.create(
          { session_id: recent.session_id },
          paramsFor(f, f.collaborator, branch.branch_id)
        )
      )
    ).rejects.toMatchObject({ code: 403, message: expect.stringMatching(/Branch Manager/) });
    expect(await f.declarations(branch.branch_id)).toEqual([]);

    await f.pinDirect(branch.branch_id, pinned.session_id);
    await expect(
      f.inTenant(() => route.remove(null, paramsFor(f, f.collaborator, branch.branch_id)))
    ).rejects.toMatchObject({ code: 403 });
    expect(
      (await f.declarations(branch.branch_id)).filter((d) => d.status === 'active')
    ).toHaveLength(1);
  });

  it('maps pin refusals to 400 with the reason, writing nothing', async () => {
    const { f, branch, route } = await setup();
    const other = await f.createTeammate({ name: 'other-desk', displayName: 'Other Desk' });
    const foreign = await f.createSession({ branchId: other.branch_id, updatedAt: NEWER });
    const archived = await f.createSession({
      branchId: branch.branch_id,
      updatedAt: NEWER,
      archived: true,
    });

    await expect(
      f.inTenant(() =>
        route.create({ session_id: foreign.session_id }, paramsFor(f, f.owner, branch.branch_id))
      )
    ).rejects.toMatchObject({ code: 400, data: { reason: 'session_in_other_branch' } });
    await expect(
      f.inTenant(() =>
        route.create({ session_id: archived.session_id }, paramsFor(f, f.owner, branch.branch_id))
      )
    ).rejects.toMatchObject({ code: 400, data: { reason: 'session_archived' } });
    await expect(
      f.inTenant(() => route.create({} as never, paramsFor(f, f.owner, branch.branch_id)))
    ).rejects.toMatchObject({ code: 400, message: 'session_id is required' });
    expect(await f.declarations(branch.branch_id)).toEqual([]);
  });

  it('treats a stale expected_session_id as a 409 conflict on pin and clear', async () => {
    const { f, branch, pinned, recent, route } = await setup();
    await f.pinDirect(branch.branch_id, pinned.session_id);

    await expect(
      f.inTenant(() =>
        route.create(
          { session_id: recent.session_id, expected_session_id: null },
          paramsFor(f, f.owner, branch.branch_id)
        )
      )
    ).rejects.toMatchObject({ code: 409 });
    await expect(
      f.inTenant(() =>
        route.remove(
          null,
          paramsFor(f, f.owner, branch.branch_id, { expected_session_id: recent.session_id })
        )
      )
    ).rejects.toMatchObject({ code: 409 });

    const replaced = await f.inTenant(() =>
      route.create(
        { session_id: recent.session_id, expected_session_id: pinned.session_id },
        paramsFor(f, f.owner, branch.branch_id)
      )
    );
    expect(replaced.front_desk?.session_id).toBe(recent.session_id);
  });

  it('shares one declaration with the MCP tools: pinned over REST, cleared over MCP', async () => {
    const { f, branch, pinned, recent, route } = await setup();
    await f.inTenant(() =>
      route.create({ session_id: pinned.session_id }, paramsFor(f, f.owner, branch.branch_id))
    );

    const cleared = await f.frontDeskHandlersFor(f.owner).agor_teammates_front_desk_clear({
      teammate: 'front-desk',
      expectedSessionId: pinned.session_id as SessionID,
    });
    expect(f.payloadOf(cleared)).toMatchObject({ cleared: { session_id: pinned.session_id } });

    await expect(
      f.inTenant(() => route.find(paramsFor(f, f.owner, branch.branch_id)))
    ).resolves.toMatchObject({ front_desk: null });
    await expect(resolveTeammateSession(f.contextFor(), branch)).resolves.toMatchObject({
      via: 'recency',
      session: { session_id: recent.session_id },
    });

    // Clearing an empty slot over REST is a no-op that still answers the view.
    await expect(
      f.inTenant(() => route.remove(null, paramsFor(f, f.owner, branch.branch_id)))
    ).resolves.toMatchObject({ front_desk: null, can_manage: true });
  });
});
