export interface RectangleLayoutItem {
  id: string;
  width: number;
  height: number;
}

export interface RectanglePlacement extends RectangleLayoutItem {
  x: number;
  y: number;
  row: number;
  column: number;
  stackIndex: number;
  deckDepth: number;
}

export interface RectangleLayoutOptions {
  /** Outer container size. Omit for an unbounded canvas layout. */
  bounds?: { width: number; height: number };
  padding?: number;
  /** Smallest acceptable edge margin when a bounded grid needs compaction. */
  minPadding?: number;
  gapX?: number;
  gapY?: number;
  /** Smallest acceptable gaps when a bounded grid needs gentle compaction. */
  minGapX?: number;
  minGapY?: number;
  /** Soft grid-width preference. The nearest fitting width wins. */
  preferredColumns?: number;
  /** Exact grid width. Bounded layouts never substitute another column count. */
  exactColumns?: number;
  /** Used only when no non-overlapping grid fits. */
  allowDeck?: boolean;
  /** Legacy diagonal deck offset. Prefer deckOffsetX/deckOffsetY. */
  deckOffset?: number;
  /** Visible left-edge reveal between deck layers. */
  deckOffsetX?: number;
  /** Visible header reveal between deck layers. */
  deckOffsetY?: number;
  /** Quantize item sizes, spacing, and placements to this grid. */
  gridSize?: number;
}

/** The board grid used by React Flow manual drag/resize and every automatic layout path. */
export const BOARD_GRID_SIZE = 20;
export const BOARD_SNAP_GRID: [number, number] = [BOARD_GRID_SIZE, BOARD_GRID_SIZE];

export function snapBoardGridValue(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

export function ceilBoardGridValue(value: number): number {
  if (value === 0) return 0;
  return Math.ceil(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

export function snapBoardGridPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: snapBoardGridValue(point.x), y: snapBoardGridValue(point.y) };
}

export function ceilBoardGridSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: ceilBoardGridValue(size.width),
    height: ceilBoardGridValue(size.height),
  };
}

export interface RectangleLayoutResult {
  mode: 'grid' | 'deck';
  placements: RectanglePlacement[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  gapX: number;
  gapY: number;
  padding: number;
  fitsWithoutOverlap: boolean;
  stackCount: number;
  maxDeckDepth: number;
  deckOffsetX: number;
  deckOffsetY: number;
  overflowingItemIds: string[];
}

export interface CompactRectangleLayoutResult extends Omit<RectangleLayoutResult, 'mode'> {
  mode: 'cluster';
}

export interface CompactRectangleLayoutItem extends RectangleLayoutItem {
  /** Optional prior canvas position, used only as a final movement tie-break. */
  sourceX?: number;
  sourceY?: number;
}

export interface CompactRectangleLayoutOptions {
  /** Optional outer container. Placements stay inside it after padding. */
  bounds?: { width: number; height: number };
  padding?: number;
  gapX?: number;
  gapY?: number;
  gridSize?: number;
}

interface GridCandidate {
  placements: RectanglePlacement[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  gapX: number;
  gapY: number;
  padding: number;
}

const finiteNonNegative = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value ?? -1) >= 0 ? (value as number) : fallback;

const ceilToGrid = (value: number, gridSize: number): number =>
  gridSize > 0 && value !== 0 ? Math.ceil(value / gridSize) * gridSize : value;

const floorToGrid = (value: number, gridSize: number): number =>
  gridSize > 0 ? Math.floor(value / gridSize) * gridSize : value;

function normalizedItems(
  items: readonly RectangleLayoutItem[],
  gridSize: number
): RectangleLayoutItem[] {
  return items.map((item) => {
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) {
      throw new Error(`Rectangle '${item.id}' has a non-finite size.`);
    }
    if (item.width <= 0 || item.height <= 0) {
      throw new Error(`Rectangle '${item.id}' must have a positive width and height.`);
    }
    return {
      ...item,
      width: ceilToGrid(item.width, gridSize),
      height: ceilToGrid(item.height, gridSize),
    };
  });
}

