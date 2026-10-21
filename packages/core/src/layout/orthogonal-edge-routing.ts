/**
 * Orthogonal (Manhattan) routing for workflow transitions between zones, in
 * the style of schematic/EDA connectors and ELK/libavoid's orthogonal router.
 *
 *   1. Side selection: forward transitions leave a zone's right side and enter
 *      the target's left side. Back edges (target left of the source) loop over
 *      the top or under the bottom, whichever routes cheaper, instead of
 *      cutting back through the chart. Vertically stacked zones use
 *      bottom/top.
 *   2. Port distribution: every edge on a zone side gets its own attachment
 *      point, ordered by where the other end sits so ports do not cross.
 *   3. Routing: A* over a sparse orthogonal visibility grid built from the
 *      inflated zone outlines and port stubs. Cost is length plus penalties for
 *      bends, crossings and reusing another edge's track; zone interiors are
 *      impassable and the clearance margin around them is expensive.
 *   4. Nudging: inner segments that share a channel are ordered to minimise
 *      crossings and spread across it on separate tracks (centred when there
 *      is room), so parallel edges never draw on top of each other.
 *
 * Output is deterministic for a given input, so routes are derived on demand
 * rather than persisted with the board.
 */

export interface RouteRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RouteEdgeInput {
  id: string;
  source: string;
  target: string;
}

export type RouteSide = 'left' | 'right' | 'top' | 'bottom';

export interface RoutePoint {
  x: number;
  y: number;
}

export interface RoutedEdge {
  id: string;
  /** Polyline from the source port to the target port; every segment is axis-aligned. */
  points: RoutePoint[];
  sourceSide: RouteSide;
  targetSide: RouteSide;
  /** Where a label reads best: the middle of the longest horizontal run. */
  labelPoint: RoutePoint;
}

export interface EdgeRoutingOptions {
  /** Distance routes keep from zone outlines; also the port stub length. */
  clearance?: number;
  /** Maximum distance between neighbouring ports on one zone side. */
  portPitch?: number;
  /** Preferred distance between parallel tracks in a shared channel. */
  trackSpacing?: number;
  bendPenalty?: number;
  crossingPenalty?: number;
}

const DEFAULTS = {
  clearance: 24,
  portPitch: 20,
  trackSpacing: 16,
  bendPenalty: 48,
  crossingPenalty: 96,
} as const;

/** Cost multiplier for travelling inside another zone's clearance margin. */
const MARGIN_COST = 4;
/** Per-unit-length cost of running on a track another edge already uses. */
const SHARED_TRACK_COST = 0.5;
/** Shortest segment nudging may leave next to a bend. */
const MIN_JOG = 4;
const EPSILON = 1e-6;

type Axis = 'h' | 'v';

const sideNormal: Record<RouteSide, RoutePoint> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

// Direction indices for the A* state: +x, -x, +y, -y.
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const OPPOSITE = [1, 0, 3, 2];

const directionIndex = (vector: RoutePoint): number =>
  vector.x > 0 ? 0 : vector.x < 0 ? 1 : vector.y > 0 ? 2 : 3;

interface PlannedEdge {
  edge: RouteEdgeInput;
  source: RouteRect;
  target: RouteRect;
  sourceSide: RouteSide;
  targetSide: RouteSide;
  sourcePort: RoutePoint;
  targetPort: RoutePoint;
  order: number;
}

const center = (rect: RouteRect): RoutePoint => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

const sideMidpoint = (rect: RouteRect, side: RouteSide): RoutePoint => {
  const c = center(rect);
  switch (side) {
    case 'left':
      return { x: rect.x, y: c.y };
    case 'right':
      return { x: rect.x + rect.width, y: c.y };
    case 'top':
      return { x: c.x, y: rect.y };
    case 'bottom':
      return { x: c.x, y: rect.y + rect.height };
  }
};

const stubOf = (port: RoutePoint, side: RouteSide, length: number): RoutePoint => ({
  x: port.x + sideNormal[side].x * length,
  y: port.y + sideNormal[side].y * length,
});

/** Candidate (source side, target side) pairs, best guess first. */
function candidateSides(
  source: RouteRect,
  target: RouteRect,
  clearance: number
): Array<[RouteSide, RouteSide]> {
  const room = clearance * 2;
  if (target.x >= source.x + source.width + room) return [['right', 'left']];
  if (target.y >= source.y + source.height + room) return [['bottom', 'top']];
  if (source.y >= target.y + target.height + room) return [['top', 'bottom']];
  if (target.x + target.width <= source.x - room) {
    return [
      ['top', 'top'],
      ['bottom', 'bottom'],
    ];
  }
  return [['right', 'left']];
}

/** Sorted unique coordinates. */
function uniqueSorted(values: number[]): number[] {
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of values) {
    if (out.length === 0 || value - out[out.length - 1] > EPSILON) out.push(value);
  }
  return out;
}

