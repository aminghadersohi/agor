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

function normalizedItems(items: readonly RectangleLayoutItem[]): RectangleLayoutItem[] {
  return items.map((item) => {
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) {
      throw new Error(`Rectangle '${item.id}' has a non-finite size.`);
    }
    if (item.width <= 0 || item.height <= 0) {
      throw new Error(`Rectangle '${item.id}' must have a positive width and height.`);
    }
    return { ...item };
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
  const columnWidths = Array.from({ length: safeColumns }, (_, column) =>
    Math.max(0, ...items.filter((_, index) => index % safeColumns === column).map((i) => i.width))
  );
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(
      0,
      ...items.slice(row * safeColumns, (row + 1) * safeColumns).map((item) => item.height)
    )
  );
  const columnOffsets = columnWidths.map(
    (_, column) =>
      padding + columnWidths.slice(0, column).reduce((sum, width) => sum + width + gapX, 0)
  );
  const rowOffsets = rowHeights.map(
    (_, row) => padding + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gapY, 0)
  );
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
  }
): GridCandidate | undefined {
  if (items.length === 0) return buildGrid(items, 1, options.padding, options.gapX, options.gapY);
  const exactColumns = options.exactColumns
    ? Math.max(1, Math.min(items.length, Math.floor(options.exactColumns)))
    : undefined;
  const columnCounts = exactColumns
    ? [exactColumns]
    : Array.from({ length: items.length }, (_, index) => index + 1);
  const bounds = options.bounds;
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
        const effectiveGapX = Math.min(options.gapX, fittingGapX);
        const effectiveGapY = Math.min(options.gapY, fittingGapY);
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
  }
): RectangleLayoutResult | undefined {
  // Try the maximum possible number of stacks first. Overlap grows only when
  // the zone truly cannot fit another fully separated stack.
  for (let stackCount = items.length - 1; stackCount >= 1; stackCount--) {
    const exactColumns = options.exactColumns
      ? Math.max(1, Math.min(items.length, Math.floor(options.exactColumns)))
      : undefined;
    if (exactColumns !== undefined && stackCount < exactColumns) continue;
    const stacks = Array.from({ length: stackCount }, (_, stackIndex) => {
      const members = items.filter((_, index) => index % stackCount === stackIndex);
      return {
        id: `stack-${stackIndex}`,
        width: Math.max(...members.map((item, depth) => item.width + depth * options.deckOffsetX)),
        height: Math.max(
          ...members.map((item, depth) => item.height + depth * options.deckOffsetY)
        ),
      };
    });
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
  const items = normalizedItems(sourceItems);
  const padding = finiteNonNegative(options.padding, 0);
  const minPadding = Math.min(padding, finiteNonNegative(options.minPadding, Math.min(8, padding)));
  const gapX = finiteNonNegative(options.gapX, 24);
  const gapY = finiteNonNegative(options.gapY, 24);
  const minGapX = Math.min(gapX, finiteNonNegative(options.minGapX, Math.min(12, gapX)));
  const minGapY = Math.min(gapY, finiteNonNegative(options.minGapY, Math.min(12, gapY)));
  const legacyDeckOffset = finiteNonNegative(options.deckOffset, 12);
  const deckOffsetX = finiteNonNegative(options.deckOffsetX, legacyDeckOffset);
  const deckOffsetY = finiteNonNegative(
    options.deckOffsetY,
    options.deckOffset === undefined ? 48 : legacyDeckOffset
  );
  const bounds = options.bounds
    ? {
        width: finiteNonNegative(options.bounds.width, 0),
        height: finiteNonNegative(options.bounds.height, 0),
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