function buildGrid(
  items: readonly RectangleLayoutItem[],
  columns: number,
  padding: number,
  gapX: number,
  gapY: number
): GridCandidate {
  const safeColumns = Math.max(1, Math.min(items.length || 1, Math.floor(columns)));
  const rows = Math.ceil(items.length / safeColumns);
  const columnWidths = Array.from({ length: safeColumns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  for (const [index, item] of items.entries()) {
    const column = index % safeColumns;
    const row = Math.floor(index / safeColumns);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, item.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, item.height);
  }
  const columnOffsets: number[] = [];
  let nextX = padding;
  for (const width of columnWidths) {
    columnOffsets.push(nextX);
    nextX += width + gapX;
  }
  const rowOffsets: number[] = [];
  let nextY = padding;
  for (const height of rowHeights) {
    rowOffsets.push(nextY);
    nextY += height + gapY;
  }
  const placements = items.map((item, index) => {
    const column = index % safeColumns;
    const row = Math.floor(index / safeColumns);
    return {
      ...item,
      x: columnOffsets[column] ?? padding,
      y: rowOffsets[row] ?? padding,
      row,
      column,
      stackIndex: index,
      deckDepth: 0,
    };
  });
  return {
    placements,
    columns: safeColumns,
    rows,
    width:
      padding * 2 +
      columnWidths.reduce((sum, width) => sum + width, 0) +
      Math.max(0, safeColumns - 1) * gapX,
    height:
      padding * 2 +
      rowHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, rows - 1) * gapY,
    gapX,
    gapY,
    padding,
  };
}

function fits(candidate: GridCandidate, bounds: { width: number; height: number }): boolean {
  return candidate.width <= bounds.width && candidate.height <= bounds.height;
}

function chooseGrid(
  items: readonly RectangleLayoutItem[],
  options: {
    bounds?: { width: number; height: number };
    padding: number;
    gapX: number;
    gapY: number;
    minGapX: number;
    minGapY: number;
    minPadding: number;
    preferredColumns?: number;
    exactColumns?: number;
    gridSize: number;
  }
): GridCandidate | undefined {
  if (items.length === 0) return buildGrid(items, 1, options.padding, options.gapX, options.gapY);
  const exactColumns = options.exactColumns
    ? Math.max(1, Math.min(items.length, Math.floor(options.exactColumns)))
    : undefined;
  const bounds = options.bounds;
  const minimumItemWidth = items.reduce(
    (minimum, item) => Math.min(minimum, item.width),
    Number.POSITIVE_INFINITY
  );
  // A bounded grid cannot have more columns than its width can contain at the
  // minimum allowed padding and gap. Capping the search here avoids trying all
  // n column counts (and rebuilding an n-item grid each time) on large boards.
  const maximumFittingColumns = bounds
    ? Math.max(
        0,
        Math.floor(
          (bounds.width - options.minPadding * 2 + options.minGapX) /
            (minimumItemWidth + options.minGapX)
        )
      )
    : items.length;
  const columnCounts = exactColumns
    ? [exactColumns]
    : bounds
      ? Array.from(
          { length: Math.min(items.length, maximumFittingColumns) },
          (_, index) => index + 1
        )
      : [
          options.preferredColumns
            ? Math.max(1, Math.min(items.length, Math.floor(options.preferredColumns)))
            : items.length,
        ];
  const candidates = columnCounts
    .flatMap((columns) => {
      if (!bounds) {
        return [buildGrid(items, columns, options.padding, options.gapX, options.gapY)];
      }

      // First preserve the requested margins. If that cannot fit, compact the
      // outer margin as well as the inter-item gaps before considering overlap.
      return [...new Set([options.padding, options.minPadding])].flatMap((padding) => {
        const compact = buildGrid(items, columns, padding, 0, 0);
        const horizontalDivisors = Math.max(0, compact.columns - 1);
        const verticalDivisors = Math.max(0, compact.rows - 1);
        const fittingGapX =
          horizontalDivisors === 0
            ? options.gapX
            : Math.floor((bounds.width - compact.width) / horizontalDivisors);
        const fittingGapY =
          verticalDivisors === 0
            ? options.gapY
            : Math.floor((bounds.height - compact.height) / verticalDivisors);
        const effectiveGapX = floorToGrid(Math.min(options.gapX, fittingGapX), options.gridSize);
        const effectiveGapY = floorToGrid(Math.min(options.gapY, fittingGapY), options.gridSize);
        if (effectiveGapX < options.minGapX || effectiveGapY < options.minGapY) return [];
        return [buildGrid(items, columns, padding, effectiveGapX, effectiveGapY)];
      });
    })
    .filter(
      (candidate): candidate is GridCandidate =>
        candidate !== undefined && (!bounds || fits(candidate, bounds))
    );
  const preferred = options.preferredColumns
    ? Math.max(1, Math.min(items.length, Math.floor(options.preferredColumns)))
    : undefined;
  return candidates.sort((a, b) => {
    if (preferred !== undefined) {
      const preferredDelta = Math.abs(a.columns - preferred) - Math.abs(b.columns - preferred);
      if (preferredDelta !== 0) return preferredDelta;
    }
    // With no preference, use as many complete columns as the available
    // rectangle permits. This produces a compact top-left, row-major grid.
    return (
      b.columns - a.columns ||
      b.padding - a.padding ||
      b.gapX + b.gapY - (a.gapX + a.gapY) ||
      a.height - b.height ||
      a.width - b.width
    );
  })[0];
}