function indexOf(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Math.abs(sorted[mid] - value) <= EPSILON) return mid;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Binary min-heap of A* states keyed by f-cost. */
class StateHeap {
  private keys: number[] = [];
  private states: number[] = [];
  get size(): number {
    return this.states.length;
  }
  push(key: number, state: number): void {
    const keys = this.keys;
    const states = this.states;
    let i = states.length;
    keys.push(key);
    states.push(state);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] < key || (keys[parent] === key && states[parent] <= state)) break;
      keys[i] = keys[parent];
      states[i] = states[parent];
      i = parent;
    }
    keys[i] = key;
    states[i] = state;
  }
  pop(): number {
    const keys = this.keys;
    const states = this.states;
    const top = states[0];
    const lastKey = keys.pop() as number;
    const lastState = states.pop() as number;
    const n = states.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= n) break;
        const right = left + 1;
        let child = left;
        if (
          right < n &&
          (keys[right] < keys[left] || (keys[right] === keys[left] && states[right] < states[left]))
        ) {
          child = right;
        }
        if (keys[child] > lastKey || (keys[child] === lastKey && states[child] >= lastState)) break;
        keys[i] = keys[child];
        states[i] = states[child];
        i = child;
      }
      keys[i] = lastKey;
      states[i] = lastState;
    }
    return top;
  }
}

/**
 * Sparse orthogonal visibility grid: lines at every inflated zone edge and
 * port stub. Segment blocking and margin costs are precomputed per grid step.
 */
class RoutingGrid {
  readonly xs: number[];
  readonly ys: number[];
  readonly nx: number;
  readonly ny: number;
  /** Grid point strictly inside a zone. */
  private pointBlocked: Uint8Array;
  /** Step (xi,yi)→(xi+1,yi) crosses a zone interior / its clearance margin. */
  private hBlocked: Uint8Array;
  private vBlocked: Uint8Array;
  private hMargin: Uint8Array;
  private vMargin: Uint8Array;
  /** How many routed edges use each step, and which points they pass through. */
  readonly hUse: Uint16Array;
  readonly vUse: Uint16Array;
  readonly passH: Uint8Array;
  readonly passV: Uint8Array;
  private g: Float64Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private generation = 0;

  constructor(rects: readonly RouteRect[], extraPoints: readonly RoutePoint[], clearance: number) {
    const xs: number[] = [];
    const ys: number[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const rect of rects) {
      xs.push(rect.x - clearance, rect.x + rect.width + clearance);
      ys.push(rect.y - clearance, rect.y + rect.height + clearance);
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    }
    for (const point of extraPoints) {
      xs.push(point.x);
      ys.push(point.y);
    }
    // An outer ring so loops can always go around everything.
    xs.push(minX - clearance * 2, maxX + clearance * 2);
    ys.push(minY - clearance * 2, maxY + clearance * 2);
    this.xs = uniqueSorted(xs);
    this.ys = uniqueSorted(ys);
    this.nx = this.xs.length;
    this.ny = this.ys.length;
    const points = this.nx * this.ny;
    this.pointBlocked = new Uint8Array(points);
    this.hBlocked = new Uint8Array(points);
    this.vBlocked = new Uint8Array(points);
    this.hMargin = new Uint8Array(points);
    this.vMargin = new Uint8Array(points);
    this.hUse = new Uint16Array(points);
    this.vUse = new Uint16Array(points);
    this.passH = new Uint8Array(points);
    this.passV = new Uint8Array(points);
    this.g = new Float64Array(points * 4);
    this.parent = new Int32Array(points * 4);
    this.stamp = new Uint32Array(points * 4);
    this.closed = new Uint32Array(points * 4);

    for (const rect of rects) {
      this.markRect(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, true);
      this.markRect(
        rect.x - clearance,
        rect.y - clearance,
        rect.x + rect.width + clearance,
        rect.y + rect.height + clearance,
        false
      );
    }
  }

  /** Mark the open box (left,right)×(top,bottom) as blocked or as margin. */
  private markRect(left: number, top: number, right: number, bottom: number, hard: boolean) {
    const { xs, ys, nx } = this;
    const inside = (value: number, lo: number, hi: number) =>
      value > lo + EPSILON && value < hi - EPSILON;
    for (let yi = 0; yi < this.ny; yi += 1) {
      if (!inside(ys[yi], top, bottom)) continue;
      for (let xi = 0; xi < nx; xi += 1) {
        if (hard && inside(xs[xi], left, right)) this.pointBlocked[yi * nx + xi] = 1;
        if (xi + 1 < nx && xs[xi] < right - EPSILON && xs[xi + 1] > left + EPSILON) {
          (hard ? this.hBlocked : this.hMargin)[yi * nx + xi] = 1;
        }
      }
    }
    for (let xi = 0; xi < nx; xi += 1) {
      if (!inside(xs[xi], left, right)) continue;
      for (let yi = 0; yi + 1 < this.ny; yi += 1) {
        if (ys[yi] < bottom - EPSILON && ys[yi + 1] > top + EPSILON) {
          (hard ? this.vBlocked : this.vMargin)[yi * nx + xi] = 1;
        }
      }
    }
  }

  pointIndex(point: RoutePoint): number {
    const xi = indexOf(this.xs, point.x);
    const yi = indexOf(this.ys, point.y);
    return xi < 0 || yi < 0 ? -1 : yi * this.nx + xi;
  }

  pointAt(index: number): RoutePoint {
    return { x: this.xs[index % this.nx], y: this.ys[Math.floor(index / this.nx)] };
  }

  /** Grid step from `point` in `dir`, or -1 when it leaves the grid or is blocked. */
  private step(point: number, dir: number): number {
    const nx = this.nx;
    const xi = point % nx;
    const yi = (point - xi) / nx;
    const tx = xi + DX[dir];
    const ty = yi + DY[dir];
    if (tx < 0 || ty < 0 || tx >= nx || ty >= this.ny) return -1;
    const next = ty * nx + tx;
    if (this.pointBlocked[next]) return -1;
    const blocked =
      dir < 2
        ? this.hBlocked[yi * nx + Math.min(xi, tx)]
        : this.vBlocked[Math.min(yi, ty) * nx + xi];
    return blocked ? -1 : next;
  }

