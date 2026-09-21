/**
 * Server-side ingestion of inbound gateway message attachments.
 *
 * Downloads image, text-like, and PDF files attached to inbound Slack
 * messages using the channel's bot token and stores them in the daemon upload
 * directory — the same destination the session composer's
 * `/sessions/:sessionId/upload` route writes to — so the session's agent can
 * Read them by absolute path.
 *
 * Other attachment types (office documents, archives, media) are out of scope
 * and never downloaded; they are reported as `skipped` so the caller can tell
 * the user why nothing arrived. Downloads are restricted to Slack-owned hosts
 * and to the same per-file size / per-message count ceilings the upload route
 * enforces.
 */

import { Readable } from 'node:stream';
import type { InboundFile } from '@agor/core/gateway';
import type {
  BranchID,
  SessionID,
  TenantID,
  UploadMetadata,
  UploadStagingStore,
  UserID,
} from '@agor/core/types';
import { buildUploadAttachmentPrompt } from '@agor/core/types';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  getUploadLimits,
  MAX_UPLOAD_FILES_PER_REQUEST,
} from './upload.js';
import { getUploadStagingStore } from './upload-staging.js';

export interface AttachmentIngestResult {
  /** Opaque logical records, in the order the attachments arrived. */
  uploads: UploadMetadata[];
  /** Ingestable attachments that could not be fetched or stored. */
  failed: number;
  /**
   * Attachments whose type the pipeline refuses to download at all. Distinct
   * from `failed`: "we will not fetch this type" is a different message to the
   * user than "we could not fetch it".
   */
  skipped: number;
  /** Normalized MIME types of the `skipped` attachments, in arrival order. */
  skippedMimeTypes: string[];
}

const MAX_REDIRECT_HOPS = 3;

/**
 * Whether a platform file URL may be downloaded with the channel's bot token.
 * Slack serves `url_private_download` from files.slack.com; anything outside
 * slack.com would leak the bot token to an attacker-controlled host.
 */
export function isAllowedSlackFileUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'slack.com' || host.endsWith('.slack.com');
}

/** Strip MIME parameters and case so `Text/Plain; charset=utf-8` compares. */
function normalizeMime(rawMime: string): string {
  return rawMime.split(';')[0].trim().toLowerCase();
}

/**
 * MIME types the ingestion pipeline accepts: images, text-like files (logs,
 * plain text, CSV, JSON, markdown), and PDFs — the document types agents can
 * read directly. Constrained to the upload route's allowlist, which
 * deliberately excludes script-bearing types like image/svg+xml; the prefix
 * check additionally keeps allowlisted-but-unsupported types (office
 * documents, archives) out of ingestion.
 */
function isAllowedIngestMime(rawMime: string): boolean {
  const mime = normalizeMime(rawMime);
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) return false;
  return (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/pdf'
  );
}

/** Image, text-like, and PDF attachments the ingestion pipeline accepts. */
export function isIngestableFile(file: InboundFile): boolean {
  return isAllowedIngestMime(file.mimetype);
}

/**
 * MIME type to name in a user-facing note. Slack supplies this string, so it
 * is reported only when it looks like a MIME type — never echoed verbatim
 * into a prompt.
 */
function describeMime(rawMime: string): string {
  const mime = normalizeMime(rawMime);
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : 'unknown';
}

/**
 * User-facing note for attachments the pipeline will not download. Without it
 * a dropped attachment is entirely invisible to the agent and the sender —
 * Slack inbound prompts carry no gateway context block to fall back on.
 */
export function formatSkippedAttachmentNote(skipped: number, mimeTypes: string[]): string {
  const distinct = [...new Set(mimeTypes)];
  const subject = skipped === 1 ? '1 attachment was' : `${skipped} attachments were`;
  if (distinct.length === 0) return `(${subject} not delivered: unsupported type)`;
  const types = distinct.length === 1 ? `type ${distinct[0]}` : `types ${distinct.join(', ')}`;
  return `(${subject} not delivered: unsupported ${types})`;
}

export function buildPromptWithAttachments(text: string, attachments: UploadMetadata[]): string {
  return buildUploadAttachmentPrompt(
    text,
    attachments.map(({ ref, name, mimeType, size }) => ({ ref, filename: name, mimeType, size }))
  );
}

