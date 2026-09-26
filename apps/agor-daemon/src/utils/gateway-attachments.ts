/**
 * Server-side ingestion of inbound gateway message attachments.
 *
 * Downloads supported files attached to inbound gateway messages and stores
 * them in the existing tenant/session/branch upload staging layer. Slack
 * downloads use the channel's bot token; Discord downloads use the signed CDN
 * URL supplied by the provider and never receive a channel credential.
 *
 * Other attachment types (office documents, archives, media) are out of scope
 * and never downloaded; they are reported as `skipped` so the caller can tell
 * the user why nothing arrived. Downloads are restricted to provider-owned URLs
 * and to the same per-file size / per-message count ceilings the upload route
 * enforces.
 */

import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InboundFile } from '@agor/core/gateway';
import { isAllowedDiscordAttachmentUrl } from '@agor/core/gateway';
import type {
  BranchID,
  SessionID,
  TenantID,
  UploadMetadata,
  UploadStagingStore,
  UserID,
} from '@agor/core/types';
import { buildUploadAttachmentPrompt, normalizeUploadMimeType } from '@agor/core/types';
import { getUploadLimits, MAX_UPLOAD_FILES_PER_REQUEST } from './upload.js';
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
   *
   * Fork delta (fork PR #38), and deliberately optional: upstream-owned ingest
   * paths with no notion of "refused by type" — the Discord image path, and
   * whatever provider upstream adds next — satisfy this contract unchanged.
   * Absent reads as zero at every call site. Making it required is what turns
   * each upstream sync into a compile break here.
   */
  skipped?: number;
  /** Normalized MIME types of the `skipped` attachments, in arrival order. */
  skippedMimeTypes?: string[];
}

const MAX_REDIRECT_HOPS = 3;
const DISCORD_IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
export const DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Whether a Slack file URL may be downloaded with the channel's bot token.
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

/**
 * MIME types the ingestion pipeline accepts: images, text-like files (logs,
 * plain text, CSV, JSON, markdown), and PDFs — the types agents read as
 * context. Unlike browser uploads (any type, chosen by the signed-in user),
 * gateway ingestion downloads third-party-posted files automatically, so it
 * stays deliberately narrow and excludes script-bearing types like
 * image/svg+xml as well as office documents and archives.
 */
const GATEWAY_INGEST_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Fork delta (fork PR #38): PDFs are ingested as well. Agents read them
  // directly, and Slack senders routinely attach them. Kept inside upstream's
  // explicit set so the type stays reviewed alongside the others.
  'application/pdf',
]);

function isAllowedIngestMime(rawMime: string): boolean {
  return GATEWAY_INGEST_MIME_TYPES.has(normalizeUploadMimeType(rawMime));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Discord attachment download timed out');
}

/**
 * Cancel a response whose body will not be consumed. Fetch implementations
 * differ in whether cancellation rejects for an already-locked body, so this
 * is deliberately best-effort and never masks the original download error.
 */
async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The Node readable created from the body owns cancellation after handoff.
  }
}

/** Race a provider fetch against the per-attachment deadline. */
function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateResolve?: (value: T) => void
): Promise<T> {
  if (signal.aborted) {
    void operation.then(
      (value) => onLateResolve?.(value),
      () => undefined
    );
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    function cleanup(): void {
      signal.removeEventListener('abort', onAbort);
    }
    function onAbort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) {
          onLateResolve?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function discordDownloadTimeoutError(): Error {
  return Object.assign(new Error('Discord attachment download timed out'), {
    code: 'ETIMEDOUT' as const,
  });
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
  const mime = normalizeUploadMimeType(rawMime);
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
 * URL is validated against the provider-specific allowlist before it is
 * fetched. This makes credential forwarding (where a provider requires it)
 * an invariant of this function, rather than a property of the runtime's
 * cross-origin redirect header stripping.
 */
async function fetchFromAllowedHosts(
  initialUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  isAllowedUrl: (rawUrl: string) => boolean = isAllowedSlackFileUrl,
  signal?: AbortSignal
): Promise<Response> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedUrl(url)) {
      throw new Error('download URL host not allowed');
    }
    if (signal?.aborted) throw abortReason(signal);
    const request = { headers, redirect: 'manual' as const };
    const response = signal
      ? await withAbort(
          Promise.resolve().then(() => fetchImpl(url, { ...request, signal })),
          signal,
          (lateResponse) => void cancelResponseBody(lateResponse)
        )
      : await fetchImpl(url, request);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        await cancelResponseBody(response);
        throw new Error(`redirect (HTTP ${response.status}) without Location header`);
      }
      await cancelResponseBody(response);
      url = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw new Error(`too many redirects (limit ${MAX_REDIRECT_HOPS})`);
}

function discordImageMime(rawMime: string): string {
  return rawMime.split(';')[0].trim().toLowerCase();
}

/**
 * Download only the live Discord PNG/JPEG subset. Discord's URL is already
 * signed, so this path deliberately sends no Authorization header and
 * validates every manually-followed redirect against the same signed CDN
 * policy.
 */
