/**
 * Artifact interaction bindings: save-time validation on every write path,
 * and the viewer-filtered `interaction_config` in the payload. Execute-time
 * behaviour of the binding routes is covered against PostgreSQL RLS in
 * register-hooks.artifact-bindings.postgres.test.ts.
 */
import { generateId } from '@agor/core';
import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  type Database,
  RepoRepository,
  ScheduleRepository,
  SessionRepository,
  shortId,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  Artifact,
  ArtifactInteractionConfig,
  BoardID,
  Branch,
  Schedule,
  Session,
  UUID,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ArtifactsService, parseArtifactInteractionConfig } from './artifacts';

const OWNER = 'user-owner';
const OUTSIDER = 'user-outsider';

function makeFakeApp(): Application {
  return {
    service: () => ({ emit: () => {} }),
    get: (key: string) => (key === 'config' ? {} : undefined),
  } as unknown as Application;
}

async function seedUser(db: Database, userId: string): Promise<void> {
  const repo = new UsersRepository(db);
  if ((await repo.findAll()).some((user) => user.user_id === userId)) return;
  await repo.create({ user_id: userId as never, email: `${userId}@test.local`, role: 'member' });
}

interface Fixture {
  boardId: BoardID;
  branch: Branch;
  otherBranch: Branch;
  schedule: Schedule;
  foreignSchedule: Schedule;
  session: Session;
  artifact: Artifact;
}

async function seed(db: Database): Promise<Fixture> {
  await seedUser(db, OWNER);
  await seedUser(db, OUTSIDER);
  const board = await new BoardRepository(db).create({
    board_id: generateId() as BoardID,
    name: 'Bindings board',
    created_by: OWNER,
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `bindings-${generateId()}`,
    name: 'Bindings repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branches = new BranchRepository(db);
  const makeBranch = (name: string) =>
    branches.create({
      branch_id: generateId() as never,
      repo_id: repo.repo_id,
      board_id: board.board_id,
      name,
      ref: `refs/heads/${name}`,
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: `/tmp/${generateId()}`,
      created_by: OWNER as UUID,
    });
  const branch = await makeBranch('bound');
  const otherBranch = await makeBranch('elsewhere');
  const schedules = new ScheduleRepository(db);
  const makeSchedule = (branchId: string, name: string) =>
    schedules.create({
      branch_id: branchId as never,
      created_by: OWNER as never,
      name,
      cron_expression: '0 * * * *',
      timezone_mode: 'utc',
      prompt: 'Run',
      enabled: true,
      retention: 0,
      allow_concurrent_runs: false,
      agentic_tool_config: { agentic_tool: 'claude-code' },
    });
  const schedule = await makeSchedule(branch.branch_id, 'Nightly');
  const foreignSchedule = await makeSchedule(otherBranch.branch_id, 'Elsewhere');
  const session = await new SessionRepository(db).create({
    session_id: generateId() as never,
    branch_id: branch.branch_id,
    created_by: OWNER as UUID,
    tasks: [],
    genealogy: { children: [] },
  });
  const artifact = await new ArtifactRepository(db).create({
    artifact_id: generateId(),
    board_id: board.board_id,
    branch_id: branch.branch_id,
    name: 'Console',
    template: 'static',
    files: { '/index.html': '<h1>console</h1>' },
    content_hash: 'hash-seed',
    public: true,
    created_by: OWNER,
  });
  return {
    boardId: board.board_id,
    branch,
    otherBranch,
    schedule,
    foreignSchedule,
    session,
    artifact,
  };
}

function bindings(f: Fixture, scheduleId: string = f.schedule.schedule_id) {
  return {
    actions: [
      { id: 'run', label: 'Run once', effect: { kind: 'schedule_run', schedule_id: scheduleId } },
      {
        id: 'disarm',
        label: 'Disarm',
        confirm: true,
        effect: { kind: 'schedule_set_enabled', schedule_id: scheduleId, enabled: false },
      },
    ],
    data: [
      {
        id: 'nightly',
        label: 'Nightly',
        source: { kind: 'schedule_status', schedule_id: scheduleId },
      },
    ],
    chats: [{ id: 'triage', label: 'Triage', session_id: f.session.session_id }],
  } as ArtifactInteractionConfig;
}

async function persisted(db: Database, artifactId: string) {
  return (await new ArtifactRepository(db).findById(artifactId))?.agor_runtime;
}

function executorParams(branchId: string) {
  return {
    provider: 'socketio',
    user: { user_id: OWNER, email: `${OWNER}@test.local`, role: 'member' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-command',
        session_id: 'artifact.publish',
        branch_id: branchId,
      },
    },
  } as never;
}

describe('parseArtifactInteractionConfig', () => {
  const problemsOf = (value: unknown): string => {
    try {
      parseArtifactInteractionConfig(value);
    } catch (error) {
      expect((error as Error).name).toBe('BadRequest');
      return (error as Error).message;
    }
    throw new Error('expected the config to be rejected');
  };
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: 'run',
    label: 'Run',
    effect: { kind: 'schedule_run', schedule_id: 'sched-1' },
    ...overrides,
  });

  it('accepts a well-formed config and treats empty as no bindings', () => {
    expect(parseArtifactInteractionConfig({ actions: [run()] })).toEqual({ actions: [run()] });
    expect(parseArtifactInteractionConfig({})).toBeUndefined();
    expect(parseArtifactInteractionConfig(null)).toBeUndefined();
  });

  it.each([
    [{ actions: [run({ id: 'has space' })] }, 'interactions.actions[0].id must be 1-64'],
    [{ actions: [run({ id: 'x'.repeat(65) })] }, '.id must be 1-64'],
    [{ actions: [run({ label: '  ' })] }, 'actions[0] ("run").label is required'],
    [{ actions: [run(), run()] }, 'actions[1] ("run").id duplicates another actions binding id'],
    [
      { actions: [run({ effect: { kind: 'schedule_delete', schedule_id: 's' } })] },
      'effect.kind must be one of: schedule_run, schedule_set_enabled',
    ],
    [
      { actions: [run({ effect: { kind: 'schedule_set_enabled', schedule_id: 's' } })] },
      'effect.enabled must be true or false',
    ],
    [{ actions: [run({ effect: { kind: 'schedule_run' } })] }, 'effect.schedule_id is required'],
    [{ actions: [run({ args: { prompt: 'x' } })] }, 'actions[0] ("run").args is not a recognized'],
    [
      { actions: [run({ effect: { kind: 'schedule_run', schedule_id: 's', prompt: 'x' } })] },
      'effect.prompt is not a recognized field',
    ],
    [{ actions: [run({ confirm: 'yes' })] }, 'confirm must be true or false'],
    [
      { data: [{ id: 'd', label: 'D', source: { kind: 'api_get' } }] },
      'source.kind must be one of',
    ],
    [{ chats: [{ id: 'c', label: 'C' }] }, 'chats[0] ("c").session_id is required'],
    [{ actions: {} }, 'interactions.actions must be an array'],
    [{ bindings: [] }, 'interactions.bindings is not a binding family'],
    [{ actions: Array.from({ length: 13 }, (_, i) => run({ id: `a${i}` })) }, 'at most 12'],
    [[], 'interactions must be an object'],
  ])('rejects %j with a reason', (value, reason) => {
    expect(problemsOf(value)).toContain(reason);
  });
});