  /**
   * Cheapest orthogonal path from `start` (leaving in `startDir`) to `goal`
   * (arriving in `goalDir`). Returns grid point indices or null.
   */
  search(
    start: number,
    startDir: number,
    goal: number,
    goalDir: number,
    penalties: { bend: number; crossing: number }
  ): { path: number[]; cost: number } | null {
    if (start < 0 || goal < 0) return null;
    this.generation += 1;
    const generation = this.generation;
    const { xs, ys, nx, g, parent, stamp, closed } = this;
    const goalX = xs[goal % nx];
    const goalY = ys[Math.floor(goal / nx)];
    const heuristic = (point: number) =>
      Math.abs(xs[point % nx] - goalX) + Math.abs(ys[Math.floor(point / nx)] - goalY);
    const heap = new StateHeap();
    const startState = start * 4 + startDir;
    stamp[startState] = generation;
    g[startState] = 0;
    parent[startState] = -1;
    heap.push(heuristic(start), startState);
    let bestGoalState = -1;
    let bestGoalCost = Number.POSITIVE_INFINITY;
    while (heap.size > 0) {
      const state = heap.pop();
      if (closed[state] === generation) continue;
      closed[state] = generation;
      const cost = g[state];
      if (cost + heuristic(Math.floor(state / 4)) >= bestGoalCost) break;
      const point = Math.floor(state / 4);
      const dir = state % 4;
      if (point === goal) {
        if (dir === OPPOSITE[goalDir]) continue;
        const total = cost + (dir === goalDir ? 0 : penalties.bend);
        if (total < bestGoalCost) {
          bestGoalCost = total;
          bestGoalState = state;
        }
        continue;
      }
      for (let nextDir = 0; nextDir < 4; nextDir += 1) {
        if (nextDir === OPPOSITE[dir]) continue;
        const next = this.step(point, nextDir);
        if (next < 0) continue;
        const horizontal = nextDir < 2;
        const segment = horizontal
          ? Math.floor(point / nx) * nx + Math.min(point % nx, next % nx)
          : Math.min(Math.floor(point / nx), Math.floor(next / nx)) * nx + (point % nx);
        const length = horizontal
          ? Math.abs(xs[next % nx] - xs[point % nx])
          : Math.abs(ys[Math.floor(next / nx)] - ys[Math.floor(point / nx)]);
        const margin = horizontal ? this.hMargin[segment] : this.vMargin[segment];
        const use = horizontal ? this.hUse[segment] : this.vUse[segment];
        let stepCost = length * (margin ? MARGIN_COST : 1) + length * SHARED_TRACK_COST * use;
        if (nextDir !== dir) stepCost += penalties.bend;
        if (next !== goal && (horizontal ? this.passV[next] : this.passH[next])) {
          stepCost += penalties.crossing;
        }
        const nextState = next * 4 + nextDir;
        const nextCost = cost + stepCost;
        if (closed[nextState] === generation) continue;
        if (stamp[nextState] === generation && g[nextState] <= nextCost) continue;
        stamp[nextState] = generation;
        g[nextState] = nextCost;
        parent[nextState] = state;
        heap.push(nextCost + heuristic(next), nextState);
      }
    }
    if (bestGoalState < 0) return null;
    const path: number[] = [];
    for (let state = bestGoalState; state >= 0; state = parent[state]) {
      path.push(Math.floor(state / 4));
    }
    path.reverse();
    return { path, cost: bestGoalCost };
  }

  /** Record a routed path so later searches avoid sharing or crossing it. */
  occupy(path: readonly number[]): void {
    const nx = this.nx;
    for (let i = 0; i + 1 < path.length; i += 1) {
      const a = path[i];
      const b = path[i + 1];
      if (a === b) continue;
      const horizontal = Math.floor(a / nx) === Math.floor(b / nx);
      if (horizontal) {
        this.hUse[Math.floor(a / nx) * nx + Math.min(a % nx, b % nx)] += 1;
        this.passH[a] = 1;
        this.passH[b] = 1;
      } else {
        this.vUse[Math.min(Math.floor(a / nx), Math.floor(b / nx)) * nx + (a % nx)] += 1;
        this.passV[a] = 1;
        this.passV[b] = 1;
      }
    }
  }
}

/** Drop repeated points and merge collinear runs. */
export function simplifyOrthogonalPath(points: readonly RoutePoint[]): RoutePoint[] {
  const deduped: RoutePoint[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.x - point.x) < EPSILON && Math.abs(last.y - point.y) < EPSILON) {
      continue;
    }
    deduped.push({ x: point.x, y: point.y });
  }
  const out: RoutePoint[] = [];
  for (const point of deduped) {
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear =
        (Math.abs(a.x - b.x) < EPSILON && Math.abs(b.x - point.x) < EPSILON) ||
        (Math.abs(a.y - b.y) < EPSILON && Math.abs(b.y - point.y) < EPSILON);
      if (!collinear) break;
      out.pop();
    }
    out.push(point);
  }
  return out;
}

