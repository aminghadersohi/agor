import { describe, expect, it } from 'vitest';
import {
  type BoardZoneArrangementInput,
  containingBoardZoneId,
  DEFAULT_BOARD_ZONE_ARRANGEMENT,
  planBoardZoneArrangement,
} from './board-zone-arrangement';
import { growZoneLayoutHeight } from './zone-layout';

const item = (id: string, width: number, height: number, x = 0, y = 0) => ({
  id,
  entityType: 'card' as const,
  width,
  height,
  position: { x, y },
});
const branchItem = (id: string, width: number, height: number, x = 0, y = 0) => ({
  ...item(id, width, height, x, y),
  entityType: 'branch' as const,
});
const zone = (
  id: string,
  x: number,
  y: number,
  items: BoardZoneArrangementInput['items']
): BoardZoneArrangementInput => ({ id, x, y, width: 600, height: 500, items });

describe('planBoardZoneArrangement', () => {
  it('keeps a protruding anchored canvas child in its smallest containing zone', () => {
    expect(
      containingBoardZoneId({ x: 100, y: 120, width: 860, height: 660 }, [
        { id: 'outer', x: 0, y: 0, width: 1200, height: 1000 },
        { id: 'tiny', x: 80, y: 80, width: 300, height: 220 },
      ])
    ).toBe('tiny');
    expect(
      containingBoardZoneId({ x: 400, y: 400, width: 100, height: 100 }, [
        { id: 'tiny', x: 80, y: 80, width: 300, height: 220 },
      ])
    ).toBeUndefined();
  });

  it('packs inner geometry before outer placement, growing small zones and compacting waste', () => {
    const plan = planBoardZoneArrangement(
      [
        { ...zone('tiny', 0, 0, [item('protruding', 860, 660, 20, 120)]), width: 300, height: 220 },
        { ...zone('wasteful', 400, 0, [item('single', 380, 100)]), width: 1600, height: 900 },
        { ...zone('empty', 2100, 0, []), width: 1600, height: 900 },
      ],
      { looseItems: [{ id: 'free', x: 0, y: 1200, width: 500, height: 300 }] }
    );
    const tiny = plan.zones.find(({ id }) => id === 'tiny')!;
    const wasteful = plan.zones.find(({ id }) => id === 'wasteful')!;
    const empty = plan.zones.find(({ id }) => id === 'empty')!;

    expect(tiny.width).toBeGreaterThanOrEqual(900);
    expect(tiny.items[0]!.x + tiny.items[0]!.width).toBeLessThanOrEqual(tiny.width);
    expect(tiny.items[0]!.y + tiny.items[0]!.height).toBeLessThanOrEqual(tiny.height);
    expect(wasteful.width).toBeLessThan(1600);
    expect(wasteful.height).toBeLessThan(900);
    expect(empty).toMatchObject({ width: 600, height: 240 });
    for (const arranged of plan.zones) {
      expect(plan.boardLayout?.placements.find(({ id }) => id === arranged.id)).toMatchObject({
        width: arranged.width,
        height: arranged.height,
      });
    }
    // Persisting this explicit packed frame makes it the next durable Auto
    // Grow floor; background maintenance may grow it, but never undo Pack.
    expect(growZoneLayoutHeight(wasteful.height, 120)).toBe(wasteful.height);
    const free = plan.looseItems[0]!;
    expect(
      tiny.position.x + tiny.width <= free.x ||
        free.x + free.width <= tiny.position.x ||
        tiny.position.y + tiny.height <= free.y ||
        free.y + free.height <= tiny.position.y
    ).toBe(true);
  });

  it('preserves zone frames and child geometry when Pack zone contents is off', () => {
    const source = {
      ...zone('manual', 900, 700, [item('child', 860, 660, 20, 120)]),
      width: 300,
      height: 220,
    };
    const arranged = planBoardZoneArrangement([source], { packZoneContents: false }).zones[0]!;
    expect(arranged).toMatchObject({ width: 300, height: 220 });
    expect(arranged.items).toHaveLength(1);
    expect(arranged.items[0]).toMatchObject({
      id: 'child',
      x: 20,
      y: 120,
      width: 860,
      height: 660,
    });
  });

  it('uses shared defaults, preserves spatial order, and packs every child for its final frame', () => {
    const plan = planBoardZoneArrangement([
      zone('a-later', 900, 200, [item('later-card', 380, 100)]),
      zone('z-first', 20, 20, [item('first-card', 380, 120), item('first-branch', 500, 200)]),
    ]);
    expect(plan.zones.map(({ id }) => id)).toEqual(['z-first', 'a-later']);
    expect(plan.zones[0]?.position).toEqual({
      x: DEFAULT_BOARD_ZONE_ARRANGEMENT.startX,
      y: DEFAULT_BOARD_ZONE_ARRANGEMENT.startY,
    });
    expect(plan.zones.map(({ items }) => items.length)).toEqual([2, 1]);
    for (const arranged of plan.zones) {
      for (const child of arranged.items) {
        expect(child.x).toBeGreaterThanOrEqual(0);
        expect(child.y).toBeGreaterThan(0);
        expect(child.x + child.width).toBeLessThanOrEqual(arranged.width);
        expect(child.y + child.height).toBeLessThanOrEqual(arranged.height);
      }
    }
  });

  it('is deterministic, grid aligned, and collision free', () => {
    const input = [
      zone('a', 0, 0, [item('a-1', 381, 101), item('a-2', 499, 199)]),
      zone('b', 700, 0, [item('b-1', 380, 160)]),
      zone('c', 0, 700, [item('c-1', 500, 200), item('c-2', 380, 80)]),
    ];
    const first = planBoardZoneArrangement(input);
    expect(planBoardZoneArrangement(input)).toEqual(first);
    for (const arranged of first.zones) {
      for (const value of [
        arranged.position.x,
        arranged.position.y,
        arranged.width,
        arranged.height,
      ])
        expect(value % 20).toBe(0);
    }
    for (const [index, left] of first.zones.entries()) {
      for (const right of first.zones.slice(index + 1)) {
        expect(
          left.position.x < right.position.x + right.width &&
            right.position.x < left.position.x + left.width &&
            left.position.y < right.position.y + right.height &&
            right.position.y < left.position.y + left.height
        ).toBe(false);
      }
    }
  });

  it('keeps empty zones useful and compact lists single-column', () => {
    const plan = planBoardZoneArrangement([
      zone('empty', 0, 0, []),
      {
        ...zone('list', 700, 0, [item('one', 380, 100), item('two', 380, 100)]),
        layout: { preset: 'compact_list' },
      },
    ]);
    const empty = plan.zones.find(({ id }) => id === 'empty');
    const list = plan.zones.find(({ id }) => id === 'list');
    expect(empty?.width).toBeGreaterThanOrEqual(400);
    expect(empty?.height).toBeGreaterThanOrEqual(240);
    expect(list?.contentColumns).toBe(1);
    expect(new Set(list?.items.map(({ x }) => x))).toHaveLength(1);
  });

  it('uses compact-list density geometry only for capable worktrees', () => {
    const plan = planBoardZoneArrangement([
      {
        ...zone('honest-list', 0, 0, [
          branchItem('worktree', 500, 220),
          item('generic-card', 380, 180),
          { id: 'artifact', width: 440, height: 300, position: { x: 0, y: 0 } },
        ]),
        layout: { preset: 'compact_list', gap: 8 },
      },
    ]);
    const byId = new Map(plan.zones[0]?.items.map((entry) => [entry.id, entry]));

    expect(byId.get('worktree')?.height).toBeLessThan(220);
    expect(byId.get('generic-card')).toMatchObject({ width: 380, height: 180 });
    expect(byId.get('artifact')).toMatchObject({ width: 440, height: 300 });
  });

  it('makes two-column Apply geometry identical to a repeated Arrange and idempotent', () => {
    const source = [
      zone('one', 0, 0, [branchItem('one-child', 500, 220)]),
      zone('two', 2200, 0, [item('two-child', 380, 180)]),
      zone('three', 0, 1600, [item('three-child', 380, 100)]),
    ];
    const options = { maxPerRow: 2 };
    const applied = planBoardZoneArrangement(source, options);
    const reapplied = planBoardZoneArrangement(
      source.map((zoneInput) => {
        const arranged = applied.zones.find(({ id }) => id === zoneInput.id)!;
        const itemById = new Map(arranged.items.map((entry) => [entry.id, entry]));
        return {
          ...zoneInput,
          x: arranged.position.x,
          y: arranged.position.y,
          width: arranged.width,
          height: arranged.height,
          items: zoneInput.items.map((entry) => ({
            ...entry,
            position: {
              x: itemById.get(entry.id)?.x ?? entry.position.x,
              y: itemById.get(entry.id)?.y ?? entry.position.y,
            },
          })),
        };
      }),
      options
    );

    expect(reapplied).toEqual(applied);
    expect(applied.zones.map(({ row, column }) => ({ row, column }))).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
    ]);
  });

  it('carries a measured title scale through zone sizing and child packing', () => {
    const base = { ...zone('large-title', 0, 0, [item('child', 500, 240)]), fontSize: 48 };
    const normal = planBoardZoneArrangement([base]).zones[0]!;
    const zoomedOut = planBoardZoneArrangement([{ ...base, fontScale: 2 }]).zones[0]!;

    expect(zoomedOut.height).toBeGreaterThan(normal.height);
    expect(zoomedOut.items[0]!.y).toBeGreaterThan(normal.items[0]!.y);
  });

  it('does not exceed an explicit zone column preference', () => {
    const plan = planBoardZoneArrangement([
      {
        ...zone(
          'limited',
          0,
          0,
          Array.from({ length: 6 }, (_, index) => item(`item-${index}`, 200, 100))
        ),
        layout: { columns: 2 },
      },
    ]);
    expect(plan.zones[0]?.contentColumns).toBeLessThanOrEqual(2);
  });

  it('uses the compact engine for heterogeneous entity and canvas children', () => {
    const mixed: BoardZoneArrangementInput['items'] = [
      item('wide-worktree', 520, 140, 20, 100),
      item('card', 280, 180, 20, 280),
      { id: 'tall-artifact', width: 260, height: 440, position: { x: 600, y: 100 } },
      { id: 'note', width: 320, height: 140, position: { x: 880, y: 100 } },
      { id: 'app', width: 360, height: 220, position: { x: 880, y: 280 } },
    ];
    const first = planBoardZoneArrangement([zone('mixed', 0, 0, mixed)]);
    const arranged = first.zones[0];

    expect(arranged?.items).toHaveLength(mixed.length);
    expect(arranged?.contentColumns).toBeGreaterThan(0);
    for (const [index, left] of (arranged?.items ?? []).entries()) {
      expect(left.x + left.width).toBeLessThanOrEqual(arranged?.width ?? 0);
      expect(left.y + left.height).toBeLessThanOrEqual(arranged?.height ?? 0);
      for (const right of (arranged?.items ?? []).slice(index + 1)) {
        expect(
          left.x + left.width + 20 <= right.x ||
            right.x + right.width + 20 <= left.x ||
            left.y + left.height + 20 <= right.y ||
            right.y + right.height + 20 <= left.y
        ).toBe(true);
      }
    }

    const byId = new Map(arranged?.items.map((entry) => [entry.id, entry]));
    const second = planBoardZoneArrangement([
      zone(
        'mixed',
        arranged?.position.x ?? 0,
        arranged?.position.y ?? 0,
        mixed.map((entry) => ({
          ...entry,
          position: {
            x: byId.get(entry.id)?.x ?? entry.position.x,
            y: byId.get(entry.id)?.y ?? entry.position.y,
          },
        }))
      ),
    ]);
    expect(second.zones[0]?.items).toEqual(arranged?.items);
  });

  it('normalizes input permutations when a durable logical sort is configured', () => {
    const items: BoardZoneArrangementInput['items'] = [
      { ...item('c', 360, 180), title: 'Charlie' },
      { ...item('a', 520, 140), title: 'Alpha' },
      { id: 'artifact', width: 260, height: 440, position: { x: 700, y: 100 }, title: 'Bravo' },
    ];
    const arrange = (values: BoardZoneArrangementInput['items']) =>
      planBoardZoneArrangement([{ ...zone('sorted', 0, 0, values), layout: { sortBy: 'title' } }])
        .zones[0]?.items;

    expect(arrange([items[2]!, items[0]!, items[1]!])).toEqual(arrange(items));
  });

  it('packs content-sized zones and heterogeneous free board nodes into one idempotent cluster', () => {
    const zones = [
      zone('review', 0, 0, [item('review-card', 380, 120)]),
      zone('shipping', 900, 0, [item('shipping-worktree', 500, 200)]),
    ];
    const looseItems = [
      { id: 'artifact', x: 0, y: 800, width: 720, height: 420 },
      { id: 'free-card', x: 760, y: 800, width: 380, height: 100 },
      { id: 'note', x: 1180, y: 800, width: 260, height: 500 },
    ];
    const first = planBoardZoneArrangement(zones, { looseItems });

    expect(first.boardLayout?.mode).toBe('cluster');
    expect(first.looseItems.map((entry) => entry.id)).toEqual(looseItems.map((entry) => entry.id));
    const topLevel = [
      ...first.zones.map((entry) => ({
        id: entry.id,
        x: entry.position.x,
        y: entry.position.y,
        width: entry.width,
        height: entry.height,
      })),
      ...first.looseItems,
    ];
    for (const [index, left] of topLevel.entries()) {
      for (const right of topLevel.slice(index + 1)) {
        expect(
          left.x + left.width <= right.x ||
            right.x + right.width <= left.x ||
            left.y + left.height <= right.y ||
            right.y + right.height <= left.y,
          `${left.id} overlaps ${right.id}`
        ).toBe(true);
      }
    }

    const firstZoneById = new Map(first.zones.map((entry) => [entry.id, entry]));
    const second = planBoardZoneArrangement(
      zones.map((entry) => ({
        ...entry,
        x: firstZoneById.get(entry.id)?.position.x ?? entry.x,
        y: firstZoneById.get(entry.id)?.position.y ?? entry.y,
      })),
      {
        looseItems: looseItems.map((entry) => {
          const placed = first.looseItems.find((item) => item.id === entry.id);
          return { ...entry, x: placed?.x ?? entry.x, y: placed?.y ?? entry.y };
        }),
      }
    );
    expect(new Map(second.zones.map((entry) => [entry.id, entry.position]))).toEqual(
      new Map(first.zones.map((entry) => [entry.id, entry.position]))
    );
    expect(second.looseItems).toEqual(first.looseItems);
  });
});
