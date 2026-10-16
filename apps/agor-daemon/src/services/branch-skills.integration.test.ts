/**
 * `branches/:id/skills` against a real migrated SQLite database, reusing the
 * front-desk fixture (owner, branch Viewer, outsider) so access is proven
 * against the real capability policy. Only the executor and Knowledge
 * services are stubbed; the route's own checks run for real.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BranchRepository,
  createDatabase,
  type Database,
  initializeDatabase,
  KnowledgeNamespaceRepository,
  runWithTenantContext,
  SessionRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  BRANCH_SKILLS_SCAN_COMMAND,
  type BranchID,
  type BranchSkillScan,
  type TeammateSkillsReport,
  type User,
  type UserID,
} from '@agor/core/types';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FrontDeskFixture, frontDeskFixture } from '../../test/front-desk-fixture';
import { KnowledgeSkillProvider } from '../skills/knowledge-skill-provider';
import { SkillSets } from '../skills/skillsets';
import { slugify } from '../teammate-skills/assign';
import { requestExecutor } from '../utils/spawn-executor.js';
import { createBranchSkillsRoute } from './branch-skills';
import { KnowledgeDocumentsService } from './knowledge-documents';
import { KnowledgeNamespacesService } from './knowledge-namespaces';
import { KnowledgeVersionsService } from './knowledge-versions';
import { ensureTeammateKnowledgeNamespace } from './teammate-knowledge';

vi.mock('../utils/spawn-executor.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  requestExecutor: vi.fn(),
}));

const tempDirs: string[] = [];

async function migratedSqliteDatabase(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), 'agor-branch-skills-route-'));
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

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function scanOf(...skills: Array<{ name: string; sha256: string }>): BranchSkillScan {
  return {
    skills: skills.map((skill) => ({
      ...skill,
      path: `skills/${skill.name}/SKILL.md`,
      mtime: '2026-10-01T00:00:00.000Z',
    })),
    skipped: [],
    truncated: false,
  };
}

/** Executor stub answering each branch with its own scan. */
function executorAnswers(scans: Map<string, BranchSkillScan>) {
  vi.mocked(requestExecutor).mockImplementation(async (payload) => {
    const branchId = (payload.params as { branchId: string }).branchId;
    const scan = scans.get(branchId);
    return scan
      ? { success: true, data: { scan } }
      : { success: false, error: { code: 'X', message: 'no worktree' } };
  });
}

interface StubNamespace {
  namespace_id: string;
  slug: string;
  display_name: string;
  archived?: boolean;
}

interface StubDoc {
  document_id: string;
  namespace_id: string;
  path: string;
  kind: string;
  content: string;
  status?: string;
  version_number?: number;
}

/**
 * In-memory `kb/namespaces` + `kb/documents` honoring the query fields the
 * route sends. Every call is a spy so tests can check the caller's params.
 */
function memoryKnowledge(
  namespaces: StubNamespace[] = [],
  docs: StubDoc[] = [],
  options: { getNamespace?: (id: string) => Promise<unknown> } = {}
) {
  const hydrate = (doc: StubDoc) => ({
    ...doc,
    uri: `agor://kb/document/${doc.document_id}`,
    url: null,
    status: doc.status ?? 'published',
    updated_at: new Date('2026-10-09T00:00:00.000Z'),
    current_version: {
      version_id: `${doc.document_id}-v`,
      version_number: doc.version_number ?? 1,
      content_sha256: SHA_B,
    },
  });
  return {
    namespaces: {
      get: vi.fn(
        options.getNamespace ??
          (async (id: string) => {
            const namespace = namespaces.find((ns) => ns.namespace_id === id);
            if (!namespace) throw Object.assign(new Error('Not found'), { code: 404 });
            return namespace;
          })
      ),
      find: vi.fn(async () => namespaces),
    },
    documents: {
      find: vi.fn(async (params: { query: Record<string, unknown> }) => {
        const q = params.query;
        const matches = docs
          .filter(
            (doc) =>
              (!q.namespace_id || doc.namespace_id === q.namespace_id) &&
              (!q.kind || doc.kind === q.kind) &&
              (!q.path || doc.path === q.path)
          )
          .sort((x, y) => x.path.localeCompare(y.path));
        const skip = Number(q.$skip ?? 0);
        const limit = Number(q.$limit ?? 100);
        return { total: matches.length, data: matches.slice(skip, skip + limit).map(hydrate) };
      }),
      get: vi.fn(async (id: string) => {
        const doc = docs.find((d) => d.document_id === id);
        if (!doc) throw Object.assign(new Error('Not found'), { code: 404 });
        return hydrate(doc);
      }),
    },
  };
}

