/**
 * Team skills delivery at session start.
 *
 * On a teammate branch (unless its config has `skills.enabled: false`), the
 * daemon resolves the teammate's latest skill set release, renders a compact
 * index, and passes it to the executor (`params.skillsIndex`), which appends
 * it to the Agor system prompt every harness already receives. The first
 * delivery writes a receipt to `session.custom_context.skills_receipt`; later
 * tasks of the same session re-render that same release, so a running session
 * keeps what it started with.
 *
 * Reads use the prompt actor's params, so a caller only ever gets skills it
 * could read itself. Nothing here may fail a session: every problem is a
 * missing index plus one log line.
 */

import type { Application } from '@agor/core/feathers';
import { parseSkillSetManifest } from '@agor/core/knowledge';
import {
  type AuthenticatedParams,
  type Branch,
  getTeammateConfig,
  type HydratedKnowledgeDocument,
  isTeammate,
  type KnowledgeNamespace,
  SESSION_SKILLS_RECEIPT_KEY,
  type Session,
  type SessionSkillsReceipt,
  type SkillSetManifest,
} from '@agor/core/types';
import { KnowledgeSkillProvider, sha256Hex } from './knowledge-skill-provider.js';
import { truncateOneLine } from './render.js';
import { SkillSets } from './skillsets.js';
import { type SkillTeammate, skillTeammateOf } from './teammate.js';

/** Index entries shown before the truncation note. */
export const SKILLS_INDEX_MAX_ENTRIES = 60;
/** Index size, header and footer included. */
export const SKILLS_INDEX_MAX_CHARS = 8000;
const INDEX_DESCRIPTION_CHARS = 160;
const PIN_READ_CONCURRENCY = 8;
/** Delivery gives up after this long and starts the session without an index. */
export const SKILLS_DELIVERY_TIMEOUT_MS = 5000;

export interface SkillsIndexEntry {
  name: string;
  version?: string;
  description?: string;
  namespace: string;
  path: string;
}

/**
 * ```
 * ## Team skills (Professor Fritz r3)
 * - research-loop v0.1.4 — Plan, run and file a research question … [assistant-…/skills/fritz/research-loop.md]
 *
 * Before doing one of these kinds of task, read the full skill with `agor_skills_get` …
 * ```
 */