function overflowingIds(
  placements: readonly RectanglePlacement[],
  bounds: { width: number; height: number }
): string[] {
  return placements
    .filter(
      (item) =>
        item.x < 0 ||
        item.y < 0 ||
        item.x + item.width > bounds.width ||
        item.y + item.height > bounds.height
    )
    .map((item) => item.id);
}

function buildDeck(
  items: readonly RectangleLayoutItem[],
  options: {
    bounds: { width: number; height: number };
    padding: number;
    gapX: number;
    gapY: number;
    minGapX: number;
    minGapY: number;
    minPadding: number;
    preferredColumns?: number;
    exactColumns?: number;
    deckOffsetX: number;
    deckOffsetY: number;
    gridSize: number;
  }
): RectangleLayoutResult | undefined {
  // Try the maximum possible number of stacks first. Overlap grows only when
  // the zone truly cannot fit another fully separated stack.
  for (let stackCount = items.length - 1; stackCount >= 1; stackCount--) {
    const exactColumns = options.exactColumns
      ? Math.max(1, Math.min(items.length, Math.floor(options.exactColumns)))
      : undefined;
    if (exactColumns !== undefined && stackCount < exactColumns) continue;
    // Aggregate every stack in one pass. Filtering the complete item list once
    // per stack made a single candidate quadratic before grid selection even
    // began, which was especially costly for large layouts that cannot fit.
    const stacks = Array.from({ length: stackCount }, (_, stackIndex) => ({
      id: `stack-${stackIndex}`,
      width: 0,
      height: 0,
    }));
    for (const [index, item] of items.entries()) {
      const stackIndex = index % stackCount;
      const depth = Math.floor(index / stackCount);
      const stack = stacks[stackIndex];
      if (!stack) throw new Error(`Missing deck stack ${stackIndex}.`);
      stack.width = Math.max(stack.width, item.width + depth * options.deckOffsetX);
      stack.height = Math.max(stack.height, item.height + depth * options.deckOffsetY);
    }
    const stackGrid = chooseGrid(stacks, options);
    if (!stackGrid) continue;
    const stackBaseByIndex = new Map(
      stackGrid.placements.map((placement, index) => [index, placement] as const)
    );
    const placements = items.map((item, index) => {
      const stackIndex = index % stackCount;
      const deckDepth = Math.floor(index / stackCount);
      const base = stackBaseByIndex.get(stackIndex);
      if (!base) throw new Error(`Missing deck stack ${stackIndex}.`);
      return {
        ...item,
        x: base.x + deckDepth * options.deckOffsetX,
        y: base.y + deckDepth * options.deckOffsetY,
        row: base.row,
        column: base.column,
        stackIndex,
        deckDepth,
      };
    });
    return {
      mode: 'deck',
      placements,
      columns: stackGrid.columns,
      rows: stackGrid.rows,
      width: stackGrid.width,
      height: stackGrid.height,
      gapX: stackGrid.gapX,
      gapY: stackGrid.gapY,
      padding: stackGrid.padding,
      fitsWithoutOverlap: false,
      stackCount,
      maxDeckDepth: Math.ceil(items.length / stackCount),
      deckOffsetX: options.deckOffsetX,
      deckOffsetY: options.deckOffsetY,
      overflowingItemIds: overflowingIds(placements, options.bounds),
    };
  }
  return undefined;
}