/** Spread the ports of every zone side so no two edges share an attachment point. */
function assignPorts(planned: PlannedEdge[], portPitch: number, clearance: number): void {
  type Slot = { plan: PlannedEdge; end: 'source' | 'target' };
  const bySide = new Map<string, Slot[]>();
  const add = (rect: RouteRect, side: RouteSide, slot: Slot) => {
    const key = `${rect.id}\u0000${side}`;
    const list = bySide.get(key) ?? [];
    list.push(slot);
    bySide.set(key, list);
  };
  for (const plan of planned) {
    add(plan.source, plan.sourceSide, { plan, end: 'source' });
    add(plan.target, plan.targetSide, { plan, end: 'target' });
  }
  for (const [key, slots] of bySide) {
    const side = key.slice(key.indexOf('\u0000') + 1) as RouteSide;
    const rect = slots[0].end === 'source' ? slots[0].plan.source : slots[0].plan.target;
    const horizontalSide = side === 'top' || side === 'bottom';
    const own = center(rect);
    const otherOf = (slot: Slot) =>
      center(slot.end === 'source' ? slot.plan.target : slot.plan.source);
    // Loops (top→top / bottom→bottom) nest: the farther the other end, the
    // farther out its port, with leftward loops on the left half of the side.
    const loopGroup = (slot: Slot) => {
      const loop = slot.plan.sourceSide === slot.plan.targetSide;
      if (!loop) return 1;
      return otherOf(slot).x < own.x ? 0 : 2;
    };
    slots.sort((a, b) => {
      if (horizontalSide) {
        const group = loopGroup(a) - loopGroup(b);
        if (group !== 0) return group;
        const ax = otherOf(a).x;
        const bx = otherOf(b).x;
        if (ax !== bx) return loopGroup(a) === 1 ? ax - bx : bx - ax;
      } else {
        const ay = otherOf(a).y;
        const by = otherOf(b).y;
        if (ay !== by) return ay - by;
      }
      // Incoming and outgoing edges on the same side: keep each end's partner
      // ordering stable, then fall back to edge id.
      return a.plan.edge.id < b.plan.edge.id ? -1 : a.plan.edge.id > b.plan.edge.id ? 1 : 0;
    });
    const length = horizontalSide ? rect.width : rect.height;
    const usable = Math.max(0, length - clearance);
    const pitch = slots.length > 1 ? Math.min(portPitch, usable / (slots.length - 1)) : 0;
    const mid = sideMidpoint(rect, side);
    slots.forEach((slot, index) => {
      const offset = (index - (slots.length - 1) / 2) * pitch;
      const port = horizontalSide
        ? { x: mid.x + offset, y: mid.y }
        : { x: mid.x, y: mid.y + offset };
      if (slot.end === 'source') slot.plan.sourcePort = port;
      else slot.plan.targetPort = port;
    });
  }

  // Straighten: when an edge joins facing sides and either end has its side
  // to itself, slide that port level with the other so the wire runs straight
  // instead of jogging by a few pixels.
  const alone = (rect: RouteRect, side: RouteSide) =>
    (bySide.get(`${rect.id}\u0000${side}`)?.length ?? 0) === 1;
  const inset = Math.min(clearance, portPitch);
  for (const plan of planned) {
    const pair = `${plan.sourceSide}>${plan.targetSide}`;
    const facingX = pair === 'right>left' || pair === 'left>right';
    const facingY = pair === 'bottom>top' || pair === 'top>bottom';
    if (!facingX && !facingY) continue;
    const key = facingX ? 'y' : 'x';
    const range = (rect: RouteRect): [number, number] =>
      facingX
        ? [rect.y + inset, rect.y + rect.height - inset]
        : [rect.x + inset, rect.x + rect.width - inset];
    const sourceFree = alone(plan.source, plan.sourceSide);
    const targetFree = alone(plan.target, plan.targetSide);
    const [sLo, sHi] = range(plan.source);
    const [tLo, tHi] = range(plan.target);
    const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
    if (sourceFree && targetFree) {
      const lo = Math.max(sLo, tLo);
      const hi = Math.min(sHi, tHi);
      if (lo > hi) continue;
      const level = clamp((plan.sourcePort[key] + plan.targetPort[key]) / 2, lo, hi);
      plan.sourcePort = { ...plan.sourcePort, [key]: level };
      plan.targetPort = { ...plan.targetPort, [key]: level };
    } else if (sourceFree) {
      const level = plan.targetPort[key];
      if (level >= sLo && level <= sHi) plan.sourcePort = { ...plan.sourcePort, [key]: level };
    } else if (targetFree) {
      const level = plan.sourcePort[key];
      if (level >= tLo && level <= tHi) plan.targetPort = { ...plan.targetPort, [key]: level };
    }
  }
}

/**
 * Remove short Z-jogs left by routing on neighbouring grid lines: when two
 * parallel runs are joined by a tiny step, move the free run level with the
 * other, provided that stays clear of zones and of other edges' tracks.
 */
