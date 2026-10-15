/**
 * `skills/releases` through the real registrar (`transaction: false`) on a
 * guarded database handle: the route has tenant context but no request-long
 * database scope, so every direct read must open its own tenant-bound unit.
 * Calling the route object directly over an unguarded handle hides that.
 */

import {
  createTenantScopedDatabaseProxy,
  type Database,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { type HookContext, ROLES, type User } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  putSkillDoc,
  seedSkillsNamespace,
  seedSkillsUser,
  skillMarkdown,
  skillsKnowledgeApp,
} from '../../test/skills-fixture';
import { createTenantScopedAuthenticatedRouteRegistrar } from '../utils/tenant-authenticated-route';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { KnowledgeNamespacesService } from './knowledge-namespaces';
import { KnowledgeVersionsService } from './knowledge-versions';
import { createSkillReleasesRoute } from './skill-releases';

const TENANT = 'default';

async function registeredRoute(rawDb: Database) {
  // Seed through the plain fixture (unguarded), which also records the provider config.
  const seed = skillsKnowledgeApp(rawDb);
  const admin = await seedSkillsUser(rawDb, 'admin', ROLES.ADMIN);
  const ns = await seedSkillsNamespace(rawDb, admin);
  await putSkillDoc(
    seed,
    admin,
    ns,
    'skills/fritz/research-loop.md',
    skillMarkdown('research-loop')
  );
  await putSkillDoc(
    seed,
    admin,
    ns,
    'skills/mila/campaign-brief.md',
    skillMarkdown('campaign-brief')
  );

  // The daemon's shape: a guarded handle, kb/* services behind a tenant scope hook,
  // and the route registered by the real tenant registrar without a transaction.
  const db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });
  const config = {
    multi_tenancy: { mode: 'static', static_tenant_id: TENANT },
    skills: seed.config.skills,
  };
  const app = feathers();
  app.set('config', config);
  const scoped = async (_context: HookContext, next: () => Promise<void>) =>
    runWithTenantDatabaseScope(db, TENANT, next);
  app.use(
    'kb/documents',
    new KnowledgeDocumentsService(db as never, app as never) as never,
    {
      methods: ['find', 'get', 'create', 'update', 'patch', 'remove', 'putDocument'],
    } as never
  );
  app.use('kb/namespaces', new KnowledgeNamespacesService(db as never, app as never) as never);
  app.use('kb/versions', new KnowledgeVersionsService(db as never) as never);
  for (const path of ['kb/documents', 'kb/namespaces', 'kb/versions']) {
    app.service(path).hooks({ around: { all: [scoped] } });
  }
  const register = createTenantScopedAuthenticatedRouteRegistrar({
    db: db as never,
    config: config as never,
    jwtSecret: 'secret',
    transaction: false,
  });
  register(
    app,
    '/skills/releases',
    createSkillReleasesRoute({ db: db as never }),
    { create: { role: ROLES.ADMIN, action: 'cut skill set releases' } },
    async (context: HookContext) => context
  );
  await app.setup();
  return { app, admin, ns };
}

function adminLogin(user: User) {
  return {
    user,
    provider: 'rest',
    authentication: { strategy: 'jwt', payload: {} },
  } as never;
}

describe('skills/releases through the registered route', () => {
  dbTest('cuts a single teammate release without a request transaction', async ({ db }) => {
    const { app, admin, ns } = await registeredRoute(db);
    const result = await app
      .service('skills/releases')
      .create({ teammate: 'fritz' }, adminLogin(admin));
    expect(result.results).toEqual([
      expect.objectContaining({
        namespace: ns.slug,
        path: 'skillsets/fritz.md',
        status: 'released',
        release: 1,
        authorized_as: 'admin',
      }),
    ]);
  });

  dbTest('cuts releases for every teammate without a request transaction', async ({ db }) => {
    const { app, admin } = await registeredRoute(db);
    const result = await app.service('skills/releases').create({ all: true }, adminLogin(admin));
    expect(result.counts).toEqual({ released: 2 });
    expect(result.failed).toBe(false);
    // Idempotent on a second run.
    expect(
      (await app.service('skills/releases').create({ all: true }, adminLogin(admin))).counts
    ).toEqual({ unchanged: 2 });
  });
});
