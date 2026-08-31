import type { Node } from 'reactflow';

export type PostLayoutViewportSource = 'user' | 'auto' | 'realtime';
export type PostLayoutViewportScope = 'board' | 'selection' | 'zone';

export interface LayoutNodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PostLayoutViewportIntent {
  source: PostLayoutViewportSource;
  boardId: string;
  scope: PostLayoutViewportScope;
  before: readonly LayoutNodeRect[];
  after: readonly LayoutNodeRect[];
}

export interface LayoutViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PostLayoutViewportDecisionInput {
  intent: PostLayoutViewportIntent;
  viewport: LayoutViewportBounds;
  viewportPixels: { width: number; height: number };
  zoom: number;
}

export interface PostLayoutViewportDecision {
  fit: boolean;
  reason: 'not-user' | 'no-material-change' | 'comfortable' | 'clipped' | 'scale';
  padding: number;
}

const MATERIAL_GEOMETRY_DELTA = 8;
const COMFORT_MARGIN_PX = 48;
const MIN_COMFORTABLE_OCCUPANCY = 0.18;
const MAX_COMFORTABLE_OCCUPANCY = 0.9;
const SNAPSHOT_TOLERANCE = 1;

function nodeDimension(node: Node, key: 'width' | 'height'): number {
  const measured = (node as Node & { measured?: { width?: number; height?: number } }).measured;
  // Explicit planner output wins while React Flow's measured cache catches up.
  const value = Number(node[key] ?? node.style?.[key] ?? measured?.[key] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function absolutePosition(
  node: Node,
  byId: ReadonlyMap<string, Node>,
  seen: ReadonlySet<string> = new Set()
): { x: number; y: number } {
  if (!node.parentId || seen.has(node.id)) return node.position;
  const parent = byId.get(node.parentId);
  if (!parent) return node.position;
  const nextSeen = new Set(seen);
  nextSeen.add(node.id);
  const parentPosition = absolutePosition(parent, byId, nextSeen);
  return {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y,
  };
}

/** Capture stable absolute geometry without trusting a pre-render positionAbsolute. */
export function snapshotLayoutNodes(
  nodes: readonly Node[],
  affectedNodeIds: readonly string[]
): LayoutNodeRect[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return [...new Set(affectedNodeIds)].flatMap((id) => {
    const node = byId.get(id);
    if (!node || node.hidden) return [];
    const position = absolutePosition(node, byId);
    return [
      {
        id,
        ...position,
        width: nodeDimension(node, 'width'),
        height: nodeDimension(node, 'height'),
      },
    ];
  });
}

export function layoutSnapshotsMatch(
  expected: readonly LayoutNodeRect[],
  actual: readonly LayoutNodeRect[],
  tolerance = SNAPSHOT_TOLERANCE
): boolean {
  if (expected.length !== actual.length) return false;
  const actualById = new Map(actual.map((rect) => [rect.id, rect]));
  return expected.every((rect) => {
    const candidate = actualById.get(rect.id);
    return (
      candidate !== undefined &&
      Math.abs(rect.x - candidate.x) <= tolerance &&
      Math.abs(rect.y - candidate.y) <= tolerance &&
      Math.abs(rect.width - candidate.width) <= tolerance &&
      Math.abs(rect.height - candidate.height) <= tolerance
    );
  });
}

/**
 * Confirm that the persisted layout has settled at the requested positions.
 * Rendered card heights can legitimately converge after persistence (for
 * example when compact content paints), so callers that will consume the
 * fresh settled rectangles should not reject that newer size information.
 */
export function layoutPositionsMatch(
  expected: readonly LayoutNodeRect[],
  actual: readonly LayoutNodeRect[],
  tolerance = SNAPSHOT_TOLERANCE
): boolean {
  if (expected.length !== actual.length) return false;
  const actualById = new Map(actual.map((rect) => [rect.id, rect]));
  return expected.every((rect) => {
    const candidate = actualById.get(rect.id);
    return (
      candidate !== undefined &&
      Math.abs(rect.x - candidate.x) <= tolerance &&
      Math.abs(rect.y - candidate.y) <= tolerance
    );
  });
}

export function layoutGeometryChanged(
  before: readonly LayoutNodeRect[],
  after: readonly LayoutNodeRect[],
  threshold = 0.5
): boolean {
  if (before.length !== after.length) return true;
  const beforeById = new Map(before.map((rect) => [rect.id, rect]));
  return after.some((rect) => {
    const previous = beforeById.get(rect.id);
    return (
      previous === undefined ||
      Math.abs(previous.x - rect.x) >= threshold ||
      Math.abs(previous.y - rect.y) >= threshold ||
      Math.abs(previous.width - rect.width) >= threshold ||
      Math.abs(previous.height - rect.height) >= threshold
    );
  });
}

function boundsFor(rects: readonly LayoutNodeRect[]): LayoutViewportBounds | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.x)),
    top: Math.min(...rects.map((rect) => rect.y)),
    right: Math.max(...rects.map((rect) => rect.x + rect.width)),
    bottom: Math.max(...rects.map((rect) => rect.y + rect.height)),
  };
}

/** Pure policy shared by every explicit layout surface. */
export function decidePostLayoutViewport(
  input: PostLayoutViewportDecisionInput
): PostLayoutViewportDecision {
  const padding = input.intent.scope === 'board' ? 0.12 : 0.16;
  if (input.intent.source !== 'user') return { fit: false, reason: 'not-user', padding };
  if (!layoutGeometryChanged(input.intent.before, input.intent.after, MATERIAL_GEOMETRY_DELTA)) {
    return { fit: false, reason: 'no-material-change', padding };
  }

  const bounds = boundsFor(input.intent.after);
  if (
    !bounds ||
    input.zoom <= 0 ||
    input.viewportPixels.width <= 0 ||
    input.viewportPixels.height <= 0
  ) {
    return { fit: false, reason: 'comfortable', padding };
  }
  const margin = COMFORT_MARGIN_PX / input.zoom;
  const comfortablyVisible =
    bounds.left >= input.viewport.left + margin &&
    bounds.top >= input.viewport.top + margin &&
    bounds.right <= input.viewport.right - margin &&
    bounds.bottom <= input.viewport.bottom - margin;
  const occupiedWidth = ((bounds.right - bounds.left) * input.zoom) / input.viewportPixels.width;
  const occupiedHeight = ((bounds.bottom - bounds.top) * input.zoom) / input.viewportPixels.height;
  const occupancy = Math.max(occupiedWidth, occupiedHeight);
  const impracticalScale =
    occupancy < MIN_COMFORTABLE_OCCUPANCY || occupancy > MAX_COMFORTABLE_OCCUPANCY;

  if (!comfortablyVisible) return { fit: true, reason: 'clipped', padding };
  if (impracticalScale) return { fit: true, reason: 'scale', padding };
  return { fit: false, reason: 'comfortable', padding };
}

export function createPostLayoutViewportIntent(input: {
  source: PostLayoutViewportSource;
  boardId: string;
  scope: PostLayoutViewportScope;
  beforeNodes: readonly Node[];
  afterNodes: readonly Node[];
  affectedNodeIds: readonly string[];
}): PostLayoutViewportIntent {
  return {
    source: input.source,
    boardId: input.boardId,
    scope: input.scope,
    before: snapshotLayoutNodes(input.beforeNodes, input.affectedNodeIds),
    after: snapshotLayoutNodes(input.afterNodes, input.affectedNodeIds),
  };
}
