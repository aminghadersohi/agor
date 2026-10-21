import type { ZoneWorkflowTransition } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  arrowHeadPath,
  geometryMatches,
  rectKey,
  roundedOrthogonalPath,
  routeWorkflowTransitions,
  screenConstant,
  trimEnd,
  WORKFLOW_EDGE_SCREEN,
} from './workflowEdgeGeometry';

describe('screenConstant', () => {
  it('keeps the on-screen size fixed across zoom levels', () => {
    for (const zoom of [0.25, 0.5, 1, 1.5]) {
      expect(screenConstant(WORKFLOW_EDGE_SCREEN.stroke, zoom) * zoom).toBeCloseTo(
        WORKFLOW_EDGE_SCREEN.stroke
      );
    }
  });

  it('caps flow-space size in the far-out overview and tolerates bad zoom', () => {
    expect(screenConstant(10, 0.01)).toBe(48);
    expect(screenConstant(2, 0)).toBe(2);
    expect(screenConstant(2, Number.NaN)).toBe(2);
  });
});

describe('roundedOrthogonalPath', () => {
  it('rounds each bend with a quadratic corner', () => {
    const path = roundedOrthogonalPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      10
    );
    expect(path).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 100');
  });

  it('shrinks the radius on short segments', () => {
    const path = roundedOrthogonalPath(
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 100 },
      ],
      10
    );
    expect(path).toBe('M 0 0 L 4 0 Q 8 0 8 4 L 8 100');
  });
});

describe('arrowheads', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];

  it('stops the line under the arrowhead', () => {
    expect(trimEnd(points, 8)).toEqual([
      { x: 0, y: 0 },
      { x: 92, y: 0 },
    ]);
  });

  it('points the arrowhead along the last segment with its tip on the port', () => {
    expect(arrowHeadPath(points, 10, 8)).toBe('M 100 0 L 90 4 L 90 -4 Z');
  });
});

describe('rectKey', () => {
  it('ignores sub-pixel jitter', () => {
    expect(rectKey({ x: 10.2, y: 19.8, width: 300, height: 200.4 })).toBe('10,20,300,200');
  });
});

describe('routeWorkflowTransitions', () => {
  const transition = (id: string, source: string, target: string, label: string) =>
    ({
      transition_id: id,
      board_id: 'board',
      source_zone_id: source,
      target_zone_id: target,
      label,
      enabled: true,
      behavior: 'manual',
      created_by: 'user',
      created_at: '',
      updated_at: '',
    }) as unknown as ZoneWorkflowTransition;
  const rects = [
    { id: 'a', x: 0, y: 0, width: 300, height: 140 },
    { id: 'b', x: 500, y: 0, width: 300, height: 140 },
  ];

  it('routes known zones and keys each route to the layout it was made for', () => {
    const routes = routeWorkflowTransitions(
      rects,
      [transition('t1', 'a', 'b', 'Ship'), transition('t2', 'a', 'missing', 'Lost')],
      12
    );
    expect([...routes.keys()]).toEqual(['t1']);
    const t1 = routes.get('t1');
    expect(t1?.source).toEqual(rects[0]);
    expect(t1?.target).toEqual(rects[1]);
    expect(t1?.route.points[0]).toEqual({ x: 300, y: 70 });
    expect(t1?.route.points.at(-1)).toEqual({ x: 500, y: 70 });
  });

  it('is empty without zones or transitions', () => {
    expect(routeWorkflowTransitions([], [transition('t1', 'a', 'b', 'x')], 12).size).toBe(0);
    expect(routeWorkflowTransitions(rects, [], 12).size).toBe(0);
  });
});

describe('geometryMatches', () => {
  const routed = { id: 'z', x: 100, y: 200, width: 300, height: 140 };

  it('accepts sub-pixel noise and unmeasured nodes', () => {
    expect(geometryMatches({ x: 100.6, y: 199.4, width: 300.9, height: 140 }, routed)).toBe(true);
    expect(geometryMatches({ x: 100, y: 200, width: null, height: null }, routed)).toBe(true);
  });

  it('treats a move or a resize as stale', () => {
    expect(geometryMatches({ x: 140, y: 200, width: 300, height: 140 }, routed)).toBe(false);
    // Dragging the right edge keeps the position but changes the size.
    expect(geometryMatches({ x: 100, y: 200, width: 360, height: 140 }, routed)).toBe(false);
    expect(geometryMatches(undefined, routed)).toBe(false);
  });
});
