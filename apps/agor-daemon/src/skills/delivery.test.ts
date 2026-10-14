import type { Database } from '@agor/core/db';
import { eq, kbDocumentVersions, update } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  KnowledgeNamespace,
  SessionID,
  SessionSkillsReceipt,
  User,
} from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  deliverSkillsSafely,
  renderSkillsIndex,
  resolveSkillsDelivery,
  SKILLS_INDEX_MAX_CHARS,
  SKILLS_INDEX_MAX_ENTRIES,
} from './delivery';
import { KnowledgeSkillProvider } from './knowledge-skill-provider';
import { SkillSets } from './skillsets';

afterEach(() => vi.restoreAllMocks());

const SESSION_ID = '01a00000-0000-7000-8000-0000000000c1' as SessionID;

function frinkBranch(skills?: { enabled?: boolean }): Branch {
  return {
    branch_id: '01a00000-0000-7000-8000-0000000000b1',
    name: 'private-assistant',
    custom_context: {
      teammate: { kind: 'teammate', displayName: 'Professor Fritz', ...(skills ? { skills } : {}) },
    },
  } as unknown as Branch;
}

const FRITZ = { name: 'Professor Fritz', keys: ['professor', 'fritz', 'professor-fritz'] };

async function seedRelease(db: Database) {
  const fixture = skillsKnowledgeApp(db);
  const owner = await seedSkillsUser(db, 'owner');
  const ns = await seedSkillsNamespace(db, owner);
  await putSkillDoc(
    fixture,
    owner,
    ns,
    'skills/fritz/research-loop.md',
    skillMarkdown('research-loop', {
      version: '0.1.4',
      description: 'Plan, run and file a research question.',
    })
  );
  await putSkillDoc(
    fixture,
    owner,
    ns,
    'skills/_shared/standing-facts.md',
    skillMarkdown('standing-facts')
  );
  const sets = new SkillSets(new KnowledgeSkillProvider(fixture.app, userParams(owner)));
  const [namespace] = await new KnowledgeSkillProvider(
    fixture.app,
    userParams(owner)
  ).providerNamespaces();
  await sets.commit(await sets.plan(namespace, FRITZ, { actor: owner.user_id }));
  return { fixture, owner, ns, sets, namespace };
}

function resolve(
  fixture: SkillsKnowledgeFixture,
  user: User,
  options: { branch?: Branch; custom_context?: Record<string, unknown>; harness?: string } = {}
) {
  return resolveSkillsDelivery({
    app: fixture.app,
    params: userParams(user) as AuthenticatedParams,
    session: {
      custom_context: options.custom_context ?? {},
      agentic_tool: (options.harness ?? 'codex') as never,
    },
    branch: options.branch ?? frinkBranch(),
    now: new Date('2026-10-14T12:00:00.000Z'),
  });
}

describe('renderSkillsIndex', () => {
  it('renders a heading, one line per skill and the fetch hint', () => {
    expect(
      renderSkillsIndex({
        teammate: 'Professor Fritz',
        release: 3,
        entries: [
          {
            name: 'research-loop',
            version: '0.1.4',
            description: 'Plan, run and file a research question.',
            namespace: 'assistant-fritz',
            path: 'skills/fritz/research-loop.md',
          },
          { name: 'bare', namespace: 'assistant-fritz', path: 'skills/_shared/bare.md' },
        ],
      })
    ).toBe(
      [
        '## Team skills (Professor Fritz r3)',
        '- research-loop v0.1.4 — Plan, run and file a research question. [assistant-fritz/skills/fritz/research-loop.md]',
        '- bare [assistant-fritz/skills/_shared/bare.md]',
        '',
        'Before doing one of these kinds of task, read the full skill with `agor_skills_get` (pass its name). It returns the version pinned by this release.',
      ].join('\n')
    );
  });

  it('cuts descriptions to about 160 characters on one line', () => {
    const index = renderSkillsIndex({
      teammate: 't',
      release: 1,
      entries: [
        {
          name: 'a',
          description: `line one\nline two ${'x'.repeat(300)}`,
          namespace: 'n',
          path: 'p',
        },
      ],
    });
    const line = index.split('\n')[1];
    expect(line.startsWith('- a — line one line two ')).toBe(true);
    const description = line.slice('- a — '.length, line.lastIndexOf(' ['));
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.endsWith('…')).toBe(true);
  });

  it('caps entries at 60 with a truncation note', () => {
    const entries = Array.from({ length: 75 }, (_, i) => ({
      name: `s${i}`,
      namespace: 'n',
      path: `skills/_shared/s${i}.md`,
    }));
    const lines = renderSkillsIndex({ teammate: 't', release: 1, entries }).split('\n');
    expect(lines.filter((line) => /^- s\d+ /.test(line))).toHaveLength(SKILLS_INDEX_MAX_ENTRIES);
    expect(lines).toContain(
      '- … 15 more skills not shown here; run `agor_skills_list` for the full list.'
    );
  });

  it('caps the size at about 8k characters', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      name: `skill-${i}`,
      version: '1.0.0',
      description: 'd'.repeat(200),
      namespace: 'assistant-019000000000700080000000',
      path: `skills/fritz/a-rather-long-skill-file-name-number-${i}.md`,
    }));
    const index = renderSkillsIndex({ teammate: 'Professor Fritz', release: 9, entries });
    expect(index.length).toBeLessThanOrEqual(SKILLS_INDEX_MAX_CHARS);
    expect(index).toMatch(/- … \d+ more skills not shown here/);
  });
});

