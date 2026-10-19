/**
 * Layered (Sugiyama-style) layout for zones joined by workflow transitions.
 *
 * Transitions leave a zone's right handle and enter the target's left handle,
 * so the chart runs left to right: each rank is a column and every transition
 * should point forward into a later column.
 *
 *   1. Break cycles with a DFS feedback-arc pass (back edges are reversed for
 *      ranking only, so a loop costs one backwards arrow, not a tangle).
 *   2. Rank by longest path so a zone always sits right of everything feeding it.
 *   3. Give each multi-rank edge a dummy node in every rank it crosses. Dummies
 *      reserve a lane, so the arrow passes between zones instead of under them.
 *   4. Order each rank by barycenter sweeps, keeping the ordering with the
 *      fewest edge crossings.
 *   5. Zones with no transitions are packed in shelves after the flow.
 */

export interface ZoneFlowNode {
  id: string;
  width: number;
  height: number;
}

export interface ZoneFlowEdge {
  source: string;
  target: string;
}

export interface ZoneFlowOptions {
  /** Horizontal space between rank columns (room for arrows and labels). */
  rankGap: number;
  /** Space between side-by-side disconnected zones. Defaults to `rankGap`. */
  gapX?: number;
  /** Vertical space between zones in a rank, and around reserved arrow lanes. */
  gapY: number;
  /** Space between the flow chart and the packed disconnected zones. */
  tailGap?: number;
  /** Positions snap up to this grid. */
  gridSize?: number;
}

export interface ZoneFlowPlacement {
  id: string;
  x: number;
  y: number;
  /** Rank (column) for flow zones; slot within the shelf row for disconnected ones. */
  column: number;
  /** Position within the rank; disconnected shelf rows continue after the last rank. */
  row: number;
  /** False for zones packed after the flow because nothing links to them. */
  inFlow: boolean;
}

export interface ZoneFlowResult {
  placements: ZoneFlowPlacement[];
  width: number;
  height: number;
  ranks: number;
  /** Transitions that run against the chart direction (cycle closers). */
  backEdges: ZoneFlowEdge[];
}

/**
 * Lane nodes (and edges into them) outweigh real zones when relaxing, so a
 * multi-rank transition stays a straight line and the zones it bypasses are
 * the ones that move aside.
 */
const LANE_WEIGHT = 64;

/** Height of the lane an arrow passing through a rank reserves between zones. */
const LANE_HEIGHT = 20;
const SWEEPS = 8;

interface LayerNode {
  key: string;
  /** Real zone id, absent for dummy lane nodes. */
  id?: string;
  width: number;
  height: number;
}

const snapUp = (value: number, grid: number): number =>
  grid > 0 ? Math.ceil(value / grid) * grid : value;

interface Block {
  keys: string[];
  /** Offset of each key from the block top. */
  offsets: number[];
  desired: number[];
  weights: number[];
  extent: number;
  top: number;
}

const blockTop = (block: Block): number =>
  block.desired.reduce(
    (sum, value, index) => sum + (value - block.offsets[index]) * block.weights[index],
    0
  ) / block.weights.reduce((sum, weight) => sum + weight, 0);

/** Minimal-displacement placement of an ordered column around desired tops. */
function resolveColumn(
  keys: readonly string[],
  desiredTops: readonly number[],
  heights: readonly number[],
  weights: readonly number[],
  gap: number
): number[] {
  const blocks: Block[] = [];
  keys.forEach((key, index) => {
    let block: Block = {
      keys: [key],
      offsets: [0],
      desired: [desiredTops[index]],
      weights: [weights[index]],
      extent: heights[index],
      top: desiredTops[index],
    };
    for (;;) {
      const previous = blocks[blocks.length - 1];
      if (!previous || block.top >= previous.top + previous.extent + gap) break;
      const shift = previous.extent + gap;
      previous.keys.push(...block.keys);
      previous.offsets.push(...block.offsets.map((offset) => offset + shift));
      previous.desired.push(...block.desired);
      previous.weights.push(...block.weights);
      previous.extent = shift + block.extent;
      previous.top = blockTop(previous);
      blocks.pop();
      block = previous;
    }
    blocks.push(block);
  });
  const tops: number[] = [];
  for (const block of blocks) {
    for (const offset of block.offsets) tops.push(block.top + offset);
  }
  return tops;
}