function removeJogs(routes: RoutePoint[][], rects: readonly RouteRect[], limit: number): void {
  const hitsRect = (a: RoutePoint, b: RoutePoint) =>
    rects.some(
      (r) =>
        Math.min(a.x, b.x) < r.x + r.width - EPSILON &&
        Math.max(a.x, b.x) > r.x + EPSILON &&
        Math.min(a.y, b.y) < r.y + r.height - EPSILON &&
        Math.max(a.y, b.y) > r.y + EPSILON
    );
  const overlapsOther = (route: number, a: RoutePoint, b: RoutePoint) => {
    const horizontal = Math.abs(a.y - b.y) < EPSILON;
    return routes.some((points, other) => {
      if (other === route) return false;
      for (let i = 0; i + 1 < points.length; i += 1) {
        const c = points[i];
        const d = points[i + 1];
        if (horizontal) {
          if (Math.abs(c.y - d.y) > EPSILON || Math.abs(c.y - a.y) > EPSILON) continue;
          if (Math.min(c.x, d.x) < Math.max(a.x, b.x) && Math.max(c.x, d.x) > Math.min(a.x, b.x)) {
            return true;
          }
        } else {
          if (Math.abs(c.x - d.x) > EPSILON || Math.abs(c.x - a.x) > EPSILON) continue;
          if (Math.min(c.y, d.y) < Math.max(a.y, b.y) && Math.max(c.y, d.y) > Math.min(a.y, b.y)) {
            return true;
          }
        }
      }
      return false;
    });
  };
  routes.forEach((original, route) => {
    let points = original;
    for (let changed = true, guard = 0; changed && guard < 8; guard += 1) {
      changed = false;
      for (let k = 1; k + 1 < points.length - 1; k += 1) {
        const a = points[k];
        const b = points[k + 1];
        const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (length >= limit || length < EPSILON) continue;
        const prev = points[k - 1];
        const next = points[k + 2];
        const jogVertical = Math.abs(a.x - b.x) < EPSILON;
        const key = jogVertical ? 'y' : 'x';
        const along = jogVertical ? 'x' : 'y';
        // Z shape only: both neighbours continue the same way.
        if (Math.sign(a[along] - prev[along]) !== Math.sign(next[along] - b[along])) continue;
        const candidates: Array<() => RoutePoint[] | null> = [];
        // Move the run after the jog onto the run before it (not the last, fixed run).
        if (k + 2 < points.length - 1) {
          candidates.push(() => {
            const moved = points.map((p) => ({ ...p }));
            moved[k + 1][key] = a[key];
            moved[k + 2][key] = a[key];
            const after = points[k + 3];
            if (
              Math.sign(after[key] - next[key]) !== Math.sign(after[key] - a[key]) &&
              after[key] !== next[key]
            ) {
              return null;
            }
            if (hitsRect(moved[k + 1], moved[k + 2]) || hitsRect(moved[k + 2], moved[k + 3]))
              return null;
            if (overlapsOther(route, moved[k], moved[k + 2])) return null;
            return moved;
          });
        }
        // Or move the run before it onto the run after it (not the first, fixed run).
        if (k - 1 > 0) {
          candidates.push(() => {
            const moved = points.map((p) => ({ ...p }));
            moved[k - 1][key] = b[key];
            moved[k][key] = b[key];
            const before = points[k - 2];
            if (
              Math.sign(before[key] - prev[key]) !== Math.sign(before[key] - b[key]) &&
              before[key] !== prev[key]
            ) {
              return null;
            }
            if (hitsRect(moved[k - 2], moved[k - 1]) || hitsRect(moved[k - 1], moved[k]))
              return null;
            if (overlapsOther(route, moved[k - 1], moved[k + 1])) return null;
            return moved;
          });
        }
        for (const attempt of candidates) {
          const moved = attempt();
          if (moved) {
            points = simplifyOrthogonalPath(moved);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
    routes[route] = points;
  });
}

interface Segment {
  route: number;
  /** Index of the segment's first point in the route's point list. */
  index: number;
  axis: Axis;
  /** Coordinate the segment sits on (x for vertical, y for horizontal). */
  at: number;
  /** Extent along the segment. */
  min: number;
  max: number;
  /** Direction (±1) the neighbouring segment leaves each end toward, across the channel axis. */
  ends: Array<{ pos: number; dir: number }>;
  lo: number;
  hi: number;
}

/**
 * Separate and centre inner segments that share a channel. Vertical segments
 * move in x, horizontal ones in y; the first and last segments stay on their
 * ports.
 */
function nudge(
  routes: RoutePoint[][],
  rects: readonly RouteRect[],
  axis: Axis,
  clearance: number,
  trackSpacing: number
): void {
  const segments: Segment[] = [];
  routes.forEach((points, route) => {
    for (let index = 1; index + 2 < points.length; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      const vertical = Math.abs(a.x - b.x) < EPSILON;
      if ((axis === 'v') !== vertical) continue;
      const at = vertical ? a.x : a.y;
      const along = (p: RoutePoint) => (vertical ? p.y : p.x);
      const across = (p: RoutePoint) => (vertical ? p.x : p.y);
      const min = Math.min(along(a), along(b));
      const max = Math.max(along(a), along(b));
      const prev = points[index - 1];
      const next = points[index + 2];
      const prevDir = Math.sign(across(prev) - at);
      const nextDir = Math.sign(across(next) - at);
      // Free channel: nearest zone (plus clearance) on either side across the
      // segment's whole extent, so the neighbours' runs stay clear as it moves.
      let lo = Number.NEGATIVE_INFINITY;
      let hi = Number.POSITIVE_INFINITY;
      for (const rect of rects) {
        const rMin = vertical ? rect.y : rect.x;
        const rMax = vertical ? rect.y + rect.height : rect.x + rect.width;
        if (rMin - clearance >= max || rMax + clearance <= min) continue;
        const cLo = (vertical ? rect.x : rect.y) - clearance;
        const cHi = (vertical ? rect.x + rect.width : rect.y + rect.height) + clearance;
        if (cHi <= at + EPSILON) lo = Math.max(lo, cHi);
        else if (cLo >= at - EPSILON) hi = Math.min(hi, cLo);
        else {
          // Already squeezed through a margin: do not move.
          lo = Math.max(lo, at);
          hi = Math.min(hi, at);
        }
      }
      // Keep both neighbouring runs pointing the same way (no folding back).
      const prevAcross = across(prev);
      const nextAcross = across(next);
      if (prevDir > 0) hi = Math.min(hi, prevAcross - MIN_JOG);
      else if (prevDir < 0) lo = Math.max(lo, prevAcross + MIN_JOG);
      if (nextDir > 0) hi = Math.min(hi, nextAcross - MIN_JOG);
      else if (nextDir < 0) lo = Math.max(lo, nextAcross + MIN_JOG);
      if (lo > at) lo = at;
      if (hi < at) hi = at;
      const startPos = along(a);
      const endPos = along(b);
      segments.push({
        route,
        index,
        axis,
        at,
        min,
        max,
        ends: [
          { pos: startPos, dir: prevDir },
          { pos: endPos, dir: nextDir },
        ],
        lo,
        hi,
      });
    }
  });
  if (segments.length === 0) return;

  // Group segments competing for the same channel stretch (union-find).
  const parent = segments.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let a = 0; a < segments.length; a += 1) {
    for (let b = a + 1; b < segments.length; b += 1) {
      const sa = segments[a];
      const sb = segments[b];
      if (sa.min >= sb.max + trackSpacing || sb.min >= sa.max + trackSpacing) continue;
      if (sa.lo > sb.hi || sb.lo > sa.hi) continue;
      parent[find(a)] = find(b);
    }
  }
  const groups = new Map<number, Segment[]>();
  segments.forEach((segment, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(segment);
    groups.set(root, list);
  });

  const inSpan = (pos: number, s: Segment) => pos > s.min + EPSILON && pos < s.max - EPSILON;
  // Crossings created when `a` sits at a lower coordinate than `b`.
  const crossingsIfBefore = (a: Segment, b: Segment) => {
    let count = 0;
    for (const end of a.ends) if (end.dir > 0 && inSpan(end.pos, b)) count += 1;
    for (const end of b.ends) if (end.dir < 0 && inSpan(end.pos, a)) count += 1;
    return count;
  };
  const stableKey = (s: Segment) => `${s.route}:${s.index}`;

  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at || a.route - b.route || a.index - b.index);
    // Greedy insertion by crossing count, ties keep the current order.
    const order: Segment[] = [];
    for (const segment of group) {
      let bestAt = order.length;
      let bestCost = Number.POSITIVE_INFINITY;
      for (let position = 0; position <= order.length; position += 1) {
        let cost = 0;
        for (let i = 0; i < order.length; i += 1) {
          cost +=
            i < position
              ? crossingsIfBefore(order[i], segment)
              : crossingsIfBefore(segment, order[i]);
        }
        if (cost < bestCost) {
          bestCost = cost;
          bestAt = position;
        }
      }
      order.splice(bestAt, 0, segment);
    }
    // Adjacent swaps until stable.
    for (let changed = true, guard = 0; changed && guard < order.length * 2; guard += 1) {
      changed = false;
      for (let i = 0; i + 1 < order.length; i += 1) {
        const keep = crossingsIfBefore(order[i], order[i + 1]);
        const swap = crossingsIfBefore(order[i + 1], order[i]);
        if (
          swap < keep ||
          (swap === keep &&
            order[i].at === order[i + 1].at &&
            stableKey(order[i]) > stableKey(order[i + 1]))
        ) {
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
          changed = true;
        }
      }
    }

    const lo = Math.max(...order.map((s) => s.lo));
    const hi = Math.min(...order.map((s) => s.hi));
    const n = order.length;
    const targets: number[] = [];
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
      const spacing = n > 0 ? Math.min(trackSpacing, (hi - lo) / (n + 1)) : 0;
      const middle = (lo + hi) / 2;
      for (let i = 0; i < n; i += 1) targets.push(middle + (i - (n - 1) / 2) * spacing);
    } else if (Number.isFinite(hi) && !Number.isFinite(lo)) {
      // Open toward lower coordinates (e.g. above all zones): stack outward.
      for (let i = 0; i < n; i += 1) targets.push(hi - (n - 1 - i) * trackSpacing);
    } else if (Number.isFinite(lo) && !Number.isFinite(hi)) {
      for (let i = 0; i < n; i += 1) targets.push(lo + i * trackSpacing);
    } else {
      const middle = order.reduce((sum, s) => sum + s.at, 0) / Math.max(1, n);
      for (let i = 0; i < n; i += 1) targets.push(middle + (i - (n - 1) / 2) * trackSpacing);
    }
    // Respect each segment's own limits, then restore order/spacing best-effort.
    const placed = order.map((s, i) => Math.min(Math.max(targets[i], s.lo), s.hi));
    for (let i = 1; i < n; i += 1) {
      const min = placed[i - 1] + Math.min(trackSpacing, MIN_JOG * 2);
      if (placed[i] < min) placed[i] = Math.min(min, order[i].hi);
    }
    order.forEach((segment, i) => {
      const value = placed[i];
      const points = routes[segment.route];
      const key = segment.axis === 'v' ? 'x' : 'y';
      points[segment.index][key] = value;
      points[segment.index + 1][key] = value;
    });
  }
}