describe('ArtifactsService interaction bindings: save-time validation', () => {
  dbTest('persists canonical bindings and resolves short ids', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    const short = shortId(f.schedule.schedule_id);

    await service.updateMetadata(
      f.artifact.artifact_id,
      { interaction_config: bindings(f, short) },
      OWNER
    );

    expect((await persisted(db, f.artifact.artifact_id))?.interactions).toEqual(bindings(f));
  });

  dbTest(
    'rejects a schedule on another branch or an unknown session, persisting nothing',
    async ({ db }) => {
      const f = await seed(db);
      const service = new ArtifactsService(db, makeFakeApp());
      const foreign = bindings(f, f.foreignSchedule.schedule_id);

      await expect(
        service.updateMetadata(f.artifact.artifact_id, { interaction_config: foreign }, OWNER)
      ).rejects.toThrow(
        `interactions.actions[0] ("run").effect.schedule_id "${f.foreignSchedule.schedule_id}" is not a schedule on this artifact's branch`
      );

      const unknownSession = generateId();
      await expect(
        service.updateMetadata(
          f.artifact.artifact_id,
          {
            interaction_config: {
              chats: [{ id: 'triage', label: 'Triage', session_id: unknownSession as never }],
            },
          },
          OWNER
        )
      ).rejects.toMatchObject({
        name: 'BadRequest',
        errors: [
          {
            path: 'chats[0] ("triage").session_id',
            message: `"${unknownSession}" is not a session on this artifact's branch`,
          },
        ],
      });

      expect((await persisted(db, f.artifact.artifact_id))?.interactions).toBeUndefined();
    }
  );

  dbTest('reports an ambiguous short id instead of guessing', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    await expect(
      service.updateMetadata(
        f.artifact.artifact_id,
        {
          interaction_config: {
            actions: [
              {
                id: 'run',
                label: 'Run',
                effect: { kind: 'schedule_run', schedule_id: '0' as never },
              },
            ],
          },
        },
        OWNER
      )
    ).rejects.toThrow('"0" matches more than one schedule; use the full id');
  });

  dbTest('keeps bindings across agor_runtime flag changes and clears on null', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    await service.updateMetadata(
      f.artifact.artifact_id,
      { interaction_config: bindings(f) },
      OWNER
    );

    await service.updateMetadata(
      f.artifact.artifact_id,
      { agor_runtime: { enabled: false } },
      OWNER
    );
    expect(await persisted(db, f.artifact.artifact_id)).toEqual({
      enabled: false,
      interactions: bindings(f),
    });

    await service.updateMetadata(f.artifact.artifact_id, { interaction_config: null }, OWNER);
    expect(await persisted(db, f.artifact.artifact_id)).toEqual({ enabled: false });
  });

  dbTest('validates bindings sent through a plain REST patch', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    const params = { provider: 'rest', user: { user_id: OWNER, role: 'member' } } as never;

    await expect(
      service.patch(
        f.artifact.artifact_id,
        { agor_runtime: { interactions: bindings(f, f.foreignSchedule.schedule_id) } },
        params
      )
    ).rejects.toThrow('is not a schedule on this artifact');
    await expect(
      service.patch(
        f.artifact.artifact_id,
        { agor_runtime: { interactions: { actions: [{ id: 'run' }] } as never } },
        params
      )
    ).rejects.toThrow('actions[0] ("run").label is required');
    expect((await persisted(db, f.artifact.artifact_id))?.interactions).toBeUndefined();

    await service.patch(
      f.artifact.artifact_id,
      { agor_runtime: { interactions: bindings(f) } },
      params
    );
    expect((await persisted(db, f.artifact.artifact_id))?.interactions).toEqual(bindings(f));
  });

  dbTest('validates bindings on executor publish, from data or sidecar', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    const publish = (extra: Record<string, unknown>) =>
      service.publishFromExecutor(
        {
          files: { '/index.html': '<h1>published</h1>' },
          branch_id: f.branch.branch_id,
          board_id: f.boardId,
          name: 'Published console',
          template: 'static',
          ...extra,
        },
        executorParams(f.branch.branch_id)
      );

    const created = await publish({ interaction_config: bindings(f) });
    expect(created.agor_runtime?.interactions).toEqual(bindings(f));

    // An author-edited sidecar is untrusted input like any other.
    await expect(
      publish({
        artifact_id: created.artifact_id,
        sidecar: {
          agor_runtime: { interactions: bindings(f, f.foreignSchedule.schedule_id) },
        },
      })
    ).rejects.toThrow('is not a schedule on this artifact');

    // A routine republish keeps the declared bindings untouched.
    const republished = await publish({ artifact_id: created.artifact_id });
    expect(republished.agor_runtime?.interactions).toEqual(bindings(f));

    // Moving the artifact to a branch its bindings are not on is refused.
    await expect(
      service.publishFromExecutor(
        {
          files: { '/index.html': '<h1>moved</h1>' },
          branch_id: f.otherBranch.branch_id,
          artifact_id: created.artifact_id,
        },
        executorParams(f.otherBranch.branch_id)
      )
    ).rejects.toThrow('is not a schedule on this artifact');
  });
});