export async function ingestDiscordInboundImages(args: {
  files: InboundFile[];
  fetchImpl?: typeof fetch;
  tenantId: TenantID;
  sessionId: SessionID;
  branchId: BranchID;
  createdBy: UserID;
  store?: UploadStagingStore;
  /** Test seam; production uses the fixed bounded deadline below. */
  downloadTimeoutMs?: number;
}): Promise<AttachmentIngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const store = args.store ?? getUploadStagingStore();
  const downloadTimeoutMs = args.downloadTimeoutMs ?? DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(downloadTimeoutMs) ||
    downloadTimeoutMs <= 0 ||
    downloadTimeoutMs > MAX_TIMER_MS
  ) {
    throw new Error('Invalid Discord attachment download timeout');
  }
  const limits = getUploadLimits();
  const uploads: UploadMetadata[] = [];
  let failed = 0;
  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;

  for (const [index, file] of args.files.entries()) {
    if (index >= MAX_UPLOAD_FILES_PER_REQUEST) {
      failed++;
      console.warn(
        `[gateway] Skipping Discord attachment: message exceeds ${MAX_UPLOAD_FILES_PER_REQUEST}-file limit`
      );
      continue;
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > limits.maxFileBytes ||
      file.size > limits.maxTotalBytes - declaredTotalBytes
    ) {
      failed++;
      console.warn(
        '[gateway] Skipping Discord attachment: declared size exceeds the upload limits'
      );
      continue;
    }
    if (
      (file.mimetype !== 'image/png' && file.mimetype !== 'image/jpeg') ||
      !isAllowedDiscordAttachmentUrl(file.url_private_download)
    ) {
      failed++;
      console.warn('[gateway] Skipping Discord attachment: unsupported type or URL');
      continue;
    }
    declaredTotalBytes += file.size;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(discordDownloadTimeoutError()),
      downloadTimeoutMs
    );
    timeout.unref?.();
    let response: Response | undefined;
    try {
      response = await fetchFromAllowedHosts(
        file.url_private_download,
        {},
        fetchImpl,
        isAllowedDiscordAttachmentUrl,
        controller.signal
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = discordImageMime(response.headers.get('content-type') ?? '');
      if (!DISCORD_IMAGE_MIMES.has(contentType)) {
        throw new Error(`unexpected content-type ${contentType || 'unknown'}`);
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes) {
        throw new Error(`declared size ${declaredLength} exceeds per-file limit`);
      }
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > limits.maxTotalBytes - actualTotalBytes
      ) {
        throw new Error(`declared size ${declaredLength} exceeds total upload limit`);
      }
      if (!response.body) throw new Error('download response has no body');
      let fileBytes = 0;
      const source = Readable.fromWeb(response.body as never);
      const aggregateLimiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileBytes += chunk.byteLength;
          if (actualTotalBytes + fileBytes > limits.maxTotalBytes) {
            callback(
              Object.assign(new Error('Combined Discord attachment size exceeds upload limit'), {
                status: 413,
              })
            );
            return;
          }
          callback(null, chunk);
        },
      });
      const onAbort = () => {
        const reason = abortReason(controller.signal);
        source.destroy(reason);
        aggregateLimiter.destroy(reason);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      let stagePromise: Promise<UploadMetadata> | undefined;
      let sourcePipelinePromise: Promise<void> | undefined;
      try {
        const currentStagePromise = store.stage({
          owner: {
            tenantId: args.tenantId,
            sessionId: args.sessionId,
            branchId: args.branchId,
            createdBy: args.createdBy,
          },
          name: `${file.id}_${file.name}`,
          mimeType: contentType,
          provenance: 'gateway-discord',
          body: aggregateLimiter,
          sizeHint: Number.isFinite(declaredLength) ? declaredLength : file.size,
        });
        stagePromise = currentStagePromise;
        const currentSourcePipelinePromise = pipeline(source, aggregateLimiter);
        sourcePipelinePromise = currentSourcePipelinePromise;
        const [staged] = await Promise.all([currentStagePromise, currentSourcePipelinePromise]);
        if (staged.size === 0) {
          await store.delete({
            tenantId: args.tenantId,
            sessionId: args.sessionId,
            branchId: args.branchId,
            ref: staged.ref,
          });
          throw new Error('Discord attachment download was empty');
        }
        actualTotalBytes += staged.size;
        uploads.push(staged);
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error));
        source.destroy(reason);
        aggregateLimiter.destroy(reason);
        await Promise.allSettled(
          [stagePromise, sourcePipelinePromise].filter(
            (promise): promise is Promise<UploadMetadata> | Promise<void> => promise !== undefined
          )
        );
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        source.destroy();
        aggregateLimiter.destroy();
      }
    } catch (error) {
      failed++;
      console.warn('[gateway] Failed to ingest Discord attachment:', error);
    } finally {
      clearTimeout(timeout);
      if (response) await cancelResponseBody(response);
    }
  }

  return { uploads, failed };
}

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
        throw new Error(
          `unexpected content-type ${normalizeUploadMimeType(contentType) || 'unknown'}`
        );
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
        mimeType: normalizeUploadMimeType(contentType),
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
