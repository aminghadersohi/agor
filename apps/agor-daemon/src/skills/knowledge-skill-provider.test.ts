import type { KnowledgeDocumentVersionID, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  putSkillDoc,
  seedSkillsNamespace,
  seedSkillsUser,
  skillMarkdown,
  skillsKnowledgeApp,
  userParams,
} from '../../test/skills-fixture';
import { KnowledgeSkillProvider, pinOf, sha256Hex } from './knowledge-skill-provider';

describe('KnowledgeSkillProvider', () => {
  dbTest('lists a teammate’s folder plus _shared, and nothing else', async ({ db }) => {
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
    // Not skills: a README, another kind, a draft, an unfoldered path.
    await fixture.documents.putDocument(
      {
        namespace_slug: ns.slug,
        path: 'skills/fritz/README.md',
        kind: 'doc',
        content_text: '# Index',
      } as never,
      userParams(owner) as never
    );
    await fixture.documents.putDocument(
      {
        namespace_slug: ns.slug,
        path: 'skills/fritz/notes.md',
        kind: 'doc',
        content_text: '# Notes',
      } as never,
      userParams(owner) as never
    );
    await putSkillDoc(fixture, owner, ns, 'skills/fritz/half-done.md', skillMarkdown('half-done'), {
      status: 'draft',
    });
    await putSkillDoc(fixture, owner, ns, 'skills/loose.md', skillMarkdown('loose'));

    const provider = new KnowledgeSkillProvider(fixture.app, userParams(owner));
    const fritz = await provider.list({ teammateKeys: ['professor', 'fritz', 'professor-fritz'] });
    expect(fritz.map((skill) => skill.path)).toEqual([
      'skills/_shared/standing-facts.md',
      'skills/fritz/research-loop.md',
    ]);
    const [shared, own] = fritz;
    expect(shared.assignment).toEqual({ kind: 'shared' });
    expect(own).toMatchObject({
      name: 'research-loop',
      version: '0.1.0',
      description: 'Use when doing research-loop.',
      namespace_slug: ns.slug,
      assignment: { kind: 'teammate', key: 'fritz' },
      version_number: 1,
      ref: { provider: 'knowledge', id: own.document_id },
    });
    expect(own.sha256).toMatch(/^[0-9a-f]{64}$/);

    const all = await provider.list();
    expect(all.map((skill) => skill.name).sort()).toEqual([
      'campaign-brief',
      'research-loop',
      'standing-facts',
    ]);
  });

  dbTest('ignores namespaces without skills_provider: true', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const plain = await seedSkillsNamespace(db, owner, { provider: false });
    await putSkillDoc(
      fixture,
      owner,
      plain,
      'skills/fritz/research-loop.md',
      skillMarkdown('research-loop')
    );
    const provider = new KnowledgeSkillProvider(fixture.app, userParams(owner));
    expect(await provider.providerNamespaces()).toEqual([]);
    expect(await provider.list()).toEqual([]);
  });

  dbTest('shows a caller only provider namespaces it can read', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const outsider = await seedSkillsUser(db, 'outsider');
    const closed = await seedSkillsNamespace(db, owner, { othersCan: 'none' });
    const open = await seedSkillsNamespace(db, owner, { othersCan: 'read' });
    await putSkillDoc(fixture, owner, closed, 'skills/fritz/secret.md', skillMarkdown('secret'));
    await putSkillDoc(
      fixture,
      owner,
      open,
      'skills/fritz/public-one.md',
      skillMarkdown('public-one')
    );
    // Private document in a readable namespace: the visibility overlay applies.
    await putSkillDoc(
      fixture,
      owner,
      open,
      'skills/fritz/private-one.md',
      skillMarkdown('private-one'),
      {
        visibility: 'private',
      }
    );

    const asOutsider = new KnowledgeSkillProvider(fixture.app, userParams(outsider));
    expect((await asOutsider.list()).map((skill) => skill.name)).toEqual(['public-one']);
    const secretId = (await new KnowledgeSkillProvider(fixture.app, userParams(owner)).list()).find(
      (skill) => skill.name === 'secret'
    )?.document_id as string;
    await expect(asOutsider.get({ provider: 'knowledge', id: secretId })).rejects.toThrow();
  });

  dbTest('gets current, numbered and pinned versions; lists history', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    const first = skillMarkdown('triage', { version: '1.0.0', body: '# Triage\n\nOld steps.' });
    const doc = await putSkillDoc(fixture, owner, ns, 'skills/_shared/triage.md', first);
    await putSkillDoc(
      fixture,
      owner,
      ns,
      'skills/_shared/triage.md',
      skillMarkdown('triage', { version: '1.1.0', body: '# Triage\n\nNew steps.' })
    );
    const provider = new KnowledgeSkillProvider(fixture.app, userParams(owner));
    const ref = { provider: 'knowledge', id: doc.document_id };

    const current = await provider.get(ref);
    expect(current).toMatchObject({ version: '1.1.0', version_number: 2 });
    expect(current.body).toBe('# Triage\n\nNew steps.\n');
    expect(current.content.startsWith('---\nname: triage')).toBe(true);

    const old = await provider.get(ref, 1);
    expect(old).toMatchObject({ version: '1.0.0', version_number: 1, sha256: sha256Hex(first) });

    const pinned = await provider.pin(ref, 1);
    expect(pinned).toEqual({
      provider: 'knowledge',
      id: doc.document_id,
      version_id: old.version_id,
      version_number: 1,
      sha256: sha256Hex(first),
    });
    expect((await provider.get(pinned)).version_number).toBe(1);
    expect((await provider.pin(ref)).version_number).toBe(2);

    const history = await provider.versions(ref);
    expect(history.map((version) => version.version_number)).toEqual([2, 1]);
    expect(history[1].sha256).toBe(sha256Hex(first));
  });

  dbTest('verify re-hashes the pinned content', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    const content = skillMarkdown('triage', { extra: 'license: MIT' });
    await putSkillDoc(fixture, owner, ns, 'skills/_shared/triage.md', content);
    const provider = new KnowledgeSkillProvider(fixture.app, userParams(owner));
    const [skill] = await provider.list();
    const pinned = pinOf(skill);

    expect(await provider.verify(pinned)).toMatchObject({
      status: 'ok',
      actual_sha256: sha256Hex(content),
      path: 'skills/_shared/triage.md',
      license: 'MIT',
    });
    expect(await provider.verify({ ...pinned, sha256: 'f'.repeat(64) })).toMatchObject({
      status: 'hash_mismatch',
      actual_sha256: sha256Hex(content),
    });
    expect(
      await provider.verify({
        ...pinned,
        version_id: '01a00000-0000-7000-8000-000000000000' as KnowledgeDocumentVersionID,
      })
    ).toMatchObject({ status: 'missing', actual_sha256: null });
  });

  dbTest('rejects refs from another provider and non-skill documents', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const admin: User = await seedSkillsUser(db, 'admin', ROLES.ADMIN);
    const ns = await seedSkillsNamespace(db, admin);
    const doc = await fixture.documents.putDocument(
      {
        namespace_slug: ns.slug,
        path: 'skills/fritz/notes.md',
        kind: 'doc',
        content_text: '# Notes',
      } as never,
      userParams(admin) as never
    );
    const provider = new KnowledgeSkillProvider(fixture.app, userParams(admin));
    await expect(provider.get({ provider: 'git:x/y', id: doc.document_id })).rejects.toThrow(
      /Unknown skills provider/
    );
    await expect(provider.get({ provider: 'knowledge', id: doc.document_id })).rejects.toThrow(
      /Not a skill/
    );
  });
});
