/**
 * Hook for managing board objects (text labels, zones, etc.)
 */

import {
  type BoardZoneArrangementOptions,
  containingBoardZoneId,
  planBoardZoneArrangement,
} from '@agor/core/layout/board-zone-arrangement';
import {
  BOARD_GRID_SIZE,
  ceilBoardGridSize,
  ceilBoardGridValue,
  LayoutObstacleError,
  layoutCompactRectangles,
  layoutRectangles,
  snapBoardGridValue,
} from '@agor/core/layout/rectangle-packing';
import { planZoneGrowthReflow } from '@agor/core/layout/zone-growth-reflow';
import {
  compactZoneItemSize,
  getZoneLayoutFrame,
  growZoneLayoutHeight,
  isBoardEntityDensityExpandable,
  justifyZoneContentCluster,
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  type ZoneContentJustification,
  type ZoneLayoutSortItem,
} from '@agor/core/layout/zone-layout';
import type { AgorClient, Board, BoardEntityObject, BoardObject } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node } from 'reactflow';
import { useThemedMessage } from '../../../utils/message';
import { dealDelayMs, dealOrderIndex, dealStyle, dealTiming } from './arrangeAnimation';
import { AutoZoneDeferral } from './autoZoneDeferral';
import {
  type AutoZoneObserverInput,
  type AutoZoneObserverLockManager,
  changedAutoZoneObserverIds,
  holdAutoZoneObserverLease,
} from './autoZoneObserver';
import {
  createPostLayoutViewportIntent,
  type PostLayoutViewportIntent,
} from './postLayoutViewport';
import { zonesNeedingAutoArrange } from './utils/autoArrangeGuard';
import { getNodeAbsolutePosition } from './utils/coordinateTransforms';
import {
  renderedZoneStackHeaderHeight,
  stackExposesHeaders,
  type ZoneStackPresentation,
  zoneStackRevealHeight,
} from './zoneStack';

// Long enough for the expanded cards to paint before the re-pack measures
// them; short enough that the board does not visibly sit in a broken state.
const EXPANDED_REPACK_DELAY_MS = 400;
const AUTO_ZONE_BASE_DELAY_MS = 400;
const CALLED_OUT_ZONE_STACK_Z_INDEX = 900;

const placementNodeId = (placement: BoardEntityObject): string | undefined =>
  placement.branch_id ?? (placement.card_id ? `card-${placement.card_id}` : undefined);

import { getMeasuredLayoutNodeSize } from './utils/boardNodeGeometry';
import type { ReactFlowNode } from './utils/reactFlowTypes';
import {
  computeLayerChanges,
  DEFAULT_BOARD_OBJECT_Z_INDEX,
  type LayerOp,
  sanitizeZIndex,
} from './zOrder';

function renderedNodeSize(node: Node): { width: number; height: number } {
  const measured = (node as ReactFlowNode).measured;
  return getMeasuredLayoutNodeSize(node, {
    width: Number(measured?.width ?? 380),
    height: Number(measured?.height ?? 120),
  });
}

/**
 * Zone titles stay a constant screen size while the board zooms. Convert that
 * rendered size back into board units for one explicit layout pass so children
 * cannot be packed underneath a large title. Missing DOM measurements retain
 * the shared core/MCP fallback scale of 1.
 */
function renderedZoneFontScale(zoneId: string, flowWidth: number): number {
  if (typeof document === 'undefined' || !Number.isFinite(flowWidth) || flowWidth <= 0) return 1;
  const element = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node-zone[data-id]')
  ).find((candidate) => candidate.dataset.id === zoneId);
  const renderedWidth = element?.getBoundingClientRect().width ?? 0;
  if (!Number.isFinite(renderedWidth) || renderedWidth <= 0) return 1;
  return flowWidth / renderedWidth;
}

const ZONE_CANVAS_NODE_TYPES = new Set(['markdown', 'appNode', 'artifactNode']);
const BOARD_ARRANGEABLE_NODE_TYPES = new Set(['branchNode', 'cardNode', ...ZONE_CANVAS_NODE_TYPES]);

function isTopLevelZoneCanvasNode(node: Node): boolean {
  return !node.parentId && ZONE_CANVAS_NODE_TYPES.has(node.type ?? '');
}

function isPositionableZoneCanvasNode(node: Node): boolean {
  return !node.hidden && isTopLevelZoneCanvasNode(node) && node.data?.locked !== true;
}

function isArrangeableTopLevelNode(node: Node): boolean {
  return (
    !node.hidden &&
    !node.parentId &&
    BOARD_ARRANGEABLE_NODE_TYPES.has(node.type ?? '') &&
    node.data?.locked !== true
  );
}

function isVisibleBoardNode(node: Node): boolean {
  return !node.hidden && BOARD_ARRANGEABLE_NODE_TYPES.has(node.type ?? '');
}

function nodeCenterInsideZone(
  node: Node,
  zone: { x: number; y: number; width: number; height: number }
): boolean {
  const size = renderedNodeSize(node);
  const centerX = node.position.x + size.width / 2;
  const centerY = node.position.y + size.height / 2;
  return (
    centerX >= zone.x &&
    centerX <= zone.x + zone.width &&
    centerY >= zone.y &&
    centerY <= zone.y + zone.height
  );
}

/**
 * Resolve one board-arrangement scope from the rendered graph. Canvas objects
 * are geometrically contained rather than parented, so classify them against
 * every zone before filtering the requested zone set. That keeps an object in
 * an unselected, hidden, or locked zone from being mistaken for a free item.
 */
function getBoardArrangementCandidates(
  currentBoard: Board,
  currentNodes: readonly Node[],
  requestedZoneIds?: ReadonlySet<string>
) {
  const currentNodeList = [...currentNodes];
  const liveById = new Map(currentNodeList.map((node) => [node.id, node]));
  const allZones = Object.entries(currentBoard.objects ?? {}).flatMap(([zoneId, object]) => {
    if (object.type !== 'zone') return [];
    const live = liveById.get(zoneId);
    const width = Number(live?.width ?? live?.style?.width);
    const height = Number(live?.height ?? live?.style?.height);
    return [
      [
        zoneId,
        {
          ...object,
          x: live?.position.x ?? object.x,
          y: live?.position.y ?? object.y,
          width: Number.isFinite(width) && width > 0 ? width : object.width,
          height: Number.isFinite(height) && height > 0 ? height : object.height,
          fontSize: typeof live?.data?.fontSize === 'number' ? live.data.fontSize : object.fontSize,
          status: typeof live?.data?.status === 'string' ? live.data.status : object.status,
        },
      ] as const,
    ];
  });
  const zoneForCanvasNode = new Map<string, string>();
  const membershipZones = allZones.map(([id, zone]) => ({ id, ...zone }));
  for (const node of currentNodes) {
    if (!isTopLevelZoneCanvasNode(node)) continue;
    const zoneId = containingBoardZoneId(
      { ...node.position, ...renderedNodeSize(node) },
      membershipZones
    );
    if (zoneId) zoneForCanvasNode.set(node.id, zoneId);
  }

  // A locked/hidden canvas object has absolute coordinates. Moving its zone
  // without moving the object would silently break membership, so preserve the
  // complete zone rather than offering a partially effective arrangement.
  const blockedZoneIds = new Set<string>();
  for (const node of currentNodes) {
    if (!node.hidden && node.data?.locked !== true) continue;
    const zoneId =
      node.parentId ??
      (isTopLevelZoneCanvasNode(node) ? zoneForCanvasNode.get(node.id) : undefined);
    if (zoneId) blockedZoneIds.add(zoneId);
  }

  const selectedZones = allZones.filter(([zoneId]) => {
    const live = liveById.get(zoneId);
    return (
      (!requestedZoneIds || requestedZoneIds.has(zoneId)) &&
      Boolean(live) &&
      !live?.hidden &&
      live?.data?.locked !== true &&
      !blockedZoneIds.has(zoneId)
    );
  });
  const looseNodes = currentNodes.filter(
    (node) => isArrangeableTopLevelNode(node) && !zoneForCanvasNode.has(node.id)
  );
  const selectedZoneIds = new Set(selectedZones.map(([zoneId]) => zoneId));
  const fixedObstacles = [
    ...allZones.flatMap(([zoneId, zone]) => {
      const live = liveById.get(zoneId);
      return !selectedZoneIds.has(zoneId) && live && !live.hidden
        ? [{ id: zoneId, x: zone.x, y: zone.y, width: zone.width, height: zone.height }]
        : [];
    }),
    ...currentNodes.flatMap((node) => {
      const containingZoneId = node.parentId ?? zoneForCanvasNode.get(node.id);
      if (!isVisibleBoardNode(node) || selectedZoneIds.has(containingZoneId ?? '')) return [];
      return [
        {
          id: node.id,
          ...getNodeAbsolutePosition(node, currentNodeList),
          ...ceilBoardGridSize(renderedNodeSize(node)),
        },
      ];
    }),
  ];

  return { selectedZones, zoneForCanvasNode, looseNodes, fixedObstacles };
}

