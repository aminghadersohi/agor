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
  createDatabase,
  type Database,
  initializeDatabase,
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
import { requestExecutor } from '../utils/spawn-executor.js';
import { createBranchSkillsRoute } from './branch-skills';
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

interface KnowledgeStub {
  namespaces: { get: ReturnType<typeof vi.fn> };
  documents: { find: ReturnType<typeof vi.fn> };
}

function fakeApp(knowledge?: KnowledgeStub): Application {
  return {
    get: (key: string) => (key === 'config' ? { execution: {} } : undefined),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'command-token') },
    service: (path: string) => {
      if (path === 'kb/namespaces' && knowledge) return knowledge.namespaces;
      if (path === 'kb/documents' && knowledge) return knowledge.documents;
      throw new Error(`Unexpected service ${path}`);
    },
  } as unknown as Application;
}

async function setup(knowledge?: KnowledgeStub) {
  const f = await frontDeskFixture(await migratedSqliteDatabase());
  const branch = await f.createTeammate({ name: 'larkspur', displayName: 'Larkspur' });
  const route = createBranchSkillsRoute({ db: f.db, allowSuperadmin: () => false });
  await route.setup(fakeApp(knowledge));
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
  return { f, branch, find };
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

  it('reads Knowledge skills and gaps through kb services with the caller as user', async () => {
    const knowledge: KnowledgeStub = {
      namespaces: {
        get: vi.fn(async () => ({ namespace_id: 'ns-1', slug: 'teammate-x', archived: false })),
      },
      documents: {
        find: vi.fn(async (params: { query: { path?: string } }) =>
          params.query.path === 'skills/_gaps.md'
            ? {
                total: 1,
                data: [
                  {
                    uri: 'agor://kb/document/gaps',
                    url: null,
                    content:
                      '---\ngaps:\n  - skill: release-evidence-pack\n    priority: P0\n---\n',
                  },
                ],
              }
            : {
                total: 2,
                data: [
                  {
                    document_id: 'doc-1',
                    path: 'skills/verifying-a-fix/SKILL.md',
                    uri: 'agor://kb/document/doc-1',
                    url: null,
                    status: 'published',
                    updated_at: new Date('2026-10-09T00:00:00.000Z'),
                    current_version: {
                      version_id: 'ver-1',
                      version_number: 3,
                      content_sha256: SHA_B,
                    },
                    content: '---\nname: verifying-a-fix\n---\n',
                  },
                  {
                    document_id: 'doc-2',
                    path: 'quarantine/x/SKILL.md',
                    uri: 'agor://kb/document/doc-2',
                    status: 'draft',
                    content: '---\nname: under-review\n---\n',
                  },
                ],
              }
        ),
      },
    };
    const { f, branch, find } = await setup(knowledge);
    const namespaceId = await provisionNamespace(f, branch.branch_id);
    executorAnswers(new Map([[branch.branch_id, scanOf()]]));

    const report = await find(f.owner);

    expect(knowledge.namespaces.get).toHaveBeenCalledWith(
      namespaceId,
      expect.objectContaining({ user: f.owner, provider: 'rest' })
    );
    expect(knowledge.documents.find).toHaveBeenCalledWith(
      expect.objectContaining({
        user: f.owner,
        query: expect.objectContaining({ namespace_id: namespaceId, kind: 'skill' }),
      })
    );
    expect(report.sources.knowledge).toEqual({ status: 'ok', namespace_slug: 'teammate-x' });
    expect(report.skills).toEqual([
      expect.objectContaining({
        name: 'verifying-a-fix',
        source: 'knowledge',
        version_label: 'v3',
        updated_at: '2026-10-09T00:00:00.000Z',
      }),
    ]);
    expect(report.gaps).toMatchObject({
      status: 'ok',
      items: [{ skill: 'release-evidence-pack', priority: 'P0', closed: false }],
    });
  });

  it('reports an unreadable Knowledge namespace instead of failing the view', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { code: 403 });
    const knowledge: KnowledgeStub = {
      namespaces: { get: vi.fn(async () => Promise.reject(forbidden)) },
      documents: { find: vi.fn() },
    };
    const { f, branch, find } = await setup(knowledge);
    await provisionNamespace(f, branch.branch_id);
    executorAnswers(new Map([[branch.branch_id, scanOf()]]));

    const report = await find(f.owner);

    expect(report.sources.knowledge).toEqual({
      status: 'unavailable',
      reason: "You can't read this teammate's Knowledge namespace.",
    });
    expect(report.gaps.status).toBe('missing');
    expect(knowledge.documents.find).not.toHaveBeenCalled();
  });
});
