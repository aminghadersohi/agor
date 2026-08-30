import { BOARD_GRID_SIZE, snapBoardGridPoint } from '@agor/core/layout/rectangle-packing';
import type { Board } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import type { Node } from 'reactflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
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

function makeRoutedClient() {
  const boardsPatch = vi.fn().mockResolvedValue({});
  const boardObjectsPatch = vi.fn().mockResolvedValue({});
  const service = vi.fn((path: string) => ({
    patch: path === 'boards' ? boardsPatch : boardObjectsPatch,
  }));
  return { client: { service } as never, service, boardsPatch, boardObjectsPatch };
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
  it('packs once, starts one motion, and persists one complete patch per child', async () => {
    const { client, patch } = makeClient();
    const onArrangeNodes = vi.fn();
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
        width: 399,
        height: 179,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 220, y: 210 },
        data: {},
        width: 299,
        height: 99,
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
          onArrangeNodes,
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual({
      x: 20,
      y: 100,
    });
    expect(renderedNodes.find((node) => node.id === 'card-card-1')?.position).toEqual({
      x: 440,
      y: 100,
    });
    expect(onArrangeNodes).toHaveBeenCalledTimes(1);
    expect(onArrangeNodes.mock.calls[0]?.[0].map((node: Node) => node.position)).toEqual([
      { x: 20, y: 100 },
      { x: 440, y: 100 },
    ]);
    expect(onArrangeNodes.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('placement-branch', {
      position: { x: 20, y: 100 },
      size: { width: 400, height: 180 },
    });
    expect(patch).toHaveBeenCalledWith('placement-card', {
      position: { x: 440, y: 100 },
      size: { width: 300, height: 100 },
    });
    expect(showSuccess).toHaveBeenCalledWith('Arranged 2 items in a non-overlapping grid.');
    for (const [, update] of patch.mock.calls) {
      if (!('position' in update) || !('size' in update)) continue;
      expect(update.position.x % BOARD_GRID_SIZE).toBe(0);
      expect(update.position.y % BOARD_GRID_SIZE).toBe(0);
      expect(update.size.width % BOARD_GRID_SIZE).toBe(0);
      expect(update.size.height % BOARD_GRID_SIZE).toBe(0);
      expect(snapBoardGridPoint(update.position)).toEqual(update.position);
    }
  });

  it('uses the live rendered height when dynamic branch content exceeds React Flow dimensions', async () => {
    const renderedBranch = document.createElement('div');
    renderedBranch.className = 'react-flow__node';
    renderedBranch.dataset.id = 'branch-1';
    Object.defineProperties(renderedBranch, {
      offsetWidth: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 236 },
    });
    const renderedCard = document.createElement('div');
    renderedCard.className = 'react-flow__node';
    renderedCard.dataset.id = 'card-card-1';
    Object.defineProperties(renderedCard, {
      offsetWidth: { configurable: true, value: 380 },
      offsetHeight: { configurable: true, value: 85 },
    });
    document.body.append(renderedBranch, renderedCard);

    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 620, height: 1200, label: 'Zone' },
    });
    const initialNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 620, height: 1200 },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 60 },
        data: {},
        width: 500,
        height: 200,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 20, y: 300 },
        data: {},
        width: 380,
        height: 120,
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
              position: { x: 20, y: 60 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-card',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'card-1',
              position: { x: 20, y: 300 },
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
      x: 20,
      y: 100,
    });
    expect(renderedNodes.find((node) => node.id === 'card-card-1')?.position).toEqual({
      x: 20,
      y: 360,
    });
    expect(patch).toHaveBeenCalledWith('placement-branch', {
      position: { x: 20, y: 100 },
      size: { width: 500, height: 240 },
    });
    expect(patch).toHaveBeenCalledWith('placement-card', {
      position: { x: 20, y: 360 },
      size: { width: 380, height: 100 },
    });

    renderedBranch.remove();
    renderedCard.remove();
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

  it('uses persisted latest-first ordering and compact dimensions for the list preset', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 900,
        label: 'Zone',
        layout: {
          mode: 'manual',
          preset: 'compact_list',
          sortBy: 'updated',
          sortDirection: 'desc',
          autoResizeHeight: true,
        },
      },
    });
    const initialNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 620, height: 900 },
      {
        id: 'card-older',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 200, y: 300 },
        data: { card: { title: 'Older', updated_at: '2026-01-01T00:00:00.000Z' } },
        width: 380,
        height: 220,
      },
      {
        id: 'card-newer',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 200, y: 100 },
        data: { card: { title: 'Newer', updated_at: '2026-02-01T00:00:00.000Z' } },
        width: 380,
        height: 260,
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
              object_id: 'placement-older',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'older',
              position: { x: 200, y: 300 },
              zone_id: 'zone',
              compact: false,
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-newer',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'newer',
              position: { x: 200, y: 100 },
              zone_id: 'zone',
              compact: false,
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

    expect(renderedNodes.find((node) => node.id === 'card-newer')?.position.y).toBe(100);
    expect(renderedNodes.find((node) => node.id === 'card-older')?.position.y).toBe(180);
    expect(patch).toHaveBeenCalledWith('placement-newer', {
      position: { x: 20, y: 100 },
      size: { width: 380, height: 60 },
      compact: true,
    });
    expect(patch).toHaveBeenCalledWith('placement-older', {
      position: { x: 20, y: 180 },
      size: { width: 380, height: 60 },
      compact: true,
    });
    expect(patch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: 'zone',
        objectData: expect.objectContaining({ height: 260 }),
      })
    );
  });

  it('automatically reapplies a persisted zone policy when observed content changes', async () => {
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 900,
        height: 500,
        label: 'Zone',
        layout: {
          mode: 'auto',
          preset: 'grid',
          sortBy: 'updated',
          sortDirection: 'desc',
          autoResizeHeight: false,
        },
      },
    });
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 900, height: 500 },
      {
        id: 'card-older',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 200, y: 200 },
        data: { card: { title: 'Older', updated_at: '2026-01-01T00:00:00.000Z' } },
        width: 300,
        height: 100,
      },
      {
        id: 'card-newer',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 220, y: 210 },
        data: { card: { title: 'Newer', updated_at: '2026-02-01T00:00:00.000Z' } },
        width: 300,
        height: 100,
      },
    ];
    const { rerender, unmount } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-older',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'older',
              position: { x: 200, y: 200 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-newer',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'newer',
              position: { x: 220, y: 210 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(patch).toHaveBeenCalledWith('placement-newer', {
      position: { x: 20, y: 100 },
      size: { width: 300, height: 100 },
    });
    expect(patch).toHaveBeenCalledWith('placement-older', {
      position: { x: 340, y: 100 },
      size: { width: 300, height: 100 },
    });

    const patchCountAfterFirstPass = patch.mock.calls.length;
    nodes = nodes.map((node) =>
      node.id === 'card-newer'
        ? { ...node, position: { x: 20, y: 100 } }
        : node.id === 'card-older'
          ? { ...node, position: { x: 348, y: 88 } }
          : node
    );
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(patch).toHaveBeenCalledTimes(patchCountAfterFirstPass);
    unmount();
  });
});

