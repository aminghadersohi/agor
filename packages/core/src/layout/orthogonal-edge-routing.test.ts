import { describe, expect, it } from 'vitest';
import {
  countRouteCrossings,
  placeEdgeLabels,
  type RoutedEdge,
  type RouteEdgeInput,
  type RoutePoint,
  type RouteRect,
  routeOrthogonalEdges,
  simplifyOrthogonalPath,
} from './orthogonal-edge-routing';
import { layoutZoneFlow } from './zone-flow-layout';

const rect = (id: string, x: number, y: number, width = 280, height = 120): RouteRect => ({
  id,
  x,
  y,
  width,
  height,
});
const edge = (source: string, target: string): RouteEdgeInput => ({
  id: `${source}->${target}`,
  source,
  target,
});

/** The review workflow from the board that prompted this router. */
const WORKFLOW_EDGES: RouteEdgeInput[] = [
  edge('backlog', 'coding'),
  edge('coding', 'ai-review'),
  edge('ai-review', 'human-review'),
  edge('ai-review', 'addressing-feedback'),
  edge('human-review', 'ready-to-merge'),
  edge('human-review', 'addressing-feedback'),
  edge('ready-to-merge', 'merged'),
  edge('addressing-feedback', 'ai-review'),
  edge('coding', 'blocked'),
  edge('blocked', 'coding'),
  edge('merged', 'ready-to-publish'),
];

function arrangedWorkflow(): RouteRect[] {
  const sizes: Record<string, [number, number]> = {
    backlog: [320, 160],
    coding: [320, 200],
    'ai-review': [320, 520],
    'human-review': [320, 160],
    'addressing-feedback': [320, 160],
    'ready-to-merge': [320, 160],
    merged: [320, 180],
    blocked: [320, 140],
    'ready-to-publish': [320, 160],
  };
  const nodes = Object.entries(sizes).map(([id, [width, height]]) => ({ id, width, height }));
  const layout = layoutZoneFlow(nodes, WORKFLOW_EDGES, { rankGap: 160, gapY: 48, gridSize: 20 });
  return layout.placements.map((placement) => {
    const [width, height] = sizes[placement.id];
    return rect(placement.id, placement.x, placement.y, width, height);
  });
}

const isHorizontal = (a: RoutePoint, b: RoutePoint) => Math.abs(a.y - b.y) < 1e-6;
const isVertical = (a: RoutePoint, b: RoutePoint) => Math.abs(a.x - b.x) < 1e-6;

function segmentHitsRect(a: RoutePoint, b: RoutePoint, r: RouteRect): boolean {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x1 < r.x + r.width && x2 > r.x && y1 < r.y + r.height && y2 > r.y;
}

function expectWellFormed(routes: RoutedEdge[], rects: RouteRect[], edges: RouteEdgeInput[]) {
  const rectById = new Map(rects.map((r) => [r.id, r]));
  for (const route of routes) {
    const input = edges.find((e) => e.id === route.id) as RouteEdgeInput;
    expect(route.points.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i + 1 < route.points.length; i += 1) {
      const a = route.points[i];
      const b = route.points[i + 1];
      expect(isHorizontal(a, b) || isVertical(a, b)).toBe(true);
      for (const r of rects) {
        expect(segmentHitsRect(a, b, r), `${route.id} segment ${i} enters ${r.id}`).toBe(false);
      }
    }
    const source = rectById.get(input.source) as RouteRect;
    const target = rectById.get(input.target) as RouteRect;
    const onSide = (p: RoutePoint, r: RouteRect, side: RoutedEdge['sourceSide']) => {
      switch (side) {
        case 'left':
          return p.x === r.x && p.y >= r.y && p.y <= r.y + r.height;
        case 'right':
          return p.x === r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
        case 'top':
          return p.y === r.y && p.x >= r.x && p.x <= r.x + r.width;
        case 'bottom':
          return p.y === r.y + r.height && p.x >= r.x && p.x <= r.x + r.width;
      }
    };
    expect(onSide(route.points[0], source, route.sourceSide)).toBe(true);
    expect(onSide(route.points[route.points.length - 1], target, route.targetSide)).toBe(true);
  }
}