/**
 * Deterministic top-left rectangle packing for heterogeneous board nodes.
 *
 * Grid mode never overlaps and validates the complete rendered rectangles
 * against both container axes. Deck mode is an explicit last resort: it uses
 * the greatest number of independently packed stacks that fit, then offsets
 * each layer down and right so the underlying top and left edges remain visible.
 */
export function layoutRectangles(
  sourceItems: readonly RectangleLayoutItem[],
  options: RectangleLayoutOptions = {}
): RectangleLayoutResult {
  if (options.preferredColumns !== undefined && options.exactColumns !== undefined) {
    throw new Error('Specify either preferredColumns or exactColumns, not both.');
  }
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const items = normalizedItems(sourceItems, gridSize);
  const padding = ceilToGrid(finiteNonNegative(options.padding, 0), gridSize);
  const minPadding = Math.min(
    padding,
    ceilToGrid(finiteNonNegative(options.minPadding, Math.min(8, padding)), gridSize)
  );
  const gapX = ceilToGrid(finiteNonNegative(options.gapX, 24), gridSize);
  const gapY = ceilToGrid(finiteNonNegative(options.gapY, 24), gridSize);
  const minGapX = Math.min(
    gapX,
    ceilToGrid(finiteNonNegative(options.minGapX, Math.min(12, gapX)), gridSize)
  );
  const minGapY = Math.min(
    gapY,
    ceilToGrid(finiteNonNegative(options.minGapY, Math.min(12, gapY)), gridSize)
  );
  const legacyDeckOffset = finiteNonNegative(options.deckOffset, 12);
  const deckOffsetX = ceilToGrid(
    finiteNonNegative(options.deckOffsetX, legacyDeckOffset),
    gridSize
  );
  const deckOffsetY = ceilToGrid(
    finiteNonNegative(
      options.deckOffsetY,
      options.deckOffset === undefined ? 48 : legacyDeckOffset
    ),
    gridSize
  );
  const bounds = options.bounds
    ? {
        width: floorToGrid(finiteNonNegative(options.bounds.width, 0), gridSize),
        height: floorToGrid(finiteNonNegative(options.bounds.height, 0), gridSize),
      }
    : undefined;
  const grid = chooseGrid(items, {
    bounds,
    padding,
    gapX,
    gapY,
    minGapX,
    minGapY,
    minPadding,
    preferredColumns: options.preferredColumns,
    exactColumns: options.exactColumns,
    gridSize,
  });
  if (grid) {
    return {
      mode: 'grid',
      ...grid,
      fitsWithoutOverlap: true,
      stackCount: items.length,
      maxDeckDepth: 1,
      deckOffsetX: 0,
      deckOffsetY: 0,
      overflowingItemIds: bounds ? overflowingIds(grid.placements, bounds) : [],
    };
  }
  const deck =
    bounds && options.allowDeck !== false
      ? buildDeck(items, {
          bounds,
          padding,
          gapX,
          gapY,
          minGapX,
          minGapY,
          minPadding,
          preferredColumns: options.preferredColumns,
          exactColumns: options.exactColumns,
          deckOffsetX,
          deckOffsetY,
          gridSize,
        })
      : undefined;
  if (deck) return deck;

  // An individual item is larger than the usable container, or deck mode was
  // disabled. Keep deterministic origins and report the exact rectangles that
  // cannot be contained instead of pretending the arrangement succeeded.
  const fallback = buildGrid(
    items,
    options.exactColumns ?? options.preferredColumns ?? 1,
    padding,
    gapX,
    gapY
  );
  return {
    mode: 'grid',
    ...fallback,
    fitsWithoutOverlap: true,
    stackCount: items.length,
    maxDeckDepth: 1,
    deckOffsetX: 0,
    deckOffsetY: 0,
    overflowingItemIds: bounds ? overflowingIds(fallback.placements, bounds) : [],
  };
}

