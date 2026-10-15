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
 * **Who may release.** Only two callers, both decided outside Knowledge:
 * - the *curator*: a session whose authenticated branch is the provider's
 *   `curator_branch_id` in config.yaml (`agor_skillsets_release`);
 * - an *admin* outside any session, through `agor skills release` (the
 *   `skills/releases` route). This is also how r1 is first cut.
 * Every other write under `skillsets/` is refused by the Knowledge write path
 * itself (`skill set governance`), so ordinary `agor_kb_*` edits, renames,
 * archives or imports cannot forge or reopen a release.
 */

import type { AgorSkillsProviderSettings } from '@agor/core/config';
import { BadRequest, Conflict, Forbidden } from '@agor/core/feathers';
import {
  parseSkillSetManifest,
  renderSkillSetManifest,
  sameSkillPins,
  skillSetPath,
  skillTextField,
} from '@agor/core/knowledge';
import type {
  HydratedKnowledgeDocument,
  KnowledgeNamespace,
  SkillSetEntry,
  SkillSetEntryStatus,
  SkillSetManifest,
  SkillSummary,
} from '@agor/core/types';
import { isKnowledgeDocumentVersionMismatchError } from '../services/knowledge-errors.js';
import type { KnowledgeSkillProvider } from './knowledge-skill-provider.js';
import { withSkillsetReleaseWrite } from './skillset-governance.js';
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
  const version = skillTextField(skill.version, 32);
  return {
    name: skillTextField(skill.name, 64) || skill.path,
    ...(version ? { version } : {}),
    document_id: skill.document_id,
    path: skill.path,
    version_id: skill.version_id,
    version_number: skill.version_number,
    sha256: skill.sha256,
  };
}

export type ReleaseAuthorization =
  | { allowed: true; as: 'curator' | 'admin' }
  | { allowed: false; reason: string };

/**
 * Whether a session may cut releases in a provider namespace: only when its
 * authenticated branch is the configured curator. A claimed (unverified)
 * session never qualifies, and neither does namespace ownership.
 */
export function curatorAuthorization(
  provider: Pick<AgorSkillsProviderSettings, 'namespace' | 'curator_branch_id'> | undefined,
  callerBranchId: string | null | undefined,
  branchVerified: boolean
): ReleaseAuthorization {
  if (
    provider &&
    branchVerified &&
    callerBranchId &&
    callerBranchId === provider.curator_branch_id
  ) {
    return { allowed: true, as: 'curator' };
  }
  return {
    allowed: false,
    reason: provider
      ? `Only the curator session can release skill sets in ${provider.namespace} (its configured curator_branch_id). Admins can run \`agor skills release\` outside a session.`
      : 'This namespace is not a configured skills provider.',
  };
}

/** Teammate keys tried when looking for an existing manifest. */
const MAX_MANIFEST_KEYS = 8;

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
   * The teammate's existing manifest in `namespace`: a direct path read of
   * `skillsets/<key>.md` for each of the teammate's keys (at most
   * {@link MAX_MANIFEST_KEYS}). Never lists skills. `document` is null when
   * no manifest exists; `key` is then the teammate's full-name slug.
   */
  async find(namespace: KnowledgeNamespace, teammate: SkillTeammate): Promise<SkillSetRecord> {
    for (const key of teammate.keys.slice(0, MAX_MANIFEST_KEYS)) {
      const record = await this.readManifest(namespace, key);
      if (record.document) return record;
    }
    const key = teammate.keys.at(-1) ?? teammate.name;
    return { namespace, key, path: skillSetPath(key), document: null, manifest: null };
  }

  /** Where a new manifest goes: the teammate's skill folder key, else its full-name slug. */
  private newManifestKey(teammate: SkillTeammate, skills: SkillSummary[]): string {
    const folders = new Set(
      skills.flatMap((skill) =>
        skill.assignment.kind === 'teammate' ? [skill.assignment.key] : []
      )
    );
    return (
      teammate.keys.find((candidate) => folders.has(candidate)) ??
      teammate.keys.at(-1) ??
      teammate.name
    );
  }

  /** The teammate's skills in one provider namespace, current versions. */
  async namespaceSkills(
    namespace: KnowledgeNamespace,
    teammate: SkillTeammate
  ): Promise<SkillSummary[]> {
    return this.provider.listNamespace(namespace, { teammateKeys: teammate.keys });
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
    const found = await this.find(namespace, teammate);
    const record = found.document
      ? found
      : (() => {
          const key = this.newManifestKey(teammate, skills);
          return { ...found, key, path: skillSetPath(key) };
        })();
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
      teammate: skillTextField(teammate.name, 120) || record.key,
      release: (record.manifest?.release ?? 0) + 1,
      created_at: (options.now ?? new Date()).toISOString(),
      created_by: options.actor,
      skills: skills.map(entryOf).sort((a, b) => a.path.localeCompare(b.path)),
    };
    return { record, teammate, expectedVersion: currentVersion, manifest };
  }

  /**
   * Write a planned release, unless it pins exactly what the current release
   * pins (`unchanged`) or there is nothing to pin and no release yet
   * (`skipped`). The manifest is rendered and round-trip checked first, so an
   * oversized or unreadable release fails without touching the current one.
   * A write that loses a race throws Conflict.
   *
   * Callers must have authorized the release (curator session or admin route);
   * this method carries the governance capability the Knowledge write path
   * requires. `writeParams` adds actor attribution (session, teammate).
   */
  async commit(
    plan: ReleasePlan,
    writeParams: Record<string, unknown> = {}
  ): Promise<ReleaseOutcome> {
    const { record, manifest } = plan;
    if (record.manifest && sameSkillPins(record.manifest.skills, manifest.skills)) {
      return { status: 'unchanged', record };
    }
    if (!record.manifest && manifest.skills.length === 0) {
      return { status: 'skipped', record, reason: 'no skills are assigned to this teammate' };
    }
    let content: string;
    try {
      content = renderSkillSetManifest(manifest);
    } catch (error) {
      throw new BadRequest(
        `Release r${manifest.release} of ${record.namespace.slug}/${record.path} was not written: ${(error as Error).message}`
      );
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
          content_text: content,
          title: `Skill set: ${manifest.teammate}`,
          first_line_is_title: false,
          change_summary: `Release r${manifest.release}`,
          expected_version: plan.expectedVersion,
        },
        withSkillsetReleaseWrite({ ...this.provider.paramsWith(), ...writeParams })
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
