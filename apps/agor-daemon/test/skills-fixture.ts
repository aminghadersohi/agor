/**
 * Real Knowledge services over a migrated SQLite database, for skills tests.
 *
 * `kb/namespaces`, `kb/documents` and `kb/versions` are the production
 * services, so the provider is tested against the real namespace ACL,
 * document visibility, versioning and `expected_version` checks.
 */

import {
  type Database,
  generateId,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  KnowledgeDocument,
  KnowledgeNamespace,
  KnowledgeNamespaceOthersCan,
  Params,
  User,
  UserID,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { KnowledgeDocumentsService } from '../src/services/knowledge-documents';
import { KnowledgeNamespacesService } from '../src/services/knowledge-namespaces';
import { KnowledgeVersionsService } from '../src/services/knowledge-versions';

export interface SkillsKnowledgeFixture {
  app: Application;
  documents: KnowledgeDocumentsService;
  namespaces: KnowledgeNamespacesService;
  versions: KnowledgeVersionsService;
  /** Extra services a test registers (e.g. `sessions`, `branches`). */
  services: Map<string, unknown>;
}

export function skillsKnowledgeApp(db: Database): SkillsKnowledgeFixture {
  const services = new Map<string, unknown>();
  const app = {
    service(path: string) {
      const service = services.get(path);
      if (!service) throw new Error(`No service registered at ${path}`);
      return service;
    },
  } as unknown as Application;
  const documents = new KnowledgeDocumentsService(db);
  const namespaces = new KnowledgeNamespacesService(db);
  const versions = new KnowledgeVersionsService(db);
  services.set('kb/documents', documents);
  services.set('kb/namespaces', namespaces);
  services.set('kb/versions', versions);
  return { app, documents, namespaces, versions, services };
}

export async function seedSkillsUser(
  db: Database,
  label: string,
  role: User['role'] = ROLES.MEMBER
): Promise<User> {
  return (await new UsersRepository(db).create({
    user_id: generateId() as UserID,
    email: `${label}-${generateId()}@test.local`,
    name: label,
    role,
  })) as User;
}

export function userParams(user: User): Params {
  return { user, authenticated: true, provider: 'rest' } as Params;
}

export async function seedSkillsNamespace(
  db: Database,
  owner: User,
  options: {
    slug?: string;
    provider?: boolean;
    othersCan?: KnowledgeNamespaceOthersCan;
    branchId?: string;
  } = {}
): Promise<KnowledgeNamespace> {
  const slug = options.slug ?? `skills-${generateId().replace(/-/g, '').slice(-12)}`;
  return new KnowledgeNamespaceRepository(db).create({
    slug,
    display_name: slug,
    kind: options.branchId ? 'branch' : 'team',
    owner_user_id: owner.user_id as UserID,
    created_by: owner.user_id as UserID,
    others_can: options.othersCan ?? 'read',
    visibility_default: 'public',
    ...(options.branchId ? { branch_id: options.branchId as KnowledgeNamespace['branch_id'] } : {}),
    metadata: options.provider === false ? {} : { skills_provider: true },
  });
}

export function skillMarkdown(
  name: string,
  options: { description?: string; version?: string; body?: string; extra?: string } = {}
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(options.description ?? `Use when doing ${name}.`)}`,
    ...(options.extra ? [options.extra] : []),
    'metadata:',
    `  version: "${options.version ?? '0.1.0'}"`,
    '---',
    options.body ?? `# ${name}\n\nSteps for ${name}.`,
    '',
  ].join('\n');
}

export async function putSkillDoc(
  fixture: SkillsKnowledgeFixture,
  user: User,
  namespace: KnowledgeNamespace,
  path: string,
  content: string,
  extra: Record<string, unknown> = {}
): Promise<KnowledgeDocument> {
  return fixture.documents.putDocument(
    {
      namespace_slug: namespace.slug,
      path,
      kind: 'skill',
      content_text: content,
      ...extra,
    } as never,
    userParams(user) as never
  );
}