describe('ArtifactsService interaction bindings: payload', () => {
  dbTest('carries bindings only for viewers who can view the source branch', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    await service.updateMetadata(
      f.artifact.artifact_id,
      { interaction_config: bindings(f) },
      OWNER
    );

    const ownerPayload = await service.getPayload(f.artifact.artifact_id, OWNER as never, 'member');
    expect(ownerPayload.interaction_config).toEqual(bindings(f));

    // Public artifact, but no grant on its branch: renders without controls.
    const outsiderPayload = await service.getPayload(
      f.artifact.artifact_id,
      OUTSIDER as never,
      'member'
    );
    expect(outsiderPayload.interaction_config).toBeUndefined();
    expect((await service.getPayload(f.artifact.artifact_id)).interaction_config).toBeUndefined();
  });

  dbTest('drops a chat whose session has left the branch', async ({ db }) => {
    const f = await seed(db);
    const service = new ArtifactsService(db, makeFakeApp());
    await service.updateMetadata(
      f.artifact.artifact_id,
      { interaction_config: bindings(f) },
      OWNER
    );
    await new SessionRepository(db).update(f.session.session_id, {
      branch_id: f.otherBranch.branch_id,
    });

    const payload = await service.getPayload(f.artifact.artifact_id, OWNER as never, 'member');
    expect(payload.interaction_config?.chats).toBeUndefined();
    expect(payload.interaction_config?.actions).toHaveLength(2);
  });
});