type ClusterPlacement = RectanglePlacement & { sourceX?: number; sourceY?: number };

const clusterSeparated = (
  left: ClusterPlacement,
  right: { x: number; y: number; width: number; height: number },
  gapX: number,
  gapY: number
): boolean =>
  left.x + left.width + gapX <= right.x ||
  right.x + right.width + gapX <= left.x ||
  left.y + left.height + gapY <= right.y ||
  right.y + right.height + gapY <= left.y;

/**
 * Pack heterogeneous canvas rectangles into a compact deterministic cluster.
 *
 * Unlike `layoutRectangles`, this is intentionally not a fixed row/column
 * grid. Every item is placed on the corner frontier created by prior items.
 * The larger enclosing dimension wins first, then area, perimeter, and
 * movement from the supplied source geometry. Input order remains stable in
 * the returned array, and source geometry resolves equally compact
 * alternatives with less motion.
 */
export function layoutCompactRectangles(
  sourceItems: readonly CompactRectangleLayoutItem[],
  options: CompactRectangleLayoutOptions = {}
): CompactRectangleLayoutResult {
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const padding = ceilToGrid(finiteNonNegative(options.padding, 0), gridSize);
  const gapX = ceilToGrid(finiteNonNegative(options.gapX, 24), gridSize);
  const gapY = ceilToGrid(finiteNonNegative(options.gapY, 24), gridSize);
  const bounds = options.bounds;
  const usableWidth = bounds
    ? Math.max(0, floorToGrid(finiteNonNegative(bounds.width, 0) - padding * 2, gridSize))
    : Number.POSITIVE_INFINITY;
  const usableHeight = bounds
    ? Math.max(0, floorToGrid(finiteNonNegative(bounds.height, 0) - padding * 2, gridSize))
    : Number.POSITIVE_INFINITY;
  const items = normalizedItems(sourceItems, gridSize).map((item, index) => ({
    ...item,
    sourceX: sourceItems[index]?.sourceX,
    sourceY: sourceItems[index]?.sourceY,
  }));
  if (items.length === 0) {
    return {
      mode: 'cluster',
      placements: [],
      columns: 1,
      rows: 0,
      width: padding * 2,
      height: padding * 2,
      gapX,
      gapY,
      padding,
      fitsWithoutOverlap: true,
      stackCount: 0,
      maxDeckDepth: 1,
      deckOffsetX: 0,
      deckOffsetY: 0,
      overflowingItemIds: [],
    };
  }

  const finiteSourceXs = items
    .map((item) => item.sourceX)
    .filter((value): value is number => Number.isFinite(value));
  const finiteSourceYs = items
    .map((item) => item.sourceY)
    .filter((value): value is number => Number.isFinite(value));
  const sourceLeft = finiteSourceXs.length > 0 ? Math.min(...finiteSourceXs) : 0;
  const sourceTop = finiteSourceYs.length > 0 ? Math.min(...finiteSourceYs) : 0;
  const placed: ClusterPlacement[] = [];

  for (const [index, item] of items.entries()) {
    const candidateByKey = new Map<string, { x: number; y: number }>();
    const addCandidate = (x: number, y: number) => {
      if (x < 0 || y < 0) return;
      candidateByKey.set(`${x}:${y}`, { x, y });
    };
    addCandidate(0, 0);
    for (const existing of placed) {
      addCandidate(existing.x + existing.width + gapX, existing.y);
      addCandidate(existing.x - item.width - gapX, existing.y);
      addCandidate(existing.x, existing.y + existing.height + gapY);
      addCandidate(existing.x, existing.y - item.height - gapY);
      // Aligning opposite edges as well as top/left edges lets a short item
      // fill the corner below or beside a larger heterogeneous neighbour.
      addCandidate(existing.x + existing.width - item.width, existing.y + existing.height + gapY);
      addCandidate(existing.x + existing.width + gapX, existing.y + existing.height - item.height);
    }
    const candidates = [...candidateByKey.values()].filter(
      ({ x, y }) =>
        x + item.width <= usableWidth &&
        y + item.height <= usableHeight &&
        placed.every((existing) =>
          clusterSeparated(existing, { x, y, width: item.width, height: item.height }, gapX, gapY)
        )
    );
    if (candidates.length === 0) {
      // Preserve the all-or-nothing contract used by bounded zone layout: an
      // unsuccessful solve still returns deterministic collision-free
      // geometry, but names every rectangle outside the requested frame so
      // callers can refuse the write without partially moving anything.
      const fallback = layoutCompactRectangles(sourceItems, { ...options, bounds: undefined });
      return {
        ...fallback,
        overflowingItemIds: bounds ? overflowingIds(fallback.placements, bounds) : [],
      };
    }

    const sourceX = Number.isFinite(item.sourceX) ? (item.sourceX as number) - sourceLeft : 0;
    const sourceY = Number.isFinite(item.sourceY) ? (item.sourceY as number) - sourceTop : 0;
    const best = candidates.sort((a, b) => {
      const score = (candidate: { x: number; y: number }) => {
        const width = Math.max(
          candidate.x + item.width,
          ...placed.map((entry) => entry.x + entry.width)
        );
        const height = Math.max(
          candidate.y + item.height,
          ...placed.map((entry) => entry.y + entry.height)
        );
        return [
          Math.max(width, height),
          width * height,
          width + height,
          (candidate.x - sourceX) ** 2 + (candidate.y - sourceY) ** 2,
          candidate.y,
          candidate.x,
        ] as const;
      };
      const left = score(a);
      const right = score(b);
      for (let scoreIndex = 0; scoreIndex < left.length; scoreIndex += 1) {
        const delta = (left[scoreIndex] ?? 0) - (right[scoreIndex] ?? 0);
        if (delta !== 0) return delta;
      }
      return 0;
    })[0];
    if (!best) throw new Error(`Unable to select a placement for rectangle '${item.id}'.`);
    placed.push({
      ...item,
      x: best.x,
      y: best.y,
      row: 0,
      column: 0,
      stackIndex: index,
      deckDepth: 0,
    });
  }

  const rowYs = [...new Set(placed.map((item) => item.y))].sort((a, b) => a - b);
  const rowByY = new Map(rowYs.map((y, row) => [y, row]));
  const placements = placed.map(({ sourceX: _sourceX, sourceY: _sourceY, ...item }) => ({
    ...item,
    x: item.x + padding,
    y: item.y + padding,
    row: rowByY.get(item.y) ?? 0,
    column: placed.filter((peer) => peer.y === item.y && peer.x < item.x).length,
  }));
  const contentWidth = Math.max(...placed.map((item) => item.x + item.width));
  const contentHeight = Math.max(...placed.map((item) => item.y + item.height));
  const columns = Math.max(1, ...rowYs.map((y) => placed.filter((item) => item.y === y).length));
  return {
    mode: 'cluster',
    placements,
    columns,
    rows: rowYs.length,
    width: contentWidth + padding * 2,
    height: contentHeight + padding * 2,
    gapX,
    gapY,
    padding,
    fitsWithoutOverlap: true,
    stackCount: items.length,
    maxDeckDepth: 1,
    deckOffsetX: 0,
    deckOffsetY: 0,
    overflowingItemIds: bounds ? overflowingIds(placements, bounds) : [],
  };
}

