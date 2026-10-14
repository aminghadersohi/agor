import { parseKnowledgeYaml } from './repository.js';

/** Frontmatter larger than this is ignored rather than parsed. */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

const FRONTMATTER_PATTERN = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Leading `---` YAML block of a Markdown file, parsed with the Knowledge YAML
 * rules (JSON schema, no tags/anchors/merge keys). Returns `null` when there is
 * no block, it is too large, it does not parse, or it is not a mapping, so a
 * malformed skill still lists by its file name.
 */
export function parseMarkdownFrontmatter(content: string): Record<string, unknown> | null {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return null;
  const yaml = match[1];
  if (Buffer.byteLength(yaml) > MAX_FRONTMATTER_BYTES) return null;
  try {
    const value = parseKnowledgeYaml(yaml);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
