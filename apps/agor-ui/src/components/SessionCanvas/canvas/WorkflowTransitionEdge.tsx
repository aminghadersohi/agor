import type { RoutedEdge, RoutePoint } from '@agor/core/layout/orthogonal-edge-routing';
import type { ZoneWorkflowTransition } from '@agor-live/client';
import { memo, useCallback } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  type ReactFlowState,
  useStore,
} from 'reactflow';
import {
  arrowHeadPath,
  positionsKey,
  roundedOrthogonalPath,
  screenConstant,
  trimEnd,
  WORKFLOW_EDGE_SCREEN,
  WORKFLOW_LABEL_MAX_SCALE,
  WORKFLOW_LABEL_MIN_ZOOM,
} from './workflowEdgeGeometry';

export const WORKFLOW_TRANSITION_EDGE_TYPE = 'workflowTransition';

export interface WorkflowTransitionEdgeData {
  transition: ZoneWorkflowTransition;
  /** Orthogonal route computed for the zone layout in `routedPositions`. */
  route?: RoutedEdge;
  /** Source and target zone positions the route was computed for ("x,y|x,y"). */
  routedPositions?: string;
  color: string;
  haloColor: string;
  labelColor: string;
  labelBackground: string;
  labelFontSize: number;
  labelRadius: number;
  /** Workflow tool active: the edge and its label take clicks. */
  interactive: boolean;
  /** Line opacity; disabled transitions recede (and draw dashed). */
  opacity: number;
  onSelect?: (transitionId: string) => void;
}

const selectZoom = (state: ReactFlowState) => state.transform[2];

/**
 * Labels on short hops overhang the zones they join; lift them above zones
 * (and other board objects) but keep them under the branch/card layer (500).
 */
const LABEL_Z_INDEX = 499;

/** Plain right→left elbow through the live handles, used while a route is stale. */
function elbow(sourceX: number, sourceY: number, targetX: number, targetY: number): RoutePoint[] {
  const midX = (sourceX + targetX) / 2;
  return [
    { x: sourceX, y: sourceY },
    { x: midX, y: sourceY },
    { x: midX, y: targetY },
    { x: targetX, y: targetY },
  ];
}

function WorkflowTransitionEdgeImpl({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  data,
  interactionWidth,
}: EdgeProps<WorkflowTransitionEdgeData>) {
  const zoom = useStore(selectZoom);
  // Live zone positions; a drag moves these every frame while the route is
  // only recomputed once the layout settles.
  const livePositions = useStore(
    useCallback(
      (state: ReactFlowState) => {
        const a = state.nodeInternals.get(source)?.positionAbsolute;
        const b = state.nodeInternals.get(target)?.positionAbsolute;
        if (!a || !b) return '';
        return positionsKey(a, b);
      },
      [source, target]
    )
  );
  if (!data) return null;
  const { transition } = data;
  const fresh = data.route && data.routedPositions === livePositions;
  const points =
    fresh && data.route ? data.route.points : elbow(sourceX, sourceY, targetX, targetY);
  const labelPoint =
    fresh && data.route
      ? data.route.labelPoint
      : { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };

  const stroke = screenConstant(
    selected ? WORKFLOW_EDGE_SCREEN.selectedStroke : WORKFLOW_EDGE_SCREEN.stroke,
    zoom
  );
  const halo = stroke + screenConstant(WORKFLOW_EDGE_SCREEN.halo * 2, zoom);
  const arrowLength = screenConstant(WORKFLOW_EDGE_SCREEN.arrowLength, zoom);
  const arrowWidth = screenConstant(WORKFLOW_EDGE_SCREEN.arrowWidth, zoom);
  const radius = screenConstant(WORKFLOW_EDGE_SCREEN.cornerRadius, zoom);
  const linePath = roundedOrthogonalPath(trimEnd(points, arrowLength * 0.8), radius);
  const dash = transition.enabled
    ? undefined
    : `${screenConstant(WORKFLOW_EDGE_SCREEN.dash, zoom)} ${screenConstant(WORKFLOW_EDGE_SCREEN.gap, zoom)}`;
  const showLabel = Boolean(transition.label) && (zoom >= WORKFLOW_LABEL_MIN_ZOOM || selected);
  const labelScale = Math.min(1 / Math.max(zoom, 0.1), WORKFLOW_LABEL_MAX_SCALE);

  return (
    <>
      <path
        d={linePath}
        fill="none"
        stroke={data.haloColor}
        strokeWidth={halo}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={Math.min(1, data.opacity + 0.1)}
        pointerEvents="none"
        data-testid={`workflow-edge-halo-${id}`}
      />
      <BaseEdge
        id={id}
        path={linePath}
        interactionWidth={interactionWidth}
        style={{
          stroke: data.color,
          strokeWidth: stroke,
          strokeDasharray: dash,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: data.opacity,
        }}
      />
      <path
        d={arrowHeadPath(points, arrowLength, arrowWidth)}
        fill={data.color}
        stroke={data.color}
        strokeWidth={stroke * 0.5}
        strokeLinejoin="round"
        opacity={data.opacity}
        pointerEvents="none"
        data-testid={`workflow-edge-arrow-${id}`}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan workflow-edge-label"
            data-testid={`workflow-edge-label-${id}`}
            role={data.interactive ? 'button' : undefined}
            tabIndex={data.interactive ? 0 : undefined}
            onClick={data.interactive ? () => data.onSelect?.(id) : undefined}
            onKeyDown={
              data.interactive
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') data.onSelect?.(id);
                  }
                : undefined
            }
            style={{
              position: 'absolute',
              zIndex: LABEL_Z_INDEX,
              transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px) scale(${labelScale})`,
              pointerEvents: data.interactive ? 'all' : 'none',
              cursor: data.interactive ? 'pointer' : undefined,
              padding: '1px 6px',
              borderRadius: data.labelRadius,
              border: `1px solid ${data.color}`,
              background: data.labelBackground,
              color: data.labelColor,
              fontSize: data.labelFontSize,
              fontWeight: selected ? 600 : 500,
              lineHeight: 1.4,
              whiteSpace: 'nowrap',
              opacity: Math.min(1, data.opacity + 0.15),
            }}
          >
            {transition.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const WorkflowTransitionEdge = memo(WorkflowTransitionEdgeImpl);
