export interface LayoutRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutGuide {
  orientation: 'vertical' | 'horizontal';
  offset: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: LayoutGuide[];
}

const DEFAULT_SNAP_DISTANCE = 8;

/** Snap a moving rectangle to nearby edges and centers of its peers. */
export function snapRectToPeers(
  moving: LayoutRect,
  peers: LayoutRect[],
  threshold = DEFAULT_SNAP_DISTANCE
): SnapResult {
  const xCandidates: Array<{ delta: number; guide: number }> = [];
  const yCandidates: Array<{ delta: number; guide: number }> = [];
  const movingX = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const movingY = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  for (const peer of peers) {
    const peerX = [peer.x, peer.x + peer.width / 2, peer.x + peer.width];
    const peerY = [peer.y, peer.y + peer.height / 2, peer.y + peer.height];
    for (const source of movingX) {
      for (const target of peerX) {
        const delta = target - source;
        if (Math.abs(delta) <= threshold) xCandidates.push({ delta, guide: target });
      }
    }
    for (const source of movingY) {
      for (const target of peerY) {
        const delta = target - source;
        if (Math.abs(delta) <= threshold) yCandidates.push({ delta, guide: target });
      }
    }
  }

  const bestX = xCandidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  const bestY = yCandidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  return {
    x: moving.x + (bestX?.delta ?? 0),
    y: moving.y + (bestY?.delta ?? 0),
    guides: [
      ...(bestX ? [{ orientation: 'vertical' as const, offset: bestX.guide }] : []),
      ...(bestY ? [{ orientation: 'horizontal' as const, offset: bestY.guide }] : []),
    ],
  };
}