export function renderSkillsIndex(input: {
  teammate: string;
  release: number;
  entries: SkillsIndexEntry[];
}): string {
  const header = `## Team skills (${input.teammate} r${input.release})`;
  const footer =
    'Before doing one of these kinds of task, read the full skill with `agor_skills_get` ' +
    '(pass its name). It returns the version pinned by this release.';
  const lines: string[] = [];
  let size = header.length + footer.length + 4;
  for (const entry of input.entries) {
    if (lines.length >= SKILLS_INDEX_MAX_ENTRIES) break;
    const description = truncateOneLine(entry.description, INDEX_DESCRIPTION_CHARS);
    const line =
      `- ${entry.name}${entry.version ? ` v${entry.version}` : ''}` +
      `${description ? ` — ${description}` : ''} [${entry.namespace}/${entry.path}]`;
    // Reserve room for the truncation note.
    if (size + line.length + 1 + 120 > SKILLS_INDEX_MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  const hidden = input.entries.length - lines.length;
  if (hidden > 0) {
    lines.push(
      `- … ${hidden} more skill${hidden === 1 ? '' : 's'} not shown here; run \`agor_skills_list\` for the full list.`
    );
  }
  return [header, ...lines, '', footer].join('\n');
}

function isReceipt(value: unknown): value is SessionSkillsReceipt {
  const receipt = value as Partial<SessionSkillsReceipt> | null;
  return (
    !!receipt &&
    typeof receipt === 'object' &&
    typeof receipt.manifest_document_id === 'string' &&
    typeof receipt.manifest_version_id === 'string' &&
    typeof receipt.release === 'number' &&
    Array.isArray(receipt.skills)
  );
}

export function sessionSkillsReceipt(
  session: Pick<Session, 'custom_context'>
): SessionSkillsReceipt | null {
  const value = (session.custom_context as Record<string, unknown> | undefined)?.[
    SESSION_SKILLS_RECEIPT_KEY
  ];
  return isReceipt(value) ? value : null;
}

export interface SkillsDelivery {
  index: string;
  receipt: SessionSkillsReceipt;
  /** True when this delivery created the receipt (first delivery in the session). */
  isNew: boolean;
}

export type SkillsDeliverySkip = 'not_teammate' | 'opted_out' | 'no_release' | 'receipt_unreadable';

interface ResolvedRelease {
  namespace: KnowledgeNamespace | { slug: string };
  path: string;
  document: HydratedKnowledgeDocument;
  manifest: SkillSetManifest;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The latest release for the teammate in the first provider namespace that has one. */
async function latestRelease(
  provider: KnowledgeSkillProvider,
  teammate: SkillTeammate
): Promise<ResolvedRelease | null> {
  const sets = new SkillSets(provider);
  for (const namespace of await provider.providerNamespaces()) {
    const record = await sets.find(namespace, teammate);
    if (record.document && record.manifest) {
      return {
        namespace,
        path: record.path,
        document: record.document,
        manifest: record.manifest,
      };
    }
  }
  return null;
}

/** The exact release a receipt names, read at its manifest version. */
async function receiptRelease(
  provider: KnowledgeSkillProvider,
  receipt: SessionSkillsReceipt
): Promise<ResolvedRelease | null> {
  const document = (await provider.serviceApp
    .service('kb/documents')
    .get(
      receipt.manifest_document_id,
      provider.paramsWith({ include_content: true, version: receipt.manifest_version_id })
    )) as HydratedKnowledgeDocument;
  const parsed = parseSkillSetManifest(document.content ?? '');
  if (!('manifest' in parsed)) return null;
  return {
    namespace: { slug: receipt.namespace },
    path: receipt.skillset_path,
    document,
    manifest: parsed.manifest,
  };
}

/**
 * The index and receipt for a session, or why there is none. Throws only on
 * unexpected errors; callers wrap it with {@link deliverSkillsSafely}.
 */
export async function resolveSkillsDelivery(input: {
  app: Application;
  /** The prompt actor's params: user, tenant. Reads apply that user's access. */
  params: AuthenticatedParams;
  session: Pick<Session, 'custom_context' | 'agentic_tool'>;
  branch: Branch;
  now?: Date;
}): Promise<SkillsDelivery | { skipped: SkillsDeliverySkip }> {
  const teammate = skillTeammateOf(input.branch);
  if (!teammate) return { skipped: 'not_teammate' };
  if (getTeammateConfig(input.branch)?.skills?.enabled === false) return { skipped: 'opted_out' };

  const provider = new KnowledgeSkillProvider(input.app, input.params);
  const existing = sessionSkillsReceipt(input.session);
  const release = existing
    ? await receiptRelease(provider, existing)
    : await latestRelease(provider, teammate);
  if (!release) return { skipped: existing ? 'receipt_unreadable' : 'no_release' };

  const pinned = await mapLimited(release.manifest.skills, PIN_READ_CONCURRENCY, async (entry) => {
    try {
      const skill = await provider.get({
        provider: provider.id,
        id: entry.document_id,
        version_id: entry.version_id,
        version_number: entry.version_number,
        sha256: entry.sha256,
      });
      // Never advertise content that no longer matches its pin.
      return sha256Hex(skill.content) === entry.sha256 ? { entry, skill } : null;
    } catch {
      return null;
    }
  });
  const delivered = pinned.filter((item): item is NonNullable<typeof item> => item !== null);
  const index = renderSkillsIndex({
    teammate: teammate.name,
    release: release.manifest.release,
    entries: delivered.map(({ entry, skill }) => ({
      name: skill.name,
      ...(skill.version ? { version: skill.version } : {}),
      ...(skill.description ? { description: skill.description } : {}),
      namespace: skill.namespace_slug,
      path: entry.path,
    })),
  });
  const omitted = release.manifest.skills.length - delivered.length;
  const receipt: SessionSkillsReceipt = existing ?? {
    teammate: teammate.name,
    release: release.manifest.release,
    namespace: release.namespace.slug,
    skillset_path: release.path,
    manifest_document_id: release.document.document_id,
    manifest_version_id:
      release.document.current_version?.version_id ??
      (release.document.current_version_id as SessionSkillsReceipt['manifest_version_id']),
    skills: delivered.map(({ entry }) => ({
      name: entry.name,
      version_id: entry.version_id,
      sha256: entry.sha256,
    })),
    delivered_at: (input.now ?? new Date()).toISOString(),
    harness: input.session.agentic_tool,
    ...(omitted > 0 ? { omitted } : {}),
  };
  return { index, receipt, isNew: !existing };
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
}

/**
 * {@link resolveSkillsDelivery} plus receipt persistence, never throwing.
 * Returns the index to pass to the executor, or undefined.
 */
export async function deliverSkillsSafely(input: {
  app: Application;
  /** The prompt actor's params, or a loader for them (only called for teammate branches). */
  params: AuthenticatedParams | (() => Promise<AuthenticatedParams>);
  session: Pick<Session, 'session_id' | 'custom_context' | 'agentic_tool'>;
  branch: Branch | null | undefined;
  /** Persist a new receipt. Defaults to an internal `sessions.patch`. */
  saveReceipt?: (receipt: SessionSkillsReceipt) => Promise<void>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const sessionRef = `session_id=${input.session.session_id}`;
  if (!input.branch || !isTeammate(input.branch)) return undefined;
  try {
    const params = typeof input.params === 'function' ? await input.params() : input.params;
    const result = await Promise.race([
      resolveSkillsDelivery({
        app: input.app,
        params,
        session: input.session,
        branch: input.branch,
      }),
      timeout(input.timeoutMs ?? SKILLS_DELIVERY_TIMEOUT_MS),
    ]);
    if (result === 'timeout') {
      console.warn(`[skills.delivery] timeout ${sessionRef}`);
      return undefined;
    }
    if ('skipped' in result) {
      if (result.skipped !== 'not_teammate') {
        console.debug(`[skills.delivery] skipped reason=${result.skipped} ${sessionRef}`);
      }
      return undefined;
    }
    if (result.isNew) {
      const save =
        input.saveReceipt ??
        (async (receipt: SessionSkillsReceipt) => {
          await input.app.service('sessions').patch(
            input.session.session_id,
            { custom_context: { [SESSION_SKILLS_RECEIPT_KEY]: receipt } },
            {
              provider: undefined,
              ...(params.tenant ? { tenant: params.tenant } : {}),
            }
          );
        });
      await save(result.receipt);
    }
    console.debug(
      `[skills.delivery] delivered ${sessionRef} release=${result.receipt.release} skills=${result.receipt.skills.length}`
    );
    return result.index;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(
      `[skills.delivery] failed ${sessionRef} code=${typeof code === 'string' || typeof code === 'number' ? code : 'unknown'}`
    );
    return undefined;
  }
}
