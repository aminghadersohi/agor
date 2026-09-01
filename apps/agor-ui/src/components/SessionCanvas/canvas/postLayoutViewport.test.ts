import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import {
  createPostLayoutViewportIntent,
  decidePostLayoutViewport,
  layoutPositionsMatch,
  layoutSnapshotsMatch,
  snapshotLayoutNodes,
} from './postLayoutViewport';

const viewport = { left: 0, top: 0, right: 1200, bottom: 800 };
const viewportPixels = { width: 1200, height: 800 };

function intent(overrides: Partial<Parameters<typeof decidePostLayoutViewport>[0]['intent']> = {}) {
  return {
    source: 'user' as const,
    boardId: 'board-1',
    scope: 'selection' as const,
    before: [{ id: 'one', x: 100, y: 100, width: 300, height: 200 }],
    after: [{ id: 'one', x: 700, y: 500, width: 300, height: 200 }],
    ...overrides,
  };
}

describe('post-layout viewport policy', () => {
  it('fits a materially changed user layout when its affected bounds are clipped', () => {
    expect(
      decidePostLayoutViewport({
        intent: intent({ after: [{ id: 'one', x: 1050, y: 650, width: 300, height: 200 }] }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'clipped', padding: 0.16 });
  });

  it('does not fit auto/realtime work or an already-comfortable explicit result', () => {
    for (const source of ['auto', 'realtime'] as const) {
      expect(
        decidePostLayoutViewport({
          intent: intent({ source }),
          viewport,
          viewportPixels,
          zoom: 1,
        })
      ).toMatchObject({ fit: false, reason: 'not-user' });
    }
    expect(
      decidePostLayoutViewport({
        intent: intent({ after: [{ id: 'one', x: 400, y: 250, width: 300, height: 200 }] }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: false, reason: 'comfortable' });
  });

  it('does not refit a repeated no-op or sub-grid geometry noise', () => {
    const rect = { id: 'one', x: 100, y: 100, width: 300, height: 200 };
    expect(
      decidePostLayoutViewport({
        intent: intent({
          before: [rect],
          after: [{ ...rect, x: rect.x + 7.9 }],
        }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: false, reason: 'no-material-change' });
  });

  it('fits a comfortably visible result only when its current scale is impractically small', () => {
    expect(
      decidePostLayoutViewport({
        intent: intent({ after: [{ id: 'one', x: 500, y: 350, width: 80, height: 40 }] }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'scale' });
  });

  it('fits an impractically large board result with board-scoped padding', () => {
    expect(
      decidePostLayoutViewport({
        intent: intent({
          scope: 'board',
          after: [{ id: 'one', x: 50, y: 250, width: 1100, height: 200 }],
        }),
        viewport,
        viewportPixels,
        zoom: 1,
      })
    ).toMatchObject({ fit: true, reason: 'scale', padding: 0.12 });
  });
});

describe('post-layout viewport snapshots', () => {
  it('resolves nested nodes from the planned parent geometry instead of stale positionAbsolute', () => {
    const nodes: Node[] = [
      { id: 'zone', position: { x: 500, y: 300 }, width: 600, height: 400, data: {} },
      {
        id: 'child',
        parentId: 'zone',
        position: { x: 40, y: 80 },
        positionAbsolute: { x: 120, y: 140 },
        width: 200,
        height: 100,
        data: {},
      },
    ];
    expect(snapshotLayoutNodes(nodes, ['child'])).toEqual([
      { id: 'child', x: 540, y: 380, width: 200, height: 100 },
    ]);
  });

  it('rejects stale settled bounds before a fit can run', () => {
    const before: Node[] = [
      { id: 'one', position: { x: 0, y: 0 }, width: 200, height: 100, data: {} },
    ];
    const after: Node[] = [
      { id: 'one', position: { x: 600, y: 0 }, width: 200, height: 100, data: {} },
    ];
    const request = createPostLayoutViewportIntent({
      source: 'user',
      boardId: 'board-1',
      scope: 'selection',
      beforeNodes: before,
      afterNodes: after,
      affectedNodeIds: ['one'],
    });
    expect(layoutSnapshotsMatch(request.after, snapshotLayoutNodes(after, ['one']))).toBe(true);
    expect(
      layoutSnapshotsMatch(
        request.after,
        snapshotLayoutNodes([{ ...after[0], position: { x: 640, y: 0 } }], ['one'])
      )
    ).toBe(false);
    expect(
      layoutPositionsMatch(
        request.after,
        snapshotLayoutNodes([{ ...after[0], width: 240, height: 140 }], ['one'])
      )
    ).toBe(true);
    expect(
      layoutPositionsMatch(
        request.after,
        snapshotLayoutNodes([{ ...after[0], position: { x: 640, y: 0 } }], ['one'])
      )
    ).toBe(false);
  });
});