function assignVerticalPositions(
  order: readonly string[][],
  nodeByKey: ReadonlyMap<string, LayerNode>,
  upper: ReadonlyMap<string, string[]>,
  lower: ReadonlyMap<string, string[]>,
  gap: number,
  grid: number
): Map<string, number> {
  const heightOf = (key: string) => nodeByKey.get(key)?.height ?? 0;
  const isLane = (key: string) => nodeByKey.get(key)?.id === undefined;
  const tops = new Map<string, number>();
  for (const layer of order) {
    let cursor = 0;
    for (const key of layer) {
      tops.set(key, cursor);
      cursor += heightOf(key) + gap;
    }
  }
  const relax = (rank: number, neighbours: ReadonlyMap<string, string[]>) => {
    const layer = order[rank];
    const desired = layer.map((key) => {
      const near = neighbours.get(key) ?? [];
      const own = tops.get(key) ?? 0;
      if (near.length === 0) return own;
      const ownLane = isLane(key);
      let weighted = 0;
      let total = 0;
      for (const n of near) {
        const weight = ownLane || isLane(n) ? LANE_WEIGHT : 1;
        weighted += ((tops.get(n) ?? 0) + heightOf(n) / 2) * weight;
        total += weight;
      }
      return weighted / total - heightOf(key) / 2;
    });
    const resolved = resolveColumn(
      layer,
      desired,
      layer.map(heightOf),
      layer.map((key) => (isLane(key) ? LANE_WEIGHT : 1)),
      gap
    );
    for (const [index, key] of layer.entries()) tops.set(key, resolved[index]);
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let rank = 1; rank < order.length; rank += 1) relax(rank, upper);
    for (let rank = order.length - 2; rank >= 0; rank -= 1) relax(rank, lower);
  }
  for (let rank = 1; rank < order.length; rank += 1) relax(rank, upper);

  const minTop = tops.size > 0 ? Math.min(...tops.values()) : 0;
  const snapped = new Map<string, number>();
  for (const [key, top] of tops) {
    const shifted = top - minTop;
    snapped.set(key, grid > 0 ? Math.round(shifted / grid) * grid : shifted);
  }
  return snapped;
}

