import { describe, expect, it } from 'vitest';
import {
  type BoardZoneArrangementInput,
  DEFAULT_BOARD_ZONE_ARRANGEMENT,
  planBoardZoneArrangement,
} from './board-zone-arrangement';

const item = (id: string, width: number, height: number, x = 0, y = 0) => ({
  id,
  entityType: 'card' as const,
  width,
  height,
  position: { x, y },
});
const zone = (
  id: string,
  x: number,
  y: number,
  items: BoardZoneArrangementInput['items']
): BoardZoneArrangementInput => ({ id, x, y, width: 600, height: 500, items });

describe('planBoardZoneArrangement', () => {
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
