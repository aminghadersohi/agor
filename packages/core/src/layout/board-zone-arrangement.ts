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
  placeLayoutAroundFixedObstacles,
  type RectanglePlacement,
} from './rectangle-packing.js';
import {
  compactZoneItemSize,
  getZoneLayoutFrame,
  isBoardEntityDensityExpandable,
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

/** Empty explicit packs return to the ordinary seeded/creation width. */
export const EMPTY_PACKED_ZONE_SIZE = Object.freeze({ width: 600, height: 240 });

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
  /** Exact outer grid columns for an explicit selection layout. */
  fixedItemsPerRow?: number;
  /** Preserve measured compact tracks for an explicit selection grid. */
  compactFixedGrid?: boolean;
  justifyLastRow?: boolean;
  /** Give every zone in an outer row the row's tallest final frame. */
  matchRowHeights?: boolean;
  /** Free top-level board nodes packed beside the content-sized zone frames. */
  looseItems?: readonly BoardZoneArrangementLooseItem[];
  /** Unselected visible peers that selection-scoped layout may not move or overlap. */
  fixedObstacles?: readonly BoardZoneArrangementLooseItem[];
  /** Center the compact result on the source selection rather than a board-wide origin. */
  anchorToSelectionBounds?: boolean;
  /**
   * Re-pack each eligible zone before arranging the resulting outer frames.
   * Defaults to true for the explicit Arrange board/MCP operation. Set false
   * to preserve every zone frame and child-relative placement while arranging
   * only the top-level board objects.
   */
  packZoneContents?: boolean;
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

export interface BoardZoneMembershipRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolve geometric canvas membership consistently in the browser and MCP.
 *
 * Legacy canvas objects have no persisted zone id. The center remains the
 * ordinary membership signal, but an object whose top-left anchor is inside a
 * too-small zone is also a child: otherwise the exact protrusion that Pack is
 * meant to repair is misclassified as a loose board object. Smallest-area then
 * stable-id tie-breaking matches nested/overlapping-zone behavior everywhere.
 */
export function containingBoardZoneId(
  item: Omit<BoardZoneMembershipRect, 'id'>,
  zones: readonly BoardZoneMembershipRect[]
): string | undefined {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return [...zones]
    .filter(
      (zone) =>
        (centerX >= zone.x &&
          centerX <= zone.x + zone.width &&
          centerY >= zone.y &&
          centerY <= zone.y + zone.height) ||
        (item.x >= zone.x &&
          item.x <= zone.x + zone.width &&
          item.y >= zone.y &&
          item.y <= zone.y + zone.height)
    )
    .sort(
      (left, right) =>
        left.width * left.height - right.width * right.height || left.id.localeCompare(right.id)
    )[0]?.id;
}

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
  const packZoneContents = options.packZoneContents !== false;
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
      ...(policy.preset === 'compact_list' &&
      item.entityType &&
      isBoardEntityDensityExpandable(item.entityType)
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
    const shapes = !packZoneContents
      ? [
          {
            columns: 1,
            width: zone.width,
            height: zone.height,
          },
        ]
      : items.length === 0
        ? [
            {
              columns: 1,
              width: EMPTY_PACKED_ZONE_SIZE.width,
              height: EMPTY_PACKED_ZONE_SIZE.height,
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
      fixedItemsPerRow: options.fixedItemsPerRow,
      stretchFixedTracks: options.compactFixedGrid !== true,
      justifyLastRow: options.justifyLastRow ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.justifyLastRow,
      gridSize: BOARD_GRID_SIZE,
    }
  );
  const preparedById = new Map(prepared.map((entry) => [entry.zone.id, entry]));
  const sourceZoneOrderById = new Map(sourceZones.map((zone, index) => [zone.id, index]));
  const finalFrameById = new Map(
    layout.placements.map((placement) => {
      const entry = preparedById.get(placement.id);
      if (!entry) throw new Error(`Missing arrangement input for zone '${placement.id}'.`);
      if (!packZoneContents) {
        return [placement.id, { width: entry.zone.width, height: entry.zone.height }] as const;
      }
      const naturalHeight = placement.height - placement.slackY;
      const selectedShape = entry.shapes
        .filter((shape) => shape.columns === placement.columns)
        .sort(
          (left, right) =>
            Math.abs(left.height - naturalHeight) - Math.abs(right.height - naturalHeight) ||
            left.width - right.width
        )[0];
      if (!selectedShape) {
        throw new Error(`Missing selected shape for zone '${placement.id}'.`);
      }
      return [
        placement.id,
        {
          width: selectedShape.width,
          height: options.matchRowHeights ? placement.height : selectedShape.height,
        },
      ] as const;
    })
  );
  const targetFrames = layout.placements.map((placement) => {
    const frame = finalFrameById.get(placement.id);
    if (!frame) throw new Error(`Missing final frame for zone '${placement.id}'.`);
    return {
      ...placement,
      width: frame.width,
      height: frame.height,
      stackIndex: placement.row * Math.max(1, options.fixedItemsPerRow ?? 1) + placement.column,
      deckDepth: 0,
    };
  });
  const positionedLayout: JustifiedZoneResult = (() => {
    if (targetFrames.length === 0) return layout;
    const targetMinX = Math.min(...targetFrames.map((placement) => placement.x));
    const targetMinY = Math.min(...targetFrames.map((placement) => placement.y));
    const targetMaxX = Math.max(...targetFrames.map((placement) => placement.x + placement.width));
    const targetMaxY = Math.max(...targetFrames.map((placement) => placement.y + placement.height));
    const sourceMinX = Math.min(...orderedZones.map((zone) => zone.x));
    const sourceMinY = Math.min(...orderedZones.map((zone) => zone.y));
    const sourceMaxX = Math.max(...orderedZones.map((zone) => zone.x + zone.width));
    const sourceMaxY = Math.max(...orderedZones.map((zone) => zone.y + zone.height));
    const desiredOrigin = options.anchorToSelectionBounds
      ? {
          x: (sourceMinX + sourceMaxX - (targetMaxX - targetMinX)) / 2,
          y: (sourceMinY + sourceMaxY - (targetMaxY - targetMinY)) / 2,
        }
      : { x: targetMinX, y: targetMinY };
    const obstacleAware = placeLayoutAroundFixedObstacles(targetFrames, {
      desiredOrigin,
      obstacles: options.fixedObstacles,
      gapX: options.gap ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.gap,
      gapY: options.gap ?? DEFAULT_BOARD_ZONE_ARRANGEMENT.gap,
      gridSize: BOARD_GRID_SIZE,
    });
    const obstaclePlacementById = new Map(
      obstacleAware.placements.map((placement) => [placement.id, placement])
    );
    return {
      ...layout,
      placements: layout.placements.map((placement) => {
        const positioned = obstaclePlacementById.get(placement.id);
        if (!positioned) throw new Error(`Missing positioned zone '${placement.id}'.`);
        return { ...placement, x: positioned.x, y: positioned.y };
      }),
    };
  })();
  const orderedLooseItems = [...(options.looseItems ?? [])];
  const duplicateId = orderedLooseItems.find((item) => preparedById.has(item.id));
  if (duplicateId) {
    throw new Error(`Board layout item '${duplicateId.id}' conflicts with a zone id.`);
  }
  const boardLayout =
    orderedLooseItems.length > 0
      ? layoutCompactRectangles(
          [
            ...positionedLayout.placements
              .map((placement) => {
                const source = preparedById.get(placement.id)?.zone;
                if (!source)
                  throw new Error(`Missing arrangement input for zone '${placement.id}'.`);
                const frame = finalFrameById.get(placement.id);
                if (!frame) throw new Error(`Missing final frame for zone '${placement.id}'.`);
                return {
                  id: placement.id,
                  ...frame,
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

  const zones = positionedLayout.placements.map((placement): ArrangedBoardZone => {
    const entry = preparedById.get(placement.id);
    if (!entry) throw new Error(`Missing arrangement input for zone '${placement.id}'.`);
    const finalFrame = finalFrameById.get(placement.id);
    if (!finalFrame) throw new Error(`Missing final frame for zone '${placement.id}'.`);
    const frame = getZoneLayoutFrame(
      { ...entry.zone, width: finalFrame.width },
      { fontScale: entry.zone.fontScale }
    );
    const items = entry.orderedItems.map((item) => ({
      id: item.id,
      ...(entry.policy.preset === 'compact_list' &&
      item.entityType &&
      isBoardEntityDensityExpandable(item.entityType)
        ? compactZoneItemSize(item.entityType, frame.usableWidth)
        : { width: item.width, height: item.height }),
      sourceX: item.position.x,
      sourceY: item.position.y - frame.headerInset,
    }));
    const bounds = {
      width: frame.width,
      height: Math.max(0, finalFrame.height - frame.headerInset),
    };
    const packed = !packZoneContents
      ? {
          columns: 1,
          placements: entry.orderedItems.map((item) => ({
            id: item.id,
            x: item.position.x,
            y: item.position.y,
            width: item.width,
            height: item.height,
            row: 0,
            column: 0,
            stackIndex: 0,
            deckDepth: 1,
          })),
          overflowingItemIds: [],
        }
      : entry.compact
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
      width: finalFrame.width,
      height: finalFrame.height,
      row: placement.row,
      column: placement.column,
      contentColumns: packed.columns,
      slackY: placement.slackY,
      items: packed.placements.map((item) => ({
        ...item,
        y: packZoneContents ? item.y + frame.headerInset : item.y,
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

  return { layout: positionedLayout, zones, looseItems, ...(boardLayout ? { boardLayout } : {}) };
}
