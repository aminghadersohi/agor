import type { CSSProperties } from 'react';
import type { Node, Viewport } from 'reactflow';
import {
  getVisibleSelectableNodeRect,
  isVisibleSelectableBoardNode,
  type NodeRect,
} from './boardNodeGeometry';

export interface LayoutRect extends NodeRect {
  id: string;
}

export interface LayoutGuide {
  id: string;
  orientation: 'vertical' | 'horizontal';
  /** Constant coordinate, in flow space. */
  offset: number;
  /** Local span along the guide's variable axis, in flow space. */
  start: number;
  end: number;
  kind: 'alignment' | 'size' | 'gap';
  label?: string;
  comparisonId?: string;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: LayoutGuide[];
}

interface AlignmentCandidate {
  delta: number;
  guide: number;
  peer: LayoutRect;
  sourceIndex: number;
  targetIndex: number;
}

interface GapNeighbor {
  peer: LayoutRect;
  gap: number;
}

export const GUIDE_SNAP_DISTANCE_PX = 8;
const GUIDE_DEDUPE_TOLERANCE = 0.5;

export function flowSnapDistanceForZoom(zoom: number): number {
  return GUIDE_SNAP_DISTANCE_PX / Math.max(zoom, 0.01);
}

function compareCandidates(a: AlignmentCandidate, b: AlignmentCandidate): number {
  return (
    Math.abs(a.delta) - Math.abs(b.delta) ||
    a.guide - b.guide ||
    a.peer.id.localeCompare(b.peer.id) ||
    a.sourceIndex - b.sourceIndex ||
    a.targetIndex - b.targetIndex
  );
}

function nearestGap(candidates: GapNeighbor[]): GapNeighbor | undefined {
  return candidates.sort((a, b) => a.gap - b.gap || a.peer.id.localeCompare(b.peer.id))[0];
}