describe('direct manipulation of automatic zones', () => {
  const zoneId = 'zone-1';
  const autoZone = {
    type: 'zone',
    x: 0,
    y: 0,
    width: 620,
    height: 500,
    label: 'Automatic',
    layout: {
      mode: 'auto',
      preset: 'compact_list',
      sortBy: 'position',
      sortDirection: 'asc',
      gap: 24,
      autoResizeHeight: false,
    },
  };
  const placement = {
    object_id: 'placement-card',
    board_id: 'board-1',
    entity_type: 'card',
    card_id: 'card-1',
    position: { x: 200, y: 200 },
    zone_id: zoneId,
    compact: true,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const child: Node = {
    id: 'card-card-1',
    type: 'cardNode',
    parentId: zoneId,
    position: { x: 200, y: 200 },
    width: 380,
    height: 120,
    data: {},
  };

  function renderInteraction(
    board: Board,
    client: unknown,
    nodes: Node[] = [
      { id: zoneId, type: 'zone', position: { x: 0, y: 0 }, width: 620, height: 500, data: {} },
      child,
    ]
  ) {
    return renderHook(
      () =>
        useBoardObjects({
          board,
          client: client as never,
          boardObjectsForBoard: [placement] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
  }

  it('persists manual mode before expanding a card and blocks the pending compact-list pass', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const { result } = renderInteraction(makeBoard({ [zoneId]: autoZone }), client);

    await act(async () => {
      await result.current.setPlacementCompact(placement as never, false);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(boardsPatch).toHaveBeenCalledWith('board-1', {
      _action: 'mergeObjectFields',
      objects: {
        [zoneId]: {
          layout: expect.objectContaining({ mode: 'manual', preset: 'compact_list' }),
        },
      },
    });
    expect(boardObjectsPatch).toHaveBeenCalledTimes(1);
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-card', { compact: false });
    expect(boardsPatch.mock.invocationCallOrder[0]).toBeLessThan(
      boardObjectsPatch.mock.invocationCallOrder[0]
    );
  });

  it('also demotes before the zone-wide density control changes its contents', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const { result } = renderInteraction(makeBoard({ [zoneId]: autoZone }), client);

    await act(async () => {
      await result.current.setZoneContentsCompact(zoneId, false);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        objects: { [zoneId]: { layout: expect.objectContaining({ mode: 'manual' }) } },
      })
    );
    expect(boardObjectsPatch).toHaveBeenCalledTimes(1);
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-card', { compact: false });
  });

  it('cancels a queued auto pass so a directly moved child stays at its dropped position', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const droppedChild = { ...child, position: { x: 333, y: 222 } };
    const setNodes = vi.fn();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({
            [zoneId]: { ...autoZone, layout: { ...autoZone.layout, preset: 'grid' } },
          }),
          client,
          boardObjectsForBoard: [placement] as never,
          nodes: [droppedChild],
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.demoteAutoZone(zoneId);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        objects: { [zoneId]: { layout: expect.objectContaining({ mode: 'manual' }) } },
      })
    );
    expect(boardObjectsPatch).not.toHaveBeenCalled();
    expect(setNodes).not.toHaveBeenCalled();
    expect(droppedChild.position).toEqual({ x: 333, y: 222 });
  });

  it('leaves an already-manual zone manual while applying the requested density', async () => {
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const manual = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'manual' } },
    });
    const { result } = renderInteraction(manual, client);

    await act(async () => {
      await result.current.setPlacementCompact(placement as never, false);
    });

    expect(boardsPatch).not.toHaveBeenCalled();
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-card', { compact: false });
  });

  it('re-arming auto mode schedules a fresh tidy', async () => {
    vi.useFakeTimers();
    const { client, boardObjectsPatch } = makeRoutedClient();
    let board = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'auto', preset: 'grid' } },
    });
    const { result, rerender } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [placement] as never,
          nodes: [
            {
              ...child,
              width: 300,
              height: 100,
            },
          ],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(boardObjectsPatch).toHaveBeenCalled();
    boardObjectsPatch.mockClear();

    await act(async () => {
      await result.current.demoteAutoZone(zoneId);
    });
    board = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'manual', preset: 'grid' } },
    });
    rerender();
    expect(boardObjectsPatch).not.toHaveBeenCalled();

    board = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'auto', preset: 'grid' } },
    });
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(boardObjectsPatch).toHaveBeenCalledWith(
      'placement-card',
      expect.objectContaining({ position: { x: 20, y: 100 } })
    );
  });
});

