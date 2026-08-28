import { describe, expect, it } from 'vitest';
import { layoutRectangles, type RectanglePlacement } from './rectangle-packing';

function expectNoOverlap(placements: RectanglePlacement[]): void {
  for (const [index, a] of placements.entries()) {
    for (const b of placements.slice(index + 1)) {
      const separated =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      expect(separated, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
}

describe('layoutRectangles', () => {
  it('handles empty and single-item layouts without phantom rows or columns', () => {
    const empty = layoutRectangles([], { bounds: { width: 0, height: 0 } });
    expect(empty).toMatchObject({ placements: [], columns: 1, rows: 0 });

    const single = layoutRectangles([{ id: 'only', width: 120, height: 80 }], {
      bounds: { width: 160, height: 120 },
      padding: 20,
    });
    expect(single).toMatchObject({ columns: 1, rows: 1, overflowingItemIds: [] });
    expect(single.placements[0]).toMatchObject({ x: 20, y: 20, row: 0, column: 0 });
  });

  it('packs different rendered sizes into complete row-major rows and columns', () => {
    const result = layoutRectangles(
      [
        { id: 'worktree', width: 500, height: 200 },
        { id: 'short-card', width: 280, height: 64 },
        { id: 'note', width: 320, height: 180 },
        { id: 'tall-card', width: 280, height: 240 },
      ],
      { preferredColumns: 2, padding: 20, gapX: 30, gapY: 40 }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 2, rows: 2 });
    expect(
      result.placements.map(({ id, x, y, row, column }) => ({ id, x, y, row, column }))
    ).toEqual([
      { id: 'worktree', x: 20, y: 20, row: 0, column: 0 },
      { id: 'short-card', x: 550, y: 20, row: 0, column: 1 },
      { id: 'note', x: 20, y: 260, row: 1, column: 0 },
      { id: 'tall-card', x: 550, y: 260, row: 1, column: 1 },
    ]);
    expectNoOverlap(result.placements);
  });

  it('uses actual per-column widths instead of multiplying the widest item', () => {
    const result = layoutRectangles(
      [
        { id: 'wide', width: 500, height: 100 },
        { id: 'narrow-a', width: 120, height: 100 },
        { id: 'medium', width: 260, height: 100 },
        { id: 'narrow-b', width: 120, height: 100 },
      ],
      {
        bounds: { width: 700, height: 300 },
        preferredColumns: 2,
        padding: 20,
        gapX: 20,
        gapY: 20,
      }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 2, rows: 2 });
    expect(result.width).toBe(680);
    expect(result.overflowingItemIds).toEqual([]);
    expectNoOverlap(result.placements);
  });

  it('chooses the nearest fitting column count and contains every full rectangle', () => {
    const result = layoutRectangles(
      Array.from({ length: 20 }, (_, index) => ({
        id: `card-${index}`,
        width: 380,
        height: 56,
      })),
      {
        bounds: { width: 620, height: 1800 },
        preferredColumns: 3,
        padding: 24,
        gapX: 24,
        gapY: 24,
      }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 1, rows: 20 });
    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements.at(-1)).toMatchObject({ x: 24, y: 1544 });
    expectNoOverlap(result.placements);
  });

  it('compacts outer margins before it considers overlapping a roomy zone', () => {
    const result = layoutRectangles(
      Array.from({ length: 20 }, (_, index) => ({ id: `card-${index}`, width: 380, height: 200 })),
      {
        bounds: { width: 1200, height: 1800 },
        preferredColumns: 3,
        padding: 24,
        minPadding: 8,
        gapX: 24,
        gapY: 24,
        minGapX: 8,
        minGapY: 8,
      }
    );

    expect(result).toMatchObject({
      mode: 'grid',
      columns: 3,
      rows: 7,
      padding: 8,
      fitsWithoutOverlap: true,
      overflowingItemIds: [],
    });
    expectNoOverlap(result.placements);
  });

  it('uses a contained grid fallback when a requested column target cannot fit', () => {
    const result = layoutRectangles(
      Array.from({ length: 20 }, (_, index) => ({ id: `card-${index}`, width: 380, height: 200 })),
      {
        bounds: { width: 1200, height: 1800 },
        preferredColumns: 1,
        padding: 24,
        minPadding: 8,
        gapX: 24,
        gapY: 24,
        minGapX: 8,
        minGapY: 8,
      }
    );

    expect(result).toMatchObject({
      mode: 'grid',
      columns: 3,
      rows: 7,
      fitsWithoutOverlap: true,
      overflowingItemIds: [],
    });
    expectNoOverlap(result.placements);
  });

  it('uses the maximum number of stacks only when a separated grid cannot fit', () => {
    const result = layoutRectangles(
      Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}`, width: 180, height: 140 })),
      {
        bounds: { width: 450, height: 350 },
        preferredColumns: 2,
        padding: 20,
        gapX: 20,
        gapY: 20,
        deckOffset: 8,
      }
    );

    expect(result).toMatchObject({
      mode: 'deck',
      columns: 2,
      rows: 2,
      stackCount: 4,
      maxDeckDepth: 2,
      fitsWithoutOverlap: false,
    });
    expect(result.placements[4]).toMatchObject({
      x: result.placements[0]?.x + 8,
      y: result.placements[0]?.y + 8,
      stackIndex: 0,
      deckDepth: 1,
    });
    expect(result.overflowingItemIds).toEqual([]);
  });

  it('keeps exact deck columns and exposes every cascade layer', () => {
    const result = layoutRectangles(
      Array.from({ length: 6 }, (_, index) => ({ id: `card-${index}`, width: 180, height: 140 })),
      {
        bounds: { width: 450, height: 500 },
        exactColumns: 1,
        padding: 20,
        minPadding: 20,
        gapX: 20,
        gapY: 20,
        allowDeck: true,
        deckOffsetX: 12,
        deckOffsetY: 48,
      }
    );

    expect(result).toMatchObject({
      mode: 'deck',
      columns: 1,
      rows: 1,
      stackCount: 1,
      maxDeckDepth: 6,
      fitsWithoutOverlap: false,
      deckOffsetX: 12,
      deckOffsetY: 48,
      width: 280,
      height: 420,
    });
    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements.every((placement) => placement.column === 0)).toBe(true);
    expect(result.placements[1]).toMatchObject({
      x: result.placements[0]?.x + 12,
      y: result.placements[0]?.y + 48,
      stackIndex: 0,
      deckDepth: 1,
    });
    expect(result.placements.at(-1)).toMatchObject({
      x: result.placements[0]?.x + 60,
      y: result.placements[0]?.y + 240,
      stackIndex: 0,
      deckDepth: 5,
    });
  });

  it('does not silently substitute a fitting count for exact columns', () => {
    const result = layoutRectangles(
      Array.from({ length: 4 }, (_, index) => ({ id: `card-${index}`, width: 180, height: 80 })),
      {
        bounds: { width: 450, height: 300 },
        exactColumns: 3,
        padding: 20,
        gapX: 20,
        gapY: 20,
      }
    );

    expect(result).toMatchObject({ mode: 'grid', columns: 3, rows: 2 });
    expect(result.overflowingItemIds.length).toBeGreaterThan(0);
  });

  it('rejects ambiguous exact and preferred column options', () => {
    expect(() =>
      layoutRectangles([{ id: 'card', width: 100, height: 100 }], {
        preferredColumns: 1,
        exactColumns: 1,
      })
    ).toThrow('Specify either preferredColumns or exactColumns, not both.');
  });

  it('reports items that are physically larger than the container', () => {
    const result = layoutRectangles([{ id: 'oversized', width: 700, height: 300 }], {
      bounds: { width: 620, height: 400 },
      padding: 24,
    });

    expect(result.overflowingItemIds).toEqual(['oversized']);
    expect(result.placements[0]).toMatchObject({ x: 24, y: 24 });
  });

  it('terminates for very large heterogeneous inputs without leaving grid holes', () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      id: `item-${index}`,
      width: 80 + (index % 17),
      height: 40 + (index % 29),
    }));
    const result = layoutRectangles(items, {
      bounds: { width: 1_200, height: 1_000_000 },
      preferredColumns: 10,
      padding: 8,
      minPadding: 8,
      gapX: 8,
      gapY: 8,
      minGapX: 8,
      minGapY: 8,
    });

    expect(result).toMatchObject({ mode: 'grid', columns: 10, rows: 1_000 });
    expect(result.overflowingItemIds).toEqual([]);
    expect(result.placements).toHaveLength(items.length);
    expect(result.placements.every((item, index) => item.stackIndex === index)).toBe(true);
    for (const [index, placement] of result.placements.entries()) {
      expect(placement.row).toBe(Math.floor(index / result.columns));
      expect(placement.column).toBe(index % result.columns);
      const left = placement.column > 0 ? result.placements[index - 1] : undefined;
      const above = placement.row > 0 ? result.placements[index - result.columns] : undefined;
      if (left) expect(left.x + left.width).toBeLessThanOrEqual(placement.x);
      if (above) expect(above.y + above.height).toBeLessThanOrEqual(placement.y);
    }
  });
});
