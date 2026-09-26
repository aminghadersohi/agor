/**
 * Compatibility re-export for daemon call sites. Codex's auth.json schema has
 * one pure owner in core so import validation and executor inspection cannot
 * drift apart.
 *
 * Names are listed explicitly: the daemon build splits shared code into
 * chunks, and esbuild cannot resolve a named import through `export *` of an
 * external package across a chunk boundary.
 */
export type { CodexAuthSummary, ParseCodexAuthResult } from '@agor/core/codex/auth-file';
export { codexIdTokenClaims, parseCodexAuthJson } from '@agor/core/codex/auth-file';