/**
 * `setZoneContentsCompact` is the UI half of `agor_boards_set_compact` scoped
 * to a zone, so these cover the same targeting and idempotence contract the
 * MCP tool is tested against.
 */
describe('setZoneContentsCompact', () => {
  const placements = [
    { object_id: 'obj-branch', zone_id: 'zone-1', branch_id: 'branch-1' },
    { object_id: 'obj-card', zone_id: 'zone-1', card_id: 'card-1' },
    { object_id: 'obj-other-zone', zone_id: 'zone-2', card_id: 'card-2' },
    // A nested zone placement carries neither branch_id nor card_id and is
    // not an entity the density control applies to.
    { object_id: 'obj-not-entity', zone_id: 'zone-1' },
  ];

  function renderCompact(client: unknown, boardObjectsForBoard: unknown[] = placements) {
    return renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({
            'zone-1': { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Z' },
          }),
          client: client as never,
          boardObjectsForBoard: boardObjectsForBoard as never,
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
  }

  it('patches only the entity placements pinned to the requested zone', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(client);

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(client.service).toHaveBeenCalledWith('board-objects');
    expect(patch.mock.calls.map((call) => call[0]).sort()).toEqual(['obj-branch', 'obj-card']);
    for (const call of patch.mock.calls) {
      expect(call[1]).toEqual({ compact: true });
    }
  });

  it('expands a collapsed zone back to full density', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(
      client,
      placements.map((placement) => ({ ...placement, compact: true }))
    );

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', false);
    });

    expect(patch.mock.calls.map((call) => call[0]).sort()).toEqual(['obj-branch', 'obj-card']);
    expect(patch.mock.calls[0][1]).toEqual({ compact: false });
  });

  it('skips placements already at the requested density', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(client, [
      { object_id: 'obj-branch', zone_id: 'zone-1', branch_id: 'branch-1', compact: true },
      { object_id: 'obj-card', zone_id: 'zone-1', card_id: 'card-1' },
    ]);

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe('obj-card');
  });

  it('is a no-op — no patch, no toast — when the zone is already uniform', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(
      client,
      placements.map((placement) => ({ ...placement, compact: true }))
    );

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(patch).not.toHaveBeenCalled();
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a themed error when the patch fails', async () => {
    const { client } = makeRejectingClient();
    const { result } = renderCompact(client);

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(showError).toHaveBeenCalledWith('Failed to update zone density');
    expect(showSuccess).not.toHaveBeenCalled();
  });
});