function labelPointOf(points: readonly RoutePoint[]): RoutePoint {
  let best: { length: number; point: RoutePoint } | null = null;
  let bestAny: { length: number; point: RoutePoint } | null = null;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!bestAny || length > bestAny.length) bestAny = { length, point };
    if (Math.abs(a.y - b.y) < EPSILON && (!best || length > best.length)) best = { length, point };
  }
  if (best && bestAny && best.length >= Math.min(80, bestAny.length)) return best.point;
  return bestAny?.point ?? points[0] ?? { x: 0, y: 0 };
}

/** Fallback when no grid path exists: a plain elbow through the stubs. */
function elbow(from: RoutePoint, fromSide: RouteSide, to: RoutePoint, toSide: RouteSide) {
  const horizontalExit = fromSide === 'left' || fromSide === 'right';
  const horizontalEntry = toSide === 'left' || toSide === 'right';
  if (horizontalExit && horizontalEntry) {
    const midX = (from.x + to.x) / 2;
    return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
  }
  if (!horizontalExit && !horizontalEntry) {
    const midY = (from.y + to.y) / 2;
    return [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to];
  }
  return horizontalExit ? [from, { x: to.x, y: from.y }, to] : [from, { x: from.x, y: to.y }, to];
}

/**
 * Route every transition between the given zones. Edges whose ends are not in
 * `rects`, or that loop back to their own zone, are omitted.
 */
