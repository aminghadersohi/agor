import {
  BranchRepository,
  executeRaw,
  generateId,
  RepoRepository,
  SessionReminderRepository,
  SessionRepository,
  sql,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, SessionReminder, TenantID, UserID, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../packages/core/src/db/client';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { sessionReminderTaskId } from '../utils/durable-task-id';
import {
  type GitHubPullRequestObservation,
  GitHubPullRequestReadError,
  readGitHubPullRequest,
} from './github-pull-request-state';
import {
  SESSION_REMINDER_MAX_ATTEMPTS,
  SessionReminderWorker,
  sessionReminderRetryDelayMs,
} from './session-reminder-worker';

async function seed(
  db: Database,
  archived = false,
  wake?: { state: 'merged' | 'closed'; dueInMs: number }
) {
  const user = await new UsersRepository(db).create({
    user_id: generateId(),
    email: `reminder-${generateId()}@example.test`,
    name: 'River Example',
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `reminder-${generateId()}`,
    name: 'Fictional reminder repo',
    repo_type: 'remote',
    remote_url: 'https://example.test/reminders.git',
    local_path: '/tmp/fictional-reminders',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'reminder-test',
    ref: 'refs/heads/reminder-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/fictional-reminders/reminder-test',
    created_by: user.user_id as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'codex',
    created_by: user.user_id as UUID,
    status: SessionStatus.IDLE,
    archived,
  });
  const reminder = await new SessionReminderRepository(db).create({
    session_id: session.session_id,
    text: 'Review the fictional decision.',
    due_at: new Date(Date.now() + (wake?.dueInMs ?? -1_000)).toISOString(),
    display_timezone: 'UTC',
    created_by: user.user_id as UserID,
    ...(wake
      ? {
          wake_when: {
            kind: 'github_pr' as const,
            repo: 'acme/widgets',
            number: 284,
            state: wake.state,
          },
          check_every_minutes: 10,
        }
      : {}),
  });
  return { user, session, reminder };
}

function promptText(reminder: SessionReminder): string {
  return `<session_reminder id="${reminder.reminder_id}" one_shot="true" due_at="${reminder.due_at}">
This is a durable one-shot reminder for this same Agor Session. It does not reschedule itself. Creating another reminder requires an explicit agor_session_reminders_create tool call.

${reminder.text}
</session_reminder>`;
}

function appFixture(db: Database) {
  const create = vi.fn(async (data: Record<string, unknown>, params: Record<string, unknown>) => {
    const taskId = data.idempotencyTaskId as UUID;
    const existing = await new TaskRepository(db).findById(taskId);
    if (existing) return existing;
    const route = params.route as { id: string };
    const user = params.user as { user_id: UserID };
    return new TaskRepository(db).createPending({
      task_id: taskId,
      session_id: route.id as UUID,
      full_prompt: data.prompt as string,
      created_by: user.user_id,
      metadata: data.metadata as never,
      status: TaskStatus.QUEUED,
    });
  });
  const emit = vi.fn();
  const app = {
    service(path: string) {
      if (path === '/sessions/:id/prompt') return { create };
      if (path === 'session-reminders') return { emit };
      throw new Error(`Unexpected service ${path}`);
    },
  } as unknown as Application;
  return { app, create, emit };
}

describe('SessionReminderWorker', () => {
  dbTest('two workers claim and enqueue one stable Task', async ({ db }) => {
    const { reminder } = await seed(db);
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    const discover = vi.fn(async () => [
      { reminder_id: reminder.reminder_id, tenant_id: tenantId },
    ]);
    const worker = () => new SessionReminderWorker(db, fixture.app, { tenantId, discover });
    await Promise.all([worker().checkOnce(), worker().checkOnce()]);

    expect(fixture.create).toHaveBeenCalledTimes(1);
    await expect(
      new SessionReminderRepository(db).findPage({
        session_id: reminder.session_id,
        limit: 10,
        skip: 0,
      })
    ).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          status: 'queued',
          task_id: sessionReminderTaskId(reminder.reminder_id),
        }),
      ],
    });
  });

  dbTest('blocks an archived Session instead of restoring or prompting it', async ({ db }) => {
    const { reminder } = await seed(db, true);
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    const worker = new SessionReminderWorker(db, fixture.app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    });
    await worker.checkOnce();
    expect(fixture.create).not.toHaveBeenCalled();
    const page = await new SessionReminderRepository(db).findPage({
      session_id: reminder.session_id,
      limit: 10,
      skip: 0,
    });
    expect(page.data[0]).toMatchObject({ status: 'blocked', failure_code: 'session_archived' });
  });

  dbTest(
    'reconciles a Task admitted before daemon shutdown without a duplicate prompt',
    async ({ db }) => {
      const { reminder, user } = await seed(db);
      const taskId = sessionReminderTaskId(reminder.reminder_id);
      await new TaskRepository(db).createPending({
        task_id: taskId,
        session_id: reminder.session_id,
        full_prompt: promptText(reminder),
        created_by: user.user_id as UserID,
        metadata: {
          system_authored: true,
          session_reminder: {
            reminder_id: reminder.reminder_id,
            due_at: reminder.due_at,
            created_at: reminder.created_at,
            one_shot: true,
          },
        },
        status: TaskStatus.QUEUED,
      });
      const fixture = appFixture(db);
      const tenantId = 'default' as TenantID;
      await new SessionReminderWorker(db, fixture.app, {
        tenantId,
        discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
      }).checkOnce();
      expect(fixture.create).not.toHaveBeenCalled();
      const page = await new SessionReminderRepository(db).findPage({
        session_id: reminder.session_id,
        limit: 10,
        skip: 0,
      });
      expect(page.data[0]).toMatchObject({ status: 'queued', task_id: taskId });
    }
  );

  dbTest('does not echo reminder or downstream error text in logs', async ({ db }) => {
    const { reminder } = await seed(db);
    const create = vi.fn(async () => {
      throw new Error('fictional-secret-from-downstream');
    });
    const app = {
      service(path: string) {
        if (path === '/sessions/:id/prompt') return { create };
        if (path === 'session-reminders') return { emit: vi.fn() };
        throw new Error(`Unexpected service ${path}`);
      },
    } as unknown as Application;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tenantId = 'default' as TenantID;

    await new SessionReminderWorker(db, app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    }).checkOnce();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('error_type="Error"'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('fictional-secret');
    expect(warn.mock.calls.flat().join(' ')).not.toContain(reminder.text);
    warn.mockRestore();
  });

  dbTest('blocks a stable Task ID with mismatched immutable provenance', async ({ db }) => {
    const { reminder, user } = await seed(db);
    await new TaskRepository(db).createPending({
      task_id: sessionReminderTaskId(reminder.reminder_id),
      session_id: reminder.session_id,
      full_prompt: 'Unrelated internal task',
      created_by: user.user_id as UserID,
      status: TaskStatus.QUEUED,
    });
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    await new SessionReminderWorker(db, fixture.app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    }).checkOnce();

    expect(fixture.create).not.toHaveBeenCalled();
    const page = await new SessionReminderRepository(db).findPage({
      session_id: reminder.session_id,
      limit: 10,
      skip: 0,
    });
    expect(page.data[0]).toMatchObject({ status: 'blocked', failure_code: 'dispatch_failed' });
  });

  dbTest(
    'gives up on a reminder whose delivery always fails instead of retrying forever',
    async ({ db }) => {
      const { reminder } = await seed(db);
      const create = vi.fn(async () => {
        throw new Error('prompt admission is down');
      });
      const app = {
        service(path: string) {
          if (path === '/sessions/:id/prompt') return { create };
          if (path === 'session-reminders') return { emit: vi.fn() };
          throw new Error(`Unexpected service ${path}`);
        },
      } as unknown as Application;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const tenantId = 'default' as TenantID;
      const repo = new SessionReminderRepository(db);
      const page = () =>
        repo
          .findPage({ session_id: reminder.session_id, limit: 10, skip: 0 })
          .then((p) => p.data[0]);

      // Virtual clock: each pass runs just after the previous retry deadline.
      let clock = Date.now();
      const worker = new SessionReminderWorker(db, app, {
        tenantId,
        now: () => new Date(clock),
        discover: async (now) => {
          const current = await page();
          const due =
            (current.status === 'scheduled' && new Date(current.due_at) <= now) ||
            (current.status === 'claimed' &&
              current.claim_expires_at !== undefined &&
              new Date(current.claim_expires_at) <= now);
          return due ? [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }] : [];
        },
      });

      // Before the fix this loop retried on every pass, forever.
      const deferralGaps: number[] = [];
      for (let pass = 0; pass < SESSION_REMINDER_MAX_ATTEMPTS * 4; pass++) {
        await worker.checkOnce();
        const current = await page();
        if (current.status === 'claimed' && current.claim_expires_at) {
          const next = new Date(current.claim_expires_at).getTime();
          deferralGaps.push(next - clock);
          clock = next + 1;
        } else {
          clock += 24 * 60 * 60 * 1_000;
        }
      }

      expect(create).toHaveBeenCalledTimes(SESSION_REMINDER_MAX_ATTEMPTS);
      expect(await page()).toMatchObject({
        status: 'blocked',
        failure_code: 'retries_exhausted',
        attempt_count: SESSION_REMINDER_MAX_ATTEMPTS,
      });
      // Exponential backoff between the attempts that were retried.
      expect(deferralGaps).toEqual(
        Array.from({ length: SESSION_REMINDER_MAX_ATTEMPTS - 1 }, (_, i) =>
          sessionReminderRetryDelayMs(i + 1)
        )
      );
      expect(deferralGaps[1]).toBeGreaterThan(deferralGaps[0]);
      expect(warn.mock.calls.flat().join(' ')).toContain('dispatch_exhausted');
      warn.mockRestore();
    }
  );

  dbTest('blocks a reminder already past the attempt cap without dispatching', async ({ db }) => {
    const { reminder } = await seed(db);
    // A reminder stuck retrying on an older build (27k attempts, claim lease expired).
    await executeRaw(
      db,
      sql`UPDATE session_reminders SET status = 'claimed', attempt_count = 27310, claim_token = 'stale', claim_expires_at = ${new Date(Date.now() - 1_000).getTime()} WHERE reminder_id = ${reminder.reminder_id}`
    );
    const fixture = appFixture(db);
    const tenantId = 'default' as TenantID;
    await new SessionReminderWorker(db, fixture.app, {
      tenantId,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    }).checkOnce();

    expect(fixture.create).not.toHaveBeenCalled();
    const page = await new SessionReminderRepository(db).findPage({
      session_id: reminder.session_id,
      limit: 10,
      skip: 0,
    });
    expect(page.data[0]).toMatchObject({ status: 'blocked', failure_code: 'retries_exhausted' });
  });
});