/**
 * `compact_list` collapses every item on the way in and nothing used to undo
 * it, so a zone switched back to Grid stayed collapsed with no explanation.
 * The expand is keyed to the preset transition, NOT to arranging in grid.
 */
describe('handleUpdateObject compact_list → grid expansion', () => {
  const zoneId = 'zone-1';
  const collapsed = [
    { object_id: 'obj-branch', zone_id: zoneId, branch_id: 'branch-1', compact: true },
    { object_id: 'obj-card', zone_id: zoneId, card_id: 'card-1', compact: true },
  ];

  function zone(preset: string, mode: 'auto' | 'manual' = 'manual') {
    return {
      type: 'zone',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      label: 'Triage',
      layout: { mode, preset },
    };
  }

  function renderUpdate(boardPreset: string, boardObjectsForBoard: unknown[], client: unknown) {
    return renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone(boardPreset) }),
          client: client as never,
          boardObjectsForBoard: boardObjectsForBoard as never,
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
  }

  /** Patch calls the expansion made, keyed by placement id. */
  function compactPatches(patch: ReturnType<typeof vi.fn>) {
    return patch.mock.calls
      .filter((call) => call[1] && typeof call[1] === 'object' && 'compact' in call[1])
      .map((call) => [call[0], call[1].compact]);
  }

  it('expands the zone contents when the preset leaves compact_list for grid', async () => {
    const { client, patch } = makeClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch)).toEqual([
      ['obj-branch', false],
      ['obj-card', false],
    ]);
  });

  it('keeps auto mode armed while its compact-list to grid transition expands contents', async () => {
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('compact_list', 'auto') }),
          client,
          boardObjectsForBoard: collapsed as never,
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid', 'auto') as never);
    });

    expect(compactPatches(patch)).toEqual([
      ['obj-branch', false],
      ['obj-card', false],
    ]);
    expect(
      patch.mock.calls.some(
        (call) => call[1]?._action === 'mergeObjectFields' && call[1].objects?.[zoneId]?.layout
      )
    ).toBe(false);
  });

  it('does not expand when a grid zone is merely updated again', async () => {
    // The regression guard for automatic zones: a grid zone reflows and is
    // re-saved constantly, and each of those must leave hand-collapsed cards
    // alone.
    const { client, patch } = makeClient();
    const { result } = renderUpdate('grid', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });

  it('does not expand when the zone stays on compact_list', async () => {
    const { client, patch } = makeClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, {
        ...zone('compact_list'),
        label: 'Renamed',
      } as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });

  it('expands silently — the arrange that follows reports its own result', async () => {
    const { client } = makeClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('leaves other zones alone when one zone exits compact_list', async () => {
    const { client, patch } = makeClient();
    const { result } = renderUpdate(
      'compact_list',
      [...collapsed, { object_id: 'obj-elsewhere', zone_id: 'zone-2', card_id: 'card-9' }],
      client
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch).map(([id]) => id)).not.toContain('obj-elsewhere');
  });

  it('does not expand when the board patch itself fails', async () => {
    const { client, patch } = makeRejectingClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });
});