type KnowledgeStub = ReturnType<typeof memoryKnowledge>;

function fakeApp(knowledge: { current: KnowledgeStub }): Application {
  return {
    get: (key: string) =>
      key === 'config'
        ? {
            execution: {},
            skills: {
              providers: [
                {
                  namespace: 'team-skills',
                  curator_branch_id: '01a00000-0000-7000-8000-000000000001',
                },
              ],
            },
          }
        : undefined,
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'command-token') },
    service: (path: string) => {
      if (path === 'kb/namespaces') return knowledge.current.namespaces;
      if (path === 'kb/documents') return knowledge.current.documents;
      const versions = (knowledge.current as { versions?: unknown }).versions;
      if (path === 'kb/versions' && versions) return versions;
      throw new Error(`Unexpected service ${path}`);
    },
  } as unknown as Application;
}

async function setup(knowledge: KnowledgeStub = memoryKnowledge(), displayName = 'Larkspur') {
  const f = await frontDeskFixture(await migratedSqliteDatabase());
  const branch = await f.createTeammate({ name: slugify(displayName), displayName });
  const route = createBranchSkillsRoute({ db: f.db, allowSuperadmin: () => false });
  // Swappable, so a test can seed Knowledge after the namespace ids exist.
  const holder = { current: knowledge };
  await route.setup(fakeApp(holder));
  const find = (
    user: User,
    branchId: BranchID = branch.branch_id,
    query?: Record<string, unknown>
  ) =>
    f.inTenant(
      () =>
        route.find({
          provider: 'rest',
          user,
          route: { id: branchId },
          tenant: { tenant_id: f.tenantId, source: 'explicit' as const },
          ...(query ? { query } : {}),
        } as never) as Promise<TeammateSkillsReport>
    );
  const useKnowledge = (stub: KnowledgeStub) => {
    holder.current = stub;
  };
  return { f, branch, find, useKnowledge };
}

/** Give the teammate a real primary Knowledge namespace; returns its id. */
async function provisionNamespace(f: FrontDeskFixture, branchId: BranchID): Promise<string> {
  const { namespace } = await f.inTenant((db) =>
    ensureTeammateKnowledgeNamespace(db, branchId, f.owner.user_id as UserID)
  );
  return namespace.namespace_id;
}

beforeEach(() => {
  vi.mocked(requestExecutor).mockReset();
});

describe('branches/:id/skills access', () => {
  it('answers not found to a caller without branch.view, and for a plain branch', async () => {
    const { f, find } = await setup();
    await expect(find(f.outsider)).rejects.toMatchObject({ code: 404 });

    const plain = await f.createTeammate({ name: 'plain', plainBranch: true });
    await expect(find(f.owner, plain.branch_id)).rejects.toMatchObject({ code: 404 });
    expect(requestExecutor).not.toHaveBeenCalled();
  });

  it('scans the worktree through the executor for a caller with file read access', async () => {
    const { f, branch, find } = await setup();
    executorAnswers(new Map([[branch.branch_id, scanOf({ name: 'connect-saas', sha256: SHA_A })]]));

    const report = await find(f.owner);

    expect(report.sources.in_repo).toEqual({ status: 'ok' });
    expect(report.skills).toEqual([
      expect.objectContaining({ name: 'connect-saas', source: 'in-repo', status: 'ok' }),
    ]);
    expect(requestExecutor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestExecutor).mock.calls[0][0]).toMatchObject({
      command: BRANCH_SKILLS_SCAN_COMMAND,
      sessionToken: 'command-token',
      params: { branchId: branch.branch_id, cwd: branch.path, principalBranchAccess: 'write' },
    });
  });

  it('shows a branch Viewer without file access the view but not the worktree', async () => {
    const { f, find } = await setup();
    executorAnswers(new Map());

    const report = await find(f.viewer, undefined, { include_drift: 'true' });

    expect(report.sources.in_repo).toEqual({
      status: 'unavailable',
      reason: 'You do not have file read access to this branch.',
    });
    expect(report.sources.drift.status).toBe('unavailable');
    expect(requestExecutor).not.toHaveBeenCalled();
  });
});

