import {
  placeEdgeLabels,
  type RoutedEdge,
  type RoutePoint,
  type RouteRect,
  routeOrthogonalEdges,
} from '@agor/core/layout/orthogonal-edge-routing';
import type { ZoneWorkflowTransition } from '@agor-live/client';

/**
 * On-screen sizes for workflow transition connectors. The canvas scales SVG
 * with zoom, so each size is divided by the zoom to stay constant on screen
 * (hairlines at 0.25 vanished; fat lines at 1.5 crowded the zones).
 */
export const WORKFLOW_EDGE_SCREEN = {
  stroke: 2,
  selectedStroke: 3,
  /** Background-coloured outline under each line so crossings read cleanly. */
  halo: 2,
  arrowLength: 10,
  arrowWidth: 8,
  dash: 6,
  gap: 5,
  cornerRadius: 10,
} as const;

/** Below this zoom labels are unreadable specks, so only the selected one stays. */
export const WORKFLOW_LABEL_MIN_ZOOM = 0.45;
/**
 * Labels grow in flow space as the canvas zooms out (so they stay readable)
 * up to this factor; past it they shrink on screen until they hide.
 */
export const WORKFLOW_LABEL_MAX_SCALE = 1.6;

/** Never let a screen-constant size exceed this many flow units (zoom 0.1 overview). */
const MAX_FLOW_SIZE = 48;

/** Flow-space size that renders as `px` screen pixels at `zoom`. */
export function screenConstant(px: number, zoom: number): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(px / safeZoom, Math.max(px, MAX_FLOW_SIZE));
}

/** SVG path through orthogonal points with each bend rounded off. */
export function roundedOrthogonalPath(points: readonly RoutePoint[], radius: number): string {
  if (points.length === 0) return '';
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLength = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0.01) {
      parts.push(`L ${corner.x} ${corner.y}`);
      continue;
    }
    const before = {
      x: corner.x - ((corner.x - prev.x) / inLength) * r,
      y: corner.y - ((corner.y - prev.y) / inLength) * r,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    parts.push(`L ${before.x} ${before.y}`, `Q ${corner.x} ${corner.y} ${after.x} ${after.y}`);
  }
  const last = points[points.length - 1];
  if (points.length > 1) parts.push(`L ${last.x} ${last.y}`);
  return parts.join(' ');
}

/**
 * Pull the final point back by `length` along the last segment so the stroke
 * ends under the arrowhead instead of poking through its tip.
 */
export function trimEnd(points: readonly RoutePoint[], length: number): RoutePoint[] {
  if (points.length < 2 || length <= 0) return [...points];
  const tip = points[points.length - 1];
  const prev = points[points.length - 2];
  const segment = Math.hypot(tip.x - prev.x, tip.y - prev.y);
  if (segment <= 0) return [...points];
  const cut = Math.min(length, segment * 0.9);
  return [
    ...points.slice(0, -1),
    {
      x: tip.x - ((tip.x - prev.x) / segment) * cut,
      y: tip.y - ((tip.y - prev.y) / segment) * cut,
    },
  ];
}

/** Closed triangle with its tip on the last point, pointing along the last segment. */
export function arrowHeadPath(
  points: readonly RoutePoint[],
  length: number,
  width: number
): string {
  if (points.length < 2) return '';
  const tip = points[points.length - 1];
  const prev = points[points.length - 2];
  const segment = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
  const ux = (tip.x - prev.x) / segment;
  const uy = (tip.y - prev.y) / segment;
  const baseX = tip.x - ux * length;
  const baseY = tip.y - uy * length;
  const half = width / 2;
  return [
    `M ${tip.x} ${tip.y}`,
    `L ${baseX - uy * half} ${baseY + ux * half}`,
    `L ${baseX + uy * half} ${baseY - ux * half}`,
    'Z',
  ].join(' ');
}

/** Zone rectangle → compact comparable key, used to spot routes made for an older layout. */
export function rectKey(rect: Pick<RouteRect, 'x' | 'y' | 'width' | 'height'>): string {
  return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

export interface WorkflowRoute {
  route: RoutedEdge;
  /** Source and target zone positions the route was computed for ("x,y|x,y"). */
  positions: string;
}

/** Rough rendered label box at zoom 1 (padding + border included). */
export function estimateLabelSize(label: string, fontSize: number) {
  return { width: label.length * fontSize * 0.62 + 16, height: fontSize * 1.4 + 6 };
}

/**
 * Orthogonal routes for every transition between known zones, with labels
 * spread so they sit clear of zones and of each other. Deterministic for a
 * given layout, so nothing about routes is persisted.
 */
export function routeWorkflowTransitions(
  rects: readonly RouteRect[],
  transitions: readonly ZoneWorkflowTransition[],
  labelFontSize: number
): Map<string, WorkflowRoute> {
  const result = new Map<string, WorkflowRoute>();
  if (rects.length === 0 || transitions.length === 0) return result;
  const rectById = new Map(rects.map((rect) => [rect.id, rect]));
  const transitionById = new Map(transitions.map((t) => [t.transition_id as string, t]));
  const routed = routeOrthogonalEdges(
    rects,
    transitions.map((transition) => ({
      id: transition.transition_id,
      source: transition.source_zone_id,
      target: transition.target_zone_id,
    }))
  );
  // Reserve room for the label at a middling zoom-out scale.
  const reserve = (WORKFLOW_LABEL_MAX_SCALE + 1) / 2;
  const sizes = new Map<string, { width: number; height: number }>();
  for (const route of routed) {
    const label = transitionById.get(route.id)?.label;
    if (!label) continue;
    const size = estimateLabelSize(label, labelFontSize);
    sizes.set(route.id, { width: size.width * reserve, height: size.height * reserve });
  }
  const labels = placeEdgeLabels(routed, rects, sizes);
  for (const route of routed) {
    const transition = transitionById.get(route.id);
    const a = transition && rectById.get(transition.source_zone_id);
    const b = transition && rectById.get(transition.target_zone_id);
    if (!a || !b) continue;
    result.set(route.id, {
      route: { ...route, labelPoint: labels.get(route.id) ?? route.labelPoint },
      positions: positionsKey(a, b),
    });
  }
  return result;
}

/** Comparable key for a source/target zone position pair. */
export function positionsKey(a: { x: number; y: number }, b: { x: number; y: number }): string {
  return `${Math.round(a.x)},${Math.round(a.y)}|${Math.round(b.x)},${Math.round(b.y)}`;
}