/**
 * Expanding on the way out of compact_list is only half the job: the cards keep
 * the one-row spacing the preset gave them, so restoring their full height
 * makes them overlap until the zone is re-packed.
 */
describe('compact_list → grid re-packs the expanded zone', () => {
  const zoneId = 'zone-1';

  function zone(preset: string) {
    return {
      type: 'zone',
      x: 0,
      y: 0,
      width: 420,
      height: 900,
      label: 'Triage',
      layout: { mode: 'manual', preset },
    };
  }

  const placements = [
    { object_id: 'obj-a', zone_id: zoneId, card_id: 'card-a', compact: true },
    { object_id: 'obj-b', zone_id: zoneId, card_id: 'card-b', compact: true },
  ];

  // Stacked at compact_list's row pitch: 56px apart, which is exactly the
  // spacing that overlaps once each card is ~120px tall again.
  const nodes = [
    {
      id: 'card-card-a',
      type: 'cardNode',
      parentId: zoneId,
      position: { x: 24, y: 64 },
      width: 380,
      height: 120,
      data: {},
    },
    {
      id: 'card-card-b',
      type: 'cardNode',
      parentId: zoneId,
      position: { x: 24, y: 120 },
      width: 380,
      height: 120,
      data: {},
    },
  ];

  it('schedules an arrange that moves the expanded cards apart', async () => {
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const setNodes = vi.fn();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('compact_list') }),
          client: client as never,
          boardObjectsForBoard: placements as never,
          nodes: nodes as never,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    // The expand lands immediately; the re-pack is deferred so the cards can
    // paint at full height before the layout measures them.
    const compactPatches = patch.mock.calls.filter((c) => c[1] && 'compact' in c[1]);
    expect(compactPatches.map((c) => c[1].compact)).toEqual([false, false]);
    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const positioned = patch.mock.calls.filter((c) => c[1] && 'position' in c[1]);
    expect(positioned.length).toBeGreaterThan(0);
    // Whatever the packer chooses, the two cards must no longer sit 56px apart.
    const ys = positioned.map((c) => c[1].position.y).sort((a, b) => a - b);
    if (ys.length === 2) expect(ys[1] - ys[0]).toBeGreaterThan(56);
  });

  it('re-packs when the zone toolbar expands the contents directly', async () => {
    // The toolbar calls setZoneContentsCompact, which never passes through
    // handleUpdateObject, so the preset-change re-pack does not cover it. Left
    // unrepaired the button reliably produces the overlap the preset path
    // avoids -- and the compact flags all flip correctly while it does.
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('grid') }),
          client: client as never,
          boardObjectsForBoard: placements as never,
          nodes: nodes as never,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.setZoneContentsCompact(zoneId, false);
    });

    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const positioned = patch.mock.calls.filter((c) => c[1] && 'position' in c[1]);
    expect(positioned.length).toBeGreaterThan(0);
    const ys = positioned.map((c) => c[1].position.y).sort((a, b) => a - b);
    if (ys.length === 2) expect(ys[1] - ys[0]).toBeGreaterThan(56);
  });

  it('does not re-pack when the toolbar collapses the contents', async () => {
    // Collapsing shrinks every item, which cannot create an overlap; a re-pack
    // there would move cards the user did not ask to move.
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('grid') }),
          client: client as never,
          boardObjectsForBoard: [
            { object_id: 'obj-a', zone_id: zoneId, card_id: 'card-a', compact: false },
            { object_id: 'obj-b', zone_id: zoneId, card_id: 'card-b', compact: false },
          ] as never,
          nodes: nodes as never,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.setZoneContentsCompact(zoneId, true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);
  });

  it('does not schedule a re-pack when the preset did not leave compact_list', async () => {
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('grid') }),
          client: client as never,
          boardObjectsForBoard: placements as never,
          nodes: nodes as never,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);
  });
});
