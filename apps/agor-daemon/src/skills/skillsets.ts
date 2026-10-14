/**
 * Skill sets: frozen, numbered releases of a teammate's provider skills.
 *
 * One `kind: bundle` manifest per teammate per provider namespace, at
 * `skillsets/<teammate key>.md`. A release reads the manifest, pins the
 * current published version of every skill assigned to the teammate, and
 * writes release N+1 as a new Knowledge version with `expected_version` set
 * to the version it read (0 = create-only for r1). Two concurrent releases
 * therefore conflict; neither overwrites the other.
 *
 * **Who may release** (see {@link releaseAuthorization}):
 * - the *curator*: a session on the teammate branch that owns the provider
 *   namespace, or a caller outside any teammate session with `own` on it;
 * - **bootstrap:** while a teammate has no manifest in the namespace yet,
 *   anyone with namespace write may cut its r1.
 *
 * Everything goes through `kb/*` with the caller's params.
 */

import { Conflict, Forbidden } from '@agor/core/feathers';
import {
  parseSkillSetManifest,
  renderSkillSetManifest,
  sameSkillPins,
  skillSetPath,
} from '@agor/core/knowledge';
import type {
  Branch,
  BranchID,
  HydratedKnowledgeDocument,
  KnowledgeNamespace,
  KnowledgeNamespaceEffectivePermission,
  SkillSetEntry,
  SkillSetEntryStatus,
  SkillSetManifest,
  SkillSummary,
} from '@agor/core/types';
import { isTeammate } from '@agor/core/types';
import { isKnowledgeDocumentVersionMismatchError } from '../services/knowledge-errors.js';
import type { KnowledgeSkillProvider } from './knowledge-skill-provider.js';
import type { SkillTeammate } from './teammate.js';

export interface SkillSetRecord {
  namespace: KnowledgeNamespace;
  /** Teammate key the manifest is (or would be) filed under. */
  key: string;
  path: string;
  /** The manifest document at its current version, when one exists. */
  document: HydratedKnowledgeDocument | null;
  manifest: SkillSetManifest | null;
  /** Why an existing manifest could not be read. */
  error?: string;
}

function paginatedData<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { data?: T[] } | null)?.data ?? []) as T[];
}

function entryOf(skill: SkillSummary): SkillSetEntry {
  return {
    name: skill.name,
    ...(skill.version ? { version: skill.version } : {}),
    document_id: skill.document_id,
    path: skill.path,
    version_id: skill.version_id,
    version_number: skill.version_number,
    sha256: skill.sha256,
  };
}

/** The teammate branch that owns a provider namespace (Fritz's for Fritz's namespace). */
export function providerOwnerBranchId(namespace: KnowledgeNamespace): BranchID | undefined {
  if (namespace.branch_id) return namespace.branch_id;
  const metadata = namespace.metadata ?? {};
  for (const key of ['teammate', 'assistant'] as const) {
    const block = metadata[key];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const branchId = (block as Record<string, unknown>).branch_id;
      if (typeof branchId === 'string' && branchId) return branchId as BranchID;
    }
  }
  return undefined;
}

const RANK: Record<KnowledgeNamespaceEffectivePermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  own: 3,
};

export type ReleaseAuthorization =
  | { allowed: true; as: 'curator' | 'bootstrap' }
  | { allowed: false; reason: string };

/**
 * Whether the caller may cut a release in `namespace`.
 *
 * @param callerBranch The calling session's branch, or null outside a session.
 * @param manifestExists Whether this teammate already has a manifest there.
 * @param branchVerified Whether `callerBranch` comes from the authenticated
 *   session identity. A claimed (header-supplied) session can only take the
 *   curator role away from a caller, never grant it.
 */
