/**
 * The seam between the two zone layout vocabularies that share `zone.layout`.
 *
 * A zone's `layout` is either a persisted `ZoneLayoutPolicy` (manual/auto
 * arrange, presets, sort, resize) or an arranged layout string: `row`,
 * `column` or `grid` place pinned cards in display-only slots, and `free`
 * keeps their stored positions. Writes in one vocabulary must never erase the
 * other: an arranged layout parks the zone's policy in `suspended_layout`, and
 * `free` brings it back. Policy engines (arrange, tidy, auto zones, pinning)
 * treat an arranged zone as one opaque rectangle at the size it is shown.
 */
import type {
  BoardPosition,
  SuspendedZoneLayout,
  ZoneBoardObject,
  ZoneLayout,
  ZoneLayoutPolicy,
} from '../types/board.js';
import {
  type AutoZoneLayout,
  isAutoZoneLayout,
  orderZoneEntities,
  planZoneGrid,
  sanitizeZoneOrder,
  ZONE_LAYOUTS,
  zoneLayoutOf,
} from '../utils/zone-layout.js';
import { normalizeZoneLayoutPolicy, zoneLayoutBinding } from './zone-layout.js';

type ZoneLayoutFields = Pick<ZoneBoardObject, 'layout' | 'layout_binding' | 'suspended_layout'>;

/** The zone's row, column or grid layout, or undefined when a policy (or free) places its cards. */
export function arrangedZoneLayout(
  zone: Pick<ZoneBoardObject, 'layout'> | undefined
): AutoZoneLayout | undefined {
  const layout = zoneLayoutOf(zone);
  return isAutoZoneLayout(layout) ? layout : undefined;
}

const isLayoutString = (value: unknown): value is ZoneLayout =>
  typeof value === 'string' && ZONE_LAYOUTS.includes(value as ZoneLayout);

const isPolicyObject = (value: unknown): value is ZoneLayoutPolicy =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The policy (and binding) an arranged layout replaces, carried over from an earlier switch. */
function suspendedLayoutOf(
  existing: ZoneLayoutFields | undefined
): SuspendedZoneLayout | undefined {
  if (!existing) return undefined;
  if (arrangedZoneLayout(existing)) return existing.suspended_layout;
  if (isPolicyObject(existing.layout)) {
    return { layout: existing.layout, layout_binding: zoneLayoutBinding(existing) };
  }
  return existing.layout_binding === 'inherit' ? { layout_binding: 'inherit' } : undefined;
}

/**
 * Resolve a zone write against the zone it replaces, so neither layout
 * vocabulary silently discards the other:
 *
 * - `row`/`column`/`grid` keep the arranged string and park the previous
 *   policy (and binding) in `suspended_layout`.
 * - `free` restores a parked policy (an inheriting zone takes the board
 *   defaults), keeps an existing policy untouched, and otherwise makes the
 *   zone follow the board's zone defaults.
 * - A policy object (or no layout) is an explicit choice and drops the parked one.
 *
 * `suspended_layout` is server-maintained: whatever the caller sent is ignored.
 */
export function resolveZoneLayoutWrite<T extends ZoneLayoutFields>(
  existing: ZoneLayoutFields | undefined,
  incoming: T,
  boardDefaults?: Partial<ZoneLayoutPolicy>
): T {
  const { suspended_layout: _ignored, ...rest } = incoming;
  const layout = incoming.layout;
  if (!isLayoutString(layout)) return rest as T;

  if (isAutoZoneLayout(layout)) {
    const { layout_binding: _binding, ...arranged } = rest;
    const suspended = suspendedLayoutOf(existing);
    return { ...arranged, layout, ...(suspended ? { suspended_layout: suspended } : {}) } as T;
  }

  // `free`: hand the zone back to its policy rather than to an empty layout.
  const parked = existing && arrangedZoneLayout(existing) ? existing.suspended_layout : undefined;
  if (parked) {
    const binding = zoneLayoutBinding(parked);
    return {
      ...rest,
      layout_binding: binding,
      layout: normalizeZoneLayoutPolicy(binding === 'inherit' ? boardDefaults : parked.layout),
    } as T;
  }
  if (existing && isPolicyObject(existing.layout)) {
    return { ...rest, layout: existing.layout, layout_binding: existing.layout_binding } as T;
  }
  // No policy to return to: the zone follows the board's zone defaults.
  const { layout: _layout, ...unspecified } = rest;
  return { ...unspecified, layout_binding: 'inherit' } as T;
}

export interface ArrangedZoneItem {
  /** Canvas node id: the branch id, or `card-<card id>`. */
  id: string;
  /** Stored zone-relative position; orders items the zone hasn't listed yet. */
  position: BoardPosition;
  /** Rendered (or estimated) height. */
  height: number;
}

/**
 * The size a row, column or grid zone is shown at: its columns' width and its
 * cards' height, computed the way the canvas places them. Policy engines use
 * this instead of the stored size, which an arranged zone does not maintain.
 */
export function arrangedZoneShownSize(
  zone: Pick<ZoneBoardObject, 'layout' | 'width' | 'order'>,
  items: readonly ArrangedZoneItem[]
): { width: number; height: number } | undefined {
  const layout = arrangedZoneLayout(zone);
  if (!layout) return undefined;
  const ordered = orderZoneEntities(sanitizeZoneOrder(zone.order), zone.width, items);
  const plan = planZoneGrid(layout, zone.width, ordered);
  return { width: plan.contentWidth, height: plan.contentHeight };
}
