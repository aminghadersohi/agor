import { parseKnowledgeYaml } from './repository.js';

/** Frontmatter larger than this is ignored rather than parsed. */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

const FRONTMATTER_PATTERN = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Leading `---` YAML block of a Markdown file, parsed with the Knowledge YAML
 * rules (JSON schema, no tags/anchors/merge keys), and the markdown after it.
 * `frontmatter` is `null` when there is no block, it is too large, it does not
 * parse, or it is not a mapping; `body` is then the whole content when there
 * is no block, and the text after the block otherwise.
 */
export function splitMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return { frontmatter: null, body: content };
  const body = content.slice(match[0].length);
  const yaml = match[1];
  if (Buffer.byteLength(yaml) > MAX_FRONTMATTER_BYTES) return { frontmatter: null, body };
  try {
    const value = parseKnowledgeYaml(yaml);
    const frontmatter =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    return { frontmatter, body };
  } catch {
    return { frontmatter: null, body };
  }
}

/**
 * Leading `---` YAML block of a Markdown file; see {@link splitMarkdownFrontmatter}.
 * Returns `null` so a malformed skill still lists by its file name.
 */
export function parseMarkdownFrontmatter(content: string): Record<string, unknown> | null {
  return splitMarkdownFrontmatter(content).frontmatter;
}

export function frontmatterString(
  frontmatter: Record<string, unknown> | null | undefined,
  key: string,
  maxLength = 1024
): string | undefined {
  const value = frontmatter?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}
