/**
 * Dependency-free MCP result helpers.
 *
 * Every `src/**` file is its own tsup entry with code splitting off, so a
 * runtime import of `server.ts` (which imports every tool registrar) inlines
 * the entire MCP server into the importing entry. Tool modules that only need
 * a result formatter import it from here instead.
 */

/** Format a value as MCP text content response. */
export function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}