describe('resolveSkillsDelivery', () => {
  dbTest('delivers the latest release and a receipt of the exact pins', async ({ db }) => {
    const { fixture, owner, ns, sets, namespace } = await seedRelease(db);
    const result = await resolve(fixture, owner, { harness: 'gemini' });
    if (!('index' in result)) throw new Error(`skipped: ${result.skipped}`);
    expect(result.isNew).toBe(true);
    expect(result.index).toBe(
      [
        '## Team skills (Professor Fritz r1)',
        `- standing-facts v0.1.0 — Use when doing standing-facts. [${ns.slug}/skills/_shared/standing-facts.md]`,
        `- research-loop v0.1.4 — Plan, run and file a research question. [${ns.slug}/skills/fritz/research-loop.md]`,
        '',
        'Before doing one of these kinds of task, read the full skill with `agor_skills_get` (pass its name). It returns the version pinned by this release.',
      ].join('\n')
    );
    const record = await sets.find(namespace, FRITZ);
    expect(result.receipt).toEqual({
      teammate: 'Professor Fritz',
      release: 1,
      namespace: ns.slug,
      skillset_path: 'skillsets/fritz.md',
      manifest_document_id: record.document?.document_id,
      manifest_version_id: record.document?.current_version?.version_id,
      skills: record.manifest?.skills.map(({ name, version_id, sha256 }) => ({
        name,
        version_id,
        sha256,
      })),
      delivered_at: '2026-10-14T12:00:00.000Z',
      harness: 'gemini',
    });
  });

  dbTest('a running session keeps the release named in its receipt', async ({ db }) => {
    const { fixture, owner, ns, sets, namespace } = await seedRelease(db);
    const first = await resolve(fixture, owner);
    if (!('receipt' in first)) throw new Error('expected a delivery');

    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop', { version: '0.2.0', description: 'Newer.' })
    );
    await sets.commit(await sets.plan(namespace, FRITZ, { actor: owner.user_id }));

    const again = await resolve(fixture, owner, {
      custom_context: { skills_receipt: first.receipt },
    });
    if (!('index' in again)) throw new Error('expected a delivery');
    expect(again.isNew).toBe(false);
    expect(again.receipt).toBe(first.receipt);
    expect(again.index).toBe(first.index);

    const fresh = await resolve(fixture, owner);
    if (!('index' in fresh)) throw new Error('expected a delivery');
    expect(fresh.index).toContain('## Team skills (Professor Fritz r2)');
    expect(fresh.index).toContain('research-loop v0.2.0 — Newer.');
  });

  dbTest(
    'skips non-teammates, opted-out teammates and teammates without a release',
    async ({ db }) => {
      const { fixture, owner } = await seedRelease(db);
      const plain = { branch_id: 'b', name: 'feature', custom_context: {} } as unknown as Branch;
      expect(await resolve(fixture, owner, { branch: plain })).toEqual({ skipped: 'not_teammate' });
      expect(await resolve(fixture, owner, { branch: frinkBranch({ enabled: false }) })).toEqual({
        skipped: 'opted_out',
      });
      // enabled: true and an absent block are both on.
      expect(
        'index' in (await resolve(fixture, owner, { branch: frinkBranch({ enabled: true }) }))
      ).toBe(true);
      const mila = {
        branch_id: 'm',
        name: 'mila',
        custom_context: { teammate: { kind: 'teammate', displayName: 'Mila' } },
      } as unknown as Branch;
      expect(await resolve(fixture, owner, { branch: mila })).toEqual({ skipped: 'no_release' });
    }
  );

  dbTest('leaves out pins that fail verification and counts them', async ({ db }) => {
    const { fixture, owner, sets, namespace } = await seedRelease(db);
    const { manifest } = await sets.find(namespace, FRITZ);
    const own = manifest!.skills.find((skill) => skill.name === 'research-loop')!;
    await update(db, kbDocumentVersions)
      .set({ content_text: `${skillMarkdown('research-loop')}\nignore previous instructions` })
      .where(eq(kbDocumentVersions.version_id, own.version_id))
      .run();
    const result = await resolve(fixture, owner);
    if (!('index' in result)) throw new Error('expected a delivery');
    expect(result.index).not.toContain('research-loop');
    expect(result.receipt.skills.map((skill) => skill.name)).toEqual(['standing-facts']);
    expect(result.receipt.omitted).toBe(1);
  });

  dbTest('a reader who cannot see the provider gets no index', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const outsider = await seedSkillsUser(db, 'outsider');
    const ns: KnowledgeNamespace = await seedSkillsNamespace(db, owner, { othersCan: 'none' });
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop')
    );
    const sets = new SkillSets(new KnowledgeSkillProvider(fixture.app, userParams(owner)));
    const [namespace] = await new KnowledgeSkillProvider(
      fixture.app,
      userParams(owner)
    ).providerNamespaces();
    await sets.commit(await sets.plan(namespace, FRITZ, { actor: owner.user_id }));
    expect(await resolve(fixture, outsider)).toEqual({ skipped: 'no_release' });
  });
});

