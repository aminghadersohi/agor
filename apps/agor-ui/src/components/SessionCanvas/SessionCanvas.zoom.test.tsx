// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted zone palette fixtures verify canvas creation behavior

import { BOARD_SNAP_GRID } from '@agor/core/layout/rectangle-packing';
import type { AgorClient, Board } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import type { Node } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import SessionCanvas, { isCanvasSelectionControlTarget } from './SessionCanvas';

let reactFlowProps: Record<string, unknown> | null = null;
// Stable spy for the `useNodesState` setter (onNodesChangeInternal). Lets tests
// assert that onNodesChange forwards changes to React Flow's internal handler.
const onNodesChangeInternalSpy = vi.fn();
// Stable spy for the raw setNodes setter (setNodesUnsafe). Lets tests inspect
// the functional updater passed when zIndex needs to change for zone selection.
const setNodesUnsafeSpy = vi.fn();
let nodesStateOverride: Node[] | undefined;

vi.mock('reactflow', () => ({
  Background: () => <div data-testid="react-flow-background" />,
  BackgroundVariant: { Dots: 'dots' },
  ControlButton: ({
    children,
    onClick,
    ...props
  }: {
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Controls: ({ children }: { children?: ReactNode }) => (
    <div data-testid="react-flow-controls">{children}</div>
  ),
  MiniMap: () => <div data-testid="react-flow-minimap" />,
  ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
    reactFlowProps = props;
    return (
      <div data-testid="react-flow" className="react-flow__pane">
        <div
          data-testid="zone-selection-surface"
          className="react-flow__node react-flow__node-zone"
          data-id="zone-1"
        />
        {props.children}
      </div>
    );
  },
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useEdgesState: (initialEdges: unknown[]) => [initialEdges, vi.fn(), vi.fn()],
  useNodesState: (initialNodes: unknown[]) => [
    nodesStateOverride ?? initialNodes,
    setNodesUnsafeSpy,
    onNodesChangeInternalSpy,
  ],
}));

vi.mock('./canvas/AppNode', () => ({
  AppNode: () => <div data-testid="app-node" />,
}));

vi.mock('./canvas/ArtifactNode', () => ({
  ArtifactNode: () => <div data-testid="artifact-node" />,
}));

beforeEach(() => {
  reactFlowProps = null;
  nodesStateOverride = undefined;
  onNodesChangeInternalSpy.mockClear();
  setNodesUnsafeSpy.mockClear();
});

describe('SessionCanvas zoom shortcuts', () => {
  it('does not start a canvas selection gesture from portaled layout controls', () => {
    const popover = document.createElement('div');
    popover.className = 'canvas-layout-controls';
    const gridControl = document.createElement('span');
    popover.append(gridControl);

    expect(isCanvasSelectionControlTarget(gridControl)).toBe(true);
  });

  it('does not capture a portaled modal segmented option as a canvas gesture', () => {
    const modal = document.createElement('div');
    modal.className = 'ant-modal-root';
    const segmentedOption = document.createElement('span');
    segmentedOption.className = 'ant-segmented-item-label';
    modal.append(segmentedOption);

    expect(isCanvasSelectionControlTarget(segmentedOption)).toBe(true);
  });

  it('uses Command or Control plus scroll to zoom while preserving scroll panning', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);

    expect(reactFlowProps?.panOnScroll).toBe(true);
    expect(reactFlowProps?.zoomActivationKeyCode).toEqual(['Meta', 'Control']);
    expect(reactFlowProps?.selectionOnDrag).toBe(false);
    expect(reactFlowProps?.snapGrid).toBe(BOARD_SNAP_GRID);
  });

  it('marquee-selects partially intersected nested items through a non-1 zoom transform', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);
    const flowNodes: Node[] = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 100, y: 100 },
        width: 600,
        height: 500,
        data: {},
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone-1',
        position: { x: 40, y: 80 },
        width: 200,
        height: 120,
        data: {},
      },
      {
        id: 'card-1',
        type: 'cardNode',
        parentId: 'zone-1',
        position: { x: 280, y: 80 },
        width: 180,
        height: 100,
        data: {},
      },
    ];
    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        getNodes: () => flowNodes,
        getViewport: () => ({ x: 0, y: 0, zoom: 0.5 }),
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
          x: x / 0.5,
          y: y / 0.5,
        }),
      });
    });
    setNodesUnsafeSpy.mockClear();

    const surface = screen.getByTestId('zone-selection-surface');
    fireEvent.pointerDown(surface, { button: 0, pointerId: 7, clientX: 65, clientY: 80 });
    fireEvent.pointerMove(surface, { pointerId: 7, clientX: 245, clientY: 120, buttons: 1 });

    expect(document.querySelector('.canvas-marquee-selection')).toBeInTheDocument();
    const updater = setNodesUnsafeSpy.mock.calls.at(-1)?.[0] as
      | ((current: Node[]) => Node[])
      | undefined;
    const updated = updater?.(flowNodes);
    expect(updated?.filter((node) => node.selected).map((node) => node.id)).toEqual([
      'branch-1',
      'card-1',
    ]);

    fireEvent.pointerUp(surface, { button: 0, pointerId: 7, clientX: 245, clientY: 120 });
    expect(document.querySelector('.canvas-marquee-selection')).not.toBeInTheDocument();
  });

  it('runs nested worktree snapping through heterogeneous production peers', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);
    const flowNodes: Node[] = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 100, y: 100 },
        width: 600,
        height: 500,
        data: {},
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone-1',
        position: { x: 41, y: 80 },
        positionAbsolute: { x: 141, y: 180 },
        width: 200,
        height: 120,
        data: {},
      },
      {
        id: 'artifact-1',
        type: 'artifactNode',
        position: { x: 140, y: 400 },
        width: 300,
        height: 180,
        data: {},
      },
    ];
    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        getNodes: () => flowNodes,
        getViewport: () => ({ x: 10, y: 20, zoom: 0.5 }),
        getZoom: () => 0.5,
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    });
    setNodesUnsafeSpy.mockClear();

    act(() => {
      (reactFlowProps?.onNodeDrag as (event: unknown, node: Node) => void)?.({}, flowNodes[1]);
    });

    const guide = document.querySelector<HTMLElement>(
      '.canvas-alignment-guide.vertical[data-guide-kind="alignment"]'
    );
    expect(guide).not.toBeNull();
    expect(guide).toHaveStyle({ left: '80px' });
    expect(guide?.style.height).not.toBe('100%');
    const updater = setNodesUnsafeSpy.mock.calls.at(-1)?.[0] as
      | ((current: Node[]) => Node[])
      | undefined;
    expect(updater?.(flowNodes).find((node) => node.id === 'branch-1')?.position.x).toBe(40);
  });

  it.each([
    ['worktree', 'branchNode', 'branch-1'],
    ['card', 'cardNode', 'card-1'],
  ])('keeps one compact %s size readout outside while dragging', (_label, type, id) => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);
    const moving: Node = {
      id,
      type,
      position: { x: 300, y: 100 },
      width: 200,
      height: 120,
      data: {},
    };
    const flowNodes: Node[] = [
      moving,
      {
        id: 'peer',
        type: 'artifactNode',
        position: { x: 0, y: 0 },
        width: 200,
        height: 120,
        data: {},
      },
    ];
    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        getNodes: () => flowNodes,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getZoom: () => 1,
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
      (reactFlowProps?.onNodeDrag as (event: unknown, node: Node) => void)?.({}, moving);
    });

    const readout = document.querySelector<HTMLElement>('[data-guide-kind="size-readout"]');
    const sizeLines = document.querySelectorAll('.canvas-alignment-guide[data-guide-kind="size"]');
    expect(readout).toHaveTextContent('200 × 120');
    expect(sizeLines).toHaveLength(1);
    expect(Number.parseFloat(readout?.style.top ?? '')).toBeGreaterThan(220);
  });

  describe('automatic zone direct manipulation', () => {
    const autoBoard = {
      board_id: 'board-1',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 900,
          label: 'Automatic',
          layout: { mode: 'auto', preset: 'grid' },
        },
      },
    } as unknown as Board;

    function renderAutoBoard() {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={autoBoard}
            client={client}
            branches={[]}
            sessionById={new Map()}
            sessionsByBranch={new Map()}
            userById={new Map()}
            repoById={new Map()}
            branchById={new Map()}
            boardObjectById={new Map()}
            boardObjectsByBoardId={new Map()}
            commentById={new Map()}
            cardById={new Map()}
          />
        </ConnectionProvider>
      );
      return { client, patch };
    }

    it('demotes before dragging a card already managed by the automatic zone', async () => {
      const { client, patch } = renderAutoBoard();

      act(() => {
        (reactFlowProps?.onNodeDragStart as (event: unknown, node: Node) => void)?.(
          {},
          {
            id: 'card-1',
            type: 'cardNode',
            parentId: 'zone-1',
            position: { x: 140, y: 160 },
            data: {},
          }
        );
      });

      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith('board-1', {
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({
            type: 'zone',
            layout: expect.objectContaining({ mode: 'manual', preset: 'grid' }),
          }),
        })
      );
      expect(client.service).toHaveBeenCalledWith('boards');
    });

    it.each([
      ['the zone container', { id: 'zone-1', type: 'zone', parentId: undefined }],
      ['a card entering from outside', { id: 'card-new', type: 'cardNode', parentId: undefined }],
    ])('does not demote for dragging %s', async (_label, partialNode) => {
      const { patch } = renderAutoBoard();

      act(() => {
        (reactFlowProps?.onNodeDragStart as (event: unknown, node: Node) => void)?.({}, {
          ...partialNode,
          position: { x: 140, y: 160 },
          data: {},
        } as Node);
      });
      await Promise.resolve();

      expect(patch).not.toHaveBeenCalled();
    });
  });

  it('opens the markdown note modal when the markdown tool clicks a board node', async () => {
    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <SessionCanvas
          board={
            {
              board_id: 'board-1',
              name: 'Board',
              slug: 'board',
              objects: {
                'zone-1': {
                  type: 'zone',
                  x: 0,
                  y: 0,
                  width: 1200,
                  height: 900,
                  label: 'Large Zone',
                  borderColor: '#d9d9d9',
                  backgroundColor: '#d9d9d91a',
                },
              },
              created_at: '2026-06-18T00:00:00.000Z',
              last_updated: '2026-06-18T00:00:00.000Z',
              created_by: 'user-1',
              url: 'http://localhost/ui/b/board/',
              archived: false,
            } as unknown as Board
          }
          client={null}
          branches={[]}
        />
      </ConnectionProvider>
    );

    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Markdown Note' }));
    await waitFor(() => expect(reactFlowProps?.className).toBe('tool-mode-markdown'));

    act(() => {
      (reactFlowProps?.onNodeClick as (event: unknown, node: unknown) => void)?.(
        { clientX: 240, clientY: 320 },
        { id: 'zone-1', type: 'zone' }
      );
    });

    expect(await screen.findByText('Add Markdown Note')).toBeInTheDocument();
  });

  describe('onNodesChange zone resize via O(1) getNode lookup', () => {
    const zoneBoard = {
      board_id: 'board-1',
      name: 'Board',
      slug: 'board',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 1200,
          height: 900,
          label: 'Large Zone',
          borderColor: '#d9d9d9',
          backgroundColor: '#d9d9d91a',
          layout: { mode: 'auto', resize: 'height', autoResizeHeight: true },
        },
      },
      created_at: '2026-06-18T00:00:00.000Z',
      last_updated: '2026-06-18T00:00:00.000Z',
      created_by: 'user-1',
      url: 'http://localhost/ui/b/board/',
      archived: false,
    } as unknown as Board;

    // Render the canvas, then wire up React Flow's instance via onInit with a
    // controlled `getNode`. During a real resize React Flow mutates the live
    // node style before emitting onNodesChange, so tests can supply that live
    // geometry independently from the persisted board snapshot.
    function renderCanvas(
      client: AgorClient | null,
      liveStyle: { width: number; height: number } = { width: 1200, height: 900 }
    ) {
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={zoneBoard}
            client={client}
            sessionById={new Map()}
            sessionsByBranch={new Map()}
            userById={new Map()}
            repoById={new Map()}
            branches={[]}
            branchById={new Map()}
            boardObjectById={new Map()}
            boardObjectsByBoardId={new Map()}
            commentById={new Map()}
            cardById={new Map()}
          />
        </ConnectionProvider>
      );

      const zoneNode = {
        id: 'zone-1',
        type: 'zone',
        position: { x: 0, y: 0 },
        style: liveStyle,
      };
      const getNode = vi.fn((id: string) => (id === 'zone-1' ? zoneNode : undefined));
      act(() => {
        (reactFlowProps?.onInit as (instance: unknown) => void)?.({
          getNode,
          screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
          fitView: vi.fn(),
        });
      });

      const onNodesChange = reactFlowProps?.onNodesChange as (changes: unknown[]) => void;
      return { getNode, onNodesChange };
    }

    function makeClient() {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      return { client, patch };
    }

    it('forwards non-dimensions changes through onNodesChangeInternal', () => {
      const { onNodesChange } = renderCanvas(null);
      const changes = [{ type: 'position', id: 'zone-1', position: { x: 5, y: 5 } }];

      act(() => onNodesChange(changes));

      expect(onNodesChangeInternalSpy).toHaveBeenCalledWith(changes);
    });

    it('skips persisting a no-op resize within the 1px tolerance', async () => {
      const { client, patch } = makeClient();
      const { getNode, onNodesChange } = renderCanvas(client);

      vi.useFakeTimers();
      // Incoming dims sit within 1px of the node's current 1200x900 → no-op.
      act(() =>
        onNodesChange([
          {
            type: 'dimensions',
            id: 'zone-1',
            resizing: true,
            dimensions: { width: 1200.4, height: 899.6 },
          },
        ])
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      vi.useRealTimers();

      expect(getNode).toHaveBeenCalledWith('zone-1'); // real lookup HIT
      expect(patch).not.toHaveBeenCalled(); // no debounce-persist for a no-op
      expect(onNodesChangeInternalSpy).toHaveBeenCalled(); // change still forwarded
    });

    it('debounce-persists a real resize via a boards patch after 500ms', async () => {
      const { client, patch } = makeClient();
      const { onNodesChange } = renderCanvas(client, { width: 1000, height: 700 });

      vi.useFakeTimers();
      act(() =>
        onNodesChange([
          {
            type: 'dimensions',
            id: 'zone-1',
            resizing: true,
            dimensions: { width: 1000, height: 700 },
          },
        ])
      );

      // Nothing persisted until the 500ms debounce elapses.
      expect(patch).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      vi.useRealTimers();

      expect(client.service).toHaveBeenCalledWith('boards');
      expect(patch).toHaveBeenCalledWith(
        'board-1',
        expect.objectContaining({
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({
            type: 'zone',
            width: 1000,
            height: 700,
            layout: expect.objectContaining({
              mode: 'auto',
              resize: 'height',
              autoResizeHeight: true,
            }),
          }),
        })
      );
    });

    it('persists the paired origin from a top-left resize in the same zone patch', async () => {
      const { client, patch } = makeClient();
      const { onNodesChange } = renderCanvas(client);

      vi.useFakeTimers();
      act(() =>
        onNodesChange([
          { type: 'position', id: 'zone-1', position: { x: 200, y: 100 } },
          {
            type: 'dimensions',
            id: 'zone-1',
            resizing: true,
            dimensions: { width: 1000, height: 800 },
          },
        ])
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      vi.useRealTimers();

      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith(
        'board-1',
        expect.objectContaining({
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({
            x: 200,
            y: 100,
            width: 1000,
            height: 800,
          }),
        })
      );
    });

    it('treats a dimensions change for an unknown id as a safe no-op miss', () => {
      const { client, patch } = makeClient();
      const { getNode, onNodesChange } = renderCanvas(client);

      expect(() =>
        act(() =>
          onNodesChange([
            {
              type: 'dimensions',
              id: 'missing-node',
              resizing: true,
              dimensions: { width: 10, height: 10 },
            },
          ])
        )
      ).not.toThrow();

      expect(getNode).toHaveBeenCalledWith('missing-node');
      expect(patch).not.toHaveBeenCalled();
    });

    describe('zone select zIndex', () => {
      // The setNodes wrapper in SessionCanvas calls setNodesUnsafe with a
      // functional updater. We capture that updater and call it with mock nodes
      // to assert what the zIndex transition produces.
      function getLastSetNodesUpdater() {
        const calls = setNodesUnsafeSpy.mock.calls;
        const last = calls.at(-1);
        return last?.[0] as ((nodes: unknown[]) => unknown[]) | undefined;
      }

      it('raises zone zIndex to 101 when the zone is selected', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 100 }];
        const result = updater!(mockNodes) as typeof mockNodes;
        expect(result[0].zIndex).toBe(101);
      });

      it('restores zone zIndex to 100 when the zone is deselected', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: false }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 101 }];
        const result = updater!(mockNodes) as typeof mockNodes;
        expect(result[0].zIndex).toBe(100);
      });

      it('returns the same node array reference when no zone is in the select changes', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        // Select a non-zone node (e.g. a branch) — zone-1 is untouched
        act(() => onNodesChange([{ type: 'select', id: 'branch-999', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 100 }];
        const result = updater!(mockNodes);
        // Guard returns currentNodes unchanged so React can bail out on re-render
        expect(result).toBe(mockNodes);
      });

      it('returns the same node array reference when zone zIndex is already current', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 101 }];
        const result = updater!(mockNodes);
        // No-op select echoes from React Flow must not allocate a fresh nodes
        // array, or controlled ReactFlow can re-emit selection indefinitely.
        expect(result).toBe(mockNodes);
      });
    });
  });

  it('exposes Arrange board by accessible name and explains an empty board', async () => {
    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <SessionCanvas board={null} client={null} branches={[]} />
      </ConnectionProvider>
    );

    const button = screen.getByRole('button', { name: 'Arrange board' });
    expect(button).toBeDisabled();
    fireEvent.mouseOver(button.parentElement as HTMLElement);
    expect(
      await screen.findByText('Arrange board — no visible unlocked board items to arrange')
    ).toBeInTheDocument();
  });

  it('keeps focus while an Arrange board transaction blocks keyboard and double activation', async () => {
    nodesStateOverride = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 1200, y: 900 },
        width: 620,
        height: 500,
        data: {},
      },
    ];
    let releaseWrite: (() => void) | undefined;
    const patch = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({});
        })
    );
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const board = {
      board_id: 'board-1',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 1200,
          y: 900,
          width: 620,
          height: 500,
          label: 'Zone',
        },
      },
    } as unknown as Board;
    render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );

    const button = screen.getByRole('button', { name: 'Arrange board' });
    expect(button).toBeEnabled();
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    const options = await screen.findByRole('dialog', { name: 'Arrange board options' });
    expect(within(options).getByRole('checkbox', { name: 'Pack zone contents' })).toBeChecked();
    fireEvent.click(within(options).getByRole('button', { name: 'Arrange board' }));

    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(patch).toHaveBeenCalledTimes(1);

    releaseWrite?.();
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
    expect(button).toHaveFocus();
  });

  it('defaults Pack zone contents on and preserves the frame when the user turns it off', async () => {
    nodesStateOverride = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 1200, y: 900 },
        width: 620,
        height: 500,
        data: {},
      },
    ];
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const board = {
      board_id: 'board-1',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 1200,
          y: 900,
          width: 620,
          height: 500,
          label: 'Zone',
        },
      },
    } as unknown as Board;
    render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Arrange board' }));
    const options = await screen.findByRole('dialog', { name: 'Arrange board options' });
    const pack = within(options).getByRole('checkbox', { name: 'Pack zone contents' });
    expect(pack).toBeChecked();
    fireEvent.click(pack);
    expect(pack).not.toBeChecked();
    fireEvent.click(within(options).getByRole('button', { name: 'Arrange board' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'applyLayout',
        objects: {
          'zone-1': expect.objectContaining({ width: 620, height: 500 }),
        },
      })
    );
  });
});