interface UseBoardObjectsProps {
  board: Board | null;
  client: AgorClient | null;
  boardObjectsForBoard: BoardEntityObject[];
  nodes: Node[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  deletedObjectsRef: React.MutableRefObject<Set<string>>;
  eraserMode?: boolean;
  /** Artifact ID currently targeted by an `/a/<…>/` deep link. Used to
   *  flag the matching ArtifactNode so it can render the dashed
   *  "selected" outline. */
  activeUrlTargetArtifactId?: string | null;
  onEditMarkdown?: (objectId: string, content: string, width: number) => void;
  /** Hold optimistic placements and enable motion before realtime echoes arrive. */
  onArrangeNodes?: (nodes: Node[], totalMs: number) => void;
  /** Queue one smart viewport decision after a persisted, explicitly requested layout. */
  onUserLayoutComplete?: (intent: PostLayoutViewportIntent) => void;
}

interface ArrangeZoneContentsOptions {
  silent?: boolean;
  preserveZoneFrame?: boolean;
  userInitiated?: boolean;
}

type ArrangeBoardZonesOptions = Omit<BoardZoneArrangementOptions, 'looseItems'> & {
  userInitiated?: boolean;
  /** Whole-board layout includes free peers; selection layout never does. */
  layoutScope?: 'board' | 'selection';
};

export const useBoardObjects = ({
  board,
  client,
  boardObjectsForBoard,
  nodes,
  setNodes,
  deletedObjectsRef,
  eraserMode = false,
  activeUrlTargetArtifactId,
  onEditMarkdown,
  onArrangeNodes,
  onUserLayoutComplete,
}: UseBoardObjectsProps) => {
  // Use ref to avoid recreating callbacks when board changes
  const boardRef = useRef(board);
  boardRef.current = board;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const { showError, showSuccess, showWarning } = useThemedMessage();
  // `handleUpdateObject` re-packs a zone after expanding it, but
  // `arrangeZoneContents` is declared below it and its dependency array is
  // evaluated during render. A ref keeps the call late-bound.
  const arrangeZoneContentsRef = useRef<
    ((zoneId: string, options?: ArrangeZoneContentsOptions) => Promise<void>) | null
  >(null);
  const autoZoneDeferralRef = useRef<AutoZoneDeferral | null>(null);
  autoZoneDeferralRef.current ??= new AutoZoneDeferral();
  const runAutoZoneArrangeRef = useRef<(zoneId: string) => void>(() => undefined);
  const lastAutoLayoutSignaturesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const [ownsAutoZoneObserver, setOwnsAutoZoneObserver] = useState(
    () => typeof navigator === 'undefined' || navigator.locks === undefined
  );
  const skipNextAutoArrangeRef = useRef(new Set<string>());
  const preserveNextAutoZoneFrameRef = useRef(new Set<string>());
  // Direct manipulation wins immediately, before the persisted board patch
  // returns over realtime. This also blocks an already-scheduled auto pass
  // from snapping the item back during the interaction.
  const manuallyControlledZoneIdsRef = useRef(new Set<string>());
  const zoneDemotionPromisesRef = useRef(new Map<string, Promise<boolean>>());
  const [zoneStackByNodeId, setZoneStackByNodeId] = useState<
    ReadonlyMap<string, ZoneStackPresentation>
  >(new Map());
  const zoneStackByNodeIdRef = useRef(zoneStackByNodeId);
  zoneStackByNodeIdRef.current = zoneStackByNodeId;
  const [calledOutNodeIds, setCalledOutNodeIds] = useState<ReadonlySet<string>>(new Set());
  const calledOutNodeIdsRef = useRef(calledOutNodeIds);
  calledOutNodeIdsRef.current = calledOutNodeIds;
  const boardArrangementInFlightRef = useRef(false);
  const [isBoardArrangementActive, setIsBoardArrangementActive] = useState(false);

  // Use the board object's reference directly. The store already preserves
  // unchanged board references, and serializing every object on every canvas
  // render is prohibitively expensive on large boards.
  const boardObjects = board?.objects;

  const completeUserLayout = useCallback(
    (input: {
      userInitiated?: boolean;
      scope: PostLayoutViewportIntent['scope'];
      beforeNodes: readonly Node[];
      afterNodes: readonly Node[];
      affectedNodeIds: readonly string[];
    }) => {
      const boardId = boardRef.current?.board_id;
      if (!input.userInitiated || !boardId || !onUserLayoutComplete) return;
      onUserLayoutComplete(
        createPostLayoutViewportIntent({
          source: 'user',
          boardId,
          scope: input.scope,
          beforeNodes: input.beforeNodes,
          afterNodes: input.afterNodes,
          affectedNodeIds: input.affectedNodeIds,
        })
      );
    },
    [onUserLayoutComplete]
  );

  useEffect(() => {
    for (const zoneId of manuallyControlledZoneIdsRef.current) {
      const object = boardObjects?.[zoneId];
      if (object?.type === 'zone' && normalizeZoneLayoutPolicy(object.layout).mode === 'manual') {
        manuallyControlledZoneIdsRef.current.delete(zoneId);
        zoneDemotionPromisesRef.current.delete(zoneId);
      }
    }
  }, [boardObjects]);

  useEffect(() => () => autoZoneDeferralRef.current?.dispose(), []);

  useEffect(() => {
    const boardId = board?.board_id;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    lastAutoLayoutSignaturesRef.current = new Map();
    if (!boardId || !locks) {
      setOwnsAutoZoneObserver(true);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setOwnsAutoZoneObserver(false);
    void holdAutoZoneObserverLease(
      locks as unknown as AutoZoneObserverLockManager,
      boardId,
      controller.signal,
      (owned) => {
        if (active) setOwnsAutoZoneObserver(owned);
      }
    ).catch((error) => {
      if (active) console.error('Failed to coordinate Auto Zone observer ownership:', error);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [board?.board_id]);

  const restoreZoneCallouts = useCallback((zoneId: string) => {
    setCalledOutNodeIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const nodeId of current) {
        if (zoneStackByNodeIdRef.current.get(nodeId)?.zoneId !== zoneId) continue;
        next.delete(nodeId);
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  /** Transient stack interaction keeps Auto Zone armed but postpones its next tidy. */
  const deferAutoZone = useCallback((zoneId: string | null | undefined) => {
    if (!zoneId) return;
    const zone = boardRef.current?.objects?.[zoneId];
    if (zone?.type !== 'zone' || normalizeZoneLayoutPolicy(zone.layout).mode !== 'auto') return;
    autoZoneDeferralRef.current?.defer(zoneId, () => runAutoZoneArrangeRef.current(zoneId));
  }, []);

  /** Persist the user's decision to take control of an automatically laid-out zone. */
  const demoteAutoZone = useCallback(
    async (zoneId: string | null | undefined): Promise<boolean> => {
      if (!zoneId || !client) return false;
      const currentBoard = boardRef.current;
      const zone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || zone?.type !== 'zone') return false;
      const layout = normalizeZoneLayoutPolicy(zone.layout);
      if (layout.mode === 'manual') return true;

      const pending = zoneDemotionPromisesRef.current.get(zoneId);
      if (pending) return pending;

      manuallyControlledZoneIdsRef.current.add(zoneId);
      autoZoneDeferralRef.current?.cancel(zoneId);
      skipNextAutoArrangeRef.current.delete(zoneId);
      const demotion = client
        .service('boards')
        .patch(currentBoard.board_id, {
          // mergeObjectFields intentionally accepts zIndex only. Replacing the
          // existing zone through the normal upsert path is what makes this
          // layout-policy transition durable rather than a successful no-op.
          _action: 'upsertObject',
          objectId: zoneId,
          objectData: { ...zone, layout: { ...layout, mode: 'manual' } },
        } as unknown as Partial<Board>)
        .then(() => true)
        .catch((error) => {
          manuallyControlledZoneIdsRef.current.delete(zoneId);
          zoneDemotionPromisesRef.current.delete(zoneId);
          console.error('Failed to disable Auto Zone:', error);
          showError('Failed to disable Auto Zone');
          return false;
        });
      zoneDemotionPromisesRef.current.set(zoneId, demotion);
      return demotion;
    },
    [client, showError]
  );

  /** Change one capable worktree's density without allowing auto-layout to undo it. */
  const setPlacementCompact = useCallback(
    async (placement: BoardEntityObject | undefined, compact: boolean) => {
      if (!client || !placement || !isBoardEntityDensityExpandable(placement.entity_type)) return;
      const nodeId = placementNodeId(placement);
      const stack = nodeId ? zoneStackByNodeIdRef.current.get(nodeId) : undefined;
      if (nodeId && stack && compact && calledOutNodeIdsRef.current.has(nodeId)) {
        setCalledOutNodeIds((current) => {
          const next = new Set(current);
          next.delete(nodeId);
          return next;
        });
        deferAutoZone(stack.zoneId);
        return;
      }
      const transientStackInteraction = !!nodeId && !!stack;
      if (transientStackInteraction) {
        setCalledOutNodeIds((current) => {
          const next = new Set(current);
          if (compact) next.delete(nodeId);
          else next.add(nodeId);
          return next;
        });
        deferAutoZone(stack.zoneId);
        return;
      }
      if (placement.zone_id && !(await demoteAutoZone(placement.zone_id))) return;
      try {
        await client.service('board-objects').patch(placement.object_id, { compact });
      } catch (error) {
        console.error('Failed to update worktree density:', error);
        showError('Failed to update worktree density');
      }
    },
    [client, deferAutoZone, demoteAutoZone, showError]
  );

  /**
   * Collapse or expand every density-capable worktree pinned to a zone. This is the UI
   * half of `agor_boards_set_compact` with a `zoneId`: same targeting (pinned
   * entity placements only), same idempotence (placements already at the
   * requested density are skipped rather than re-patched).
   */
  const setZoneContentsCompact = useCallback(
    async (
      zoneId: string,
      compact: boolean,
      options: { silent?: boolean; manualInteraction?: boolean } = {}
    ) => {
      if (!client) return;
      const targets = boardObjectsForBoard.filter(
        (placement) =>
          placement.zone_id === zoneId &&
          isBoardEntityDensityExpandable(placement.entity_type) &&
          (placement.compact === true) !== compact
      );
      if (targets.length === 0) return;
      if (options.manualInteraction !== false && !(await demoteAutoZone(zoneId))) return;

      try {
        await Promise.all(
          targets.map((placement) =>
            client.service('board-objects').patch(placement.object_id, { compact })
          )
        );
        // Expanding restores every item's full height while the positions still
        // carry compact_list's one-row spacing, so the items overlap and spill
        // out of the zone. `handleUpdateObject` already re-packs when a *preset*
        // change leaves compact_list, but the zone toolbar calls this directly
        // and never passes through there — so without the same repair here the
        // button reliably produces the broken layout the preset path avoids.
        // Deferred for the same reason as that one: the layout measures
        // rendered nodes, and arranging before the expanded items paint would
        // measure the collapsed heights and pack just as tightly.
        // In compact-list presentation, an arrange deliberately collapses the
        // items again. A manual expand has just demoted the zone specifically
        // so that choice wins, so do not immediately undo it with an explicit
        // compact-list arrange. Grid still needs the measured-height re-pack.
        const zone = boardRef.current?.objects?.[zoneId];
        const shouldRepackExpandedGrid =
          !compact &&
          zone?.type === 'zone' &&
          normalizeZoneLayoutPolicy(zone.layout).preset !== 'compact_list';
        if (shouldRepackExpandedGrid) {
          setTimeout(() => {
            void arrangeZoneContentsRef.current?.(zoneId, { silent: true });
          }, EXPANDED_REPACK_DELAY_MS);
        }
        if (options.silent) return;
        const noun = targets.length === 1 ? 'item' : 'items';
        showSuccess(
          compact ? `Collapsed ${targets.length} ${noun}.` : `Expanded ${targets.length} ${noun}.`
        );
      } catch (error) {
        console.error('Failed to update zone density:', error);
        showError('Failed to update zone density');
      }
    },
    [boardObjectsForBoard, client, demoteAutoZone, showError, showSuccess]
  );

  /**
   * Update an existing board object
   */
  const handleUpdateObject = useCallback(
    async (objectId: string, objectData: BoardObject) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return false;

      // Leaving `compact_list` is the one moment we can be certain a collapse
      // was the preset's doing rather than the user's: the preset collapsed
      // every item on the way in, so it owes them an expand on the way out.
      // Deliberately keyed to the preset *transition* and not to arranging in
      // grid — an automatic grid zone reflows on every session change, and
      // expanding there would repeatedly stomp worktree density chosen by hand.
      const previous = currentBoard.objects?.[objectId];
      const leftCompactList =
        previous?.type === 'zone' &&
        objectData.type === 'zone' &&
        normalizeZoneLayoutPolicy(previous.layout).preset === 'compact_list' &&
        normalizeZoneLayoutPolicy(objectData.layout).preset !== 'compact_list';

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'upsertObject',
          objectId,
          objectData,
        } as unknown as Partial<Board>);
        if (leftCompactList) {
          // Silent: this is one user action, and a toast per internal step
          // reads as a bug.
          await setZoneContentsCompact(objectId, false, {
            silent: true,
            manualInteraction: false,
          });
          // The positions still carry compact_list's one-row spacing, so the
          // worktrees we just restored to full height would overlap. Re-pack once
          // they have actually rendered — the layout measures the DOM, so
          // arranging before the expanded worktrees paint would measure the
          // collapsed heights and pack just as tightly. An automatic zone
          // reflows on its own, but a manual one has nothing else to fix this.
          setTimeout(() => {
            void arrangeZoneContentsRef.current?.(objectId, { silent: true });
          }, EXPANDED_REPACK_DELAY_MS);
        }
        return true;
      } catch (error) {
        console.error('Failed to update object:', error);
        showError('Failed to update board item');
        return false;
      }
    },
    [client, setZoneContentsCompact, showError] // Board is read through boardRef, not a dep
  );

  /**
   * Reorder a board object relative to its peers (To Front / Bring Forward /
   * Send Backward / To Back). Computes the new zIndex via the pure helper and
   * persists it.
   *
   * Peers are scoped to board objects of the SAME type as the target (zones
   * reorder only against zones). This is intentional: only zones expose reorder
   * controls, so ranking a zone against markdown/app objects — which have no
   * reorder UI — would strand them and let a zone intercept their clicks.
   * Same-type scoping does NOT strictly isolate the per-type default bands:
   * a zone can be pushed above a lower-default markdown (300) / app (400) under
   * deliberate or MCP/import input. The only hard guarantee is the clamp to
   * [1, 499], so a zone can never reach the card (500) / comment (1000) layers.
   *
   * Persistence sends ONLY the changed `zIndex` per object via a narrow field
   * merge (`mergeObjectFields`), not a full stale copy. The server shallow-
   * merges into the freshest stored object and skips any object that was
   * deleted concurrently, so a swap can't resurrect a just-deleted neighbor and
   * unrelated fields edited elsewhere aren't reverted. The merge persists all
   * touched objects in one read-modify-write (last-write-wins vs concurrent
   * writers, like every other board writer — not atomic).
   */
  const reorderObject = useCallback(
    async (objectId: string, op: LayerOp) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      const objects = currentBoard.objects ?? {};
      const target = objects[objectId];
      if (!target) return;

      const peers = Object.entries(objects)
        .filter(([, obj]) => obj.type === target.type)
        .map(([id, obj]) => ({
          id,
          zIndex: sanitizeZIndex(obj.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX[obj.type]),
        }));

      const changes = computeLayerChanges(op, objectId, peers);
      if (changes.length === 0) return;

      const patches: Record<string, Partial<BoardObject>> = {};
      for (const { id, zIndex } of changes) {
        if (!objects[id]) continue;
        patches[id] = { zIndex };
      }
      if (Object.keys(patches).length === 0) return;

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'mergeObjectFields',
          objects: patches,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to reorder object:', error);
        showError('Failed to reorder zone');
      }
    },
    [client, showError]
  );

