import { BOARD_GRID_SIZE, ceilBoardGridValue } from './rectangle-packing';

export interface ZoneGrowthRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fixed obstacle which participates in collisions but is never displaced. */
  locked?: boolean;
}

export interface ZoneGrowthReflowPlan {
  placements: ZoneGrowthRect[];
  movedZoneIds: string[];
}

interface Movement {
  id: string;
  before: ZoneGrowthRect;
  after: ZoneGrowthRect;
}

function overlaps(left: ZoneGrowthRect, right: ZoneGrowthRect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function spatialOrder(left: ZoneGrowthRect, right: ZoneGrowthRect): number {
  return left.y - right.y || left.x - right.x || left.id.localeCompare(right.id);
}

/**
 * Move only the zones newly obstructed by a grow, cascading the smallest
 * positive-axis shift through their neighbours. Existing overlaps are left
 * untouched, spatial order stays stable, and a repeated plan after the grown
 * rectangle is persisted is a no-op.
 */
export function planZoneGrowthReflow(
  sourceZones: readonly ZoneGrowthRect[],
  growingZoneId: string,
  nextGrowingRect: ZoneGrowthRect,
  options: { gap?: number } = {}
): ZoneGrowthReflowPlan {
  const sourceGrowing = sourceZones.find((zone) => zone.id === growingZoneId);
  if (!sourceGrowing) {
    return { placements: sourceZones.map((zone) => ({ ...zone })), movedZoneIds: [] };
  }

  const growsRight =
    nextGrowingRect.x + nextGrowingRect.width > sourceGrowing.x + sourceGrowing.width;
  const growsDown =
    nextGrowingRect.y + nextGrowingRect.height > sourceGrowing.y + sourceGrowing.height;
  if (!growsRight && !growsDown) {
    return { placements: sourceZones.map((zone) => ({ ...zone })), movedZoneIds: [] };
  }

  const gap = Math.max(0, ceilBoardGridValue(options.gap ?? BOARD_GRID_SIZE));
  const placements = new Map(
    sourceZones.map((zone) => [
      zone.id,
      zone.id === growingZoneId ? { ...nextGrowingRect, id: growingZoneId } : { ...zone },
    ])
  );
  const orderedIds = [...sourceZones].sort(spatialOrder).map((zone) => zone.id);
  const queue: Movement[] = [
    { id: growingZoneId, before: { ...sourceGrowing }, after: { ...nextGrowingRect } },
  ];
  const moved = new Set<string>();
  const maxPasses = Math.max(1, sourceZones.length * sourceZones.length * 4);

  for (let pass = 0; queue.length > 0 && pass < maxPasses; pass += 1) {
    const movement = queue.shift();
    if (!movement) break;
    for (const candidateId of orderedIds) {
      if (candidateId === growingZoneId || candidateId === movement.id) continue;
      const candidate = placements.get(candidateId);
      if (!candidate || !overlaps(movement.after, candidate)) continue;
      // This collision already existed before the edge moved, so the grow did
      // not cause it and must not turn into unsolicited cleanup.
      if (overlaps(movement.before, candidate)) continue;
      if (candidate.locked) continue;

      const shiftRight = growsRight
        ? ceilBoardGridValue(movement.after.x + movement.after.width + gap - candidate.x)
        : Number.POSITIVE_INFINITY;
      const shiftDown = growsDown
        ? ceilBoardGridValue(movement.after.y + movement.after.height + gap - candidate.y)
        : Number.POSITIVE_INFINITY;
      const before = { ...candidate };
      const after =
        shiftDown <= shiftRight
          ? { ...candidate, y: candidate.y + shiftDown }
          : { ...candidate, x: candidate.x + shiftRight };
      placements.set(candidateId, after);
      moved.add(candidateId);
      queue.push({ id: candidateId, before, after });
    }
  }

  return {
    placements: sourceZones.map((zone) => placements.get(zone.id) ?? { ...zone }),
    movedZoneIds: sourceZones
      .filter((zone) => moved.has(zone.id))
      .sort(spatialOrder)
      .map((zone) => zone.id),
  };
}
