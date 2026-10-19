import { describe, expect, it } from 'vitest';
import { layoutZoneFlow, type ZoneFlowEdge, type ZoneFlowNode } from './zone-flow-layout';

const zone = (id: string, width = 400, height = 300): ZoneFlowNode => ({ id, width, height });
const options = { rankGap: 120, gapX: 64, gapY: 48, gridSize: 20 };
const edge = (source: string, target: string): ZoneFlowEdge => ({ source, target });

function run(nodes: ZoneFlowNode[], edges: ZoneFlowEdge[]) {
  const result = layoutZoneFlow(nodes, edges, options);
  const rect = new Map(
    result.placements.map((placement) => {
      const node = nodes.find((candidate) => candidate.id === placement.id) as ZoneFlowNode;
      return [placement.id, { ...placement, width: node.width, height: node.height }] as const;
    })
  );
  return { result, rect };
}

/** True when the straight right-handle -> left-handle arrow crosses another zone. */
function arrowPassesUnderZone(
  rect: ReturnType<typeof run>['rect'],
  from: string,
  to: string
): boolean {
  const a = rect.get(from);
  const b = rect.get(to);
  if (!a || !b) return false;
  const x1 = a.x + a.width;
  const y1 = a.y + a.height / 2;
  const x2 = b.x;
  const y2 = b.y + b.height / 2;
  return [...rect.entries()].some(([id, other]) => {
    if (id === from || id === to) return false;
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      if (x > other.x && x < other.x + other.width && y > other.y && y < other.y + other.height) {
        return true;
      }
    }
    return false;
  });
}

function overlaps(rect: ReturnType<typeof run>['rect']): boolean {
  const all = [...rect.values()];
  return all.some((left, i) =>
    all
      .slice(i + 1)
      .some(
        (right) =>
          left.x < right.x + right.width &&
          right.x < left.x + left.width &&
          left.y < right.y + right.height &&
          right.y < left.y + left.height
      )
  );
}

describe('layoutZoneFlow', () => {
  it('lays a linear chain out left to right on one line', () => {
    const { result, rect } = run(
      [zone('c'), zone('a'), zone('b')],
      [edge('a', 'b'), edge('b', 'c')]
    );
    expect(result.ranks).toBe(3);
    expect(result.backEdges).toEqual([]);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => rect.get(id)!);
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
    // Ranks are separated by at least the rank gap so arrows have room.
    expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(120);
    expect(arrowPassesUnderZone(rect, 'a', 'b')).toBe(false);
  });

  it('splits a branch and merge into stacked parallel zones', () => {
    const edges = [edge('start', 'x'), edge('start', 'y'), edge('x', 'end'), edge('y', 'end')];
    const { result, rect } = run([zone('start'), zone('x'), zone('y'), zone('end')], edges);
    expect(result.ranks).toBe(3);
    expect(rect.get('x')!.x).toBe(rect.get('y')!.x);
    expect(rect.get('x')!.y).not.toBe(rect.get('y')!.y);
    expect(overlaps(rect)).toBe(false);
    for (const { source, target } of edges) {
      expect(rect.get(source)!.x).toBeLessThan(rect.get(target)!.x);
      expect(arrowPassesUnderZone(rect, source, target)).toBe(false);
    }
  });

  it('routes a skip edge through a lane instead of under the zone it skips', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];
    const { rect } = run([zone('a'), zone('b'), zone('c')], edges);
    expect(overlaps(rect)).toBe(false);
    for (const { source, target } of edges) {
      expect(arrowPassesUnderZone(rect, source, target)).toBe(false);
    }
  });

  it('avoids crossings in a layered graph where input order would cross', () => {
    const edges = [edge('a1', 'b2'), edge('a2', 'b1')];
    const { rect } = run([zone('a1'), zone('a2'), zone('b1'), zone('b2')], edges);
    // a1 -> b2 and a2 -> b1: the two b zones must be ordered to match their sources.
    const aOrder = rect.get('a1')!.y < rect.get('a2')!.y;
    const bOrder = rect.get('b2')!.y < rect.get('b1')!.y;
    expect(aOrder).toBe(bOrder);
  });

  it('breaks a cycle with a single backwards transition', () => {
    const { result, rect } = run(
      [zone('a'), zone('b'), zone('c')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    );
    expect(result.backEdges).toEqual([edge('c', 'a')]);
    expect(rect.get('a')!.x).toBeLessThan(rect.get('b')!.x);
    expect(rect.get('b')!.x).toBeLessThan(rect.get('c')!.x);
    expect(overlaps(rect)).toBe(false);
  });

  it('treats a two-zone back-and-forth as one forward and one backward edge', () => {
    const { result, rect } = run([zone('a'), zone('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(result.backEdges).toHaveLength(1);
    expect(rect.get('a')!.x).toBeLessThan(rect.get('b')!.x);
  });

  it('ignores self loops, duplicates, and edges to unknown zones', () => {
    const { result } = run(
      [zone('a'), zone('b')],
      [edge('a', 'a'), edge('a', 'b'), edge('a', 'b'), edge('a', 'ghost')]
    );
    expect(result.ranks).toBe(2);
    expect(result.placements.every((placement) => placement.inFlow)).toBe(true);
  });

  it('places zones with no transitions after the flow without overlap', () => {
    const { result, rect } = run(
      [zone('lonely'), zone('a'), zone('b'), zone('other')],
      [edge('a', 'b')]
    );
    const flowBottom = Math.max(rect.get('a')!.y + 300, rect.get('b')!.y + 300);
    for (const id of ['lonely', 'other']) {
      expect(rect.get(id)!.inFlow).toBe(false);
      expect(rect.get(id)!.y).toBeGreaterThanOrEqual(flowBottom);
    }
    expect(overlaps(rect)).toBe(false);
    expect(result.height).toBeGreaterThan(flowBottom);
  });

  it('wraps disconnected zones to the width of the flow', () => {
    const nodes = [
      zone('a', 400, 200),
      zone('b', 400, 200),
      ...['d1', 'd2', 'd3', 'd4'].map((id) => zone(id, 400, 200)),
    ];
    const { result, rect } = run(nodes, [edge('a', 'b')]);
    const flowWidth = 400 + 120 + 400;
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      expect(rect.get(id)!.x + 400).toBeLessThanOrEqual(flowWidth);
    }
    expect(result.width).toBe(flowWidth);
    expect(overlaps(rect)).toBe(false);
  });

  it('is deterministic and snaps to the grid', () => {
    const nodes = [zone('a', 420, 260), zone('b', 380, 340), zone('c', 400, 300)];
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const first = run(nodes, edges).result;
    const second = run(nodes, edges).result;
    expect(second).toEqual(first);
    for (const placement of first.placements) {
      expect(placement.x % 20).toBe(0);
      expect(placement.y % 20).toBe(0);
    }
  });

  it('returns an empty layout for no zones', () => {
    expect(layoutZoneFlow([], [], options)).toMatchObject({ placements: [], ranks: 0 });
  });
});