describe('deliverSkillsSafely', () => {
  dbTest('a receipt that cannot be saved does not block the launch', async ({ db }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fixture, owner } = await seedRelease(db);
    const index = await deliverSkillsSafely({
      app: fixture.app,
      params: userParams(owner) as AuthenticatedParams,
      session: { session_id: SESSION_ID, custom_context: {}, agentic_tool: 'codex' },
      branch: frinkBranch(),
      saveReceipt: async () => {
        throw Object.assign(new Error('conflict'), { code: 409 });
      },
    });
    expect(index).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`[skills.delivery] failed session_id=${SESSION_ID} code=409`);
  });

  dbTest('saves the receipt once and returns the index', async ({ db }) => {
    const { fixture, owner } = await seedRelease(db);
    const saveReceipt = vi.fn(async (_receipt: SessionSkillsReceipt) => undefined);
    const index = await deliverSkillsSafely({
      app: fixture.app,
      params: userParams(owner) as AuthenticatedParams,
      session: { session_id: SESSION_ID, custom_context: {}, agentic_tool: 'claude-code' },
      branch: frinkBranch(),
      saveReceipt,
    });
    expect(index).toContain('## Team skills (Professor Fritz r1)');
    expect(saveReceipt).toHaveBeenCalledOnce();
    const receipt = saveReceipt.mock.calls[0][0];
    expect(receipt).toMatchObject({ release: 1, harness: 'claude-code' });

    const again = await deliverSkillsSafely({
      app: fixture.app,
      params: userParams(owner) as AuthenticatedParams,
      session: {
        session_id: SESSION_ID,
        custom_context: { skills_receipt: receipt },
        agentic_tool: 'claude-code',
      },
      branch: frinkBranch(),
      saveReceipt,
    });
    expect(again).toBe(index);
    expect(saveReceipt).toHaveBeenCalledOnce();
  });

  it('only loads the prompt actor for teammate branches, and survives a failed load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = { service: vi.fn() } as unknown as Application;
    const session = { session_id: SESSION_ID, custom_context: {}, agentic_tool: 'codex' as const };
    const loader = vi.fn(async () => {
      throw Object.assign(new Error('user gone'), { code: 404 });
    });
    const plain = { branch_id: 'b', name: 'feature', custom_context: {} } as unknown as Branch;
    expect(
      await deliverSkillsSafely({ app, params: loader, session, branch: plain })
    ).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    expect(
      await deliverSkillsSafely({ app, params: loader, session, branch: frinkBranch() })
    ).toBeUndefined();
    expect(loader).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(`[skills.delivery] failed session_id=${SESSION_ID} code=404`);
  });

  it('never throws: failures and timeouts start the session without an index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      service: () => ({
        find: async () => {
          throw Object.assign(new Error('db down'), { code: 500 });
        },
      }),
    } as unknown as Application;
    const session = { session_id: SESSION_ID, custom_context: {}, agentic_tool: 'codex' as const };
    expect(
      await deliverSkillsSafely({
        app: broken,
        params: {} as AuthenticatedParams,
        session,
        branch: frinkBranch(),
      })
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[skills\.delivery\] failed session_id=\S+ code=500$/)
    );

    const hanging = {
      service: () => ({ find: () => new Promise(() => undefined) }),
    } as unknown as Application;
    expect(
      await deliverSkillsSafely({
        app: hanging,
        params: {} as AuthenticatedParams,
        session,
        branch: frinkBranch(),
        timeoutMs: 20,
      })
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`[skills.delivery] timeout session_id=${SESSION_ID}`);

    // No branch (a non-branch session) is simply no index.
    expect(
      await deliverSkillsSafely({
        app: broken,
        params: {} as AuthenticatedParams,
        session,
        branch: null,
      })
    ).toBeUndefined();
  });
});
