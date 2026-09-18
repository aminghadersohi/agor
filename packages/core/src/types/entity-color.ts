// src/types/entity-color.ts

/**
 * Board entity colors — the user-chosen organisational signal shared by
 * Branch cards and Cards.
 *
 * Color on a board is a *human* label, in the Trello sense: someone picks it
 * to group work or flag priority, and it means whatever they decided it means.
 * Nothing in Agor derives it from CI state, PR state, environment health, or
 * any other computed property, and nothing should start doing so — a color the
 * product assigns is no longer a color the user can use.
 */

/**
 * Accepted persisted form: `#rgb`, `#rrggbb`, or `#rrggbbaa`.
 *
 * Every color the UI can produce is a hex string (AntD's `ColorPicker`
 * serializes through `toHexString()`), so constraining storage to hex costs
 * nothing and keeps a free-text column from becoming an arbitrary CSS value
 * that renderers have to reason about.
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True when `value` is a hex color Agor is willing to persist. */
export function isValidEntityColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim());
}

/**
 * Normalize a user-supplied color override for persistence.
 *
 * Returns a lowercased hex string, or `null` for "no color" — which covers
 * `null`, `undefined`, the empty string, and anything that isn't valid hex.
 * Mirrors how the Card repository treats `url` (`sanitizeUrl`): an
 * unrepresentable value is stored as absent rather than persisted unchecked.
 */
export function normalizeEntityColor(value: unknown): string | null {
  if (!isValidEntityColor(value)) return null;
  return value.trim().toLowerCase();
}
