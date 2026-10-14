/**
 * Skill set governance in the Knowledge write path: nothing but the release
 * code path writes `skillsets/**` in a configured provider namespace, and only
 * an admin outside any session reaches the admin release route.
 */

import { createTenantScopedDatabaseProxy } from '@agor/core/db';
import { ROLES, type User } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  putSkillDoc,
  type SkillsKnowledgeFixture,
  seedSkillsNamespace,
  seedSkillsUser,
  skillMarkdown,
  skillsKnowledgeApp,
  userParams,
} from '../../test/skills-fixture';
import { EXECUTOR_SESSION_TOKEN_TYPE } from '../auth/executor-session-token';
import { KnowledgeDocumentEditsService } from '../services/knowledge-document-edits';
import { KnowledgeTransfersService } from '../services/knowledge-transfers';
import { assertAdminOutsideSession, createSkillReleasesRoute } from '../services/skill-releases';
import { SKILLSET_GOVERNED_MESSAGE } from './skillset-governance';

const FORBIDDEN =
  /skillsets\/ in a skills provider namespace is written only by skill set releases/;

async function releasedNamespace(db: Parameters<typeof skillsKnowledgeApp>[0]) {
  const fixture = skillsKnowledgeApp(db);
  const admin = await seedSkillsUser(db, 'admin', ROLES.ADMIN);
  const member = await seedSkillsUser(db, 'member');
  const ns = await seedSkillsNamespace(db, admin, { othersCan: 'write' });
  await putSkillDoc(
    fixture,
    admin,
    ns,
    'skills/frink/research-loop.md',
    skillMarkdown('research-loop')
  );
  const route = createSkillReleasesRoute({ db: db as never });
  await route.setup(fixture.app);
  const result = await route.create({ teammate: 'frink' }, adminCli(admin));
  expect(result.results[0]).toMatchObject({ status: 'released', release: 1 });
  const manifest = (
    await fixture.documents.find({
      ...userParams(admin),
      query: { namespace_id: ns.namespace_id, path: 'skillsets/frink.md' },
    } as never)
  ).data[0];
  return { fixture, admin, member, ns, route, manifest };
}

function adminCli(user: User) {
  return { user, provider: 'rest', authentication: { strategy: 'jwt', payload: {} } } as never;
}

function put(fixture: SkillsKnowledgeFixture, user: User, data: Record<string, unknown>) {
  return fixture.documents.putDocument(data as never, userParams(user) as never);
}

