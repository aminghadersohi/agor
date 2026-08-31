import type { BoardEntityType, BoardPosition, ZoneLayoutPolicy } from '../types/board.js';
import {
  type JustifiedZoneResult,
  layoutJustifiedZones,
  zoneShapesForItems,
} from './justified-zones.js';
import {
  BOARD_GRID_SIZE,
  type CompactRectangleLayoutResult,
  ceilBoardGridValue,
  layoutCompactRectangles,
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
  /** Present for branch/card placements; canvas nodes keep their natural size. */
  entityType?: BoardEntityType;
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
  /** Inverse canvas zoom for screen-stable zone title geometry. */
  fontScale?: number;
  status?: string;
  layout?: Partial<ZoneLayoutPolicy>;
  items: readonly BoardZoneArrangementItem[];
}

export interface BoardZoneArrangementLooseItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardZoneArrangementOptions {
  targetWidth?: number;
  targetRowHeight?: number;
  gap?: number;
  startX?: number;
  startY?: number;
  maxPerRow?: number;
  justifyLastRow?: boolean;
  /** Free top-level board nodes packed beside the content-sized zone frames. */
  looseItems?: readonly BoardZoneArrangementLooseItem[];
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
  looseItems: RectanglePlacement[];
  /** Present when the operation also packed free top-level board nodes. */
  boardLayout?: CompactRectangleLayoutResult;
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
    const frame = getZoneLayoutFrame(zone, { fontScale: zone.fontScale });
    // Compact geometry must not become its own next sort key: a frontier pack
    // can intentionally fill a hole above an earlier item. Re-sorting those
    // placements spatially on reload would change insertion order and churn.
    // The supplied order is the durable logical order for the default compact
    // mode; explicit semantic sorts and explicit grids retain their policy.
    const orderedItems =
      policy.preset === 'grid' && policy.columns === undefined && policy.sortBy === 'position'
        ? [...zone.items]
        : sortZoneLayoutItems(zone.items, policy);
    const items = orderedItems.map((item) => ({
      id: item.id,
      ...(policy.preset === 'compact_list' && item.entityType
        ? compactZoneItemSize(item.entityType, frame.usableWidth)
        : { width: item.width, height: item.height }),
      sourceX: item.position.x,
      sourceY: item.position.y - frame.headerInset,
    }));
    const gap = gridGap(policy.gap ?? 24);
    const compact =
      policy.preset === 'grid' && policy.columns === undefined
        ? layoutCompactRectangles(items, {
            padding: frame.padding,
            gapX: gap,
            gapY: gap,
            gridSize: BOARD_GRID_SIZE,
          })
        : undefined;
    const shapes =
      items.length === 0
        ? [
            {
              columns: 1,
              width: Math.max(400, ceilBoardGridValue(zone.width)),
              height: Math.max(240, ceilBoardGridValue(zone.height)),
            },
          ]
        : compact
          ? [
              {
                columns: compact.columns,
                width: Math.max(400, ceilBoardGridValue(compact.width)),
                height: Math.max(240, ceilBoardGridValue(compact.height + frame.headerInset)),
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
    return { zone, policy, orderedItems, shapes, gap, compact };
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
  const sourceZoneOrderById = new Map(sourceZones.map((zone, index) => [zone.id, index]));
  const orderedLooseItems = [...(options.looseItems ?? [])];
  const duplicateId = orderedLooseItems.find((item) => preparedById.has(item.id));
  if (duplicateId) {
    throw new Error(`Board layout item '${duplicateId.id}' conflicts with a zone id.`);
  }
  const boardLayout =
    orderedLooseItems.length > 0
      ? layoutCompactRectangles(
          [
            ...layout.placements
              .map((placement) => {
                const source = preparedById.get(placement.id)?.zone;
                if (!source)
                  throw new Error(`Missing arrangement input for zone '${placement.id}'.`);
                return {
                  id: placement.id,
                  width: placement.width,
                  height: placement.height,
                  sourceX: source.x,
                  sourceY: source.y,
                };
              })
              .sort(
                (a, b) =>
                  (sourceZoneOrderById.get(a.id) ?? 0) - (sourceZoneOrderById.get(b.id) ?? 0)
              ),
            ...orderedLooseItems.map((item) => ({
              id: item.id,
              width: item.width,
              height: item.height,
              sourceX: item.x,
              sourceY: item.y,
            })),
          ],
          {
            gapX: options.gap ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.gap,
            gapY: options.gap ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.gap,
            gridSize: BOARD_GRID_SIZE,
          }
        )
      : undefined;
  const boardPlacementById = new Map(
    boardLayout?.placements.map((placement) => [placement.id, placement]) ?? []
  );
  const boardOrigin = {
    x: options.startX ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.startX,
    y: options.startY ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.startY,
  };

  const zones = layout.placements.map((placement): ArrangedBoardZone => {
    const entry = preparedById.get(placement.id);
    if (!entry) throw new Error(`Missing arrangement input for zone '${placement.id}'.`);
    const frame = getZoneLayoutFrame(
      { ...entry.zone, width: placement.width },
      { fontScale: entry.zone.fontScale }
    );
    const items = entry.orderedItems.map((item) => ({
      id: item.id,
      ...(entry.policy.preset === 'compact_list' && item.entityType
        ? compactZoneItemSize(item.entityType, frame.usableWidth)
        : { width: item.width, height: item.height }),
      sourceX: item.position.x,
      sourceY: item.position.y - frame.headerInset,
    }));
    const bounds = {
      width: frame.width,
      height: Math.max(0, placement.height - frame.headerInset),
    };
    const packed = entry.compact
      ? layoutCompactRectangles(items, {
          bounds,
          padding: frame.padding,
          gapX: entry.gap,
          gapY: entry.gap,
          gridSize: BOARD_GRID_SIZE,
        })
      : layoutRectangles(items, {
          bounds,
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
      position: boardLayout
        ? {
            x: boardOrigin.x + (boardPlacementById.get(placement.id)?.x ?? 0),
            y: boardOrigin.y + (boardPlacementById.get(placement.id)?.y ?? 0),
          }
        : { x: placement.x, y: placement.y },
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

  const looseItems = orderedLooseItems.map((item) => {
    const placement = boardPlacementById.get(item.id);
    if (!placement) throw new Error(`Missing compact placement for board item '${item.id}'.`);
    return {
      ...placement,
      x: boardOrigin.x + placement.x,
      y: boardOrigin.y + placement.y,
    };
  });

  return { layout, zones, looseItems, ...(boardLayout ? { boardLayout } : {}) };
}
