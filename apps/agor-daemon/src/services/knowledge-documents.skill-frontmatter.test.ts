/**
 * `kind: skill` writes must carry valid Agent Skills frontmatter; edits that
 * keep an older skill's frontmatter only warn.
 */

import { type Database, KnowledgeDocumentRepository } from '@agor/core/db';
import type { KnowledgeNamespace, User, UserID } from '@agor/core/types';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  putSkillDoc,
  seedSkillsNamespace,
  seedSkillsUser,
  skillMarkdown,
  skillsKnowledgeApp,
  userParams,
} from '../../test/skills-fixture';
import { KnowledgeDocumentEditsService } from './knowledge-document-edits';

afterEach(() => vi.restoreAllMocks());

/** A skill stored before validation existed, written straight through the repository. */
async function seedLegacySkill(
  db: Database,
  owner: User,
  namespace: KnowledgeNamespace,
  path: string,
  content: string
) {
  return new KnowledgeDocumentRepository(db).create({
    namespace_id: namespace.namespace_id,
    path,
    title: path,
    kind: 'skill',
    visibility: 'public',
    status: 'published',
    edit_policy: 'owner',
    content_text: content,
    created_by: owner.user_id as UserID,
  });
}

describe('skill frontmatter validation on Knowledge writes', () => {
  dbTest('accepts a valid skill and a SKILL.md named after its folder', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    await expect(
      putSkillDoc(
        fixture,
        owner,
        ns,
        'skills/fritz/research-loop.md',
        skillMarkdown('research-loop')
      )
    ).resolves.toMatchObject({ kind: 'skill' });
    await expect(
      putSkillDoc(fixture, owner, ns, 'skills/triage/SKILL.md', skillMarkdown('triage'))
    ).resolves.toMatchObject({ kind: 'skill' });
  });

  dbTest('rejects new skills with missing or invalid frontmatter', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    const put = (path: string, content: string) => putSkillDoc(fixture, owner, ns, path, content);

    await expect(put('skills/a/no-front.md', '# Just a body')).rejects.toThrow(
      /Invalid skill frontmatter in skills\/a\/no-front\.md: a skill must start with a YAML frontmatter block/
    );
    await expect(put('skills/a/other.md', skillMarkdown('different'))).rejects.toThrow(
      /`name` "different" must match the file name "other"/
    );
    await expect(put('skills/folder/SKILL.md', skillMarkdown('nope'))).rejects.toThrow(
      /must match the folder "folder"/
    );
    await expect(put('skills/a/Bad_Name.md', skillMarkdown('Bad_Name'))).rejects.toThrow(
      /must be kebab-case/
    );
    const long = 'x'.repeat(65);
    await expect(put(`skills/a/${long}.md`, skillMarkdown(long))).rejects.toThrow(
      /`name` is 65 characters; the limit is 64/
    );
    await expect(
      put('skills/a/wordy.md', skillMarkdown('wordy', { description: 'd'.repeat(1025) }))
    ).rejects.toThrow(/`description` is 1025 characters; the limit is 1024/);
    await expect(put('skills/a/quiet.md', '---\nname: quiet\n---\nBody')).rejects.toThrow(
      /`description` is required/
    );
    // Other kinds are not checked.
    await expect(
      fixture.documents.putDocument(
        {
          namespace_slug: ns.slug,
          path: 'skills/a/README.md',
          kind: 'doc',
          content_text: '# x',
        } as never,
        userParams(owner) as never
      )
    ).resolves.toMatchObject({ kind: 'doc' });
  });

  dbTest('checks create() and patch() too', async ({ db }) => {
    const fixture = skillsKnowledgeApp(db);
    const owner = await seedSkillsUser(db, 'owner');
    const ns = await seedSkillsNamespace(db, owner);
    await expect(
      fixture.documents.create(
        {
          namespace_id: ns.namespace_id,
          path: 'skills/a/b.md',
          kind: 'skill',
          content_text: '# b',
        } as never,
        userParams(owner) as never
      )
    ).rejects.toThrow(/Invalid skill frontmatter/);
    const doc = await putSkillDoc(fixture, owner, ns, 'skills/a/b.md', skillMarkdown('b'));
    await expect(
      fixture.documents.patch(
        doc.document_id,
        { content_text: '# b, frontmatter gone' } as never,
        userParams(owner) as never
      )
    ).rejects.toThrow(/Invalid skill frontmatter/);
    // Renaming the file away from the declared name is a change too.
    await expect(
      fixture.documents.patch(
        doc.document_id,
        { path: 'skills/a/c.md' } as never,
        userParams(owner) as never
      )
    ).rejects.toThrow(/must match the file name "c"/);
    // Turning a doc into a skill is checked against its stored content.
    const plain = await fixture.documents.putDocument(
      {
        namespace_slug: ns.slug,
        path: 'skills/a/plain.md',
        kind: 'doc',
        content_text: '# plain',
      } as never,
      userParams(owner) as never
    );
    await expect(
      fixture.documents.patch(
        plain.document_id,
        { kind: 'skill' } as never,
        userParams(owner) as never
      )
    ).rejects.toThrow(/Invalid skill frontmatter/);
    // Metadata-only writes are not checked.
    await expect(
      fixture.documents.patch(
        doc.document_id,
        { icon_emoji: '🧩' } as never,
        userParams(owner) as never
      )
    ).resolves.toMatchObject({ icon_emoji: '🧩' });
  });

  dbTest(
    'only warns when an invalid legacy skill is edited without touching its frontmatter',
    async ({ db }) => {
      const fixture = skillsKnowledgeApp(db);
      const owner = await seedSkillsUser(db, 'owner');
      const ns = await seedSkillsNamespace(db, owner);
      const frontmatter = `---\nname: legacy\ndescription: ${JSON.stringify('d'.repeat(1100))}\n---\n`;
      const legacy = await seedLegacySkill(
        db,
        owner,
        ns,
        'skills/a/legacy.md',
        `${frontmatter}# Old body\n`
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        putSkillDoc(fixture, owner, ns, 'skills/a/legacy.md', `${frontmatter}# New body\n`)
      ).resolves.toMatchObject({ document_id: legacy.document_id });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[knowledge.skill_frontmatter] kept_invalid')
      );

      // agor_kb_edit goes through putDocument as well.
      const edits = new KnowledgeDocumentEditsService(db, fixture.documents);
      await expect(
        edits.create(
          {
            documentId: legacy.document_id,
            expectedVersion: 2,
            ops: [
              {
                type: 'replace_literal',
                find: 'New body',
                replace: 'Newer body',
                expectedCount: 1,
              },
            ],
          } as never,
          userParams(owner) as never
        )
      ).resolves.toBeTruthy();

      // Changing the frontmatter while it is still invalid is rejected.
      const changed = `---\nname: legacy\ndescription: ${JSON.stringify('e'.repeat(1100))}\n---\n# Body\n`;
      await expect(putSkillDoc(fixture, owner, ns, 'skills/a/legacy.md', changed)).rejects.toThrow(
        /`description` is 1100 characters/
      );
      // Fixing it is accepted.
      await expect(
        putSkillDoc(fixture, owner, ns, 'skills/a/legacy.md', skillMarkdown('legacy'))
      ).resolves.toBeTruthy();
    }
  );
});
