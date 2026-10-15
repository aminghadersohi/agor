/**
 * The Knowledge skills provider (v1).
 *
 * Provider namespaces are the Knowledge namespaces the daemon config lists
 * under `skills.providers` (operator-owned; nothing stored in Knowledge can
 * add one). Their `kind: skill` documents under
 * `skills/<teammate key>/` or `skills/_shared/` are the provider's skills
 * (see `teammate-skills/assign.ts`). Drafts, archived documents, other kinds
 * and `README.md` files are not.
 *
 * Every read goes through the `kb/*` services with the caller's params, so the
 * normal namespace ACL and document visibility checks apply: a provider only
 * ever shows a caller what that caller could read with `agor_kb_get`.
 */

import { createHash } from 'node:crypto';
import type { AgorSkillsProviderSettings } from '@agor/core/config';
import { type Application, BadRequest, NotFound } from '@agor/core/feathers';
import { expectedSkillName, parseSkillDocument, validateSkillDocument } from '@agor/core/knowledge';
import {
  type HydratedKnowledgeDocument,
  KNOWLEDGE_SKILL_PROVIDER_ID,
  type KnowledgeDocumentID,
  type KnowledgeDocumentVersion,
  type KnowledgeDocumentVersionID,
  type KnowledgeNamespace,
  type Params,
  type PinnedSkill,
  type SkillContent,
  type SkillListQuery,
  type SkillProvider,
  type SkillRef,
  type SkillSummary,
  type SkillVerification,
  type SkillVersion,
  type SkillVersionSelector,
} from '@agor/core/types';
import { providerSkillAssignment, providerSkillIsFor } from '../teammate-skills/assign.js';

/** `kb/documents` page size; the service caps `$limit` at 500. */
const PAGE_SIZE = 500;
/** Skill documents read per provider namespace. */
export const PROVIDER_SKILL_LIMIT = 2000;
/** Configured providers considered; the rest of a longer list is ignored. */
export const MAX_SKILL_PROVIDERS = 16;

/** The operator's trusted skills providers (`skills.providers` in config.yaml). */
export function configuredSkillProviders(app: Application): readonly AgorSkillsProviderSettings[] {
  const config = (app as { get?: (key: string) => unknown }).get?.('config') as
    | { skills?: { providers?: readonly AgorSkillsProviderSettings[] } }
    | undefined;
  return (config?.skills?.providers ?? []).slice(0, MAX_SKILL_PROVIDERS);
}

