import { runWithTenantDatabaseScope } from '@agor/core/db';
import { type Branch, type BranchID, type SessionID, shortId, type User } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import {
  putSkillDoc,
  type SkillsKnowledgeFixture,
  seedSkillsNamespace,
  seedSkillsUser,
  skillMarkdown,
  skillsKnowledgeApp,
  userParams,
} from '../../../test/skills-fixture';
import { teammateAddressingFixture } from '../../../test/teammate-addressing-fixture';
import { resolveSkillTeammate } from '../../skills/teammate';
import type { McpContext } from '../server';
import { registerSkillTools } from './skills';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

const BRANCH_ID = '01a00000-0000-7000-8000-0000000000b1' as BranchID;
const SESSION_ID = '01a00000-0000-7000-8000-0000000000c1' as SessionID;

function teammateBranch(displayName: string): Branch {
  return {
    branch_id: BRANCH_ID,
    name: 'private-assistant',
    custom_context: { teammate: { kind: 'teammate', displayName } },
  } as unknown as Branch;
}

function toolsFor(
  fixture: SkillsKnowledgeFixture,
  user: User,
  options: { branch?: Branch | null; db?: unknown } = {}
): Record<string, Handler> {
  const branch = options.branch === undefined ? teammateBranch('Professor Fritz') : options.branch;
  fixture.services.set('branches', {
    get: async () => branch ?? { branch_id: BRANCH_ID, name: 'plain', custom_context: {} },
  });
  const ctx = {
    app: fixture.app,
    db: options.db,
    userId: user.user_id,
    sessionId: SESSION_ID,
    authenticatedSession: {
      session_id: SESSION_ID,
      agentic_tool: 'claude-code',
      branch_id: BRANCH_ID,
    },
    authenticatedUser: user,
    baseServiceParams: userParams(user),
  } as unknown as McpContext;
  const handlers: Record<string, Handler> = {};
  registerSkillTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as McpServer,
    ctx
  );
  return handlers;
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('agor_skills_list / agor_skills_get', () => {
  dbTest('lists the calling teammate’s skills as a compact index', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop', { description: `Loop. ${'x'.repeat(300)}` })
    );
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/_shared/standing-facts.md',
      skillMarkdown('standing-facts')
    );
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/mila/campaign-brief.md',
      skillMarkdown('campaign-brief')
    );

    const result = payload(await toolsFor(fixture, owner).agor_skills_list({}));
    expect(result.teammate).toEqual({
      name: 'Professor Fritz',
      keys: ['professor', 'fritz', 'professor-fritz'],
    });
    expect(result.provider_namespaces).toEqual([ns.slug]);
    expect(result.skills.map((skill: { name: string }) => skill.name)).toEqual([
      'standing-facts',
      'research-loop',
    ]);
    const loop = result.skills[1];
    expect(loop).toMatchObject({
      version: '0.1.0',
      namespace: ns.slug,
      path: 'skills/fritz/research-loop.md',
      version_number: 1,
      for: 'fritz',
    });
    expect(loop.description.length).toBeLessThanOrEqual(160);
    expect(loop.description.endsWith('…')).toBe(true);
    expect(result.skills[0].for).toBe('everyone');
  });

  dbTest(
    'takes an explicit teammate, and lists everything outside a teammate session',
    async ({ db }) => {
      const fixture = skillsKnowledgeApp(db);
      const owner = await seedSkillsUser(db, 'owner');
      const ns = await seedSkillsNamespace(db, owner);
      await putSkillDoc(
        fixture,
        owner,
        ns,
        'skills/fritz/research-loop.md',
        skillMarkdown('research-loop')
      );
      await putSkillDoc(
        fixture,
        owner,
        ns,
        'skills/mila/campaign-brief.md',
        skillMarkdown('campaign-brief')
      );

      const plain = toolsFor(fixture, owner, { branch: null, db });
      const everything = payload(await plain.agor_skills_list({}));
      expect(everything.teammate).toBeNull();
      expect(everything.count).toBe(2);

      // No teammate branch named "mila" exists: the name is used as a folder key.
      const mila = payload(await plain.agor_skills_list({ teammate: 'Mila' }));
      expect(mila.teammate).toEqual({ name: 'Mila', keys: ['mila'] });
      expect(mila.skills.map((skill: { name: string }) => skill.name)).toEqual(['campaign-brief']);
    }
  );

  dbTest('says so when no provider namespace is readable', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const result = payload(await toolsFor(fixture, owner).agor_skills_list({}));
    expect(result).toMatchObject({ count: 0, skills: [], provider_namespaces: [] });
    expect(result.note).toMatch(/skills_provider: true/);
  });

  dbTest('gets a skill by name with a provenance header, or by id at a version', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    const doc = await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop', {
        version: '1.0.0',
        body: '# Loop\n\nOld.',
        extra: 'license: MIT',
      })
    );
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop', {
        version: '1.1.0',
        body: '# Loop\n\nNew.',
        extra: 'license: MIT',
      })
    );
    const tools = toolsFor(fixture, owner);

    const byName = payload(await tools.agor_skills_get({ name: 'research-loop' }));
    expect(byName.provenance).toMatchObject({
      provider: 'knowledge',
      namespace: ns.slug,
      path: 'skills/fritz/research-loop.md',
      version_number: 2,
      version: '1.1.0',
      license: 'MIT',
      selected_by: 'current version',
    });
    expect(byName.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byName.content).toBe(
      [
        '> Skill `research-loop` v1.1.0 from Knowledge',
        `> ${ns.slug}/skills/fritz/research-loop.md · version 2 (current version)`,
        `> sha256 ${byName.provenance.sha256}`,
        '> license: MIT',
        '',
        '# Loop',
        '',
        'New.',
        '',
      ].join('\n')
    );

    const old = payload(await tools.agor_skills_get({ documentId: doc.document_id, version: 1 }));
    expect(old.provenance).toMatchObject({ version_number: 1, selected_by: 'requested version' });
    expect(old.content).toContain('Old.');

    await expect(tools.agor_skills_get({ name: 'nope' })).rejects.toThrow(/No skill named "nope"/);
    await expect(tools.agor_skills_get({})).rejects.toThrow(/Provide name or documentId/);
  });

  dbTest('reports an ambiguous name instead of guessing', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    await putSkillDoc(fixture, owner, ns, 'skills/mila/triage.md', skillMarkdown('triage'));
    await putSkillDoc(fixture, owner, ns, 'skills/susan/triage.md', skillMarkdown('triage'));
    const tools = toolsFor(fixture, owner, { branch: null });
    await expect(tools.agor_skills_get({ name: 'triage' })).rejects.toThrow(
      /Several skills are named "triage"/
    );
    // From Mila's session, her own copy wins.
    const mila = toolsFor(fixture, owner, { branch: teammateBranch('Mila') });
    expect(payload(await mila.agor_skills_get({ name: 'triage' })).path).toBe(
      'skills/mila/triage.md'
    );
  });
});

describe('resolveSkillTeammate', () => {
  dbTest('finds a visible teammate by name, key or branch id', async ({ db: rawDb }) => {
    const f = await teammateAddressingFixture(rawDb);
    const fritz = await f.createTeammate({
      name: 'private-assistant',
      displayName: 'Professor Fritz',
    });
    const resolve = (query: string, user = f.owner) =>
      runWithTenantDatabaseScope(f.db, f.tenantId, () =>
        resolveSkillTeammate(f.db, query, user.user_id)
      );

    const expected = {
      name: 'Professor Fritz',
      keys: ['professor', 'fritz', 'professor-fritz'],
      branch_id: fritz.branch_id,
    };
    expect(await resolve('Professor Fritz')).toEqual(expected);
    expect(await resolve('fritz')).toEqual(expected);
    expect(await resolve(fritz.branch_id)).toEqual(expected);
    expect(await resolve(shortId(fritz.branch_id))).toEqual(expected);
    // A caller who cannot view the branch gets the bare key.
    expect(await resolve('fritz', f.outsider)).toEqual({ name: 'fritz', keys: ['fritz'] });
    await expect(resolve('  ')).rejects.toThrow(/teammate must be/);
  });
});
