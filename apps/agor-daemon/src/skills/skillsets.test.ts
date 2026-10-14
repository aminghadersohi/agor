import { type Database, eq, kbDocumentVersions, update } from '@agor/core/db';
import { parseSkillSetManifest } from '@agor/core/knowledge';
import type { Branch, BranchID, KnowledgeNamespace, User } from '@agor/core/types';
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
import { KnowledgeSkillProvider } from './knowledge-skill-provider';
import { providerOwnerBranchId, releaseAuthorization, SkillSets } from './skillsets';
import type { SkillTeammate } from './teammate';

const FRITZ: SkillTeammate = {
  name: 'Professor Fritz',
  keys: ['professor', 'fritz', 'professor-fritz'],
};
const NOW = new Date('2026-10-14T12:00:00.000Z');

async function setup(db: Database) {
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
  return {
    fixture,
    owner,
    ns,
    sets: setsFor(fixture, owner),
    ...(await providerNamespace(fixture, owner, ns)),
  };
}

function setsFor(fixture: SkillsKnowledgeFixture, user: User): SkillSets {
  return new SkillSets(new KnowledgeSkillProvider(fixture.app, userParams(user)));
}

/** The namespace as the provider sees it, with the caller's effective permission. */
async function providerNamespace(
  fixture: SkillsKnowledgeFixture,
  user: User,
  ns: KnowledgeNamespace
) {
  const [namespace] = await new KnowledgeSkillProvider(
    fixture.app,
    userParams(user)
  ).providerNamespaces();
  expect(namespace.namespace_id).toBe(ns.namespace_id);
  return { namespace };
}

async function release(
  sets: SkillSets,
  namespace: KnowledgeNamespace,
  teammate = FRITZ,
  expectedVersion?: number
) {
  return sets.commit(
    await sets.plan(namespace, teammate, {
      actor: 'user-1',
      now: NOW,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    })
  );
}

describe('SkillSets releases', () => {
  dbTest('cuts r1 at skillsets/<folder key>.md pinning the teammate’s skills', async ({ db }) => {
    const { sets, namespace } = await setup(db);
    const outcome = await release(sets, namespace);
    expect(outcome.status).toBe('released');
    const record = await sets.find(namespace, FRITZ);
    expect(record.path).toBe('skillsets/fritz.md');
    expect(record.document).toMatchObject({ kind: 'bundle', title: 'Skill set: Professor Fritz' });
    expect(record.document?.current_version?.version_number).toBe(1);
    expect(record.manifest).toMatchObject({
      name: 'fritz',
      teammate: 'Professor Fritz',
      release: 1,
      created_at: NOW.toISOString(),
      created_by: 'user-1',
    });
    expect(record.manifest?.skills.map((skill) => [skill.path, skill.version_number])).toEqual([
      ['skills/_shared/standing-facts.md', 1],
      ['skills/fritz/research-loop.md', 1],
    ]);
    expect(record.manifest?.skills[1].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  dbTest(
    'releases are frozen: skill edits change nothing until the next release',
    async ({ db }) => {
      const { fixture, owner, ns, sets, namespace } = await setup(db);
      await release(sets, namespace);
      expect((await release(sets, namespace)).status).toBe('unchanged');

      await putSkillDoc(
        fixture,
        owner,
        ns,
        'skills/fritz/research-loop.md',
        skillMarkdown('research-loop', { version: '0.2.0' })
      );
      const r1 = await sets.find(namespace, FRITZ);
      expect(r1.manifest?.release).toBe(1);
      const statuses = await sets.status(r1.manifest!);
      expect(statuses.map((skill) => [skill.name, skill.status])).toEqual([
        ['standing-facts', 'current'],
        ['research-loop', 'update_available'],
      ]);
      expect(statuses[1]).toMatchObject({
        version_number: 1,
        latest_version_number: 2,
        latest_version: '0.2.0',
      });

      const outcome = await release(sets, namespace);
      expect(outcome).toMatchObject({ status: 'released', manifest: { release: 2 } });
      const r2 = await sets.find(namespace, FRITZ);
      expect(r2.document?.current_version?.version_number).toBe(2);
      expect(r2.manifest?.skills[1]).toMatchObject({ version_number: 2, version: '0.2.0' });
      // r1 is still readable as manifest version 1.
      const v1 = (await fixture.documents.get(r2.document!.document_id, {
        ...userParams(owner),
        query: { include_content: true, version: 1 },
      } as never)) as { content: string };
      expect(parseSkillSetManifest(v1.content)).toMatchObject({ manifest: { release: 1 } });
    }
  );

  dbTest('concurrent first releases conflict instead of overwriting', async ({ db }) => {
    const { sets, namespace } = await setup(db);
    // r1 race: both see no manifest and write with expected_version 0.
    const a = await sets.plan(namespace, FRITZ, { actor: 'a', now: NOW });
    const b = await sets.plan(namespace, FRITZ, { actor: 'b', now: NOW });
    expect((await sets.commit(a)).status).toBe('released');
    await expect(sets.commit(b)).rejects.toThrow(
      /Another release of .*skillsets\/fritz\.md landed first/
    );
    const record = await sets.find(namespace, FRITZ);
    expect(record.manifest?.created_by).toBe('a');
  });

  dbTest('rN race and expectedVersion checks', async ({ db }) => {
    const { fixture, owner, ns, sets, namespace } = await setup(db);
    await release(sets, namespace);
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop', { version: '2.0.0' })
    );
    const a = await sets.plan(namespace, FRITZ, { actor: 'a' });
    const b = await sets.plan(namespace, FRITZ, { actor: 'b' });
    expect(a.expectedVersion).toBe(1);
    expect(await sets.commit(a)).toMatchObject({ status: 'released', manifest: { release: 2 } });
    await expect(sets.commit(b)).rejects.toThrow(/landed first/);

    await expect(release(sets, namespace, FRITZ, 1)).rejects.toThrow(
      /skillsets\/fritz\.md is at version 2, not 1/
    );
    await expect(release(sets, namespace, FRITZ, 0)).rejects.toThrow(/is at version 2, not 0/);
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/_shared/standing-facts.md',
      skillMarkdown('standing-facts', { version: '9.0.0' })
    );
    expect(await release(sets, namespace, FRITZ, 2)).toMatchObject({ manifest: { release: 3 } });
  });

  dbTest('skips teammates with nothing to pin and keys them by full name', async ({ db }) => {
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
    const sets = setsFor(fixture, owner);
    const { namespace } = await providerNamespace(fixture, owner, ns);
    const architect = { name: 'The Architect', keys: ['the', 'architect', 'the-architect'] };
    const outcome = await release(sets, namespace, architect);
    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'no skills are assigned to this teammate',
    });
    expect(outcome.record.path).toBe('skillsets/the-architect.md');
  });

  dbTest('refuses to release over an unreadable manifest', async ({ db }) => {
    const { fixture, owner, ns, sets, namespace } = await setup(db);
    await fixture.documents.putDocument(
      {
        namespace_slug: ns.slug,
        path: 'skillsets/fritz.md',
        kind: 'bundle',
        content_text: '# hand-written',
      } as never,
      userParams(owner) as never
    );
    await expect(release(sets, namespace)).rejects.toThrow(
      /skillsets\/fritz\.md is not a valid skill set manifest \(the manifest has no YAML frontmatter\)/
    );
  });

  dbTest('status reports missing and hash-mismatched pins', async ({ db }) => {
    const { fixture, owner, sets, namespace } = await setup(db);
    await release(sets, namespace);
    const { manifest } = await sets.find(namespace, FRITZ);
    const [shared, own] = manifest!.skills;

    // Tamper with the stored content of the pinned version.
    await update(db, kbDocumentVersions)
      .set({ content_text: `${skillMarkdown('research-loop')}\ninjected` })
      .where(eq(kbDocumentVersions.version_id, own.version_id))
      .run();
    await fixture.documents.patch(
      shared.document_id,
      { archived: true } as never,
      userParams(owner) as never
    );

    expect((await sets.status(manifest!)).map((skill) => [skill.name, skill.status])).toEqual([
      ['standing-facts', 'missing'],
      ['research-loop', 'hash_mismatch'],
    ]);
  });
});

