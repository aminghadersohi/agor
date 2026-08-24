import type { Board } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import type { Node } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardObjects } from './useBoardObjects';

// Spy the themed error toast so the failure path of reorderObject is observable.
const { showError, showSuccess, showWarning } = vi.hoisted(() => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showWarning: vi.fn(),
}));
vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => ({
    showError,
    showSuccess,
    showWarning,
    showInfo: vi.fn(),
    showLoading: vi.fn(),
    destroy: vi.fn(),
  }),
}));

beforeEach(() => {
  showError.mockClear();
  showSuccess.mockClear();
  showWarning.mockClear();
});

/**
 * Minimal client whose `service('boards').patch` is a spy. reorderObject is the
 * only behavior exercised here, and it only touches `client` + `board`.
 */
function makeClient() {
  const patch = vi.fn().mockResolvedValue({});
  const client = { service: vi.fn().mockReturnValue({ patch }) };
  return { client: client as never, patch };
}

/** Like makeClient but `patch` rejects, to exercise the error path. */
function makeRejectingClient() {
  const patch = vi.fn().mockRejectedValue(new Error('network down'));
  const client = { service: vi.fn().mockReturnValue({ patch }) };
  return { client: client as never, patch };
}

function makeBoard(objects: Record<string, unknown>): Board {
  return { board_id: 'board-1', objects } as unknown as Board;
}

const wrapper = ({ children }: { children: ReactNode }) => <AntApp>{children}</AntApp>;

function renderReorder(board: Board, client: unknown) {
  return renderHook(
    () =>
      useBoardObjects({
        board,
        client: client as never,
        boardObjectsForBoard: [],
        nodes: [],
        setNodes: vi.fn(),
        deletedObjectsRef: { current: new Set<string>() },
      }),
    { wrapper }
  );
}

describe('reorderObject', () => {
  it('"front" sends a single mergeObjectFields patch with the clamped zIndex', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 105 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe('board-1');
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 106 } },
    });
  });

  it('"forward" sends one mergeObjectFields patch touching BOTH swapped ids', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 105 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'forward');

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 105 }, b: { zIndex: 100 } },
    });
  });

  it('scopes peers to the SAME type — a zone does not rank against markdown', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 100 },
      m: { type: 'markdown', x: 0, y: 0, width: 1, content: '', zIndex: 300 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // If the markdown (300) were a peer, the result would be 301. Scoping to
    // zones makes maxOther 100, so the tie breaks to 101.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 101 } },
    });
  });

  it('"front" at an occupied ceiling pins the target at 499 and drops the occupant (never the card layer)', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 200 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 499 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // Can't go to 500; pin target at the ceiling and push the occupant down so
    // the target still leads — both stay in-band.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 499 }, b: { zIndex: 498 } },
    });
  });

  it('does nothing when the operation is a no-op (already at front)', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 110 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 100 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    expect(patch).not.toHaveBeenCalled();
  });

  it('surfaces a themed error (and does not throw) when the patch rejects', async () => {
    const { client, patch } = makeRejectingClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 105 },
    });
    const { result } = renderReorder(board, client);

    // Must resolve (swallow the rejection), not throw out of reorderObject.
    await expect(result.current.reorderObject('a', 'front')).resolves.toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith('Failed to reorder zone');
  });

  it('coerces a non-finite base zIndex via sanitizeZIndex before computing (NaN → default 100 → 101)', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: Number.NaN },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 100 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // NaN sanitizes to the zone default (100); tie with b (100) breaks to 101.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 101 } },
    });
  });

  it('treats an out-of-band peer (600) as the ceiling (499) so the result stays in-band', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 600 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // sanitizeZIndex clamps the 600 peer to 499 (the ceiling), so "front" pins
    // the target at 499 and drops the occupant to 498 — never 601 / the card
    // (500) / comment (1000) layers.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 499 }, b: { zIndex: 498 } },
    });
  });
});

describe('arrangeZoneContents', () => {
  it('packs measured children row-major and persists position and size as separate patches', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 900, height: 500, label: 'Zone' },
    });
    const initialNodes: Node[] = [
      {
        id: 'zone',
        type: 'zone',
        position: { x: 0, y: 0 },
        data: {},
        width: 900,
        height: 500,
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 200, y: 200 },
        data: {},
        width: 400,
        height: 180,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 220, y: 210 },
        data: {},
        width: 300,
        height: 100,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-1',
              position: { x: 200, y: 200 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-card',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'card-1',
              position: { x: 220, y: 210 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual({
      x: 24,
      y: 88,
    });
    expect(renderedNodes.find((node) => node.id === 'card-card-1')?.position).toEqual({
      x: 448,
      y: 88,
    });
    expect(patch).toHaveBeenCalledTimes(4);
    expect(patch).toHaveBeenCalledWith('placement-branch', { position: { x: 24, y: 88 } });
    expect(patch).toHaveBeenCalledWith('placement-branch', {
      size: { width: 400, height: 180 },
    });
    expect(patch).toHaveBeenCalledWith('placement-card', { position: { x: 448, y: 88 } });
    expect(patch).toHaveBeenCalledWith('placement-card', {
      size: { width: 300, height: 100 },
    });
    expect(showSuccess).toHaveBeenCalledWith('Arranged 2 items in a non-overlapping grid.');
  });

  it('does not persist an overlapping fallback when the zone cannot contain its children', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 500, height: 200, label: 'Zone' },
    });
    const initialNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 500, height: 200 },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 20 },
        data: {},
        width: 400,
        height: 180,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 40, y: 40 },
        data: {},
        width: 300,
        height: 100,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-1',
              position: { x: 20, y: 20 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-card',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'card-1',
              position: { x: 40, y: 40 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(renderedNodes).toEqual(initialNodes);
    expect(patch).not.toHaveBeenCalled();
    expect(showWarning).toHaveBeenCalledWith(expect.stringContaining('No positions were changed'));
  });
});