export function routeOrthogonalEdges(
  rects: readonly RouteRect[],
  edges: readonly RouteEdgeInput[],
  options: EdgeRoutingOptions = {}
): RoutedEdge[] {
  const clearance = options.clearance ?? DEFAULTS.clearance;
  const portPitch = options.portPitch ?? DEFAULTS.portPitch;
  const trackSpacing = options.trackSpacing ?? DEFAULTS.trackSpacing;
  const penalties = {
    bend: options.bendPenalty ?? DEFAULTS.bendPenalty,
    crossing: options.crossingPenalty ?? DEFAULTS.crossingPenalty,
  };
  const rectById = new Map(rects.map((rect) => [rect.id, rect]));
  const valid = edges.filter(
    (edge) => edge.source !== edge.target && rectById.has(edge.source) && rectById.has(edge.target)
  );
  if (valid.length === 0) return [];

  // 1. Sides. Ambiguous back edges are decided by a quick unloaded route
  // between side midpoints.
  const candidatesByEdge = valid.map((edge) => {
    const source = rectById.get(edge.source) as RouteRect;
    const target = rectById.get(edge.target) as RouteRect;
    return { edge, source, target, candidates: candidateSides(source, target, clearance) };
  });
  let probeGrid: RoutingGrid | null = null;
  const planned: PlannedEdge[] = candidatesByEdge.map(
    ({ edge, source, target, candidates }, order) => {
      let [sourceSide, targetSide] = candidates[0];
      if (candidates.length > 1) {
        if (!probeGrid) {
          const stubs = candidatesByEdge.flatMap((entry) =>
            entry.candidates.flatMap(([s, t]) => [
              stubOf(sideMidpoint(entry.source, s), s, clearance),
              stubOf(sideMidpoint(entry.target, t), t, clearance),
            ])
          );
          probeGrid = new RoutingGrid(rects, stubs, clearance);
        }
        let bestCost = Number.POSITIVE_INFINITY;
        for (const [s, t] of candidates) {
          const from = stubOf(sideMidpoint(source, s), s, clearance);
          const to = stubOf(sideMidpoint(target, t), t, clearance);
          const found = probeGrid.search(
            probeGrid.pointIndex(from),
            directionIndex(sideNormal[s]),
            probeGrid.pointIndex(to),
            directionIndex({ x: -sideNormal[t].x, y: -sideNormal[t].y }),
            penalties
          );
          const cost = found?.cost ?? Number.POSITIVE_INFINITY;
          if (cost < bestCost) {
            bestCost = cost;
            sourceSide = s;
            targetSide = t;
          }
        }
      }
      return {
        edge,
        source,
        target,
        sourceSide,
        targetSide,
        sourcePort: sideMidpoint(source, sourceSide),
        targetPort: sideMidpoint(target, targetSide),
        order,
      };
    }
  );

  // 2. Ports.
  assignPorts(planned, portPitch, clearance);

  // 3. Route, shortest forward edges first so the main flow claims the
  // straight tracks and loops go around it.
  const stubs = planned.flatMap((plan) => [
    stubOf(plan.sourcePort, plan.sourceSide, clearance),
    stubOf(plan.targetPort, plan.targetSide, clearance),
  ]);
  const grid = new RoutingGrid(rects, stubs, clearance);
  const routeOrder = [...planned].sort((a, b) => {
    const loopA = a.sourceSide === a.targetSide ? 1 : 0;
    const loopB = b.sourceSide === b.targetSide ? 1 : 0;
    if (loopA !== loopB) return loopA - loopB;
    const lengthA =
      Math.abs(a.sourcePort.x - a.targetPort.x) + Math.abs(a.sourcePort.y - a.targetPort.y);
    const lengthB =
      Math.abs(b.sourcePort.x - b.targetPort.x) + Math.abs(b.sourcePort.y - b.targetPort.y);
    if (lengthA !== lengthB) return lengthA - lengthB;
    return a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0;
  });
  const pointsByOrder: RoutePoint[][] = new Array(planned.length);
  for (const plan of routeOrder) {
    const fromStub = stubOf(plan.sourcePort, plan.sourceSide, clearance);
    const toStub = stubOf(plan.targetPort, plan.targetSide, clearance);
    const found = grid.search(
      grid.pointIndex(fromStub),
      directionIndex(sideNormal[plan.sourceSide]),
      grid.pointIndex(toStub),
      directionIndex({ x: -sideNormal[plan.targetSide].x, y: -sideNormal[plan.targetSide].y }),
      penalties
    );
    let points: RoutePoint[];
    if (found) {
      grid.occupy(found.path);
      points = [
        plan.sourcePort,
        ...found.path.map((index) => grid.pointAt(index)),
        plan.targetPort,
      ];
    } else {
      points = [
        plan.sourcePort,
        ...elbow(fromStub, plan.sourceSide, toStub, plan.targetSide),
        plan.targetPort,
      ];
    }
    pointsByOrder[plan.order] = simplifyOrthogonalPath(points);
  }

  // 4. Nudge parallel runs apart: verticals first, then horizontals against
  // the updated verticals.
  nudge(pointsByOrder, rects, 'v', clearance, trackSpacing);
  nudge(pointsByOrder, rects, 'h', clearance, trackSpacing);
  removeJogs(pointsByOrder, rects, trackSpacing * 1.5);

  return planned.map((plan) => {
    const points = simplifyOrthogonalPath(pointsByOrder[plan.order]);
    return {
      id: plan.edge.id,
      points,
      sourceSide: plan.sourceSide,
      targetSide: plan.targetSide,
      labelPoint: labelPointOf(points),
    };
  });
}