export function releaseAuthorization(
  namespace: KnowledgeNamespace,
  callerBranch: Pick<Branch, 'branch_id' | 'custom_context'> | null,
  manifestExists: boolean,
  branchVerified = true
): ReleaseAuthorization {
  const permission = namespace.effective_permission ?? 'none';
  const owner = providerOwnerBranchId(namespace);
  const inTeammateSession = !!callerBranch && isTeammate(callerBranch);
  if (inTeammateSession && branchVerified && owner && callerBranch.branch_id === owner) {
    return { allowed: true, as: 'curator' };
  }
  if (!inTeammateSession && permission === 'own') return { allowed: true, as: 'curator' };
  if (!manifestExists && RANK[permission] >= RANK.write) return { allowed: true, as: 'bootstrap' };
  return {
    allowed: false,
    reason: manifestExists
      ? `Only the curator can release skill sets in ${namespace.slug}: a session on the teammate that owns it, or a caller outside a teammate session with own access.`
      : `Cutting the first release in ${namespace.slug} needs write access to it.`,
  };
}

export interface ReleasePlan {
  record: SkillSetRecord;
  teammate: SkillTeammate;
  /** Version number the manifest had when read; 0 when it did not exist. */
  expectedVersion: number;
  manifest: SkillSetManifest;
}

export type ReleaseOutcome =
  | { status: 'released'; record: SkillSetRecord; manifest: SkillSetManifest }
  | { status: 'unchanged'; record: SkillSetRecord }
  | { status: 'skipped'; record: SkillSetRecord; reason: string };

export class SkillSets {
  constructor(private readonly provider: KnowledgeSkillProvider) {}

  private get app() {
    return this.provider.serviceApp;
  }

  private async readManifest(namespace: KnowledgeNamespace, key: string): Promise<SkillSetRecord> {
    const path = skillSetPath(key);
    const docs = paginatedData<HydratedKnowledgeDocument>(
      await this.app.service('kb/documents').find(
        this.provider.paramsWith({
          namespace_id: namespace.namespace_id,
          path,
          archived: false,
          include_content: true,
          $limit: 1,
        })
      )
    );
    const document = docs.find((doc) => doc.path === path) ?? null;
    if (!document) return { namespace, key, path, document: null, manifest: null };
    if (document.kind !== 'bundle') {
      return { namespace, key, path, document, manifest: null, error: `${path} is not a bundle` };
    }
    const parsed = parseSkillSetManifest(document.content ?? '');
    return 'manifest' in parsed
      ? { namespace, key, path, document, manifest: parsed.manifest }
      : { namespace, key, path, document, manifest: null, error: parsed.error };
  }

  /**
   * The teammate's manifest in `namespace`. The key is the first of the
   * teammate's keys that already has a manifest; otherwise the key of the
   * folder its skills are filed under; otherwise its full-name slug.
   */
  async find(
    namespace: KnowledgeNamespace,
    teammate: SkillTeammate,
    skills?: SkillSummary[]
  ): Promise<SkillSetRecord> {
    for (const key of teammate.keys) {
      const record = await this.readManifest(namespace, key);
      if (record.document) return record;
    }
    const assigned = skills ?? (await this.namespaceSkills(namespace, teammate));
    const folders = new Set(
      assigned.flatMap((skill) =>
        skill.assignment.kind === 'teammate' ? [skill.assignment.key] : []
      )
    );
    const key =
      teammate.keys.find((candidate) => folders.has(candidate)) ??
      teammate.keys.at(-1) ??
      teammate.name;
    return { namespace, key, path: skillSetPath(key), document: null, manifest: null };
  }

  /** The teammate's skills in one provider namespace, current versions. */
  async namespaceSkills(
    namespace: KnowledgeNamespace,
    teammate: SkillTeammate
  ): Promise<SkillSummary[]> {
    return (await this.provider.list({ teammateKeys: teammate.keys })).filter(
      (skill) => skill.namespace_id === namespace.namespace_id
    );
  }