describe('branches/:id/skills tenant database scope', () => {
  // The route is registered with `transaction: false`: its around hook sets
  // tenant context but opens no database scope. Every repository read must
  // open its own against the armed daemon database proxy.
  it('serves the panel, drift included, from tenant context alone', async () => {
    const { f, branch } = await setup();
    const peer = await f.createTeammate({ name: 'freda', displayName: 'Freda' });
    executorAnswers(
      new Map([
        [branch.branch_id, scanOf({ name: 'connect-saas', sha256: SHA_A })],
        [peer.branch_id, scanOf({ name: 'connect-saas', sha256: SHA_B })],
      ])
    );
    const route = createBranchSkillsRoute({ db: f.db, allowSuperadmin: () => false });
    await route.setup(fakeApp({ current: memoryKnowledge() }));

    const report = (await runWithTenantContext(f.tenantId, () =>
      route.find({
        provider: 'rest',
        user: f.owner,
        route: { id: branch.branch_id },
        tenant: { tenant_id: f.tenantId, source: 'explicit' as const },
        query: { include_drift: 'true' },
      } as never)
    )) as TeammateSkillsReport;

    expect(report.sources.in_repo).toEqual({ status: 'ok' });
    expect(report.sources.harness.status).toBeDefined();
    expect(report.sources.drift).toMatchObject({ status: 'ok', branches_scanned: 1 });
  });

  it('still refuses a caller without branch.view under tenant context alone', async () => {
    const { f, branch } = await setup();
    const route = createBranchSkillsRoute({ db: f.db, allowSuperadmin: () => false });
    await route.setup(fakeApp({ current: memoryKnowledge() }));
    await expect(
      runWithTenantContext(f.tenantId, () =>
        route.find({
          provider: 'rest',
          user: f.outsider,
          route: { id: branch.branch_id },
          tenant: { tenant_id: f.tenantId, source: 'explicit' as const },
        } as never)
      )
    ).rejects.toMatchObject({ code: 404 });
  });
});

