import { normalizeEntityColor } from '@agor/core/types';
import { coerceString } from './server.js';

/**
 * Shared MCP description of a board entity color (branch cards and cards).
 * See `packages/core/src/types/entity-color.ts` for why color stays human-chosen.
 */
export function entityColorOverrideDescription(entity: string): string {
  return (
    `User-chosen organisational color for ${entity}, as hex ` +
    '(#rgb, #rrggbb, or #rrggbbaa). This is a human grouping/priority label in the ' +
    'Trello sense — do not derive it from CI, PR, or environment state.'
  );
}

/**
 * Parse an agent-supplied color override. Empty means "no color" (`null`);
 * anything else must be hex. The repositories silently store an invalid value
 * as absent, so reject it loudly here rather than dropping the agent's value.
 */
export function parseEntityColorOverride(value: unknown, field = 'colorOverride'): string | null {
  const raw = coerceString(value);
  if (!raw) return null;
  const normalized = normalizeEntityColor(raw);
  if (!normalized) {
    throw new Error(`${field} must be a hex color like #ff5630 (received ${JSON.stringify(raw)})`);
  }
  return normalized;
}
