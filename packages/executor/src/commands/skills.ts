/**
 * `branch.skills.scan`: read-only scan of a branch worktree for skill files.
 *
 * Looks only at `skills/*.md`, `skills/<name>/SKILL.md` and
 * `.claude/skills/<name>/SKILL.md`. Every path is resolved with `realpath`
 * and must stay inside the branch root, so a skill folder linked to another
 * in-repo folder lists normally while one linked outside the worktree is
 * skipped. The scan stops at `maxFiles` and refuses files over `maxFileBytes`
 * without reading them.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { frontmatterString, parseMarkdownFrontmatter } from '@agor/core/knowledge';
import type { BranchSkillFile, BranchSkillScan, BranchSkillScanSkip } from '@agor/core/types';
import type { BranchSkillsScanPayload, ExecutorResult } from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { isPathInsideRoot, resolveExecutorBranch } from './branch-filesystem.js';
import type { CommandOptions } from './index.js';

export const BRANCH_SKILL_SCAN_LIMITS = {
  maxFiles: 500,
  maxFileBytes: 256 * 1024,
  /** Directory entries examined per skills folder, so a huge folder cannot stall the scan. */
  maxDirEntries: 2_000,
} as const;

export type BranchSkillScanLimits = { [K in keyof typeof BRANCH_SKILL_SCAN_LIMITS]: number };

/** Files under `skills/` that document the folder rather than define a skill. */
function isSkillDocFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.md') && !lower.startsWith('_') && lower !== 'readme.md';
}

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/** Up to `limit` entries of `dir` in name order, or `null` when it is not a readable directory. */
async function listDir(
  dir: string,
  limit: number
): Promise<{ entries: Dirent[]; capped: boolean } | null> {
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(dir);
  } catch {
    return null;
  }
  const entries: Dirent[] = [];
  let capped = false;
  try {
    for await (const entry of handle) {
      if (entries.length >= limit) {
        capped = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    // A directory that vanishes mid-read lists what was read so far.
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, capped };
}

/** Worktree-relative candidate paths in scan order; each is validated when read. */
async function collectCandidates(
  root: string,
  limits: BranchSkillScanLimits
): Promise<{ candidates: string[]; capped: boolean; skipped: BranchSkillScanSkip[] }> {
  const candidates: string[] = [];
  const skipped: BranchSkillScanSkip[] = [];
  let capped = false;

  const openFolder = async (relativeDir: string): Promise<Dirent[]> => {
    const real = await realpathOrNull(join(root, relativeDir));
    if (!real) return [];
    if (!isPathInsideRoot(root, real)) {
      skipped.push({ path: toPosix(relativeDir), reason: 'outside-worktree' });
      return [];
    }
    const listing = await listDir(real, limits.maxDirEntries);
    if (!listing) return [];
    if (listing.capped) capped = true;
    return listing.entries;
  };

  for (const entry of await openFolder('skills')) {
    // A symlink may point at a folder or a file; both shapes are tried and the
    // reader drops whichever does not resolve to a regular file.
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      candidates.push(join('skills', entry.name, 'SKILL.md'));
    }
    if ((entry.isFile() || entry.isSymbolicLink()) && isSkillDocFile(entry.name)) {
      candidates.push(join('skills', entry.name));
    }
  }
  for (const entry of await openFolder(join('.claude', 'skills'))) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      candidates.push(join('.claude', 'skills', entry.name, 'SKILL.md'));
    }
  }
  return { candidates, capped, skipped };
}

type ReadResult =
  | { ok: true; content: Buffer; mtime: Date; realPath: string }
  | { ok: false; reason: BranchSkillScanSkip['reason'] | 'missing' };

async function readBoundedFile(
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<ReadResult> {
  const real = await realpathOrNull(join(root, relativePath));
  if (!real) return { ok: false, reason: 'missing' };
  if (!isPathInsideRoot(root, real)) return { ok: false, reason: 'outside-worktree' };

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, 'r');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    // Read one byte past the bound so a file that grew after `stat` is still refused.
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, content: buffer.subarray(0, bytesRead), mtime: stat.mtime, realPath: real };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function skillNameFromPath(relativePath: string): string {
  const base = basename(relativePath);
  if (base === 'SKILL.md') return basename(dirname(relativePath));
  return base.replace(/\.md$/i, '');
}

/** Scan `branchPath` (any path; it is canonicalized first) for skill files. */
export async function scanBranchSkills(
  branchPath: string,
  limits: BranchSkillScanLimits = BRANCH_SKILL_SCAN_LIMITS
): Promise<BranchSkillScan> {
  const root = await realpathOrNull(branchPath);
  if (!root) return { skills: [], skipped: [], truncated: false };

  const { candidates, capped, skipped } = await collectCandidates(root, limits);
  const skills: BranchSkillFile[] = [];
  const seenRealPaths = new Set<string>();
  let truncated = capped;

  for (const relativePath of candidates) {
    if (skills.length >= limits.maxFiles) {
      truncated = true;
      break;
    }
    const result = await readBoundedFile(root, relativePath, limits.maxFileBytes);
    if (!result.ok) {
      // A folder without SKILL.md, or a file link tried as a folder, is not worth reporting.
      if (result.reason === 'missing') continue;
      if (result.reason === 'not-a-file' && relativePath.endsWith('SKILL.md')) continue;
      skipped.push({ path: toPosix(relativePath), reason: result.reason });
      continue;
    }
    // `.claude/skills/x` is often a link to `skills/x`; list the file once.
    if (seenRealPaths.has(result.realPath)) continue;
    seenRealPaths.add(result.realPath);

    const frontmatter = parseMarkdownFrontmatter(result.content.toString('utf8'));
    skills.push({
      name: frontmatterString(frontmatter, 'name', 200) ?? skillNameFromPath(relativePath),
      description: frontmatterString(frontmatter, 'description'),
      path: toPosix(relativePath),
      sha256: createHash('sha256').update(result.content).digest('hex'),
      mtime: result.mtime.toISOString(),
    });
  }

  return { skills, skipped, truncated };
}

export async function handleBranchSkillsScan(
  payload: BranchSkillsScanPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true, command: payload.command } };
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const branch = await resolveExecutorBranch(client, payload.params.branchId);
    const scan = await scanBranchSkills(branch.path);
    return { success: true, data: { scan } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: { code: 'BRANCH_SKILLS_SCAN_FAILED', message } };
  } finally {
    try {
      client?.io.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}