describe('branches/:id/skills sources', () => {
  it('lists harness skills from the most recent session that reported them', async () => {
    const { f, branch, find } = await setup();
    executorAnswers(new Map([[branch.branch_id, scanOf({ name: 'connect-saas', sha256: SHA_A })]]));
    const older = await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    await f.inTenant((db) =>
      new SessionRepository(db).update(older.session_id, {
        custom_context: { skills: ['connect-saas', 'pdf'] },
      })
    );

    const report = await find(f.owner);

    expect(report.sources.harness).toMatchObject({ status: 'ok', session_id: older.session_id });
    expect(report.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ['connect-saas', 'in-repo'],
      ['pdf', 'harness'],
    ]);
  });

  it('counts drift variants across other teammates only when asked', async () => {
    const { f, branch, find } = await setup();
    const peer = await f.createTeammate({ name: 'bjorn', displayName: 'Bjorn' });
    executorAnswers(
      new Map([
        [branch.branch_id, scanOf({ name: 'connect-saas', sha256: SHA_A })],
        [peer.branch_id, scanOf({ name: 'connect-saas', sha256: SHA_B })],
      ])
    );

    const plain = await find(f.owner);
    expect(plain.skills[0].drift).toBeUndefined();
    expect(plain.sources.drift.status).toBe('unavailable');

    const report = await find(f.owner, undefined, { include_drift: 'true' });
    expect(report.sources.drift).toEqual({ status: 'ok', branches_scanned: 1 });
    expect(report.skills[0]).toMatchObject({
      status: 'drift',
      drift: {
        variants: 2,
        shared_with: [{ branch_id: peer.branch_id, name: 'Bjorn', sha256: SHA_B }],
      },
    });
  });

  it('assigns Knowledge skills by teammate folder across readable namespaces', async () => {
    const TEAM = 'ns-team';
    const { f, branch, find, useKnowledge } = await setup(undefined, 'Professor Fritz');
    const frinkNs = await provisionNamespace(f, branch.branch_id);
    const freda = await f.createTeammate({ name: 'freda-lund', displayName: 'Freda Lund' });
    const namespaces = [
      { namespace_id: frinkNs, slug: 'teammate-fritz', display_name: 'Fritz' },
      { namespace_id: TEAM, slug: 'team-skills', display_name: 'Team skills' },
    ];
    const docs: StubDoc[] = [
      {
        document_id: 'd1',
        namespace_id: frinkNs,
        path: 'skills/fritz/review.md',
        kind: 'skill',
        content: '---\nname: review\n---\n',
      },
      {
        document_id: 'd2',
        namespace_id: frinkNs,
        path: 'skills/freda/triage.md',
        kind: 'skill',
        content: '---\nname: triage\n---\n',
      },
      {
        document_id: 'd3',
        namespace_id: frinkNs,
        path: 'skills/connect-saas/SKILL.md',
        kind: 'skill',
        content: 'Body',
      },
      {
        document_id: 'd4',
        namespace_id: frinkNs,
        path: 'skills/README.md',
        kind: 'doc',
        content: '# index',
      },
      {
        document_id: 'd5',
        namespace_id: TEAM,
        path: 'skills/professor/deep-dive.md',
        kind: 'skill',
        content: 'Body',
      },
      {
        document_id: 'd6',
        namespace_id: TEAM,
        path: 'skills/loose.md',
        kind: 'skill',
        content: 'Body',
      },
      {
        document_id: 'd7',
        namespace_id: TEAM,
        path: 'skills/fritz/draft.md',
        kind: 'skill',
        content: 'Body',
        status: 'draft',
      },
      {
        document_id: 'g1',
        namespace_id: TEAM,
        path: 'skills/fritz/_gaps.md',
        kind: 'doc',
        content: '---\ngaps:\n  - skill: release-evidence-pack\n    priority: P0\n---\n',
      },
    ];
    const stub = memoryKnowledge(namespaces, docs);
    useKnowledge(stub);
    executorAnswers(
      new Map([
        [branch.branch_id, scanOf()],
        [freda.branch_id, scanOf()],
      ])
    );

    const report = await find(f.owner);

    expect(report.skills.map((skill) => [skill.name, skill.namespace_slug])).toEqual([
      ['connect-saas', 'teammate-fritz'],
      ['deep-dive', 'team-skills'],
      ['review', 'teammate-fritz'],
    ]);
    expect(report.skills[1]).toMatchObject({ namespace_name: 'Team skills', version_label: 'v1' });
    expect(report.sources.knowledge).toEqual({ status: 'ok', namespace_slug: 'teammate-fritz' });
    expect(report.gaps).toMatchObject({
      status: 'ok',
      items: [{ skill: 'release-evidence-pack', priority: 'P0', closed: false }],
      documents: [{ path: 'skills/fritz/_gaps.md', namespace_slug: 'team-skills' }],
    });
    // The owner's namespace is listed twice (on its own and across namespaces); each doc is read once.
    expect(stub.documents.get.mock.calls.map(([id]) => id).sort()).toEqual(['d1', 'd3', 'd5']);
    for (const call of [...stub.documents.find.mock.calls, ...stub.documents.get.mock.calls]) {
      expect(call.at(-1)).toMatchObject({ user: f.owner, provider: 'rest' });
    }

    const frejaReport = await find(f.owner, freda.branch_id);
    expect(frejaReport.skills.map((skill) => skill.name)).toEqual(['triage']);
    expect(frejaReport.sources.knowledge.status).toBe('ok');
  });

  it('reports an unreadable Knowledge namespace when nothing else is found', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { code: 403 });
    const knowledge = memoryKnowledge([], [], {
      getNamespace: async () => Promise.reject(forbidden),
    });
    const { f, branch, find } = await setup(knowledge);
    await provisionNamespace(f, branch.branch_id);
    executorAnswers(new Map([[branch.branch_id, scanOf()]]));

    const report = await find(f.owner);

    expect(report.sources.knowledge).toEqual({
      status: 'unavailable',
      reason: "You can't read this teammate's Knowledge namespace.",
    });
    expect(report.gaps.status).toBe('missing');
    expect(knowledge.documents.get).not.toHaveBeenCalled();
  });
});