/**
 * Fetch an allowlisted URL, following redirects manually so that EVERY hop's
 * host is validated against the Slack allowlist before it is fetched. This
 * makes "the bot-token Authorization header is only ever sent to allowlisted
 * slack.com hosts" an invariant of this function, rather than a property of
 * the runtime's cross-origin redirect header stripping.
 */
async function fetchFromAllowedHosts(
  initialUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<Response> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedSlackFileUrl(url)) {
      throw new Error('download URL host not allowed');
    }
    const response = await fetchImpl(url, { headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`redirect (HTTP ${response.status}) without Location header`);
      }
      url = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw new Error(`too many redirects (limit ${MAX_REDIRECT_HOPS})`);
}

/**
 * Buffer a response body while enforcing the byte ceiling on the ACTUAL bytes
 * received, aborting mid-stream the moment the running total exceeds it —
 * Content-Length can be absent or false, so the declared-size prechecks are
 * only cheap early-outs, never the bound.
 */
/**
 * Download the ingestable attachments of one inbound message and store them
 * in tenant-scoped staging. Never throws: every attachment that cannot be
 * fetched, validated, or written is counted in `failed`, and every attachment
 * whose type is out of scope in `skipped`, so the caller can still deliver the
 * prompt with a degradation note.
 */
export async function ingestInboundAttachments(args: {
  files: InboundFile[];
  botToken: string;
  fetchImpl?: typeof fetch;
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
  store?: UploadStagingStore;
}): Promise<AttachmentIngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const store = args.store ?? getUploadStagingStore();

  const ingestable = args.files.filter(isIngestableFile);
  const skippedMimeTypes = args.files
    .filter((file) => !isIngestableFile(file))
    .map((file) => describeMime(file.mimetype));
  for (const mimeType of skippedMimeTypes) {
    console.warn(`[gateway] Not downloading attachment of unsupported type ${mimeType}`);
  }
  const uploads: UploadMetadata[] = [];
  let failed = 0;

  for (const [index, file] of ingestable.entries()) {
    if (index >= MAX_UPLOAD_FILES_PER_REQUEST) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": message exceeds ${MAX_UPLOAD_FILES_PER_REQUEST}-file limit`
      );
      continue;
    }
    const maxFileBytes = getUploadLimits().maxFileBytes;
    if (file.size > maxFileBytes) {
      failed++;
      console.warn(
        `[gateway] Skipping attachment "${file.name}": ${file.size} bytes exceeds per-file limit ${maxFileBytes}`
      );
      continue;
    }
    if (!isAllowedSlackFileUrl(file.url_private_download)) {
      failed++;
      console.warn(`[gateway] Skipping attachment "${file.name}": download URL host not allowed`);
      continue;
    }

    try {
      const response = await fetchFromAllowedHosts(
        file.url_private_download,
        { Authorization: `Bearer ${args.botToken}` },
        fetchImpl
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // Slack answers with an HTML login/error page (status 200) when the
      // token lacks files:read or cannot see the file — only accept response
      // bodies whose type the ingestion pipeline allows (which excludes
      // text/html and script-bearing types like image/svg+xml).
      const contentType = response.headers.get('content-type') ?? '';
      if (!isAllowedIngestMime(contentType)) {
        throw new Error(`unexpected content-type ${normalizeMime(contentType) || 'unknown'}`);
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) {
        throw new Error(`declared size ${declaredLength} exceeds per-file limit`);
      }
      if (!response.body) throw new Error('download response has no body');
      const staged = await store.stage({
        owner: {
          tenantId: args.tenantId,
          sessionId: args.sessionId,
          branchId: args.branchId,
          createdBy: args.createdBy,
        },
        name: `${file.id}_${file.name}`,
        mimeType: normalizeMime(contentType),
        provenance: 'gateway-slack',
        body: Readable.fromWeb(response.body as never),
        sizeHint: Number.isFinite(declaredLength) ? declaredLength : file.size,
      });
      uploads.push(staged);
    } catch (error) {
      failed++;
      console.warn(`[gateway] Failed to ingest attachment "${file.name}":`, error);
    }
  }

  return { uploads, failed, skipped: skippedMimeTypes.length, skippedMimeTypes };
}
