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
  kind?: 'alignment' | 'size' | 'gap';
  label?: string;
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
  const guides: LayoutGuide[] = [
    ...(bestX ? [{ orientation: 'vertical' as const, offset: bestX.guide }] : []),
    ...(bestY ? [{ orientation: 'horizontal' as const, offset: bestY.guide }] : []),
  ];

  // Show size-match indicators without changing the rectangle's dimensions.
  // These are intentionally tolerant because React Flow reports fractional
  // measured sizes while a node is settling after a render.
  const sameWidth = peers.find((peer) => Math.abs(peer.width - moving.width) <= threshold);
  const sameHeight = peers.find((peer) => Math.abs(peer.height - moving.height) <= threshold);
  if (sameWidth) {
    guides.push({
      orientation: 'horizontal',
      offset: moving.y + moving.height / 2,
      kind: 'size',
      label: `${Math.round(moving.width)}px wide`,
    });
  }
  if (sameHeight) {
    guides.push({
      orientation: 'vertical',
      offset: moving.x + moving.width / 2,
      kind: 'size',
      label: `${Math.round(moving.height)}px high`,
    });
  }

  // When the moving item has peers on both sides (or above and below), show
  // an equal-spacing indicator when those two gaps match. This mirrors the
  // spacing hints in common design tools while leaving the user in control of
  // whether to snap the final position.
  const overlapsY = (peer: LayoutRect) =>
    peer.y < moving.y + moving.height && peer.y + peer.height > moving.y;
  const overlapsX = (peer: LayoutRect) =>
    peer.x < moving.x + moving.width && peer.x + peer.width > moving.x;
  const left = peers.filter((peer) => peer.x + peer.width <= moving.x && overlapsY(peer));
  const right = peers.filter((peer) => peer.x >= moving.x + moving.width && overlapsY(peer));
  const above = peers.filter((peer) => peer.y + peer.height <= moving.y && overlapsX(peer));
  const below = peers.filter((peer) => peer.y >= moving.y + moving.height && overlapsX(peer));
  const leftGap = left.length
    ? moving.x - Math.max(...left.map((peer) => peer.x + peer.width))
    : undefined;
  const rightGap = right.length
    ? Math.min(...right.map((peer) => peer.x)) - (moving.x + moving.width)
    : undefined;
  const aboveGap = above.length
    ? moving.y - Math.max(...above.map((peer) => peer.y + peer.height))
    : undefined;
  const belowGap = below.length
    ? Math.min(...below.map((peer) => peer.y)) - (moving.y + moving.height)
    : undefined;
  if (
    leftGap !== undefined &&
    rightGap !== undefined &&
    Math.abs(leftGap - rightGap) <= threshold
  ) {
    guides.push({
      orientation: 'horizontal',
      offset: moving.y + moving.height / 2,
      kind: 'gap',
      label: `${Math.round(leftGap)}px gap`,
    });
  }
  if (
    aboveGap !== undefined &&
    belowGap !== undefined &&
    Math.abs(aboveGap - belowGap) <= threshold
  ) {
    guides.push({
      orientation: 'vertical',
      offset: moving.x + moving.width / 2,
      kind: 'gap',
      label: `${Math.round(aboveGap)}px gap`,
    });
  }
  return {
    x: moving.x + (bestX?.delta ?? 0),
    y: moving.y + (bestY?.delta ?? 0),
    guides,
  };
}