export function layoutZoneFlow(
  nodes: readonly ZoneFlowNode[],
  edges: readonly ZoneFlowEdge[],
  options: ZoneFlowOptions
): ZoneFlowResult {
  const grid = options.gridSize ?? 0;
  const rankGap = snapUp(Math.max(0, options.rankGap), grid);
  const gapY = snapUp(Math.max(0, options.gapY), grid);
  const shelfGapX = snapUp(Math.max(0, options.gapX ?? options.rankGap), grid);
  const tailGap = snapUp(Math.max(0, options.tailGap ?? options.gapY * 2), grid);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const seenEdges = new Set<string>();
  const cleanEdges: ZoneFlowEdge[] = [];
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    cleanEdges.push(edge);
  }

  const linked = new Set(cleanEdges.flatMap((edge) => [edge.source, edge.target]));
  const flowNodes = nodes.filter((node) => linked.has(node.id));
  const looseNodes = nodes.filter((node) => !linked.has(node.id));

  // 1. Cycle breaking. DFS from entry points (no incoming edge) first so a
  // loop is opened at its natural re-entry rather than at an arbitrary zone.
  const outgoing = new Map<string, string[]>(flowNodes.map((node) => [node.id, []]));
  const hasIncoming = new Set<string>();
  for (const edge of cleanEdges) {
    outgoing.get(edge.source)?.push(edge.target);
    hasIncoming.add(edge.target);
  }
  const roots = [
    ...flowNodes.filter((node) => !hasIncoming.has(node.id)),
    ...flowNodes.filter((node) => hasIncoming.has(node.id)),
  ];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const preorder = new Map<string, number>();
  const backEdgeKeys = new Set<string>();
  for (const root of roots) {
    if (visited.has(root.id)) continue;
    visited.add(root.id);
    onStack.add(root.id);
    preorder.set(root.id, preorder.size);
    const stack: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = outgoing.get(frame.id) ?? [];
      if (frame.next >= targets.length) {
        onStack.delete(frame.id);
        stack.pop();
        continue;
      }
      const target = targets[frame.next++];
      if (onStack.has(target)) {
        backEdgeKeys.add(`${frame.id}\u0000${target}`);
      } else if (!visited.has(target)) {
        visited.add(target);
        onStack.add(target);
        preorder.set(target, preorder.size);
        stack.push({ id: target, next: 0 });
      }
    }
  }
  const backEdges = cleanEdges.filter((edge) =>
    backEdgeKeys.has(`${edge.source}\u0000${edge.target}`)
  );
  const dagKeys = new Set<string>();
  const dagEdges: ZoneFlowEdge[] = [];
  for (const edge of cleanEdges) {
    const reversed = backEdgeKeys.has(`${edge.source}\u0000${edge.target}`);
    const oriented = reversed ? { source: edge.target, target: edge.source } : edge;
    const key = `${oriented.source}\u0000${oriented.target}`;
    if (dagKeys.has(key)) continue;
    dagKeys.add(key);
    dagEdges.push(oriented);
  }

  // 2. Longest-path ranking in topological order.
  const dagIncoming = new Map<string, string[]>(flowNodes.map((node) => [node.id, []]));
  const dagOutgoing = new Map<string, string[]>(flowNodes.map((node) => [node.id, []]));
  const indegree = new Map<string, number>(flowNodes.map((node) => [node.id, 0]));
  for (const edge of dagEdges) {
    dagIncoming.get(edge.target)?.push(edge.source);
    dagOutgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const rankOf = new Map<string, number>(flowNodes.map((node) => [node.id, 0]));
  const queue = flowNodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const target of dagOutgoing.get(id) ?? []) {
      rankOf.set(target, Math.max(rankOf.get(target) ?? 0, (rankOf.get(id) ?? 0) + 1));
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  const rankCount = flowNodes.length === 0 ? 0 : Math.max(...rankOf.values()) + 1;

  // 3. Layers with dummy lane nodes for edges spanning more than one rank.
  const layers: LayerNode[][] = Array.from({ length: rankCount }, () => []);
  const layerNodeByKey = new Map<string, LayerNode>();
  const addToLayer = (rank: number, node: LayerNode) => {
    layers[rank].push(node);
    layerNodeByKey.set(node.key, node);
  };
  for (const node of [...flowNodes].sort(
    (left, right) => (preorder.get(left.id) ?? 0) - (preorder.get(right.id) ?? 0)
  )) {
    addToLayer(rankOf.get(node.id) ?? 0, {
      key: node.id,
      id: node.id,
      width: node.width,
      height: node.height,
    });
  }
  const layerEdges: Array<[string, string]> = [];
  for (const edge of dagEdges) {
    const from = rankOf.get(edge.source) ?? 0;
    const to = rankOf.get(edge.target) ?? 0;
    let previous = edge.source;
    for (let rank = from + 1; rank < to; rank += 1) {
      const key = `${edge.source}\u0000${edge.target}\u0000lane${rank}`;
      addToLayer(rank, { key, width: 0, height: LANE_HEIGHT });
      layerEdges.push([previous, key]);
      previous = key;
    }
    layerEdges.push([previous, edge.target]);
  }
  const upper = new Map<string, string[]>();
  const lower = new Map<string, string[]>();
  for (const [from, to] of layerEdges) {
    (lower.get(from) ?? lower.set(from, []).get(from))?.push(to);
    (upper.get(to) ?? upper.set(to, []).get(to))?.push(from);
  }

  // 4. Barycenter ordering, keeping the sweep with the fewest crossings.
  const positionIn = (order: string[][]) => {
    const positions = new Map<string, number>();
    for (const layer of order) {
      for (const [index, key] of layer.entries()) positions.set(key, index);
    }
    return positions;
  };
  const countCrossings = (order: string[][]): number => {
    const positions = positionIn(order);
    let crossings = 0;
    for (let rank = 0; rank + 1 < order.length; rank += 1) {
      const pairs: Array<[number, number]> = [];
      for (const key of order[rank]) {
        for (const target of lower.get(key) ?? []) {
          pairs.push([positions.get(key) ?? 0, positions.get(target) ?? 0]);
        }
      }
      for (let a = 0; a < pairs.length; a += 1) {
        for (let b = a + 1; b < pairs.length; b += 1) {
          if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) crossings += 1;
        }
      }
    }
    return crossings;
  };
  const reorder = (
    order: string[][],
    rank: number,
    neighbours: Map<string, string[]>,
    reference: Map<string, number>
  ) => {
    const current = order[rank];
    const score = new Map<string, number>();
    current.forEach((key, index) => {
      const near = (neighbours.get(key) ?? []).map((n) => reference.get(n) ?? 0);
      score.set(key, near.length > 0 ? near.reduce((sum, v) => sum + v, 0) / near.length : index);
    });
    const index = new Map(current.map((key, i) => [key, i]));
    order[rank] = [...current].sort(
      (left, right) =>
        (score.get(left) ?? 0) - (score.get(right) ?? 0) ||
        (index.get(left) ?? 0) - (index.get(right) ?? 0)
    );
  };
  let best = layers.map((layer) => layer.map((node) => node.key));
  let bestCrossings = countCrossings(best);
  const working = best.map((layer) => [...layer]);
  for (let sweep = 0; sweep < SWEEPS && bestCrossings > 0; sweep += 1) {
    if (sweep % 2 === 0) {
      for (let rank = 1; rank < working.length; rank += 1) {
        reorder(working, rank, upper, positionIn(working));
      }
    } else {
      for (let rank = working.length - 2; rank >= 0; rank -= 1) {
        reorder(working, rank, lower, positionIn(working));
      }
    }
    const crossings = countCrossings(working);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = working.map((layer) => [...layer]);
    }
  }

  // 5. Coordinates: rank columns left to right. Vertical positions are relaxed
  // toward the mean centre of each node's neighbours (so chains and lanes run
  // straight) and then pushed apart just enough that nothing overlaps.
  const tops = assignVerticalPositions(best, layerNodeByKey, upper, lower, gapY, grid);
  const placements: ZoneFlowPlacement[] = [];
  let flowHeight = 0;
  let cursorX = 0;
  best.forEach((layer, rank) => {
    const columnWidth = Math.max(0, ...layer.map((key) => layerNodeByKey.get(key)?.width ?? 0));
    let row = 0;
    for (const key of layer) {
      const node = layerNodeByKey.get(key);
      if (!node) continue;
      const y = tops.get(key) ?? 0;
      flowHeight = Math.max(flowHeight, y + node.height);
      if (node.id !== undefined) {
        placements.push({ id: node.id, x: cursorX, y, column: rank, row, inFlow: true });
        row += 1;
      }
    }
    cursorX += columnWidth + rankGap;
  });
  const flowWidth = Math.max(0, cursorX - rankGap);

  // 6. Disconnected zones follow the flow, wrapped to its width.
  let width = flowWidth;
  let height = flowHeight;
  if (looseNodes.length > 0) {
    const wrapWidth = Math.max(flowWidth, ...looseNodes.map((node) => node.width));
    let x = 0;
    let y = flowNodes.length > 0 ? flowHeight + tailGap : 0;
    let rowHeight = 0;
    let shelf = 0;
    let slot = 0;
    let usedWidth = 0;
    for (const node of looseNodes) {
      if (x > 0 && x + node.width > wrapWidth) {
        x = 0;
        y += rowHeight + gapY;
        rowHeight = 0;
        shelf += 1;
        slot = 0;
      }
      placements.push({ id: node.id, x, y, column: slot, row: rankCount + shelf, inFlow: false });
      usedWidth = Math.max(usedWidth, x + node.width);
      rowHeight = Math.max(rowHeight, node.height);
      x += node.width + shelfGapX;
      slot += 1;
    }
    width = Math.max(width, usedWidth);
    height = y + rowHeight;
  }

  return { placements, width, height, ranks: rankCount, backEdges };
}