describe('releaseAuthorization', () => {
  const FRITZ_BRANCH = '01a00000-0000-7000-8000-00000000f001' as BranchID;
  const namespace = (permission: 'read' | 'write' | 'own') =>
    ({
      namespace_id: 'ns',
      slug: 'assistant-fritz',
      branch_id: FRITZ_BRANCH,
      metadata: { skills_provider: true },
      effective_permission: permission,
    }) as unknown as KnowledgeNamespace;
  const teammateBranch = (branchId: string) =>
    ({
      branch_id: branchId,
      custom_context: { teammate: { kind: 'teammate', displayName: 'x' } },
    }) as unknown as Branch;
  const plainBranch = { branch_id: 'plain', custom_context: {} } as unknown as Branch;

  it('lets the owning teammate’s session release', () => {
    expect(releaseAuthorization(namespace('write'), teammateBranch(FRITZ_BRANCH), true)).toEqual({
      allowed: true,
      as: 'curator',
    });
  });

  it('lets a non-teammate caller with own release, but not another teammate’s session', () => {
    expect(releaseAuthorization(namespace('own'), null, true)).toEqual({
      allowed: true,
      as: 'curator',
    });
    expect(releaseAuthorization(namespace('own'), plainBranch, true)).toEqual({
      allowed: true,
      as: 'curator',
    });
    expect(releaseAuthorization(namespace('own'), teammateBranch('other'), true)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Only the curator'),
    });
    expect(releaseAuthorization(namespace('write'), null, true)).toMatchObject({ allowed: false });
  });

  it('bootstraps r1 for any writer, but not for readers', () => {
    expect(releaseAuthorization(namespace('write'), teammateBranch('other'), false)).toEqual({
      allowed: true,
      as: 'bootstrap',
    });
    expect(releaseAuthorization(namespace('read'), null, false)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('needs write access'),
    });
  });

  it('never grants the curator role from a claimed, unverified session', () => {
    expect(
      releaseAuthorization(namespace('write'), teammateBranch(FRITZ_BRANCH), true, false)
    ).toMatchObject({ allowed: false });
    // ...but a claimed teammate session still takes the own path away.
    expect(
      releaseAuthorization(namespace('own'), teammateBranch('other'), true, false)
    ).toMatchObject({ allowed: false });
  });

  it('finds the owning branch from the namespace or its teammate metadata', () => {
    expect(providerOwnerBranchId(namespace('own'))).toBe(FRITZ_BRANCH);
    expect(
      providerOwnerBranchId({
        metadata: { assistant: { branch_id: 'legacy' } },
      } as unknown as KnowledgeNamespace)
    ).toBe('legacy');
    expect(
      providerOwnerBranchId({ metadata: {} } as unknown as KnowledgeNamespace)
    ).toBeUndefined();
  });
});