export type SelectionRowDistribution = 'packed' | 'justify';

export type SelectionAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export interface SelectionAlignmentOptions {
  gap?: number;
  gridSize?: number;
}

/**
 * Align heterogeneous free-canvas rectangles without collapsing them onto one
 * another. The requested edge/center is shared, while the perpendicular axis
 * keeps its spatial order and only moves later rectangles far enough to clear
 * the preceding rectangle. This makes the first spatial item an intuitive
 * anchor and gives the smallest deterministic forward shift for every peer.
 */
export function layoutAlignedRectangles(
  sourceItems: readonly CompactRectangleLayoutItem[],
  alignment: SelectionAlignment,
  options: SelectionAlignmentOptions = {}
): RectanglePlacement[] {
  if (sourceItems.length === 0) return [];
  const gridSize = finiteNonNegative(options.gridSize, 0);
  const snap = (value: number) =>
    gridSize > 0 ? Math.round((Number.isFinite(value) ? value : 0) / gridSize) * gridSize : value;
  const gap = ceilToGrid(finiteNonNegative(options.gap, 0), gridSize);
  const items = sourceItems.map((item) => ({
    ...item,
    width: ceilToGrid(Math.max(1, finiteNonNegative(item.width, BOARD_GRID_SIZE)), gridSize),
    height: ceilToGrid(Math.max(1, finiteNonNegative(item.height, BOARD_GRID_SIZE)), gridSize),
    sourceX: snap(item.sourceX ?? 0),
    sourceY: snap(item.sourceY ?? 0),
  }));
  const horizontal = alignment === 'left' || alignment === 'center' || alignment === 'right';
  const left = Math.min(...items.map((item) => item.sourceX));
  const right = Math.max(...items.map((item) => item.sourceX + item.width));
  const top = Math.min(...items.map((item) => item.sourceY));
  const bottom = Math.max(...items.map((item) => item.sourceY + item.height));
  const ordered = [...items].sort((a, b) =>
    horizontal
      ? a.sourceY - b.sourceY || a.sourceX - b.sourceX || a.id.localeCompare(b.id)
      : a.sourceX - b.sourceX || a.sourceY - b.sourceY || a.id.localeCompare(b.id)
  );
  const placements: RectanglePlacement[] = [];
  let nextPerpendicular = Number.NEGATIVE_INFINITY;

  for (const [index, item] of ordered.entries()) {
    const x =
      alignment === 'left'
        ? left
        : alignment === 'center'
          ? snap((left + right - item.width) / 2)
          : alignment === 'right'
            ? right - item.width
            : Math.max(item.sourceX, nextPerpendicular);
    const y =
      alignment === 'top'
        ? top
        : alignment === 'middle'
          ? snap((top + bottom - item.height) / 2)
          : alignment === 'bottom'
            ? bottom - item.height
            : Math.max(item.sourceY, nextPerpendicular);
    placements.push({
      id: item.id,
      width: item.width,
      height: item.height,
      x,
      y,
      row: horizontal ? index : 0,
      column: horizontal ? 0 : index,
      stackIndex: index,
      deckDepth: 0,
    });
    nextPerpendicular = (horizontal ? y + item.height : x + item.width) + gap;
  }

  const byId = new Map(placements.map((placement) => [placement.id, placement]));
  return sourceItems.flatMap((item) => {
    const placement = byId.get(item.id);
    return placement ? [placement] : [];
  });
}