function paginatedData<T>(result: unknown): { data: T[]; total: number } {
  if (Array.isArray(result)) return { data: result as T[], total: result.length };
  const page = result as { data?: T[]; total?: number } | null;
  const data = page?.data ?? [];
  return { data, total: page?.total ?? data.length };
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : undefined;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isPinned(ref: SkillRef | PinnedSkill): ref is PinnedSkill {
  return typeof (ref as PinnedSkill).version_id === 'string';
}

/** A published, active `kind: skill` document at a provider skill path. */
export function isProviderSkillDocument(doc: {
  kind?: string;
  status?: string;
  archived?: boolean;
  path: string;
}): boolean {
  return (
    doc.kind === 'skill' &&
    doc.status !== 'draft' &&
    doc.archived !== true &&
    providerSkillAssignment(doc.path) !== undefined
  );
}

export class KnowledgeSkillProvider implements SkillProvider {
  readonly id = KNOWLEDGE_SKILL_PROVIDER_ID;
  readonly providers: readonly AgorSkillsProviderSettings[];
  private namespaceCache: Promise<KnowledgeNamespace[]> | undefined;

  /**
   * @param params The caller's service params (user, provider, tenant). Every
   *   `kb/*` call is made with them; never pass internal/service-account params
   *   on behalf of a user.
   * @param providers Trusted providers; defaults to the daemon config.
   */
  constructor(
    private readonly app: Application,
    private readonly params: Params,
    providers?: readonly AgorSkillsProviderSettings[]
  ) {
    this.providers = (providers ?? configuredSkillProviders(app)).slice(0, MAX_SKILL_PROVIDERS);
  }

  /** The caller's params, with `query` when given. */
  paramsWith(query?: Record<string, unknown>): Params {
    return query ? { ...this.params, query } : { ...this.params };
  }

  /** The Feathers app this provider reads through. */
  get serviceApp(): Application {
    return this.app;
  }

  /**
   * Configured provider namespaces the caller can read, in config order. Each
   * is one lookup by slug; nothing else is scanned.
   */
  async providerNamespaces(): Promise<KnowledgeNamespace[]> {
    this.namespaceCache ??= (async () => {
      const found: KnowledgeNamespace[] = [];
      for (const provider of this.providers) {
        const result = await this.app
          .service('kb/namespaces')
          .find(this.paramsWith({ slug: provider.namespace, archived: false }));
        const namespace = paginatedData<KnowledgeNamespace>(result).data.find(
          (ns) => ns.slug === provider.namespace && !ns.archived
        );
        if (namespace) found.push(namespace);
      }
      return found;
    })();
    return this.namespaceCache;
  }

  /** The configured provider entry for a namespace slug. */
  providerFor(slug: string): AgorSkillsProviderSettings | undefined {
    return this.providers.find((provider) => provider.namespace === slug);
  }

  private async providerNamespace(namespaceId: string): Promise<KnowledgeNamespace | undefined> {
    return (await this.providerNamespaces()).find((ns) => ns.namespace_id === namespaceId);
  }

  /** Published skill documents (with current content) in one provider namespace. */
  private async listNamespaceSkillDocs(
    namespace: KnowledgeNamespace
  ): Promise<HydratedKnowledgeDocument[]> {
    const docs: HydratedKnowledgeDocument[] = [];
    let total = 0;
    while (docs.length < PROVIDER_SKILL_LIMIT) {
      const page = paginatedData<HydratedKnowledgeDocument>(
        await this.app.service('kb/documents').find(
          this.paramsWith({
            namespace_id: namespace.namespace_id,
            kind: 'skill',
            status: 'published',
            archived: false,
            include_content: true,
            $limit: Math.min(PAGE_SIZE, PROVIDER_SKILL_LIMIT - docs.length),
            $skip: docs.length,
            $sort: { path: 1 },
          })
        )
      );
      docs.push(...page.data);
      total = page.total;
      if (page.data.length === 0 || docs.length >= total) break;
    }
    return docs.filter(isProviderSkillDocument);
  }

  async list(query?: SkillListQuery): Promise<SkillSummary[]> {
    const skills: SkillSummary[] = [];
    for (const namespace of await this.providerNamespaces()) {
      skills.push(...(await this.listNamespace(namespace, query)));
    }
    return skills;
  }

  /** The skills of one provider namespace only. */
  async listNamespace(
    namespace: KnowledgeNamespace,
    query?: SkillListQuery
  ): Promise<SkillSummary[]> {
    const skills: SkillSummary[] = [];
    for (const doc of await this.listNamespaceSkillDocs(namespace)) {
      if (query?.teammateKeys && !providerSkillIsFor(doc.path, query.teammateKeys)) continue;
      const content = this.toContent(doc, namespace, doc.current_version ?? null);
      if (content) skills.push(summaryOf(content));
    }
    return skills;
  }

  /**
   * The skill document at a version: the pinned one for a {@link PinnedSkill},
   * `selector` otherwise (default: current). Throws NotFound when the document
   * is not a provider skill the caller can read.
   */
  private async read(
    documentId: string,
    version?: string | number
  ): Promise<{ doc: HydratedKnowledgeDocument; namespace: KnowledgeNamespace }> {
    const doc = (await this.app.service('kb/documents').get(
      documentId,
      this.paramsWith({
        include_content: true,
        ...(version !== undefined && version !== 'latest' ? { version } : {}),
      })
    )) as HydratedKnowledgeDocument;
    const namespace = await this.providerNamespace(doc.namespace_id);
    if (!namespace || !isProviderSkillDocument(doc)) {
      throw new NotFound(`Not a skill in a skills provider namespace: ${documentId}`);
    }
    if (!doc.current_version) {
      throw new NotFound(`Skill ${doc.path} has no version ${version ?? ''}`.trim());
    }
    return { doc, namespace };
  }

  private toContent(
    doc: HydratedKnowledgeDocument,
    namespace: KnowledgeNamespace,
    version: KnowledgeDocumentVersion | null
  ): SkillContent | null {
    const assignment = providerSkillAssignment(doc.path);
    const content = version?.content_text;
    if (!assignment || !version || typeof content !== 'string') return null;
    const parsed = parseSkillDocument(content);
    const issues = validateSkillDocument({ path: doc.path, content });
    const fields = parsed.fields;
    return {
      ref: { provider: this.id, id: doc.document_id },
      name: fields.name ?? expectedSkillName(doc.path) ?? doc.path,
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.version ? { version: fields.version } : {}),
      ...(fields.license ? { license: fields.license } : {}),
      ...(fields.origin ? { origin: fields.origin } : {}),
      assignment,
      namespace_id: namespace.namespace_id,
      namespace_slug: namespace.slug,
      path: doc.path,
      document_id: doc.document_id as KnowledgeDocumentID,
      version_id: version.version_id,
      version_number: version.version_number,
      sha256: version.content_sha256 ?? sha256Hex(content),
      ...(issues.length ? { issues } : {}),
      body: parsed.body,
      content,
      frontmatter: parsed.frontmatter,
    };
  }

  async get(ref: SkillRef | PinnedSkill, selector?: SkillVersionSelector): Promise<SkillContent> {
    this.assertOwnRef(ref);
    const version = isPinned(ref) ? ref.version_id : selector;
    const { doc, namespace } = await this.read(ref.id, version);
    const content = this.toContent(doc, namespace, doc.current_version ?? null);
    if (!content) throw new NotFound(`Skill ${doc.path} has no readable content`);
    return content;
  }

  async versions(ref: SkillRef): Promise<SkillVersion[]> {
    this.assertOwnRef(ref);
    // Confirms it is a provider skill the caller can read before listing history.
    await this.read(ref.id);
    const versions = (await this.app
      .service('kb/versions')
      .find(this.paramsWith({ document_id: ref.id }))) as KnowledgeDocumentVersion[];
    return [...versions]
      .sort((a, b) => b.version_number - a.version_number)
      .map((version) => ({
        version_id: version.version_id,
        version_number: version.version_number,
        sha256: version.content_sha256 ?? '',
        created_at: toIso(version.created_at),
        change_summary: version.change_summary ?? null,
      }));
  }

  async pin(ref: SkillRef, selector: SkillVersionSelector = 'latest'): Promise<PinnedSkill> {
    const skill = await this.get({ provider: ref.provider, id: ref.id }, selector);
    return pinOf(skill);
  }

  async verify(pinned: PinnedSkill): Promise<SkillVerification> {
    this.assertOwnRef(pinned);
    let skill: SkillContent;
    try {
      skill = await this.get(pinned);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 403 || code === 404) return { pinned, actual_sha256: null, status: 'missing' };
      throw error;
    }
    const actual = sha256Hex(skill.content);
    return {
      pinned,
      actual_sha256: actual,
      status: actual === pinned.sha256 ? 'ok' : 'hash_mismatch',
      namespace_slug: skill.namespace_slug,
      path: skill.path,
      ...(skill.license ? { license: skill.license } : {}),
      ...(skill.origin ? { origin: skill.origin } : {}),
    };
  }

  private assertOwnRef(ref: SkillRef): void {
    if (ref.provider !== this.id) {
      throw new BadRequest(`Unknown skills provider "${ref.provider}"; expected "${this.id}"`);
    }
  }
}

export function summaryOf(skill: SkillContent): SkillSummary {
  const { body: _body, content: _content, frontmatter: _frontmatter, ...summary } = skill;
  return summary;
}

export function pinOf(skill: SkillSummary): PinnedSkill {
  return {
    provider: skill.ref.provider,
    id: skill.ref.id,
    version_id: skill.version_id as KnowledgeDocumentVersionID,
    version_number: skill.version_number,
    sha256: skill.sha256,
  };
}