/** Collinear overlap between segments of different routes. */
function sharedTrackLength(routes: RoutedEdge[]): number {
  let shared = 0;
  const segments = routes.flatMap((route, index) =>
    route.points.slice(1).map((b, i) => ({ route: index, a: route.points[i], b }))
  );
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s = segments[i];
      const t = segments[j];
      if (s.route === t.route) continue;
      if (isHorizontal(s.a, s.b) && isHorizontal(t.a, t.b) && Math.abs(s.a.y - t.a.y) < 1e-6) {
        const lo = Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x));
        const hi = Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x));
        shared += Math.max(0, hi - lo);
      } else if (isVertical(s.a, s.b) && isVertical(t.a, t.b) && Math.abs(s.a.x - t.a.x) < 1e-6) {
        const lo = Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y));
        const hi = Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y));
        shared += Math.max(0, hi - lo);
      }
    }
  }
  return shared;
}

describe('routeOrthogonalEdges', () => {
  it('draws a straight wire between aligned zones', () => {
    const rects = [rect('a', 0, 0), rect('b', 480, 0)];
    const [route] = routeOrthogonalEdges(rects, [edge('a', 'b')]);
    expect(route.points).toEqual([
      { x: 280, y: 60 },
      { x: 480, y: 60 },
    ]);
    expect(route.sourceSide).toBe('right');
    expect(route.targetSide).toBe('left');
  });

  it('routes around a zone sitting between source and target', () => {
    const rects = [rect('a', 0, 0), rect('wall', 440, -80, 200, 280), rect('b', 900, 0)];
    const edges = [edge('a', 'b')];
    const routes = routeOrthogonalEdges(rects, edges);
    expectWellFormed(routes, rects, edges);
    expect(routes[0].points.length).toBeGreaterThan(2);
  });

  it('starts in free space when a neighbour sits closer than the clearance', () => {
    // Review repro: a 20px gap is narrower than the 24px stub, which used to
    // put the stub inside the obstacle and fall back to a straight line through it.
    const rects = [
      rect('a', 0, 0, 280, 200),
      rect('wall', 300, 0, 200, 200),
      rect('b', 900, 0, 280, 200),
    ];
    const edges = [edge('a', 'b')];
    const routes = routeOrthogonalEdges(rects, edges);
    expectWellFormed(routes, rects, edges);
    expect(routes[0].points.length).toBeGreaterThan(2);
  });

  it('still routes when zones touch, crossing as little zone as possible', () => {
    const rects = [rect('a', 0, 0), rect('touching', 280, 0), rect('b', 900, 0)];
    const [route] = routeOrthogonalEdges(rects, [edge('a', 'b')]);
    expect(route.points[0]).toEqual({ x: 280, y: 60 });
    expect(route.points.at(-1)).toEqual({ x: 900, y: 60 });
    for (let i = 0; i + 1 < route.points.length; i += 1) {
      const a = route.points[i];
      const b = route.points[i + 1];
      expect(isHorizontal(a, b) || isVertical(a, b)).toBe(true);
    }
  });

  it('gives every edge on a side its own port', () => {
    const rects = [
      rect('hub', 0, 200, 280, 200),
      rect('a', 600, 0),
      rect('b', 600, 240),
      rect('c', 600, 480),
    ];
    const edges = [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c')];
    const routes = routeOrthogonalEdges(rects, edges);
    expectWellFormed(routes, rects, edges);
    const ports = routes.map((route) => `${route.points[0].x},${route.points[0].y}`);
    expect(new Set(ports).size).toBe(3);
    // Ports are ordered by where their targets sit, so the fan does not cross.
    const byId = new Map(routes.map((route) => [route.id, route.points[0].y]));
    expect(byId.get('hub->a')).toBeLessThan(byId.get('hub->b') as number);
    expect(byId.get('hub->b')).toBeLessThan(byId.get('hub->c') as number);
    expect(countRouteCrossings(routes)).toBe(0);
  });

  it('loops back edges over or under the chart instead of through it', () => {
    const rects = [rect('a', 0, 0), rect('b', 480, 0), rect('c', 960, 0)];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const routes = routeOrthogonalEdges(rects, edges);
    expectWellFormed(routes, rects, edges);
    const back = routes.find((route) => route.id === 'c->a') as RoutedEdge;
    expect(back.sourceSide).toBe(back.targetSide);
    expect(['top', 'bottom']).toContain(back.sourceSide);
    expect(countRouteCrossings(routes)).toBe(0);
  });

  it('lays the review workflow out cleanly after Arrange', () => {
    const rects = arrangedWorkflow();
    const routes = routeOrthogonalEdges(rects, WORKFLOW_EDGES);
    expect(routes).toHaveLength(WORKFLOW_EDGES.length);
    expectWellFormed(routes, rects, WORKFLOW_EDGES);
    expect(sharedTrackLength(routes)).toBe(0);
    const ports = routes.flatMap((route) => [
      `${route.points[0].x},${route.points[0].y}`,
      `${route.points.at(-1)?.x},${route.points.at(-1)?.y}`,
    ]);
    expect(new Set(ports).size).toBe(ports.length);
    expect(countRouteCrossings(routes)).toBeLessThanOrEqual(2);
    for (const route of routes) expect(route.points.length).toBeLessThanOrEqual(8);
  });

  it('separates parallel edges that share a channel', () => {
    // Two pairs whose natural routes run through the same gap.
    const rects = [
      rect('a1', 0, 0),
      rect('a2', 0, 400),
      rect('b1', 600, 200),
      rect('b2', 600, 600),
    ];
    const edges = [edge('a1', 'b1'), edge('a2', 'b2'), edge('a1', 'b2'), edge('a2', 'b1')];
    const routes = routeOrthogonalEdges(rects, edges);
    expectWellFormed(routes, rects, edges);
    expect(sharedTrackLength(routes)).toBe(0);
  });

  it('is deterministic', () => {
    const rects = arrangedWorkflow();
    const first = routeOrthogonalEdges(rects, WORKFLOW_EDGES);
    const second = routeOrthogonalEdges(
      rects.map((r) => ({ ...r })),
      WORKFLOW_EDGES.map((e) => ({ ...e }))
    );
    expect(second).toEqual(first);
  });

  it('skips self loops and edges to unknown zones', () => {
    const rects = [rect('a', 0, 0), rect('b', 480, 0)];
    const routes = routeOrthogonalEdges(rects, [
      edge('a', 'a'),
      edge('a', 'missing'),
      edge('a', 'b'),
    ]);
    expect(routes.map((route) => route.id)).toEqual(['a->b']);
  });

  it('routes a 30-zone, 60-edge board quickly and without overlaps', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({
      id: `z${i}`,
      width: 280 + (i % 3) * 40,
      height: 120 + (i % 4) * 60,
    }));
    const edges: RouteEdgeInput[] = [];
    for (let i = 0; i < 30; i += 1) {
      edges.push(edge(`z${i}`, `z${(i + 1) % 30}`));
      edges.push(edge(`z${i}`, `z${(i * 7 + 3) % 30}`));
    }
    const unique = edges.filter(
      (e, i) => e.source !== e.target && edges.findIndex((other) => other.id === e.id) === i
    );
    const layout = layoutZoneFlow(nodes, unique, { rankGap: 160, gapY: 48, gridSize: 20 });
    const rects = layout.placements.map((placement) => {
      const node = nodes.find((n) => n.id === placement.id) as (typeof nodes)[number];
      return rect(node.id, placement.x, placement.y, node.width, node.height);
    });
    const started = performance.now();
    const routes = routeOrthogonalEdges(rects, unique);
    const elapsed = performance.now() - started;
    expect(routes).toHaveLength(unique.length);
    expectWellFormed(routes, rects, unique);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('simplifyOrthogonalPath', () => {
  it('drops duplicates and merges collinear runs', () => {
    expect(
      simplifyOrthogonalPath([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
      ])
    ).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
  });
});

describe('placeEdgeLabels', () => {
  it('keeps labels off zones and off each other', () => {
    const rects = arrangedWorkflow();
    const routes = routeOrthogonalEdges(rects, WORKFLOW_EDGES);
    const sizes = new Map(routes.map((route) => [route.id, { width: 90, height: 20 }]));
    const labels = placeEdgeLabels(routes, rects, sizes);
    expect(labels.size).toBe(routes.length);
    const boxes = [...labels.values()].map((p) => ({
      x: p.x - 45,
      y: p.y - 10,
      width: 90,
      height: 20,
    }));
    const hits = (
      a: (typeof boxes)[number],
      b: { x: number; y: number; width: number; height: number }
    ) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    let collisions = 0;
    boxes.forEach((box, i) => {
      for (const other of boxes.slice(i + 1)) if (hits(box, other)) collisions += 1;
    });
    expect(collisions).toBe(0);
    // Each label sits on its own route.
    for (const route of routes) {
      const p = labels.get(route.id) as RoutePoint;
      const onRoute = route.points.slice(1).some((b, i) => {
        const a = route.points[i];
        return (
          p.x >= Math.min(a.x, b.x) - 1e-6 &&
          p.x <= Math.max(a.x, b.x) + 1e-6 &&
          p.y >= Math.min(a.y, b.y) - 1e-6 &&
          p.y <= Math.max(a.y, b.y) + 1e-6
        );
      });
      expect(onRoute).toBe(true);
    }
  });
});