  /**
   * Delete a zone (branch-centric: zones can pin branches)
   */
  const deleteZone = useCallback(
    async (objectId: string, _deleteAssociatedSessions: boolean) => {
      if (!board || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal of zone. The SessionCanvas setNodes wrapper clears
      // any orphaned parentId values locally; the daemon owns persistent
      // unpinning and converts zone-relative child positions to absolute.
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        await client.service('boards').patch(board.board_id, {
          _action: 'deleteZone',
          objectId,
        } as unknown as Partial<Board>);

        // After successful deletion, we can remove from the tracking set
        setTimeout(() => {
          deletedObjectsRef.current.delete(objectId);
        }, 1000);
      } catch (error) {
        console.error('Failed to delete zone:', error);
        // Rollback: remove from deleted set
        deletedObjectsRef.current.delete(objectId);
        // Note: WebSocket update should restore the actual state
      }
    },
    [board, client, setNodes, deletedObjectsRef]
  );

  /**
   * Delete a board object
   */
  const deleteObject = useCallback(
    async (objectId: string) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'removeObject',
          objectId,
        } as unknown as Partial<Board>);

        // After successful deletion, we can remove from the tracking set
        // (the object will no longer exist in board.objects)
        setTimeout(() => {
          deletedObjectsRef.current.delete(objectId);
        }, 1000);
      } catch (error) {
        console.error('Failed to delete object:', error);
        // Rollback: remove from deleted set
        deletedObjectsRef.current.delete(objectId);
      }
    },
    [client, setNodes, deletedObjectsRef] // Removed board dependency
  );

  /**
   * Delete an artifact entity (filesystem + board object + DB record).
   * Uses the artifacts service's lifecycle-safe remove method.
   */
  const deleteArtifact = useCallback(
    async (objectId: string, artifactId: string) => {
      if (!client) return;

      // Mark as deleted to prevent re-appearance during WebSocket updates
      deletedObjectsRef.current.add(objectId);

      // Optimistic removal
      setNodes((nodes) => nodes.filter((n) => n.id !== objectId));

      try {
        // Lifecycle-safe: removes filesystem + board object + DB record
        await client.service('artifacts').remove(artifactId);

        setTimeout(() => {
          deletedObjectsRef.current.delete(objectId);
        }, 1000);
      } catch (error) {
        console.error('Failed to delete artifact:', error);
        deletedObjectsRef.current.delete(objectId);
      }
    },
    [client, setNodes, deletedObjectsRef]
  );

  /**
   * Pack every branch/card pinned to a zone using its actual rendered size.
   * Child positions are zone-relative in both React Flow and board_objects, so
   * placements can be applied without translating through canvas coordinates.
   */
  const arrangeZoneContents = useCallback(
    async (zoneId: string, options: ArrangeZoneContentsOptions = {}) => {
      const currentBoard = boardRef.current;
      const persistedZone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || !client || persistedZone?.type !== 'zone') return;
      const sourceNodes = nodesRef.current;
      const liveZoneNode = sourceNodes.find((node) => node.id === zoneId);
      // A toolbar click can race the debounced persistence of a drag/resize.
      // Plan and write from the visible frame so arranging children can never
      // reintroduce the older container geometry from the board snapshot.
      const visibleWidth = Number(liveZoneNode?.width ?? liveZoneNode?.style?.width);
      const visibleHeight = Number(liveZoneNode?.height ?? liveZoneNode?.style?.height);
      const liveZoneData = liveZoneNode?.data as { fontSize?: number; status?: string } | undefined;
      const zone = {
        ...persistedZone,
        x: liveZoneNode?.position.x ?? persistedZone.x,
        y: liveZoneNode?.position.y ?? persistedZone.y,
        width:
          Number.isFinite(visibleWidth) && visibleWidth > 0 ? visibleWidth : persistedZone.width,
        height:
          Number.isFinite(visibleHeight) && visibleHeight > 0
            ? visibleHeight
            : persistedZone.height,
        fontSize: liveZoneData?.fontSize ?? persistedZone.fontSize,
        status: liveZoneData?.status ?? persistedZone.status,
      };

      let changedNodes: Node[] = [];
      let layoutMode: 'cluster' | 'grid' | 'deck' = 'cluster';
      let overflowCount = 0;

      const policy = normalizeZoneLayoutPolicy(zone.layout);
      const sortItem = (
        node: Node,
        position = node.position
      ): ZoneLayoutSortItem & { node: Node; isCanvasObject: boolean } => {
        const data = node.data as {
          branch?: {
            name?: string;
            created_at?: string;
            updated_at?: string;
            filesystem_status?: string;
          };
          card?: {
            title?: string;
            created_at?: string;
            updated_at?: string;
            data?: Record<string, unknown>;
          };
        };
        const cardData = data.card?.data ?? {};
        return {
          node,
          isCanvasObject: isPositionableZoneCanvasNode(node),
          id: node.id,
          position,
          title:
            data.card?.title ??
            data.branch?.name ??
            (typeof node.data?.title === 'string' ? node.data.title : undefined),
          createdAt: data.card?.created_at ?? data.branch?.created_at,
          updatedAt: data.card?.updated_at ?? data.branch?.updated_at,
          rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
          priority: cardData.priority,
          status: cardData.status ?? data.branch?.filesystem_status,
        };
      };
      const unsortedChildren = nodesRef.current.flatMap((node) => {
        if (node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode')) {
          return [sortItem(node)];
        }
        if (isPositionableZoneCanvasNode(node) && nodeCenterInsideZone(node, zone)) {
          return [
            sortItem(node, {
              x: node.position.x - zone.x,
              y: node.position.y - zone.y,
            }),
          ];
        }
        return [];
      });
      const children =
        policy.preset === 'grid' && policy.columns === undefined && policy.sortBy === 'position'
          ? unsortedChildren
          : sortZoneLayoutItems(unsortedChildren, policy);
      if (children.length === 0) {
        if (!options.silent) showWarning('This zone has no pinned items to arrange.');
        return;
      }

      const itemSize = (node: Node) => ceilBoardGridSize(renderedNodeSize(node));
      const frame = getZoneLayoutFrame(zone, {
        // Background Auto Zone writes must be viewport-independent. The
        // screen-stable title occupies a different board-space height at each
        // zoom, so measuring it during an observer pass made two clients (or
        // two reload widths) persist competing child offsets. Explicit layout
        // still plans against the title the initiating user actually sees.
        fontScale: options.userInitiated ? renderedZoneFontScale(zoneId, zone.width) : 1,
      });
      const requestedGap = policy.gap ?? 24;
      const gridGap =
        requestedGap === 0 ? 0 : Math.max(BOARD_GRID_SIZE, snapBoardGridValue(requestedGap));
      let layoutItems = children.map(({ node, isCanvasObject }) => ({
        id: node.id,
        ...(policy.preset === 'compact_list' && !isCanvasObject && node.type === 'branchNode'
          ? compactZoneItemSize('branch', frame.usableWidth)
          : itemSize(node)),
        sourceX: isCanvasObject ? node.position.x - zone.x : node.position.x,
        sourceY: isCanvasObject ? node.position.y - zone.y : node.position.y - frame.headerInset,
      }));
      const contentBounds = {
        width: frame.width,
        height: policy.autoResizeHeight
          ? Number.MAX_SAFE_INTEGER
          : Math.max(0, zone.height - frame.headerInset),
      };
      const columnPreference =
        policy.preset === 'compact_list'
          ? ({ exactColumns: 1 } as const)
          : ({
              preferredColumns: policy.columns ?? Math.ceil(Math.sqrt(children.length)),
            } as const);
      const layoutOptions = {
        padding: frame.padding,
        minPadding: frame.padding,
        gapX: gridGap,
        gapY: gridGap,
        minGapX: gridGap,
        minGapY: gridGap,
        gridSize: BOARD_GRID_SIZE,
        ...columnPreference,
      };
      const useExplicitGrid = policy.preset === 'compact_list' || policy.columns !== undefined;
      let layout = useExplicitGrid
        ? layoutRectangles(layoutItems, {
            ...layoutOptions,
            bounds: contentBounds,
            allowDeck: false,
          })
        : layoutCompactRectangles(layoutItems, {
            bounds:
              !options.preserveZoneFrame && policy.resize === 'both' ? undefined : contentBounds,
            padding: frame.padding,
            gapX: gridGap,
            gapY: gridGap,
            gridSize: BOARD_GRID_SIZE,
          });

      const renderedHeaderHeightById = new Map(
        children.flatMap(({ node, isCanvasObject }) => {
          if (isCanvasObject) return [];
          const fallback = compactZoneItemSize(
            node.type === 'branchNode' ? 'branch' : 'card',
            frame.usableWidth
          ).height;
          return [[node.id, renderedZoneStackHeaderHeight(node, fallback)] as const];
        })
      );
      const stackRevealHeight = zoneStackRevealHeight([...renderedHeaderHeightById.values()]);
      const canDeck = children.every(
        ({ node, isCanvasObject }) => !isCanvasObject && node.type === 'branchNode'
      );
      if (canDeck && layout.overflowingItemIds.length > 0) {
        // The stack renders every member collapsed. Lay it out at those same
        // compact dimensions before deciding how tall the zone must grow. If
        // we use the pre-collapse body height here, the persisted zone becomes
        // tall enough for an ordinary grid on the next load and the stack
        // silently disappears.
        layoutItems = children.map(({ node, isCanvasObject }) => ({
          id: node.id,
          ...(isCanvasObject
            ? itemSize(node)
            : compactZoneItemSize(
                node.type === 'branchNode' ? 'branch' : 'card',
                frame.usableWidth
              )),
          sourceX: isCanvasObject ? node.position.x - zone.x : node.position.x,
          sourceY: isCanvasObject ? node.position.y - zone.y : node.position.y - frame.headerInset,
        }));
        layout = layoutRectangles(layoutItems, {
          ...layoutOptions,
          bounds: contentBounds,
          allowDeck: true,
          deckOffsetX: 0,
          deckOffsetY: stackRevealHeight,
        });
      }
      if (canDeck && layout.overflowingItemIds.length > 0) {
        // Even a stack cannot expose more headers than the zone has vertical
        // room for. Grow only to the minimum shingle height rather than
        // clipping a title/action row or falling back to refusal.
        const minimumStackHeight =
          frame.padding * 2 +
          Math.max(...layoutItems.map((item, index) => item.height + index * stackRevealHeight));
        layout = layoutRectangles(layoutItems, {
          ...layoutOptions,
          bounds: { width: contentBounds.width, height: minimumStackHeight },
          exactColumns: 1,
          preferredColumns: undefined,
          allowDeck: true,
          deckOffsetX: 0,
          deckOffsetY: stackRevealHeight,
        });
      }
      if (
        layout.mode === 'deck' &&
        !stackExposesHeaders(layout.placements, renderedHeaderHeightById)
      ) {
        throw new Error('Auto Zone stack would clip a rendered title or action row.');
      }
      layoutMode = layout.mode;
      overflowCount = layout.overflowingItemIds.length;
      if (overflowCount > 0) {
        if (!options.silent) {
          showWarning(
            `This zone cannot fit ${children.length} items without overlap. No positions were changed; enlarge the zone, enable vertical auto-resize, or arrange fewer items.`
          );
        }
        return;
      }
      const placementById = new Map(
        layout.placements.map((placement) => [placement.id, placement])
      );
      setZoneStackByNodeId((current) => {
        const next = new Map(current);
        for (const [nodeId, presentation] of current) {
          if (presentation.zoneId === zoneId) next.delete(nodeId);
        }
        if (layout.mode === 'deck') {
          for (const placement of layout.placements) {
            next.set(placement.id, {
              zoneId,
              stackIndex: placement.stackIndex,
              deckDepth: placement.deckDepth,
              revealHeight: stackRevealHeight,
            });
          }
        }
        if (next.size !== current.size) return next;
        for (const [nodeId, presentation] of next) {
          const previous = current.get(nodeId);
          if (
            !previous ||
            previous.zoneId !== presentation.zoneId ||
            previous.stackIndex !== presentation.stackIndex ||
            previous.deckDepth !== presentation.deckDepth ||
            previous.revealHeight !== presentation.revealHeight
          )
            return next;
        }
        return current;
      });
      if (layout.mode !== 'deck') restoreZoneCallouts(zoneId);
      const titleInset = frame.headerInset;
      const timing = dealTiming({
        count: children.length,
        reducedMotion:
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      });
      // Background Auto Zone maintenance must not impose a temporary measured
      // box on content. React Flow rebuilds entity/canvas nodes from durable
      // state after realtime events; animating a snapped planner box and then
      // restoring the natural DOM box made ResizeObserver alternate forever.
      // Explicit user actions retain the established deal animation.
      const presentPlannedSize = options.userInitiated === true;
      changedNodes = children.map(({ node, isCanvasObject }) => {
        const placement = placementById.get(node.id);
        return placement
          ? {
              ...node,
              className:
                layout.mode === 'deck'
                  ? [node.className, 'auto-zone-stack-item'].filter(Boolean).join(' ')
                  : node.className
                      ?.split(' ')
                      .filter((name) => name !== 'auto-zone-stack-item')
                      .join(' '),
              zIndex: layout.mode === 'deck' ? 500 + placement.deckDepth : node.zIndex,
              ...(presentPlannedSize ? { width: placement.width, height: placement.height } : {}),
              position: isCanvasObject
                ? { x: zone.x + placement.x, y: zone.y + placement.y + titleInset }
                : { x: placement.x, y: placement.y + titleInset },
              data: {
                ...node.data,
                ...(!isCanvasObject &&
                node.type === 'branchNode' &&
                (layout.mode === 'deck' || policy.preset === 'compact_list')
                  ? { compact: true }
                  : {}),
              },
              style: {
                ...node.style,
                ...(layout.mode === 'deck' ? { pointerEvents: 'auto' as const } : {}),
                ...(presentPlannedSize
                  ? {
                      width: placement.width,
                      height: placement.height,
                      ...dealStyle(
                        dealDelayMs(dealOrderIndex(placement, layout.columns), timing),
                        timing
                      ),
                    }
                  : {}),
              },
            }
          : node;
      });
      const visualPositionChanged = changedNodes.some((node) => {
        const current = children.find((child) => child.id === node.id)?.node;
        return (
          !current ||
          Math.abs(current.position.x - node.position.x) >= 0.5 ||
          Math.abs(current.position.y - node.position.y) >= 0.5
        );
      });
      const nextZoneHeight = options.preserveZoneFrame
        ? zone.height
        : policy.autoResizeHeight
          ? growZoneLayoutHeight(zone.height, layout.height + titleInset)
          : layout.mode === 'deck'
            ? Math.max(zone.height, 200, ceilBoardGridValue(layout.height + titleInset))
            : zone.height;
      const nextZoneWidth =
        !options.preserveZoneFrame && policy.resize === 'both'
          ? Math.max(frame.width, ceilBoardGridValue(layout.width))
          : frame.width;
      const zoneHeightChanged = Math.abs(nextZoneHeight - zone.height) >= 0.5;
      const zoneWidthChanged = Math.abs(nextZoneWidth - zone.width) >= 0.5;
      const sourceZones = Object.entries(currentBoard.objects ?? {}).flatMap(([id, object]) => {
        if (object.type !== 'zone') return [];
        const liveNode = nodesRef.current.find((node) => node.id === id);
        const liveWidth = Number(liveNode?.width ?? liveNode?.style?.width);
        const liveHeight = Number(liveNode?.height ?? liveNode?.style?.height);
        return [
          {
            id,
            x: liveNode?.position.x ?? object.x,
            y: liveNode?.position.y ?? object.y,
            width: Number.isFinite(liveWidth) && liveWidth > 0 ? liveWidth : object.width,
            height: Number.isFinite(liveHeight) && liveHeight > 0 ? liveHeight : object.height,
          },
        ];
      });
      const reflowPlan =
        policy.onOverflow === 'reflow_board' && (zoneHeightChanged || zoneWidthChanged)
          ? planZoneGrowthReflow(
              sourceZones,
              zoneId,
              {
                id: zoneId,
                x: zone.x,
                y: zone.y,
                width: nextZoneWidth,
                height: nextZoneHeight,
              },
              { gap: policy.gap }
            )
          : null;
      const movedZoneIds = new Set(reflowPlan?.movedZoneIds ?? []);
      const movedPlacementById = new Map(
        reflowPlan?.placements
          .filter((item) => movedZoneIds.has(item.id))
          .map((item) => [item.id, item]) ?? []
      );
      const reflowedNodes = sourceNodes.flatMap((node) => {
        const movedZone = movedPlacementById.get(node.id);
        if (node.type === 'zone' && movedZone) {
          return [{ ...node, position: { x: movedZone.x, y: movedZone.y } }];
        }
        if (!isPositionableZoneCanvasNode(node)) return [];
        const sourceZone = sourceZones
          .filter(
            (candidate) => movedZoneIds.has(candidate.id) && nodeCenterInsideZone(node, candidate)
          )
          .sort(
            (left, right) =>
              left.width * left.height - right.width * right.height ||
              left.id.localeCompare(right.id)
          )[0];
        const placement = sourceZone ? movedPlacementById.get(sourceZone.id) : undefined;
        if (!sourceZone || !placement) return [];
        return [
          {
            ...node,
            position: {
              x: node.position.x + placement.x - sourceZone.x,
              y: node.position.y + placement.y - sourceZone.y,
            },
          },
        ];
      });

      // One map for both the change check and the patch loop below. These used
      // to be resolved differently — the check scanned every placement on the
      // board while the patch loop filtered to this zone — so a placement in
      // another zone could answer the "is anything still expanded?" question.
      const placementByNodeId = new Map<string, BoardEntityObject>();
      for (const placement of boardObjectsForBoard) {
        if (placement.zone_id !== zoneId) continue;
        if (placement.branch_id) placementByNodeId.set(placement.branch_id, placement);
        if (placement.card_id) placementByNodeId.set(`card-${placement.card_id}`, placement);
      }

      // Compare planner output with durable geometry, not React Flow's
      // approximate node props. The latter intentionally differ from measured
      // cards/worktrees and are rebuilt after every board realtime event; using
      // them made an already-persisted layout look changed forever.
      const durableEntityGeometryChanged = children.some(({ node, isCanvasObject }) => {
        if (isCanvasObject) return false;
        const durable = placementByNodeId.get(node.id);
        const arranged = placementById.get(node.id);
        if (!durable || !arranged) return false;
        if (!durable.position) return true;
        return (
          Math.abs(durable.position.x - arranged.x) >= 0.5 ||
          Math.abs(durable.position.y - (arranged.y + titleInset)) >= 0.5 ||
          !durable.size ||
          Math.abs(durable.size.width - arranged.width) >= 0.5 ||
          Math.abs(durable.size.height - arranged.height) >= 0.5
        );
      });
      const durableCanvasGeometryChanged = children.some(({ node, isCanvasObject }) => {
        if (!isCanvasObject) return false;
        const durable = currentBoard.objects?.[node.id];
        const arrangedNode = changedNodes.find((candidate) => candidate.id === node.id);
        const arranged = placementById.get(node.id);
        if (!durable || !arrangedNode || !arranged) return false;
        return (
          Math.abs(durable.x - arrangedNode.position.x) >= 0.5 ||
          Math.abs(durable.y - arrangedNode.position.y) >= 0.5 ||
          ('width' in durable && Math.abs(Number(durable.width) - arranged.width) >= 0.5) ||
          ('height' in durable && Math.abs(Number(durable.height) - arranged.height) >= 0.5)
        );
      });

      const compactChanged =
        policy.preset === 'compact_list' &&
        children.some(
          ({ node, isCanvasObject }) =>
            !isCanvasObject &&
            node.type === 'branchNode' &&
            placementByNodeId.get(node.id)?.compact !== true
        );
      if (
        !visualPositionChanged &&
        !durableEntityGeometryChanged &&
        !durableCanvasGeometryChanged &&
        !zoneHeightChanged &&
        !zoneWidthChanged &&
        !compactChanged
      )
        return;
      const changedById = new Map(changedNodes.map((node) => [node.id, node]));
      const reflowedById = new Map(reflowedNodes.map((node) => [node.id, node]));
      const grownZoneNode = sourceNodes.find((node) => node.id === zoneId);
      const optimisticZone =
        grownZoneNode && (zoneHeightChanged || zoneWidthChanged)
          ? {
              ...grownZoneNode,
              width: nextZoneWidth,
              height: nextZoneHeight,
              style: { ...grownZoneNode.style, width: nextZoneWidth, height: nextZoneHeight },
              data: { ...grownZoneNode.data, width: nextZoneWidth, height: nextZoneHeight },
            }
          : undefined;
      const optimisticNodes = [
        ...changedNodes,
        ...reflowedNodes,
        ...(optimisticZone ? [optimisticZone] : []),
      ];
      const optimisticById = new Map(optimisticNodes.map((node) => [node.id, node]));
      const finalNodes = sourceNodes.map((node) => optimisticById.get(node.id) ?? node);
      if (optimisticNodes.length > 0 && options.userInitiated) {
        onArrangeNodes?.(optimisticNodes, timing.totalMs);
      }
      // Positions are an auto-layout output but are also part of the observer
      // signature (so a user's manual move can reflow an automatic zone).
      // Consume exactly the next signature change produced by our own write;
      // otherwise every arrange schedules a redundant second pass 400ms later.
      if (policy.mode === 'auto') skipNextAutoArrangeRef.current.add(zoneId);
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id === zoneId && (zoneHeightChanged || zoneWidthChanged)) {
            return optimisticZone ?? node;
          }
          return changedById.get(node.id) ?? reflowedById.get(node.id) ?? node;
        })
      );

      try {
        const canvasObjects = Object.fromEntries(
          children.flatMap(({ node, isCanvasObject }) => {
            if (!isCanvasObject) return [];
            const arrangedNode = changedById.get(node.id);
            const arranged = placementById.get(node.id);
            const existing = currentBoard.objects?.[node.id];
            if (!arrangedNode || !arranged || !existing) return [];
            const next = {
              ...existing,
              x: arrangedNode.position.x,
              y: arrangedNode.position.y,
              ...('width' in existing ? { width: arranged.width } : {}),
              ...('height' in existing ? { height: arranged.height } : {}),
            } as BoardObject;
            const unchanged =
              Math.abs(existing.x - next.x) < 0.5 &&
              Math.abs(existing.y - next.y) < 0.5 &&
              (!('width' in existing) ||
                !('width' in next) ||
                Math.abs(Number(existing.width) - Number(next.width)) < 0.5) &&
              (!('height' in existing) ||
                !('height' in next) ||
                Math.abs(Number(existing.height) - Number(next.height)) < 0.5);
            if (unchanged) return [];
            return [[node.id, next] as const];
          })
        );
        const reflowedEntries: Array<readonly [string, BoardObject]> = [];
        for (const node of reflowedNodes) {
          const existing = currentBoard.objects?.[node.id];
          if (existing) {
            reflowedEntries.push([
              node.id,
              { ...existing, x: node.position.x, y: node.position.y } as BoardObject,
            ]);
          }
        }
        const reflowedObjects = Object.fromEntries(reflowedEntries);
        const objects = {
          ...(zoneHeightChanged || zoneWidthChanged
            ? { [zoneId]: { ...zone, width: nextZoneWidth, height: nextZoneHeight } }
            : {}),
          ...reflowedObjects,
          ...canvasObjects,
        };
        const placements = Object.fromEntries(
          changedNodes.flatMap((node) => {
            const placement = placementByNodeId.get(node.id);
            if (!placement) return [];
            const arranged = placementById.get(node.id);
            if (!arranged) return [];
            const { width, height } = arranged;
            const nodePositionChanged =
              !placement.position ||
              Math.abs(placement.position.x - node.position.x) >= 0.5 ||
              Math.abs(placement.position.y - node.position.y) >= 0.5;
            const sizeChanged =
              !placement.size ||
              Math.abs(placement.size.width - width) >= 0.5 ||
              Math.abs(placement.size.height - height) >= 0.5;
            const shouldCompact =
              (policy.preset === 'compact_list' || layout.mode === 'deck') &&
              isBoardEntityDensityExpandable(placement.entity_type) &&
              placement.compact !== true;
            if (!nodePositionChanged && !sizeChanged && !shouldCompact) return [];
            return [
              [
                placement.object_id,
                {
                  // applyLayout's placement contract is a complete geometry
                  // snapshot. Supplying only the changed half would serialize
                  // the other required field as undefined in the repository.
                  position: node.position,
                  size: { width, height },
                  ...(shouldCompact ? { compact: true } : {}),
                },
              ] as const,
            ];
          })
        );
        if (Object.keys(objects).length > 0 || Object.keys(placements).length > 0) {
          // Canvas objects, the zone frame, and entity placements form one
          // geometry snapshot. Publishing the existing atomic layout action
          // prevents partial placement echoes from re-arming the observer.
          await client.service('boards').patch(currentBoard.board_id, {
            _action: 'applyLayout',
            objects,
            placements,
          } as unknown as Partial<Board>);
        }
        if (overflowCount > 0 && !options.silent) {
          showWarning(
            `Arranged ${changedNodes.length} items, but ${overflowCount} cannot fit inside this zone.`
          );
        } else if (layoutMode === 'deck' && !options.silent) {
          showWarning(
            `The Auto Zone is full. Stacked ${changedNodes.length} collapsed items with every title and action row exposed.`
          );
        } else if (!options.silent) {
          showSuccess(
            `Arranged ${changedNodes.length} items in a non-overlapping ${layoutMode === 'cluster' ? 'compact cluster' : 'grid'}.`
          );
        }
        completeUserLayout({
          userInitiated: options.userInitiated,
          scope: 'zone',
          beforeNodes: sourceNodes,
          afterNodes: finalNodes,
          affectedNodeIds: [
            zoneId,
            ...children.map(({ node }) => node.id),
            ...reflowedNodes.map((node) => node.id),
          ],
        });
      } catch (error) {
        console.error('Failed to arrange zone contents:', error);
        showError('Failed to arrange zone contents');
      }
    },
    [
      boardObjectsForBoard,
      client,
      completeUserLayout,
      onArrangeNodes,
      restoreZoneCallouts,
      setNodes,
      showError,
      showSuccess,
      showWarning,
    ]
  );
  arrangeZoneContentsRef.current = arrangeZoneContents;

  /**
   * Align a zone's visible heterogeneous rows or columns independently. This
   * is deliberately a one-shot direct edit: an armed Auto Zone is demoted
   * before the optimistic position change, so no pending observer can re-pack
   * it.
   */
  const justifyZoneContents = useCallback(
    async (zoneId: string, justification: ZoneContentJustification) => {
      const currentBoard = boardRef.current;
      const persistedZone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || !client || persistedZone?.type !== 'zone') return;
      const currentNodes = nodesRef.current;
      const liveZoneNode = currentNodes.find((node) => node.id === zoneId);
      const visibleWidth = Number(liveZoneNode?.width ?? liveZoneNode?.style?.width);
      const visibleHeight = Number(liveZoneNode?.height ?? liveZoneNode?.style?.height);
      const liveZoneData = liveZoneNode?.data as { fontSize?: number; status?: string } | undefined;
      const zone = {
        ...persistedZone,
        x: liveZoneNode?.position.x ?? persistedZone.x,
        y: liveZoneNode?.position.y ?? persistedZone.y,
        width:
          Number.isFinite(visibleWidth) && visibleWidth > 0 ? visibleWidth : persistedZone.width,
        height:
          Number.isFinite(visibleHeight) && visibleHeight > 0
            ? visibleHeight
            : persistedZone.height,
        fontSize: liveZoneData?.fontSize ?? persistedZone.fontSize,
        status: liveZoneData?.status ?? persistedZone.status,
      };
      const placementByNodeId = new Map<string, BoardEntityObject>();
      for (const placement of boardObjectsForBoard) {
        if (placement.zone_id !== zoneId) continue;
        if (placement.branch_id) placementByNodeId.set(placement.branch_id, placement);
        if (placement.card_id) placementByNodeId.set(`card-${placement.card_id}`, placement);
      }
      const children = currentNodes.flatMap((node) => {
        const isPinnedEntity =
          node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode');
        const isCanvasObject =
          isPositionableZoneCanvasNode(node) && nodeCenterInsideZone(node, zone);
        if (!isPinnedEntity && !isCanvasObject) return [];
        return [
          {
            node,
            isCanvasObject,
            rect: {
              id: node.id,
              x: isCanvasObject ? node.position.x - zone.x : node.position.x,
              y: isCanvasObject ? node.position.y - zone.y : node.position.y,
              ...ceilBoardGridSize(renderedNodeSize(node)),
            },
          },
        ];
      });
      if (children.length === 0) {
        showWarning('This zone has no contents to justify.');
        return;
      }

      const justified = justifyZoneContentCluster(
        children.map(({ rect }) => rect),
        getZoneLayoutFrame(zone, {
          fontScale: renderedZoneFontScale(zoneId, zone.width),
        }),
        zone.height,
        justification
      );
      if (!justified.fits) {
        showWarning('The contents do not fit on that axis. Resize or tidy the zone first.');
        return;
      }
      const placementById = new Map(justified.placements.map((item) => [item.id, item]));
      const changedNodes = children.flatMap(({ node, isCanvasObject }) => {
        const placement = placementById.get(node.id);
        if (!placement) return [];
        const position = isCanvasObject
          ? { x: zone.x + placement.x, y: zone.y + placement.y }
          : { x: placement.x, y: placement.y };
        if (
          Math.abs(position.x - node.position.x) < 0.5 &&
          Math.abs(position.y - node.position.y) < 0.5
        )
          return [];
        return [{ ...node, position }];
      });
      const label =
        justification === 'middle'
          ? 'center'
          : justification === 'vertical_middle'
            ? 'vertical center'
            : justification;
      if (changedNodes.length === 0) {
        showSuccess(
          justification === 'middle'
            ? 'Contents are already centered in the zone.'
            : justification === 'vertical_middle'
              ? 'Contents are already centered vertically in the zone.'
              : `Contents are already justified to the ${label}.`
        );
        return;
      }
      if (!(await demoteAutoZone(zoneId))) return;

      const changedById = new Map(changedNodes.map((node) => [node.id, node]));
      onArrangeNodes?.(changedNodes, 180);
      setNodes((nodes) => nodes.map((node) => changedById.get(node.id) ?? node));

      try {
        const canvasObjects = Object.fromEntries(
          children.flatMap(({ node, isCanvasObject }) => {
            if (!isCanvasObject) return [];
            const changed = changedById.get(node.id);
            const existing = currentBoard.objects?.[node.id];
            if (!changed || !existing) return [];
            return [
              [node.id, { ...existing, x: changed.position.x, y: changed.position.y }] as const,
            ];
          })
        );
        if (Object.keys(canvasObjects).length > 0) {
          await client.service('boards').patch(currentBoard.board_id, {
            _action: 'batchUpsertObjects',
            objects: canvasObjects,
          } as unknown as Partial<Board>);
        }
        await Promise.all(
          changedNodes.map(async (node) => {
            const placement = placementByNodeId.get(node.id);
            if (!placement) return;
            await client
              .service('board-objects')
              .patch(placement.object_id, { position: node.position });
          })
        );
        completeUserLayout({
          userInitiated: true,
          scope: 'zone',
          beforeNodes: currentNodes,
          afterNodes: currentNodes.map((node) => changedById.get(node.id) ?? node),
          affectedNodeIds: [zoneId, ...children.map(({ node }) => node.id)],
        });
        showSuccess(
          justification === 'vertical_middle'
            ? `Centered ${changedNodes.length} items vertically in the zone.`
            : `Justified ${changedNodes.length} items to the ${label}.`
        );
      } catch (error) {
        console.error('Failed to justify zone contents:', error);
        showError('Failed to justify zone contents');
      }
    },
    [
      boardObjectsForBoard,
      client,
      completeUserLayout,
      demoteAutoZone,
      onArrangeNodes,
      setNodes,
      showError,
      showSuccess,
      showWarning,
    ]
  );

  /** Keep an explicitly dragged/resized Auto Zone frame while its children re-pack. */
  const preserveAutoZoneFrameOnce = useCallback((zoneId: string) => {
    const zone = boardRef.current?.objects?.[zoneId];
    if (zone?.type !== 'zone' || normalizeZoneLayoutPolicy(zone.layout).mode !== 'auto') return;
    preserveNextAutoZoneFrameRef.current.add(zoneId);
  }, []);

  /**
   * Arrange selected zone containers and their measured children using the
   * same pure planner as agor_boards_arrange_zones. Zone containers are one
   * board mutation, so realtime cannot echo intermediate board snapshots.
   */
  const arrangeBoardZones = useCallback(
    async (zoneIds: readonly string[], options: ArrangeBoardZonesOptions = {}) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client || boardArrangementInFlightRef.current) return;
      const { userInitiated = false, layoutScope = 'board', ...arrangementOptions } = options;
      const packZoneContents = arrangementOptions.packZoneContents !== false;
      const selected = new Set(zoneIds);
      const currentNodes = nodesRef.current;
      const placementByNodeId = new Map<string, BoardEntityObject>();
      for (const placement of boardObjectsForBoard) {
        if (placement.branch_id) placementByNodeId.set(placement.branch_id, placement);
        if (placement.card_id) placementByNodeId.set(`card-${placement.card_id}`, placement);
      }

      boardArrangementInFlightRef.current = true;
      setIsBoardArrangementActive(true);
      try {
        const candidates = getBoardArrangementCandidates(currentBoard, currentNodes, selected);
        const selectedZones = candidates.selectedZones.map(
          ([zoneId, object]) =>
            [
              zoneId,
              {
                ...object,
                fontScale: renderedZoneFontScale(zoneId, object.width),
              },
            ] as const
        );
        const { zoneForCanvasNode, looseNodes, fixedObstacles } = candidates;
        const scopedArrangementOptions =
          layoutScope === 'selection' && selectedZones.length > 0
            ? {
                ...arrangementOptions,
                anchorToSelectionBounds: true,
                fixedObstacles,
              }
            : arrangementOptions;
        const plan = planBoardZoneArrangement(
          selectedZones.map(([zoneId, object]) => {
            const children = currentNodes.filter((node) => {
              if (
                node.parentId === zoneId &&
                !node.hidden &&
                node.data?.locked !== true &&
                (node.type === 'branchNode' || node.type === 'cardNode')
              )
                return true;
              return (
                isPositionableZoneCanvasNode(node) && zoneForCanvasNode.get(node.id) === zoneId
              );
            });
            return {
              id: zoneId,
              x: object.x,
              y: object.y,
              width: object.width,
              height: object.height,
              fontSize: object.fontSize,
              fontScale: object.fontScale,
              status: object.status,
              layout: object.layout,
              items: children.map((node) => {
                const isCanvasObject = isPositionableZoneCanvasNode(node);
                const data = node.data as {
                  branch?: {
                    name?: string;
                    created_at?: string;
                    updated_at?: string;
                    filesystem_status?: string;
                  };
                  card?: {
                    title?: string;
                    created_at?: string;
                    updated_at?: string;
                    data?: Record<string, unknown>;
                  };
                };
                const cardData = data.card?.data ?? {};
                const placement = placementByNodeId.get(node.id);
                return {
                  id: node.id,
                  ...(isCanvasObject
                    ? {}
                    : {
                        entityType:
                          node.type === 'branchNode' ? ('branch' as const) : ('card' as const),
                      }),
                  position: isCanvasObject
                    ? { x: node.position.x - object.x, y: node.position.y - object.y }
                    : node.position,
                  compact: placement?.compact,
                  ...ceilBoardGridSize(renderedNodeSize(node)),
                  title: data.card?.title ?? data.branch?.name,
                  createdAt: data.card?.created_at ?? data.branch?.created_at,
                  updatedAt: data.card?.updated_at ?? data.branch?.updated_at,
                  rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
                  priority: cardData.priority,
                  status: cardData.status ?? data.branch?.filesystem_status,
                };
              }),
            };
          }),
          {
            ...scopedArrangementOptions,
            looseItems: (layoutScope === 'board' ? looseNodes : []).map((node) => ({
              id: node.id,
              ...node.position,
              ...ceilBoardGridSize(renderedNodeSize(node)),
            })),
          }
        );
        const arrangedZoneById = new Map(plan.zones.map((zone) => [zone.id, zone]));
        const arrangedCanvasChildren = plan.zones.flatMap((zone) =>
          zone.items.flatMap((item) =>
            currentBoard.objects?.[item.id]
              ? [
                  {
                    ...item,
                    x: zone.position.x + item.x,
                    y: zone.position.y + item.y,
                  },
                ]
              : []
          )
        );
        const arrangedItemById = new Map(
          [
            ...plan.zones.flatMap((zone) =>
              zone.items.filter((item) => !currentBoard.objects?.[item.id])
            ),
            ...arrangedCanvasChildren,
            ...plan.looseItems,
          ].map((item) => [item.id, item] as const)
        );
        const autoSignatureChangesByZoneId = new Map(
          plan.zones.map((zone) => {
            const sourceZone = currentNodes.find((node) => node.id === zone.id);
            const zoneChanged =
              !sourceZone ||
              Math.abs(Number(sourceZone.width ?? sourceZone.style?.width ?? 0) - zone.width) >=
                0.5 ||
              Math.abs(Number(sourceZone.height ?? sourceZone.style?.height ?? 0) - zone.height) >=
                0.5;
            const childChanged = zone.items.some((item) => {
              const source = currentNodes.find((node) => node.id === item.id);
              return (
                !source ||
                Math.abs(source.position.x - item.x) >= 0.5 ||
                Math.abs(source.position.y - item.y) >= 0.5 ||
                Math.abs(Number(source.width ?? source.style?.width ?? 0) - item.width) >= 0.5 ||
                Math.abs(Number(source.height ?? source.style?.height ?? 0) - item.height) >= 0.5
              );
            });
            return [zone.id, zoneChanged || childChanged] as const;
          })
        );
        const arrangedNodes = currentNodes.flatMap((node) => {
          const zone = arrangedZoneById.get(node.id);
          if (zone) {
            autoZoneDeferralRef.current?.cancel(node.id);
            if (autoSignatureChangesByZoneId.get(node.id)) {
              skipNextAutoArrangeRef.current.add(node.id);
            }
            restoreZoneCallouts(node.id);
            return [
              {
                ...node,
                position: zone.position,
                width: zone.width,
                height: zone.height,
                style: { ...node.style, width: zone.width, height: zone.height },
                data: { ...node.data, width: zone.width, height: zone.height },
              },
            ];
          }
          const item = arrangedItemById.get(node.id);
          if (!item) return [];
          return [
            {
              ...node,
              className: node.className
                ?.split(' ')
                .filter((name) => name !== 'auto-zone-stack-item')
                .join(' '),
              position: { x: item.x, y: item.y },
              width: item.width,
              height: item.height,
              style: { ...node.style, width: item.width, height: item.height },
            },
          ];
        });
        const geometryChanged = arrangedNodes.some((next) => {
          const current = currentNodes.find((node) => node.id === next.id);
          if (!current) return true;
          const currentSize = renderedNodeSize(current);
          const nextSize = renderedNodeSize(next);
          return (
            Math.abs(current.position.x - next.position.x) >= 0.5 ||
            Math.abs(current.position.y - next.position.y) >= 0.5 ||
            Math.abs(currentSize.width - nextSize.width) >= 0.5 ||
            Math.abs(currentSize.height - nextSize.height) >= 0.5
          );
        });
        const densityChanged =
          packZoneContents &&
          plan.zones.some((zone) =>
            zone.items.some((item) => {
              const placement = placementByNodeId.get(item.id);
              const zoneObject = currentBoard.objects?.[zone.id];
              const policy = normalizeZoneLayoutPolicy(
                zoneObject?.type === 'zone' ? zoneObject.layout : undefined
              );
              return (
                placement !== undefined &&
                policy.preset === 'compact_list' &&
                isBoardEntityDensityExpandable(placement.entity_type) &&
                placement.compact !== true
              );
            })
          );
        if (!geometryChanged && !densityChanged) {
          showSuccess('Zones and their contents are already arranged.');
          return;
        }
        const arrangedNodeById = new Map(arrangedNodes.map((node) => [node.id, node]));
        setNodes((nodes) => nodes.map((node) => arrangedNodeById.get(node.id) ?? node));
        onArrangeNodes?.(arrangedNodes, dealTiming({ count: arrangedNodes.length }).totalMs);

        const plannedObjects = Object.fromEntries([
          ...plan.zones.map((zone) => {
            const existing = currentBoard.objects?.[zone.id];
            if (existing?.type !== 'zone') {
              throw new Error(`Missing board zone '${zone.id}'.`);
            }
            return [
              zone.id,
              {
                ...existing,
                x: zone.position.x,
                y: zone.position.y,
                width: zone.width,
                height: zone.height,
              },
            ];
          }),
          ...plan.looseItems.flatMap((item) => {
            const existing = currentBoard.objects?.[item.id];
            if (!existing) return [];
            return [
              [
                item.id,
                {
                  ...existing,
                  x: item.x,
                  y: item.y,
                  ...('width' in existing ? { width: item.width } : {}),
                  ...('height' in existing ? { height: item.height } : {}),
                },
              ] as const,
            ];
          }),
          ...arrangedCanvasChildren.flatMap((item) => {
            const existing = currentBoard.objects?.[item.id];
            if (!existing) return [];
            return [
              [
                item.id,
                {
                  ...existing,
                  x: item.x,
                  y: item.y,
                  ...('width' in existing ? { width: item.width } : {}),
                  ...('height' in existing ? { height: item.height } : {}),
                },
              ] as const,
            ];
          }),
        ]);
        const objects = Object.fromEntries(
          Object.entries(plannedObjects).filter(([objectId, next]) => {
            const current = currentBoard.objects?.[objectId];
            return current === undefined || JSON.stringify(current) !== JSON.stringify(next);
          })
        );
        const plannedPlacements = Object.fromEntries(
          [
            ...plan.zones.flatMap((zone) =>
              zone.items.map((item) => {
                const zoneObject = currentBoard.objects?.[zone.id];
                return {
                  item,
                  policy: normalizeZoneLayoutPolicy(
                    zoneObject?.type === 'zone' ? zoneObject.layout : undefined
                  ),
                };
              })
            ),
            ...plan.looseItems.map((item) => ({ item, policy: undefined })),
          ].flatMap(({ item, policy }) => {
            const placement = placementByNodeId.get(item.id);
            if (!placement) return [];
            return [
              [
                placement.object_id,
                {
                  position: { x: item.x, y: item.y },
                  size: { width: item.width, height: item.height },
                  ...(packZoneContents &&
                  policy?.preset === 'compact_list' &&
                  isBoardEntityDensityExpandable(placement.entity_type) &&
                  placement.compact !== true
                    ? { compact: true }
                    : {}),
                },
              ] as const,
            ];
          })
        );
        const placements = Object.fromEntries(
          Object.entries(plannedPlacements).filter(([objectId, next]) => {
            const current = boardObjectsForBoard.find(
              (placement) => placement.object_id === objectId
            );
            return (
              current === undefined ||
              JSON.stringify(current.position) !== JSON.stringify(next.position) ||
              JSON.stringify(current.size) !== JSON.stringify(next.size) ||
              (next.compact !== undefined && next.compact !== current.compact)
            );
          })
        );
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'applyLayout',
          objects,
          placements,
        } as unknown as Partial<Board>);
        completeUserLayout({
          userInitiated,
          scope: layoutScope,
          beforeNodes: currentNodes,
          afterNodes: currentNodes.map((node) => arrangedNodeById.get(node.id) ?? node),
          affectedNodeIds: arrangedNodes.map((node) => node.id),
        });
        showSuccess(
          `Arranged ${plan.zones.length} zone${plan.zones.length === 1 ? '' : 's'}, ${plan.looseItems.length} free item${plan.looseItems.length === 1 ? '' : 's'}, and their contents.`
        );
      } catch (error) {
        console.error('Failed to arrange board zones:', error);
        showError(
          error instanceof LayoutObstacleError
            ? 'The selected layout cannot fit without overlapping fixed board objects.'
            : 'Failed to arrange zones'
        );
      } finally {
        boardArrangementInFlightRef.current = false;
        setIsBoardArrangementActive(false);
      }
    },
    [
      boardObjectsForBoard,
      client,
      completeUserLayout,
      onArrangeNodes,
      restoreZoneCallouts,
      setNodes,
      showError,
      showSuccess,
    ]
  );

  /** Main-toolbar entry into the exact planner used by selected-zone Arrange. */
  const arrangeWholeBoard = useCallback(
    async (packZoneContents = true) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      const { selectedZones, looseNodes } = getBoardArrangementCandidates(
        currentBoard,
        nodesRef.current
      );
      if (selectedZones.length === 0 && looseNodes.length === 0) return;
      await arrangeBoardZones(
        selectedZones.map(([zoneId]) => zoneId),
        { userInitiated: true, layoutScope: 'board', packZoneContents }
      );
    },
    [arrangeBoardZones]
  );

  const currentBoardArrangementCandidates = board
    ? getBoardArrangementCandidates(board, nodes)
    : undefined;
  const canArrangeWholeBoard = Boolean(
    currentBoardArrangementCandidates &&
      (currentBoardArrangementCandidates.selectedZones.length > 0 ||
        currentBoardArrangementCandidates.looseNodes.length > 0)
  );

  runAutoZoneArrangeRef.current = (zoneId: string) => {
    const zone = boardRef.current?.objects?.[zoneId];
    if (
      zone?.type !== 'zone' ||
      normalizeZoneLayoutPolicy(zone.layout).mode !== 'auto' ||
      manuallyControlledZoneIdsRef.current.has(zoneId)
    )
      return;
    restoreZoneCallouts(zoneId);
    const preserveZoneFrame = preserveNextAutoZoneFrameRef.current.delete(zoneId);
    void arrangeZoneContentsRef.current?.(zoneId, { silent: true, preserveZoneFrame });
  };

  useEffect(() => {
    const autoZones = Object.entries(boardObjects ?? {}).flatMap(([objectId, object]) =>
      object.type === 'zone' &&
      normalizeZoneLayoutPolicy(object.layout).mode === 'auto' &&
      !manuallyControlledZoneIdsRef.current.has(objectId)
        ? ([[objectId, object]] as const)
        : []
    );
    if (!client || !ownsAutoZoneObserver) return;
    if (autoZones.length === 0) {
      // Re-arming a zone must tidy even when its contents have not changed
      // since the last time auto mode ran.
      lastAutoLayoutSignaturesRef.current = new Map();
      return;
    }

    const autoZoneForCanvasNode = new Map<string, string>();
    for (const node of nodes) {
      if (!isPositionableZoneCanvasNode(node)) continue;
      const containing = autoZones
        .filter(([, zone]) => nodeCenterInsideZone(node, zone))
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.width * left.height - right.width * right.height || leftId.localeCompare(rightId)
        )[0];
      if (containing) autoZoneForCanvasNode.set(node.id, containing[0]);
    }

    const observerInputs: AutoZoneObserverInput[] = autoZones.map(([zoneId, zone]) => ({
      zoneId,
      width: zone.width,
      height: zone.height,
      layout: zone.layout,
      children: nodes
        .filter((node) => {
          if (node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode'))
            return true;
          return autoZoneForCanvasNode.get(node.id) === zoneId;
        })
        .map((node) => {
          const size = ceilBoardGridSize(renderedNodeSize(node));
          const data = node.data as {
            branch?: {
              name?: string;
              created_at?: string;
              updated_at?: string;
              filesystem_status?: string;
            };
            card?: {
              title?: string;
              created_at?: string;
              updated_at?: string;
              data?: Record<string, unknown>;
            };
          };
          return {
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            width: size.width,
            height: size.height,
            sortData: [
              data.branch?.name,
              data.branch?.created_at,
              data.branch?.updated_at,
              data.branch?.filesystem_status,
              data.card?.title,
              data.card?.created_at,
              data.card?.updated_at,
              data.card?.data?.priority,
              data.card?.data?.rank,
              data.card?.data?.status,
            ],
          };
        }),
    }));
    const observation = changedAutoZoneObserverIds(
      observerInputs,
      lastAutoLayoutSignaturesRef.current
    );
    lastAutoLayoutSignaturesRef.current = observation.signatures;
    if (observation.changedIds.size === 0) return;
    const changedZones = autoZones.filter(([zoneId]) => observation.changedIds.has(zoneId));
    const zonesToArrange = zonesNeedingAutoArrange(changedZones, skipNextAutoArrangeRef.current);
    if (zonesToArrange.length === 0) return;
    for (const [zoneId] of zonesToArrange) {
      autoZoneDeferralRef.current?.schedule(
        zoneId,
        () => runAutoZoneArrangeRef.current(zoneId),
        AUTO_ZONE_BASE_DELAY_MS
      );
    }
  }, [boardObjects, client, nodes, ownsAutoZoneObserver]);

  /**
   * Convert board.objects to React Flow nodes
   */
  const getBoardObjectNodes = useCallback((): Node[] => {
    if (!boardObjects) return [];

    return Object.entries(boardObjects)
      .filter(([, objectData]) => {
        // Filter out objects with invalid positions (prevents NaN errors in React Flow)
        const hasValidPosition =
          typeof objectData.x === 'number' &&
          typeof objectData.y === 'number' &&
          !Number.isNaN(objectData.x) &&
          !Number.isNaN(objectData.y);

        if (!hasValidPosition) {
          console.warn(`Skipping board object with invalid position:`, objectData);
        }

        return hasValidPosition;
      })
      .map(([objectId, objectData]) => {
        // App node (live Sandpack preview)
        if (objectData.type === 'app') {
          return {
            id: objectId,
            type: 'appNode',
            position: { x: objectData.x, y: objectData.y },
            // draggable inherits from canvas-level nodesDraggable (mutationGate.canMutate)
            selectable: true,
            // Above markdown (300), below branches (500) by default.
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.app),
            className: eraserMode ? 'eraser-mode' : undefined,
            data: {
              objectId,
              title: objectData.title,
              description: objectData.description,
              template: objectData.template,
              files: objectData.files,
              dependencies: objectData.dependencies,
              entryFile: objectData.entryFile,
              showEditor: objectData.showEditor,
              showConsole: objectData.showConsole,
              width: objectData.width,
              height: objectData.height,
              onUpdate: handleUpdateObject,
              onDelete: deleteObject,
            },
          };
        }

        // Artifact node (filesystem-backed Sandpack preview)
        if (objectData.type === 'artifact') {
          const isLocked = objectData.locked ?? false;
          return {
            id: objectId,
            type: 'artifactNode',
            position: { x: objectData.x, y: objectData.y },
            // Locked artifacts are never draggable. Unlocked artifacts inherit
            // from canvas-level nodesDraggable (mutationGate.canMutate).
            ...(isLocked ? { draggable: false } : {}),
            selectable: true,
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.artifact),
            className: eraserMode ? 'eraser-mode' : undefined,
            data: {
              objectId,
              artifactId: objectData.artifact_id,
              width: objectData.width,
              height: objectData.height,
              locked: isLocked,
              x: objectData.x,
              y: objectData.y,
              isActiveUrlTarget: objectData.artifact_id === activeUrlTargetArtifactId,
              onUpdate: handleUpdateObject,
              onDeleteArtifact: deleteArtifact,
            },
          };
        }

        // Markdown note node
        if (objectData.type === 'markdown') {
          return {
            id: objectId,
            type: 'markdown',
            position: { x: objectData.x, y: objectData.y },
            // draggable inherits from canvas-level nodesDraggable (mutationGate.canMutate)
            selectable: true,
            // Above zones (100), below branches (500) by default.
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.markdown),
            className: eraserMode ? 'eraser-mode' : undefined,
            data: {
              objectId,
              content: objectData.content,
              width: objectData.width,
              onUpdate: handleUpdateObject,
              onEdit: onEditMarkdown,
              onDelete: deleteObject,
            },
          };
        }

        // Count entities pinned to this zone via board_objects.zone_id.
        // Deliberately avoid subscribing the whole canvas to sessionsByBranch:
        // streaming session patches are high-frequency and should only update
        // the affected BranchCard's per-branch selector, not rebuild every
        // React Flow node on the board.
        let pinnedItemCount = 0;
        let positionableItemCount = 0;
        // Density is a capability, not a synonym for "pinned". Generic cards
        // are positionable but do not own a collapsible secondary surface.
        let densityExpandableItemCount = 0;
        let compactDensityExpandableItemCount = 0;
        if (objectData.type === 'zone') {
          for (const boardObj of boardObjectsForBoard) {
            if (boardObj.zone_id === objectId && (boardObj.branch_id || boardObj.card_id)) {
              pinnedItemCount += 1;
              positionableItemCount += 1;
              if (isBoardEntityDensityExpandable(boardObj.entity_type)) {
                densityExpandableItemCount += 1;
                if (boardObj.compact === true) compactDensityExpandableItemCount += 1;
              }
            }
          }
          positionableItemCount += nodesRef.current.filter(
            (node) => isPositionableZoneCanvasNode(node) && nodeCenterInsideZone(node, objectData)
          ).length;
        }

        // Zone node
        const isLocked = objectData.type === 'zone' ? objectData.locked : false;
        return {
          id: objectId,
          type: 'zone',
          position: { x: objectData.x, y: objectData.y },
          // Locked zones are never draggable. Unlocked zones inherit from
          // canvas-level nodesDraggable (mutationGate.canMutate).
          ...(isLocked ? { draggable: false } : {}),
          // Zones behind branches and comments by default; honor explicit order.
          zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone),
          className: eraserMode ? 'eraser-mode' : undefined,
          // Set dimensions both as direct props (for collision detection) and style (for rendering)
          width: objectData.width,
          height: objectData.height,
          style: {
            width: objectData.width,
            height: objectData.height,
          },
          data: {
            objectId,
            label: objectData.type === 'zone' ? objectData.label : '',
            width: objectData.width,
            height: objectData.height,
            borderColor: objectData.type === 'zone' ? objectData.borderColor : undefined,
            backgroundColor: objectData.type === 'zone' ? objectData.backgroundColor : undefined,
            color: objectData.color, // Backwards compatibility
            status: objectData.type === 'zone' ? objectData.status : undefined,
            locked: isLocked,
            fontSize: objectData.type === 'zone' ? objectData.fontSize : undefined,
            // Effective base zIndex (persisted or per-type default). Consumed by
            // the selection-bump logic in SessionCanvas so a selected zone
            // restores to its own order on deselect.
            zIndex: sanitizeZIndex(objectData.zIndex, DEFAULT_BOARD_OBJECT_Z_INDEX.zone),
            x: objectData.x, // Include position in data for updates
            y: objectData.y,
            trigger: objectData.type === 'zone' ? objectData.trigger : undefined,
            layout: objectData.type === 'zone' ? objectData.layout : undefined,
            pinnedItemCount,
            positionableItemCount,
            densityExpandableItemCount,
            compactDensityExpandableItemCount,
            onUpdate: handleUpdateObject,
            onDelete: deleteZone,
            onReorder: reorderObject,
            onArrangeContents: (zoneId: string) =>
              arrangeZoneContents(zoneId, { userInitiated: true }),
            onJustifyContents: justifyZoneContents,
            onSetContentsCompact: setZoneContentsCompact,
          },
        };
      });
  }, [
    boardObjects,
    boardObjectsForBoard,
    handleUpdateObject,
    deleteZone,
    deleteObject,
    deleteArtifact,
    reorderObject,
    arrangeZoneContents,
    justifyZoneContents,
    setZoneContentsCompact,
    eraserMode,
    activeUrlTargetArtifactId,
    onEditMarkdown,
  ]);

  /**
   * Add a zone node at the specified position
   */
  const addZoneNode = useCallback(
    async (x: number, y: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      const objectId = `zone-${Date.now()}`;
      const width = 400;
      const height = 600;

      // Optimistic update
      setNodes((nodes) => [
        ...nodes,
        {
          id: objectId,
          type: 'zone',
          position: { x, y },
          // draggable inherits from canvas-level nodesDraggable (mutationGate.canMutate)
          zIndex: DEFAULT_BOARD_OBJECT_Z_INDEX.zone, // Zones behind branches and comments
          style: {
            width,
            height,
          },
          data: {
            objectId,
            label: 'New Zone',
            width,
            height,
            color: undefined, // Will use theme default (colorBorder)
            onUpdate: handleUpdateObject,
          },
        },
      ]);

      // Persist atomically
      try {
        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'upsertObject',
          objectId,
          objectData: {
            type: 'zone',
            x,
            y,
            width,
            height,
            label: 'New Zone',
            // No color specified - will use theme default
          },
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to add zone node:', error);
        // Rollback
        setNodes((nodes) => nodes.filter((n) => n.id !== objectId));
      }
    },
    [client, setNodes, handleUpdateObject] // Removed board dependency
  );

  /**
   * Batch update positions for board objects after drag
   */
  const batchUpdateObjectPositions = useCallback(
    async (updates: Record<string, { x: number; y: number; width?: number; height?: number }>) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client || Object.keys(updates).length === 0) return;

      try {
        // Build objects payload with full object data + new positions
        const objects: Record<string, BoardObject> = {};

        for (const [objectId, position] of Object.entries(updates)) {
          // Skip objects that have been deleted locally
          if (deletedObjectsRef.current.has(objectId)) {
            continue;
          }

          const existingObject = currentBoard.objects?.[objectId];
          if (!existingObject) continue;

          objects[objectId] = {
            ...existingObject,
            x: position.x,
            y: position.y,
            ...(position.width === undefined ? {} : { width: position.width }),
            ...(position.height === undefined ? {} : { height: position.height }),
          } as BoardObject;
        }

        if (Object.keys(objects).length === 0) {
          return;
        }

        await client.service('boards').patch(currentBoard.board_id, {
          _action: 'batchUpsertObjects',
          objects,
        } as unknown as Partial<Board>);
      } catch (error) {
        console.error('Failed to persist object positions:', error);
      }
    },
    [client, deletedObjectsRef] // Removed board dependency
  );

  return {
    getBoardObjectNodes,
    handleUpdateObject,
    addZoneNode,
    deleteObject,
    deleteZone,
    reorderObject,
    demoteAutoZone,
    deferAutoZone,
    setPlacementCompact,
    setZoneContentsCompact,
    justifyZoneContents,
    arrangeBoardZones,
    arrangeWholeBoard,
    canArrangeWholeBoard,
    isBoardArrangementActive,
    preserveAutoZoneFrameOnce,
    batchUpdateObjectPositions,
    zoneStackByNodeId,
    calledOutNodeIds,
    calledOutZoneStackZIndex: CALLED_OUT_ZONE_STACK_Z_INDEX,
  };
};