function guideSort(a: LayoutGuide, b: LayoutGuide): number {
  return (
    a.orientation.localeCompare(b.orientation) ||
    a.offset - b.offset ||
    a.kind.localeCompare(b.kind) ||
    a.start - b.start ||
    a.end - b.end ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Collapse guides that describe the same logical line/measurement. Alignment
 * guides dedupe by axis + coordinate (within half a flow pixel) and merge their
 * local extents. Measurement segments additionally include their span, so the
 * two intentionally separate halves of an equal-gap comparison survive.
 */
export function dedupeLayoutGuides(
  guides: LayoutGuide[],
  tolerance = GUIDE_DEDUPE_TOLERANCE
): LayoutGuide[] {
  const result: LayoutGuide[] = [];
  for (const guide of [...guides].sort(guideSort)) {
    const start = Math.min(guide.start, guide.end);
    const end = Math.max(guide.start, guide.end);
    if (![guide.offset, start, end].every(Number.isFinite) || end <= start) continue;

    const duplicate = result.find(
      (existing) =>
        existing.orientation === guide.orientation &&
        existing.kind === guide.kind &&
        Math.abs(existing.offset - guide.offset) <= tolerance &&
        (guide.kind === 'alignment' ||
          (Math.abs(existing.start - start) <= tolerance &&
            Math.abs(existing.end - end) <= tolerance &&
            existing.comparisonId === guide.comparisonId))
    );
    if (!duplicate) {
      result.push({ ...guide, start, end });
      continue;
    }
    if (guide.kind === 'alignment') {
      duplicate.start = Math.min(duplicate.start, start);
      duplicate.end = Math.max(duplicate.end, end);
    }
    if (!duplicate.label && guide.label) duplicate.label = guide.label;
  }
  return result;
}

/** Convert a flow-space guide segment into a screen-space, fixed-weight line. */
export function layoutGuideScreenStyle(guide: LayoutGuide, viewport: Viewport): CSSProperties {
  const start = Math.min(guide.start, guide.end);
  const length = Math.abs(guide.end - guide.start) * viewport.zoom;
  if (guide.orientation === 'vertical') {
    return {
      left: guide.offset * viewport.zoom + viewport.x,
      top: start * viewport.zoom + viewport.y,
      height: length,
    };
  }
  return {
    left: start * viewport.zoom + viewport.x,
    top: guide.offset * viewport.zoom + viewport.y,
    width: length,
  };
}

function isDescendantOf(node: Node, ancestorId: string, nodesById: Map<string, Node>): boolean {
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = nodesById.get(parentId)?.parentId;
  }
  return false;
}

/** Build absolute flow-space rectangles for the real node-drag production path. */
export function getGuideLayoutRects(
  movingNode: Node,
  nodes: Node[]
): { moving: LayoutRect; peers: LayoutRect[] } | null {
  if (!isVisibleSelectableBoardNode(movingNode)) return null;
  const movingRect = getVisibleSelectableNodeRect(movingNode, nodes);
  if (!movingRect) return null;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const peers = nodes
    .filter(
      (peer) =>
        peer.id !== movingNode.id &&
        !peer.selected &&
        !isDescendantOf(peer, movingNode.id, nodesById)
    )
    .map((peer): LayoutRect | null => {
      const rect = getVisibleSelectableNodeRect(peer, nodes);
      return rect ? { id: peer.id, ...rect } : null;
    })
    .filter((peer): peer is LayoutRect => peer !== null);
  return { moving: { id: movingNode.id, ...movingRect }, peers };
}

/** Snap a moving rectangle to nearby peer edges/centers and return local tool guides. */
export function snapRectToPeers(
  moving: LayoutRect,
  peers: LayoutRect[],
  threshold = GUIDE_SNAP_DISTANCE_PX
): SnapResult {
  const xCandidates: AlignmentCandidate[] = [];
  const yCandidates: AlignmentCandidate[] = [];
  const movingX = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const movingY = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  for (const peer of [...peers].sort((a, b) => a.id.localeCompare(b.id))) {
    const peerX = [peer.x, peer.x + peer.width / 2, peer.x + peer.width];
    const peerY = [peer.y, peer.y + peer.height / 2, peer.y + peer.height];
    movingX.forEach((source, sourceIndex) => {
      peerX.forEach((target, targetIndex) => {
        const delta = target - source;
        if (Math.abs(delta) <= threshold) {
          xCandidates.push({ delta, guide: target, peer, sourceIndex, targetIndex });
        }
      });
    });
    movingY.forEach((source, sourceIndex) => {
      peerY.forEach((target, targetIndex) => {
        const delta = target - source;
        if (Math.abs(delta) <= threshold) {
          yCandidates.push({ delta, guide: target, peer, sourceIndex, targetIndex });
        }
      });
    });
  }

  const bestX = xCandidates.sort(compareCandidates)[0];
  const bestY = yCandidates.sort(compareCandidates)[0];
  const snapped: LayoutRect = {
    ...moving,
    x: moving.x + (bestX?.delta ?? 0),
    y: moving.y + (bestY?.delta ?? 0),
  };
  const guides: LayoutGuide[] = [];

  if (bestX) {
    guides.push({
      id: `align-x-${bestX.guide}-${bestX.peer.id}`,
      orientation: 'vertical',
      offset: bestX.guide,
      start: Math.min(snapped.y, bestX.peer.y),
      end: Math.max(snapped.y + snapped.height, bestX.peer.y + bestX.peer.height),
      kind: 'alignment',
    });
  }
  if (bestY) {
    guides.push({
      id: `align-y-${bestY.guide}-${bestY.peer.id}`,
      orientation: 'horizontal',
      offset: bestY.guide,
      start: Math.min(snapped.x, bestY.peer.x),
      end: Math.max(snapped.x + snapped.width, bestY.peer.x + bestY.peer.width),
      kind: 'alignment',
    });
  }

  const byWidth = [...peers].sort(
    (a, b) =>
      Math.abs(a.width - snapped.width) - Math.abs(b.width - snapped.width) ||
      a.id.localeCompare(b.id)
  );
  const byHeight = [...peers].sort(
    (a, b) =>
      Math.abs(a.height - snapped.height) - Math.abs(b.height - snapped.height) ||
      a.id.localeCompare(b.id)
  );
  if (byWidth[0] && Math.abs(byWidth[0].width - snapped.width) <= threshold) {
    guides.push({
      id: `size-width-${snapped.id}`,
      orientation: 'horizontal',
      offset: snapped.y + snapped.height / 2,
      start: snapped.x,
      end: snapped.x + snapped.width,
      kind: 'size',
      label: `${Math.round(snapped.width)}px wide`,
    });
  }
  if (byHeight[0] && Math.abs(byHeight[0].height - snapped.height) <= threshold) {
    guides.push({
      id: `size-height-${snapped.id}`,
      orientation: 'vertical',
      offset: snapped.x + snapped.width / 2,
      start: snapped.y,
      end: snapped.y + snapped.height,
      kind: 'size',
      label: `${Math.round(snapped.height)}px high`,
    });
  }

  const overlapsY = (peer: LayoutRect) =>
    peer.y < snapped.y + snapped.height && peer.y + peer.height > snapped.y;
  const overlapsX = (peer: LayoutRect) =>
    peer.x < snapped.x + snapped.width && peer.x + peer.width > snapped.x;
  const left = nearestGap(
    peers
      .filter((peer) => peer.x + peer.width <= snapped.x && overlapsY(peer))
      .map((peer) => ({ peer, gap: snapped.x - (peer.x + peer.width) }))
  );
  const right = nearestGap(
    peers
      .filter((peer) => peer.x >= snapped.x + snapped.width && overlapsY(peer))
      .map((peer) => ({ peer, gap: peer.x - (snapped.x + snapped.width) }))
  );
  const above = nearestGap(
    peers
      .filter((peer) => peer.y + peer.height <= snapped.y && overlapsX(peer))
      .map((peer) => ({ peer, gap: snapped.y - (peer.y + peer.height) }))
  );
  const below = nearestGap(
    peers
      .filter((peer) => peer.y >= snapped.y + snapped.height && overlapsX(peer))
      .map((peer) => ({ peer, gap: peer.y - (snapped.y + snapped.height) }))
  );

  if (left && right && left.gap > 0 && Math.abs(left.gap - right.gap) <= threshold) {
    const comparisonId = `gap-x-${left.peer.id}-${snapped.id}-${right.peer.id}`;
    const label = `${Math.round((left.gap + right.gap) / 2)}px`;
    const offset = snapped.y + snapped.height / 2;
    guides.push(
      {
        id: `${comparisonId}-left`,
        orientation: 'horizontal',
        offset,
        start: left.peer.x + left.peer.width,
        end: snapped.x,
        kind: 'gap',
        label,
        comparisonId,
      },
      {
        id: `${comparisonId}-right`,
        orientation: 'horizontal',
        offset,
        start: snapped.x + snapped.width,
        end: right.peer.x,
        kind: 'gap',
        label,
        comparisonId,
      }
    );
  }
  if (above && below && above.gap > 0 && Math.abs(above.gap - below.gap) <= threshold) {
    const comparisonId = `gap-y-${above.peer.id}-${snapped.id}-${below.peer.id}`;
    const label = `${Math.round((above.gap + below.gap) / 2)}px`;
    const offset = snapped.x + snapped.width / 2;
    guides.push(
      {
        id: `${comparisonId}-above`,
        orientation: 'vertical',
        offset,
        start: above.peer.y + above.peer.height,
        end: snapped.y,
        kind: 'gap',
        label,
        comparisonId,
      },
      {
        id: `${comparisonId}-below`,
        orientation: 'vertical',
        offset,
        start: snapped.y + snapped.height,
        end: below.peer.y,
        kind: 'gap',
        label,
        comparisonId,
      }
    );
  }

  return { x: snapped.x, y: snapped.y, guides: dedupeLayoutGuides(guides) };
}