const HOUR = 60 * 60_000;
const MERGED: GitHubPullRequestObservation = {
  state: 'closed',
  merged: true,
  merged_at: '2026-11-03T20:36:00.000Z',
  closed_at: '2026-11-03T20:36:00.000Z',
};
const OPEN: GitHubPullRequestObservation = { state: 'open', merged: false };

describe('SessionReminderWorker wake conditions', () => {
  const tenantId = 'default' as TenantID;
  const reload = async (db: Database, reminder: SessionReminder) =>
    (
      await new SessionReminderRepository(db).findPage({
        session_id: reminder.session_id,
        limit: 10,
        skip: 0,
      })
    ).data[0]!;
  const conditionalWorker = (
    db: Database,
    app: Application,
    reminder: SessionReminder,
    readPullRequest: () => Promise<GitHubPullRequestObservation>,
    clock: number
  ) =>
    new SessionReminderWorker(db, app, {
      tenantId,
      now: () => new Date(clock),
      readPullRequest,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    });

  dbTest('queues the prompt with the observed outcome once the PR merges', async ({ db }) => {
    const { reminder } = await seed(db, false, { state: 'merged', dueInMs: 24 * HOUR });
    const fixture = appFixture(db);
    const read = vi.fn(async () => MERGED);
    const clock = Date.parse(reminder.next_check_at!) + 1_000;
    await conditionalWorker(db, fixture.app, reminder, read, clock).checkOnce();

    expect(read).toHaveBeenCalledTimes(1);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    const prompt = (fixture.create.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toBe(
      `${promptText(reminder).replace(
        '\n</session_reminder>',
        '\n\nCondition met: acme/widgets#284 merged at 2026-11-03T20:36:00.000Z.\n</session_reminder>'
      )}`
    );
    expect(await reload(db, reminder)).toMatchObject({
      status: 'queued',
      task_id: sessionReminderTaskId(reminder.reminder_id),
      wake_outcome: 'Condition met: acme/widgets#284 merged at 2026-11-03T20:36:00.000Z.',
    });
  });

  dbTest("treats a merge as satisfying 'closed'", async ({ db }) => {
    const { reminder } = await seed(db, false, { state: 'closed', dueInMs: 24 * HOUR });
    const fixture = appFixture(db);
    const clock = Date.parse(reminder.next_check_at!) + 1_000;
    await conditionalWorker(db, fixture.app, reminder, async () => MERGED, clock).checkOnce();
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(await reload(db, reminder)).toMatchObject({ status: 'queued' });
  });

  dbTest('reschedules the next check while unmet before the deadline', async ({ db }) => {
    const { reminder } = await seed(db, false, { state: 'merged', dueInMs: 24 * HOUR });
    const fixture = appFixture(db);
    const clock = Date.parse(reminder.next_check_at!) + 1_000;
    await conditionalWorker(db, fixture.app, reminder, async () => OPEN, clock).checkOnce();

    expect(fixture.create).not.toHaveBeenCalled();
    const current = await reload(db, reminder);
    expect(current).toMatchObject({
      status: 'scheduled',
      attempt_count: 0,
      next_check_at: new Date(clock + 10 * 60_000).toISOString(),
    });
    expect(current.wake_outcome).toBeUndefined();
    // Still editable between checks.
    expect(current.revision).toBeGreaterThan(reminder.revision);
  });

  dbTest('fires at the deadline anyway and says the condition was not met', async ({ db }) => {
    const { reminder } = await seed(db, false, { state: 'merged', dueInMs: 2 * 60_000 });
    const fixture = appFixture(db);
    const clock = Date.parse(reminder.due_at) + 1_000;
    await conditionalWorker(db, fixture.app, reminder, async () => OPEN, clock).checkOnce();

    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect((fixture.create.mock.calls[0]![0] as { prompt: string }).prompt).toContain(
      'Condition not met by deadline: acme/widgets#284 is still open.\n</session_reminder>'
    );
    expect(await reload(db, reminder)).toMatchObject({ status: 'queued' });
  });

  dbTest(
    'counts a GitHub read failure as not met, logs no secrets, and never crashes',
    async ({ db }) => {
      const { reminder } = await seed(db, false, { state: 'merged', dueInMs: 24 * HOUR });
      const fixture = appFixture(db);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failing = async () => {
        throw new GitHubPullRequestReadError('http_401');
      };
      const clock = Date.parse(reminder.next_check_at!) + 1_000;
      await expect(
        conditionalWorker(db, fixture.app, reminder, failing, clock).checkOnce()
      ).resolves.toBe(1);
      expect(fixture.create).not.toHaveBeenCalled();
      expect(await reload(db, reminder)).toMatchObject({
        status: 'scheduled',
        next_check_at: new Date(clock + 10 * 60_000).toISOString(),
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('wake_check_failed'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code="http_401"'));
      expect(warn.mock.calls.flat().join(' ')).not.toContain(reminder.text);

      // At the deadline a failed read still delivers, stating the unknown state.
      const deadline = Date.parse(reminder.due_at) + 1_000;
      await conditionalWorker(db, fixture.app, reminder, failing, deadline).checkOnce();
      expect((fixture.create.mock.calls[0]![0] as { prompt: string }).prompt).toContain(
        'Condition not met by deadline: acme/widgets#284 is in an unknown state (the GitHub read failed).'
      );
      warn.mockRestore();
    }
  );

  dbTest(
    'a recovered claim reuses its recorded outcome without reading GitHub again',
    async ({ db }) => {
      const { reminder } = await seed(db, false, { state: 'merged', dueInMs: 24 * HOUR });
      const outcome = 'Condition met: acme/widgets#284 merged at 2026-11-03T20:36:00.000Z.';
      // A daemon recorded the outcome, then died before dispatch.
      await executeRaw(
        db,
        sql`UPDATE session_reminders SET status = 'claimed', attempt_count = 1, claim_token = 'dead', next_check_at = NULL, wake_outcome = ${outcome}, claim_expires_at = ${Date.now() - 1_000} WHERE reminder_id = ${reminder.reminder_id}`
      );
      const fixture = appFixture(db);
      const read = vi.fn(async () => OPEN);
      await conditionalWorker(db, fixture.app, reminder, read, Date.now()).checkOnce();
      expect(read).not.toHaveBeenCalled();
      expect((fixture.create.mock.calls[0]![0] as { prompt: string }).prompt).toContain(
        `${outcome}\n</session_reminder>`
      );
      expect(await reload(db, reminder)).toMatchObject({ status: 'queued' });
    }
  );

  dbTest('time-only reminders never read GitHub and render unchanged', async ({ db }) => {
    const { reminder } = await seed(db);
    const fixture = appFixture(db);
    const read = vi.fn(async () => MERGED);
    await new SessionReminderWorker(db, fixture.app, {
      tenantId,
      readPullRequest: read,
      discover: async () => [{ reminder_id: reminder.reminder_id, tenant_id: tenantId }],
    }).checkOnce();
    expect(read).not.toHaveBeenCalled();
    expect((fixture.create.mock.calls[0]![0] as { prompt: string }).prompt).toBe(
      promptText(reminder)
    );
  });
});

describe('readGitHubPullRequest', () => {
  it('reads state with the bearer token and classifies failures without bodies', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        state: 'closed',
        merged: true,
        merged_at: '2026-11-03T20:36:00Z',
        title: 'x',
      })
    );
    await expect(
      readGitHubPullRequest({ repo: 'acme/widgets', number: 284 }, 'ghp_fictional', fetchImpl)
    ).resolves.toEqual({
      state: 'closed',
      merged: true,
      merged_at: '2026-11-03T20:36:00.000Z',
      closed_at: undefined,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/widgets/pulls/284');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_fictional');

    const denied = vi.fn(async () => new Response('secret body', { status: 404 }));
    const error = await readGitHubPullRequest(
      { repo: 'acme/widgets', number: 284 },
      undefined,
      denied
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubPullRequestReadError);
    expect((error as GitHubPullRequestReadError).code).toBe('http_404');
    expect(String(error)).not.toContain('secret body');
    const [, anonymous] = denied.mock.calls[0] as unknown as [string, RequestInit];
    expect(anonymous.headers).not.toHaveProperty('Authorization');
  });
});
