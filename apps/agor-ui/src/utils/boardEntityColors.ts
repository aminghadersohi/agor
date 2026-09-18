import type { GlobalToken } from 'antd/es/theme/interface';

/**
 * The user-selectable color palette for board entities (branch cards and
 * cards), in the Trello-label sense: a human picks one to group work or flag
 * priority, and it means whatever they decided it means. Nothing derives it
 * from CI, PR, or environment state.
 *
 * Derived from AntD's preset scale (the `-6` "primary saturation" variants)
 * rather than hardcoded hexes, so the swatches track the active theme. This is
 * the same family the zone border/fill pickers already offer — kept here as one
 * list so a color chosen on a zone and a color chosen on a card come from the
 * same set.
 */
export interface BoardEntityPaletteEntry {
  /** Stable, theme-independent name used for the swatch's accessible label. */
  name: string;
  /** Resolved hex for the active theme. */
  color: string;
}

export const boardEntityPalette = (token: GlobalToken): BoardEntityPaletteEntry[] => [
  { name: 'Red', color: token.red6 || token.red },
  { name: 'Orange', color: token.orange6 || token.orange },
  { name: 'Gold', color: token.gold6 || token.gold },
  { name: 'Green', color: token.green6 || token.green },
  { name: 'Cyan', color: token.cyan6 || token.cyan },
  { name: 'Blue', color: token.blue6 || token.blue },
  { name: 'Purple', color: token.purple6 || token.purple },
  { name: 'Magenta', color: token.magenta6 || token.magenta },
];

/** Just the hex values — the shape AntD's `ColorPicker` `presets` prop wants. */
export const boardEntityPaletteColors = (token: GlobalToken): string[] =>
  boardEntityPalette(token).map(({ color }) => color);

/**
 * Resolve the accent stripe (left border) for a board entity.
 *
 * Precedence, highest first:
 *   1. the color the user set on this entity,
 *   2. the color of the zone it's pinned to,
 *   3. the entity's own default (card-type color, teammate accent, neutral border).
 *
 * The user's choice outranks the zone deliberately: pinning a card or branch
 * into a zone would otherwise erase the grouping signal they just picked, which
 * is the only thing the color is for. The zone color still owns the other three
 * edges, so zone membership stays legible.
 */
export function resolveEntityStripeColor(options: {
  userColor?: string;
  zoneColor?: string;
  isPinned?: boolean;
  fallback: string;
}): string {
  const { userColor, zoneColor, isPinned, fallback } = options;
  if (userColor) return userColor;
  if (isPinned && zoneColor) return zoneColor;
  return fallback;
}