export interface SelectionGridLayoutOptions {
  /** Fix one grid axis. When both are omitted, a balanced grid is chosen. */
  columns?: number;
  rows?: number;
  gapX?: number;
  gapY?: number;
  gridSize?: number;
  /** Stretch each item to the tallest measured rectangle in its own row. */
  matchRowHeights?: boolean;
  /** Spread complete rows across targetWidth while keeping the outer edges fixed. */
  rowDistribution?: SelectionRowDistribution;
  /** Existing selection width used by justified rows. */
  targetWidth?: number;
}

/**
 * Deterministic row-major grid for heterogeneous free-canvas selections.
 * Spatial order is preserved, either axis can drive the track count, and the
 * optional row treatments operate on the same measured rectangles rather than
 * replacing them with generic card sizes.
 */
export function layoutSelectionGrid(
  sourceItems: readonly CompactRectangleLayoutItem[],
  options: SelectionGridLayoutOptions = {}
): RectangleLayoutResult {
  const gridSize = finiteNonNegative(options.gridSize, 0);
  if (sourceItems.length === 0) return layoutRectangles([], { gridSize });
  const items = [...sourceItems].sort(
    (a, b) =>
      finiteNonNegative(a.sourceY, 0) - finiteNonNegative(b.sourceY, 0) ||
      finiteNonNegative(a.sourceX, 0) - finiteNonNegative(b.sourceX, 0) ||
      a.id.localeCompare(b.id)
  );
  const requestedRows = options.rows
    ? Math.max(1, Math.min(items.length, Math.floor(options.rows)))
    : undefined;
  const requestedColumns = options.columns
    ? Math.max(1, Math.min(items.length, Math.floor(options.columns)))
    : undefined;
  const columns =
    requestedColumns ??
    (requestedRows
      ? Math.ceil(items.length / requestedRows)
      : Math.max(1, Math.ceil(Math.sqrt(items.length))));
  const base = layoutRectangles(
    items.map(({ id, width, height }) => ({ id, width, height })),
    {
      exactColumns: columns,
      gapX: options.gapX,
      gapY: options.gapY,
      gridSize,
      allowDeck: false,
    }
  );
  const targetWidth = Math.max(
    base.width,
    ceilToGrid(finiteNonNegative(options.targetWidth, base.width), gridSize)
  );
  const placements = base.placements.map((placement) => ({ ...placement }));
  const rows = new Map<number, RectanglePlacement[]>();
  for (const placement of placements) {
    const row = rows.get(placement.row) ?? [];
    row.push(placement);
    rows.set(placement.row, row);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.column - b.column || a.id.localeCompare(b.id));
    if (options.matchRowHeights) {
      const height = Math.max(...row.map((item) => item.height));
      for (const item of row) item.height = height;
    }
    if (options.rowDistribution !== 'justify' || row.length < 2) continue;
    const occupiedWidth = row.reduce((total, item) => total + item.width, 0);
    const freeUnits = Math.max(0, Math.round((targetWidth - occupiedWidth) / (gridSize || 1)));
    const slots = row.length - 1;
    const baseGapUnits = Math.floor(freeUnits / slots);
    let remainder = freeUnits % slots;
    let x = 0;
    for (const [index, item] of row.entries()) {
      item.x = x;
      if (index === row.length - 1) continue;
      const gapUnits = baseGapUnits + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      x += item.width + gapUnits * (gridSize || 1);
    }
  }
  return { ...base, placements, width: targetWidth };
}