describe('skill set governance on Knowledge writes', () => {
  dbTest('refuses forged releases through ordinary writes, for every user', async ({ db }) => {
    const { fixture, admin, member, ns, manifest } = await releasedNamespace(db);
    const forged = '---\nname: frink\nteammate: x\nrelease: 2\nskills: []\n---\n';
    for (const user of [member, admin]) {
      // put over the manifest (agor_kb_put), by its own author too
      await expect(
        put(fixture, user, {
          namespace_slug: ns.slug,
          path: 'skillsets/frink.md',
          kind: 'bundle',
          content_text: forged,
        })
      ).rejects.toThrow(FORBIDDEN);
      // a new manifest for another teammate
      await expect(
        put(fixture, user, {
          namespace_slug: ns.slug,
          path: 'skillsets/maya.md',
          kind: 'bundle',
          content_text: forged,
        })
      ).rejects.toThrow(FORBIDDEN);
      // create()
      await expect(
        fixture.documents.create(
          {
            namespace_id: ns.namespace_id,
            path: 'skillsets/x.md',
            kind: 'doc',
            content_text: '# x',
          } as never,
          userParams(user) as never
        )
      ).rejects.toThrow(FORBIDDEN);
      // rename the manifest away (would reopen r1) or edit it in place
      await expect(
        fixture.documents.patch(
          manifest.document_id,
          { path: 'notes/old.md' } as never,
          userParams(user) as never
        )
      ).rejects.toThrow(FORBIDDEN);
      await expect(
        fixture.documents.patch(
          manifest.document_id,
          { content_text: forged } as never,
          userParams(user) as never
        )
      ).rejects.toThrow(FORBIDDEN);
      // archive (soft delete) and remove
      await expect(
        fixture.documents.patch(
          manifest.document_id,
          { archived: true } as never,
          userParams(user) as never
        )
      ).rejects.toThrow(FORBIDDEN);
      await expect(
        fixture.documents.remove(manifest.document_id, userParams(user) as never)
      ).rejects.toThrow(FORBIDDEN);
      // agor_kb_edit: refused (its own owner-only pre-check may answer first for non-owners)
      await expect(
        new KnowledgeDocumentEditsService(db, fixture.documents).create(
          {
            documentId: manifest.document_id,
            expectedVersion: 1,
            ops: [
              {
                type: 'replace_literal',
                find: 'release: 1',
                replace: 'release: 9',
                expectedCount: 1,
              },
            ],
          } as never,
          userParams(user) as never
        )
      ).rejects.toThrow(user === admin ? FORBIDDEN : /owner|skillsets/);
    }
    // moving a doc into skillsets/
    const note = await put(fixture, member, {
      namespace_slug: ns.slug,
      path: 'notes/n.md',
      content_text: '# n',
    });
    await expect(
      fixture.documents.patch(
        note.document_id,
        { path: 'skillsets/frink-2.md' } as never,
        userParams(member) as never
      )
    ).rejects.toThrow(FORBIDDEN);
    expect(SKILLSET_GOVERNED_MESSAGE).toMatch(FORBIDDEN);
  });

  dbTest('leaves other namespaces and other paths alone', async ({ db }) => {
    const { fixture, member, ns } = await releasedNamespace(db);
    const plain = await seedSkillsNamespace(db, member, { provider: false, othersCan: 'write' });
    await expect(
      put(fixture, member, {
        namespace_slug: plain.slug,
        path: 'skillsets/frink.md',
        content_text: '# ok',
      })
    ).resolves.toMatchObject({ path: 'skillsets/frink.md' });
    await expect(
      put(fixture, member, {
        namespace_slug: ns.slug,
        path: 'notes/skillsets.md',
        content_text: '# ok',
      })
    ).resolves.toMatchObject({ path: 'notes/skillsets.md' });
  });

  dbTest('only an admin may create a namespace with a configured provider slug', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const member = await seedSkillsUser(db, 'member');
    fixture.config.skills.providers.push({
      namespace: 'not-created-yet',
      curator_branch_id: '01a00000-0000-7000-8000-000000000001',
    });
    await expect(
      put(fixture, member, {
        namespace_slug: 'not-created-yet',
        path: 'skillsets/frink.md',
        content_text: '# x',
        create_namespace: true,
      })
    ).rejects.toThrow(/configured skills provider namespace; only an admin can create it/);
    await expect(
      fixture.namespaces.create(
        { slug: 'not-created-yet', display_name: 'x' },
        userParams(member) as never
      )
    ).rejects.toThrow(/only an admin can create it/);
    const transfers = new KnowledgeTransfersService(
      createTenantScopedDatabaseProxy(db, { requireScope: false }) as never,
      fixture.app
    );
    await expect(
      transfers.create(
        {
          action: 'namespace',
          bundle: 'a'.repeat(64),
          slug: 'not-created-yet',
          display_name: 'x',
          description: null,
          resume: false,
        } as never,
        { user: member } as never
      )
    ).rejects.toThrow(/only an admin can create it/);
  });
});

describe('skills/releases admin route', () => {
  dbTest('refuses non-admins, sessions, executors, services and MCP', async ({ db }) => {
    const { admin, member, route } = await releasedNamespace(db);
    await expect(route.create({ all: true }, adminCli(member))).rejects.toThrow(
      /requires the admin role/
    );
    const outside = /runs as an admin outside any Agor session/;
    await expect(
      route.create({ all: true }, {
        user: admin,
        provider: 'rest',
        authentication: { strategy: 'jwt', payload: { type: EXECUTOR_SESSION_TOKEN_TYPE } },
      } as never)
    ).rejects.toThrow(outside);
    await expect(
      route.create({ all: true }, { user: admin, provider: 'mcp' } as never)
    ).rejects.toThrow(outside);
    await expect(route.create({ all: true }, { user: admin } as never)).rejects.toThrow(outside);
    await expect(
      route.create({ all: true }, {
        user: { ...admin, _isServiceAccount: true },
        provider: 'rest',
      } as never)
    ).rejects.toThrow(outside);
    await expect(route.create({}, adminCli(admin))).rejects.toThrow(
      /exactly one of teammate or all/
    );
    // An admin's own login: unchanged release, nothing new written.
    expect((await route.create({ all: true }, adminCli(admin))).results[0]).toMatchObject({
      status: 'unchanged',
      release: 1,
      authorized_as: 'admin',
    });
  });

  it('accepts personal API keys', () => {
    const admin = { user_id: 'u', role: ROLES.ADMIN } as unknown as User;
    expect(() =>
      assertAdminOutsideSession({
        user: admin,
        provider: 'rest',
        authentication: { strategy: 'api-key' },
      } as never)
    ).not.toThrow();
  });
});