describe('branches/:id/skills skill set release', () => {
  it('shows the release, each pin, and what the last session was given', async () => {
    const { f, branch, find, useKnowledge } = await setup(undefined, 'Professor Fritz');
    executorAnswers(new Map());
    // Real Knowledge services over the fixture's tenant-scoped database.
    const real = {
      namespaces: new KnowledgeNamespacesService(f.db),
      documents: new KnowledgeDocumentsService(f.db),
      versions: new KnowledgeVersionsService(f.db),
    };
    useKnowledge(real as unknown as KnowledgeStub);
    const ownerParams = { user: f.owner, authenticated: true } as never;
    const ns = await f.inTenant((db) =>
      new KnowledgeNamespaceRepository(db).create({
        slug: 'team-skills',
        display_name: 'Team skills',
        kind: 'team',
        owner_user_id: f.owner.user_id as UserID,
        others_can: 'read',
        visibility_default: 'public',
      })
    );
    const put = (path: string, content: string) =>
      f.inTenant(() =>
        real.documents.putDocument(
          { namespace_slug: ns.slug, path, kind: 'skill', content_text: content } as never,
          ownerParams
        )
      );
    const skill = (name: string, version: string) =>
      `---\nname: ${name}\ndescription: Use for ${name}.\nmetadata:\n  version: "${version}"\n---\n# ${name}\n`;
    await put('skills/fritz/research-loop.md', skill('research-loop', '1.0.0'));
    await put('skills/_shared/standing-facts.md', skill('standing-facts', '1.0.0'));

    const provider = new KnowledgeSkillProvider(
      fakeApp({ current: real as unknown as KnowledgeStub }),
      ownerParams
    );
    const sets = new SkillSets(provider);
    const teammate = { name: 'Professor Fritz', keys: ['professor', 'fritz', 'professor-fritz'] };
    await f.inTenant(async () => {
      const [namespace] = await provider.providerNamespaces();
      await sets.commit(await sets.plan(namespace, teammate, { actor: f.owner.user_id }));
    });
    const record = await f.inTenant(async () =>
      sets.find((await provider.providerNamespaces())[0], teammate)
    );
    // A session was given r1, then research-loop moved on.
    const session = await f.createSession({
      branchId: branch.branch_id,
      updatedAt: new Date('2026-10-03T00:00:00.000Z'),
    });
    const pinnedLoop = record.manifest!.skills.find((s) => s.name === 'research-loop')!;
    await f.inTenant((db) =>
      new SessionRepository(db).update(session.session_id, {
        custom_context: {
          skills_receipt: {
            teammate: 'Professor Fritz',
            release: 1,
            namespace: ns.slug,
            skillset_path: record.path,
            manifest_document_id: record.document!.document_id,
            manifest_version_id: record.document!.current_version!.version_id,
            skills: [
              {
                name: 'research-loop',
                document_id: pinnedLoop.document_id,
                version_id: pinnedLoop.version_id,
                version_number: pinnedLoop.version_number,
                sha256: pinnedLoop.sha256,
              },
            ],
            delivered_at: '2026-10-03T00:00:00.000Z',
            harness: 'codex',
          },
        },
      })
    );
    await put('skills/fritz/research-loop.md', skill('research-loop', '1.1.0'));

    const report = await find(f.owner);
    expect(report.release).toMatchObject({
      status: 'ok',
      enabled: true,
      namespace_slug: 'team-skills',
      path: 'skillsets/fritz.md',
      release: 1,
      manifest_version_number: 1,
      counts: { current: 1, update_available: 1 },
      unreleased: 0,
      delivered: {
        session_id: session.session_id,
        release: 1,
        delivered_at: '2026-10-03T00:00:00.000Z',
        harness: 'codex',
        skills: 1,
      },
    });
    const byName = Object.fromEntries(report.skills.map((s) => [s.name, s]));
    // _shared skills in a provider namespace reach every teammate.
    expect(byName['standing-facts']).toMatchObject({
      pin: { release: 1, version_number: 1, status: 'current', latest_version_number: 1 },
    });
    expect(byName['standing-facts'].delivered).toBeUndefined();
    expect(byName['research-loop']).toMatchObject({
      version_number: 2,
      pin: { release: 1, version_number: 1, status: 'update_available', latest_version_number: 2 },
      delivered: true,
    });
  });

  it('reports no release and the opt-out flag', async () => {
    const { f, branch, find } = await setup(undefined, 'Professor Fritz');
    executorAnswers(new Map());
    expect((await find(f.owner)).release).toEqual({ status: 'none', enabled: true });
    await f.inTenant((db) =>
      new BranchRepository(db).update(branch.branch_id, {
        custom_context: {
          teammate: {
            kind: 'teammate',
            displayName: 'Professor Fritz',
            skills: { enabled: false },
          },
        },
      })
    );
    expect((await find(f.owner)).release).toEqual({ status: 'none', enabled: false });
  });
});
