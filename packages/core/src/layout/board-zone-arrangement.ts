import type { BoardEntityType, BoardPosition, ZoneLayoutPolicy } from '../types/board.js';
import {
  type JustifiedZoneResult,
  layoutJustifiedZones,
  zoneShapesForItems,
} from './justified-zones.js';
import {
  BOARD_GRID_SIZE,
  ceilBoardGridValue,
  layoutRectangles,
  type RectanglePlacement,
} from './rectangle-packing.js';
import {
  compactZoneItemSize,
  getZoneLayoutFrame,
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  type ZoneLayoutSortItem,
} from './zone-layout.js';

export const DEFAULT_BOARD_ZONE_ARRANGEMENT = Object.freeze({
  targetWidth: 1600,
  targetRowHeight: 600,
  gap: 40,
  startX: 80,
  startY: 80,
  justifyLastRow: false,
});

export interface BoardZoneArrangementItem extends ZoneLayoutSortItem {
  entityType: BoardEntityType;
  width: number;
  height: number;
  compact?: boolean;
}

export interface BoardZoneArrangementInput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  status?: string;
  layout?: Partial<ZoneLayoutPolicy>;
  items: readonly BoardZoneArrangementItem[];
}

export interface BoardZoneArrangementOptions {
  targetWidth?: number;
  targetRowHeight?: number;
  gap?: number;
  startX?: number;
  startY?: number;
  maxPerRow?: number;
  justifyLastRow?: boolean;
}

export interface ArrangedBoardZone {
  id: string;
  position: BoardPosition;
  width: number;
  height: number;
  row: number;
  column: number;
  contentColumns: number;
  slackY: number;
  items: RectanglePlacement[];
}

export interface BoardZoneArrangementPlan {
  layout: JustifiedZoneResult;
  zones: ArrangedBoardZone[];
}

const spatialOrder = (a: BoardZoneArrangementInput, b: BoardZoneArrangementInput): number =>
  a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);

const gridGap = (value: number): number =>
  value === 0 ? 0 : Math.max(BOARD_GRID_SIZE, ceilBoardGridValue(value));

/**
 * Plan both levels of a board-zone arrange as one deterministic operation.
 *
 * Callers supply measured visible child rectangles and persist the returned
 * geometry. Keeping the solver here makes the browser action and MCP tool use
 * identical defaults, row breaking, zone shapes, and final child packing.
 */
export function planBoardZoneArrangement(
  sourceZones: readonly BoardZoneArrangementInput[],
  options: BoardZoneArrangementOptions = {}
): BoardZoneArrangementPlan {
  const orderedZones = [...sourceZones].sort(spatialOrder);
  const prepared = orderedZones.map((zone) => {
    const policy = normalizeZoneLayoutPolicy(zone.layout);
    const frame = getZoneLayoutFrame(zone);
    const orderedItems = sortZoneLayoutItems(zone.items, policy);
    const items = orderedItems.map((item) => ({
      id: item.id,
      ...(policy.preset === 'compact_list'
        ? compactZoneItemSize(item.entityType, frame.usableWidth)
        : { width: item.width, height: item.height }),
    }));
    const gap = gridGap(policy.gap ?? 24);
    const shapes =
      items.length === 0
        ? [
            {
              columns: 1,
              width: Math.max(400, ceilBoardGridValue(zone.width)),
              height: Math.max(240, ceilBoardGridValue(zone.height)),
            },
          ]
        : zoneShapesForItems(items, {
            titleInset: frame.headerInset,
            padding: frame.padding,
            gapX: gap,
            gapY: gap,
            maxColumns: policy.preset === 'compact_list' ? 1 : policy.columns,
            gridSize: BOARD_GRID_SIZE,
          });
    return { zone, policy, orderedItems, shapes, gap };
  });

  const layout = layoutJustifiedZones(
    prepared.map(({ zone, shapes }) => ({ id: zone.id, shapes })),
    {
      targetWidth: options.targetWidth ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.targetWidth,
      targetRowHeight: options.targetRowHeight ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.targetRowHeight,
      gap: options.gap ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.gap,
      startX: options.startX ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.startX,
      startY: options.startY ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.startY,
      maxPerRow: options.maxPerRow,
      justifyLastRow: options.justifyLastRow ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.justifyLastRow,
      gridSize: BOARD_GRID_SIZE,
    }
  );
  const preparedById = new Map(prepared.map((entry) => [entry.zone.id, entry]));

  const zones = layout.placements.map((placement): ArrangedBoardZone => {
    const entry = preparedById.get(placement.id);
    if (!entry) throw new Error(`Missing arrangement input for zone '${placement.id}'.`);
    const frame = getZoneLayoutFrame({ ...entry.zone, width: placement.width });
    const items = entry.orderedItems.map((item) => ({
      id: item.id,
      ...(entry.policy.preset === 'compact_list'
        ? compactZoneItemSize(item.entityType, frame.usableWidth)
        : { width: item.width, height: item.height }),
    }));
    const packed = layoutRectangles(items, {
      bounds: {
        width: frame.width,
        height: Math.max(0, placement.height - frame.headerInset),
      },
      padding: frame.padding,
      minPadding: frame.padding,
      gapX: entry.gap,
      gapY: entry.gap,
      minGapX: entry.gap,
      minGapY: entry.gap,
      exactColumns: Math.max(1, Math.min(items.length || 1, placement.columns)),
      allowDeck: false,
      gridSize: BOARD_GRID_SIZE,
    });
    if (packed.overflowingItemIds.length > 0) {
      throw new Error(
        `Zone '${placement.id}' shape did not contain ${packed.overflowingItemIds.join(', ')}.`
      );
    }
    return {
      id: placement.id,
      position: { x: placement.x, y: placement.y },
      width: placement.width,
      height: placement.height,
      row: placement.row,
      column: placement.column,
      contentColumns: packed.columns,
      slackY: placement.slackY,
      items: packed.placements.map((item) => ({
        ...item,
        y: item.y + frame.headerInset,
      })),
    };
  });

  return { layout, zones };
}