/** Proper crossings between segments of different routes (shared endpoints excluded). */
export function countRouteCrossings(routes: readonly RoutedEdge[]): number {
  type Seg = { route: number; a: RoutePoint; b: RoutePoint };
  const horizontal: Seg[] = [];
  const vertical: Seg[] = [];
  routes.forEach((route, index) => {
    for (let i = 0; i + 1 < route.points.length; i += 1) {
      const a = route.points[i];
      const b = route.points[i + 1];
      (Math.abs(a.y - b.y) < EPSILON ? horizontal : vertical).push({ route: index, a, b });
    }
  });
  let crossings = 0;
  for (const h of horizontal) {
    const x1 = Math.min(h.a.x, h.b.x);
    const x2 = Math.max(h.a.x, h.b.x);
    for (const v of vertical) {
      if (v.route === h.route) continue;
      const y1 = Math.min(v.a.y, v.b.y);
      const y2 = Math.max(v.a.y, v.b.y);
      if (
        v.a.x > x1 + EPSILON &&
        v.a.x < x2 - EPSILON &&
        h.a.y > y1 + EPSILON &&
        h.a.y < y2 - EPSILON
      ) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

export interface EdgeLabelSize {
  width: number;
  height: number;
}

/**
 * Pick a spot on each route for its label so labels sit on their own wire,
 * clear of zones and of each other. Candidates slide along every segment
 * (horizontal runs first, middles first); the cheapest by overlap wins.
 * Shortest routes are placed first: a one-segment hop has nowhere else to
 * put its label, while long routes have plenty of alternatives.
 */
export function placeEdgeLabels(
  routes: readonly RoutedEdge[],
  rects: readonly RouteRect[],
  sizes: ReadonlyMap<string, EdgeLabelSize>
): Map<string, RoutePoint> {
  const placed: Array<{ x: number; y: number; width: number; height: number }> = [];
  const result = new Map<string, RoutePoint>();
  const overlap = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const routeLength = (route: RoutedEdge) =>
    route.points.reduce(
      (sum, point, i) =>
        i === 0
          ? 0
          : sum +
            Math.abs(point.x - route.points[i - 1].x) +
            Math.abs(point.y - route.points[i - 1].y),
      0
    );
  const ordered = routes
    .filter((route) => sizes.has(route.id))
    .sort((a, b) => routeLength(a) - routeLength(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fractions = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
  for (const route of ordered) {
    const size = sizes.get(route.id) as EdgeLabelSize;
    let best: { point: RoutePoint; cost: number } | null = null;
    for (let i = 0; i + 1 < route.points.length; i += 1) {
      const a = route.points[i];
      const b = route.points[i + 1];
      const horizontal = Math.abs(a.y - b.y) < EPSILON;
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (length < EPSILON) continue;
      const along = horizontal ? size.width : size.height;
      fractions.forEach((fraction, rank) => {
        const point = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
        const box = {
          x: point.x - size.width / 2,
          y: point.y - size.height / 2,
          width: size.width,
          height: size.height,
        };
        let cost = rank * 2 + (horizontal ? 0 : 40) + (along > length ? 30 : 0);
        for (const rect of rects) cost += overlap(box, rect) * 0.5;
        for (const other of placed) cost += overlap(box, other) * 2;
        if (!best || cost < best.cost) best = { point, cost };
      });
    }
    const chosen = (best as { point: RoutePoint; cost: number } | null)?.point ?? route.labelPoint;
    result.set(route.id, chosen);
    placed.push({
      x: chosen.x - size.width / 2,
      y: chosen.y - size.height / 2,
      width: size.width,
      height: size.height,
    });
  }
  return result;
}