  /** Per-skill status of a release against what is stored now. */
  async status(manifest: SkillSetManifest): Promise<SkillSetEntryStatus[]> {
    return Promise.all(
      manifest.skills.map(async (entry): Promise<SkillSetEntryStatus> => {
        const pinned = {
          provider: this.provider.id,
          id: entry.document_id,
          version_id: entry.version_id,
          version_number: entry.version_number,
          sha256: entry.sha256,
        };
        const verification = await this.provider.verify(pinned);
        if (verification.status !== 'ok') {
          return {
            ...entry,
            status: verification.status === 'missing' ? 'missing' : 'hash_mismatch',
          };
        }
        let latest: SkillSummary;
        try {
          latest = await this.provider.get({ provider: this.provider.id, id: entry.document_id });
        } catch {
          return { ...entry, status: 'missing' };
        }
        return {
          ...entry,
          status: latest.version_number > entry.version_number ? 'update_available' : 'current',
          latest_version_number: latest.version_number,
          ...(latest.version ? { latest_version: latest.version } : {}),
        };
      })
    );
  }

  /**
   * Read the manifest and pin the current skills. Throws Conflict when
   * `expectedVersion` is given and the manifest is not at that version
   * (0 = must not exist yet), or when an existing manifest cannot be parsed.
   */
  async plan(
    namespace: KnowledgeNamespace,
    teammate: SkillTeammate,
    options: { actor: string; expectedVersion?: number | string; now?: Date }
  ): Promise<ReleasePlan> {
    const skills = await this.namespaceSkills(namespace, teammate);
    const record = await this.find(namespace, teammate, skills);
    const current = record.document?.current_version;
    const currentVersion = current?.version_number ?? 0;
    if (options.expectedVersion !== undefined) {
      const expected = String(options.expectedVersion);
      if (expected !== String(currentVersion) && expected !== current?.version_id) {
        throw new Conflict(
          `${namespace.slug}/${record.path} is at version ${currentVersion}, not ${expected}. Re-read it with agor_skillsets_get and retry.`
        );
      }
    }
    if (record.document && !record.manifest) {
      throw new Conflict(
        `${namespace.slug}/${record.path} is not a valid skill set manifest (${record.error}). Fix or archive it before releasing.`
      );
    }
    const manifest: SkillSetManifest = {
      name: record.key,
      teammate: teammate.name,
      release: (record.manifest?.release ?? 0) + 1,
      created_at: (options.now ?? new Date()).toISOString(),
      created_by: options.actor,
      skills: skills.map(entryOf).sort((a, b) => a.path.localeCompare(b.path)),
    };
    return { record, teammate, expectedVersion: currentVersion, manifest };
  }

  /**
   * Write a planned release, unless it pins exactly what the current release
   * pins (`unchanged`) or there is nothing to pin and no release yet (`skipped`).
   * A write that loses a race throws Conflict.
   */
  async commit(plan: ReleasePlan): Promise<ReleaseOutcome> {
    const { record, manifest } = plan;
    if (record.manifest && sameSkillPins(record.manifest.skills, manifest.skills)) {
      return { status: 'unchanged', record };
    }
    if (!record.manifest && manifest.skills.length === 0) {
      return { status: 'skipped', record, reason: 'no skills are assigned to this teammate' };
    }
    try {
      const documents = this.app.service('kb/documents') as unknown as {
        putDocument(data: Record<string, unknown>, params: unknown): Promise<unknown>;
      };
      const written = (await documents.putDocument(
        {
          namespace_slug: record.namespace.slug,
          path: record.path,
          kind: 'bundle',
          content_text: renderSkillSetManifest(manifest),
          title: `Skill set: ${manifest.teammate}`,
          first_line_is_title: false,
          change_summary: `Release r${manifest.release}`,
          expected_version: plan.expectedVersion,
        },
        this.provider.paramsWith()
      )) as HydratedKnowledgeDocument;
      const reread = await this.readManifest(record.namespace, record.key);
      return {
        status: 'released',
        record: reread.document ? reread : { ...record, document: written, manifest },
        manifest,
      };
    } catch (error) {
      if (isKnowledgeDocumentVersionMismatchError(error)) {
        throw new Conflict(
          `Another release of ${record.namespace.slug}/${record.path} landed first. Re-read it with agor_skillsets_get and retry.`
        );
      }
      if ((error as { code?: unknown } | null)?.code === 403) {
        throw new Forbidden(
          `You cannot write ${record.namespace.slug}/${record.path}: ${(error as Error).message}`
        );
      }
      throw error;
    }
  }
}
