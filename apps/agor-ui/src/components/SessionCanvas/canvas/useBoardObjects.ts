/**
 * Hook for managing board objects (text labels, zones, etc.)
 */

import { layoutRectangles } from '@agor/core/layout/rectangle-packing';
import {
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  type ZoneLayoutSortItem,
} from '@agor/core/layout/zone-layout';
import type { AgorClient, Board, BoardEntityObject, BoardObject } from '@agor-live/client';
import { useCallback, useEffect, useRef } from 'react';
import type { Node } from 'reactflow';
import { useThemedMessage } from '../../../utils/message';

// Long enough for the expanded cards to paint before the re-pack measures
// them; short enough that the board does not visibly sit in a broken state.
const EXPANDED_REPACK_DELAY_MS = 400;
function zoneContentTopInset(zone: { fontSize?: number; status?: string }): number {
  const labelFontSize =
    typeof zone.fontSize === 'number' && Number.isFinite(zone.fontSize)
      ? Math.min(48, Math.max(10, zone.fontSize))
      : 14;
  const labelHeight = Math.ceil(labelFontSize * 1.2);
  const statusHeight = zone.status ? 8 + Math.ceil(labelFontSize * 1.05) : 0;

  return Math.max(64, 32 + labelHeight + statusHeight);
}

import type { ReactFlowNode } from './utils/reactFlowTypes';
import {
  computeLayerChanges,
  DEFAULT_BOARD_OBJECT_Z_INDEX,
  type LayerOp,
  sanitizeZIndex,
} from './zOrder';

function renderedNodeSize(node: Node): { width: number; height: number } {
  const measured = (node as ReactFlowNode).measured;
  const fallback = {
    width: Number(measured?.width ?? node.width ?? node.style?.width ?? 380),
    height: Number(measured?.height ?? node.height ?? node.style?.height ?? 120),
  };

  if (typeof document === 'undefined') return fallback;
  const element = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
  ).find((candidate) => candidate.dataset.id === node.id);
  if (!element) return fallback;

  const width = Math.max(element.offsetWidth, element.scrollWidth);
  const height = Math.max(element.offsetHeight, element.scrollHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : fallback.width,
    height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : fallback.height,
  };
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
  onSessionClick?: (sessionId: string) => void;
  currentUserId?: string;
}

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
  onSessionClick,
  currentUserId,
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
    ((zoneId: string, options?: { silent?: boolean }) => Promise<void>) | null
  >(null);
  const autoArrangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoLayoutSignatureRef = useRef('');

  // Use the board object's reference directly. The store already preserves
  // unchanged board references, and serializing every object on every canvas
  // render is prohibitively expensive on large boards.
  const boardObjects = board?.objects;

  /**
   * Collapse or expand every card/worktree pinned to a zone. This is the UI
   * half of `agor_boards_set_compact` with a `zoneId`: same targeting (pinned
   * entity placements only), same idempotence (placements already at the
   * requested density are skipped rather than re-patched).
   */
  const setZoneContentsCompact = useCallback(
    async (zoneId: string, compact: boolean, options: { silent?: boolean } = {}) => {
      if (!client) return;
      const targets = boardObjectsForBoard.filter(
        (placement) =>
          placement.zone_id === zoneId &&
          (placement.branch_id || placement.card_id) &&
          (placement.compact === true) !== compact
      );
      if (targets.length === 0) return;

      try {
        await Promise.all(
          targets.map((placement) =>
            client.service('board-objects').patch(placement.object_id, { compact })
          )
        );
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
    [boardObjectsForBoard, client, showError, showSuccess]
  );

  /**
   * Update an existing board object
   */
  const handleUpdateObject = useCallback(
    async (objectId: string, objectData: BoardObject) => {
      const currentBoard = boardRef.current;
      if (!currentBoard || !client) return;

      // Leaving `compact_list` is the one moment we can be certain a collapse
      // was the preset's doing rather than the user's: the preset collapsed
      // every item on the way in, so it owes them an expand on the way out.
      // Deliberately keyed to the preset *transition* and not to arranging in
      // grid — an automatic grid zone reflows on every session change, and
      // expanding there would repeatedly stomp collapses the user made by hand
      // with the per-card control.
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
          await setZoneContentsCompact(objectId, false, { silent: true });
          // The positions still carry compact_list's one-row spacing, so the
          // cards we just restored to full height would overlap. Re-pack once
          // they have actually rendered — the layout measures the DOM, so
          // arranging before the expanded cards paint would measure the
          // collapsed heights and pack just as tightly. An automatic zone
          // reflows on its own, but a manual one has nothing else to fix this.
          setTimeout(() => {
            void arrangeZoneContentsRef.current?.(objectId, { silent: true });
          }, EXPANDED_REPACK_DELAY_MS);
        }
      } catch (error) {
        console.error('Failed to update object:', error);
      }
    },
    [client, setZoneContentsCompact] // Board is read through boardRef, not a dep
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
    async (zoneId: string, options: { silent?: boolean } = {}) => {
      const currentBoard = boardRef.current;
      const zone = currentBoard?.objects?.[zoneId];
      if (!currentBoard || !client || zone?.type !== 'zone') return;

      let changedNodes: Node[] = [];
      let layoutMode: 'grid' | 'deck' = 'grid';
      let overflowCount = 0;

      const policy = normalizeZoneLayoutPolicy(zone.layout);
      const sortItem = (node: Node): ZoneLayoutSortItem & { node: Node } => {
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
          id: node.id,
          position: node.position,
          title: data.card?.title ?? data.branch?.name,
          createdAt: data.card?.created_at ?? data.branch?.created_at,
          updatedAt: data.card?.updated_at ?? data.branch?.updated_at,
          rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
          priority: cardData.priority,
          status: cardData.status ?? data.branch?.filesystem_status,
        };
      };
      const children = sortZoneLayoutItems(
        nodesRef.current
          .filter(
            (node) =>
              node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode')
          )
          .map(sortItem),
        policy
      ).map(({ node }) => node);
      if (children.length === 0) {
        if (!options.silent) showWarning('This zone has no pinned items to arrange.');
        return;
      }

      const itemSize = renderedNodeSize;
      const layout = layoutRectangles(
        children.map((node) => ({
          id: node.id,
          ...(policy.preset === 'compact_list'
            ? {
                width: node.type === 'branchNode' ? 500 : 380,
                height: node.type === 'branchNode' ? 88 : 56,
              }
            : itemSize(node)),
        })),
        {
          // Zone labels/status render within the zone above their children.
          // Reserve that header before packing so an arranged card never
          // obscures the zone title.
          bounds: {
            width: zone.width,
            height: policy.autoResizeHeight
              ? Number.MAX_SAFE_INTEGER
              : Math.max(0, zone.height - zoneContentTopInset(zone)),
          },
          padding: 24,
          minPadding: 8,
          gapX: policy.gap ?? 24,
          gapY: policy.gap ?? 24,
          minGapX: 8,
          minGapY: 8,
          ...(policy.preset === 'compact_list'
            ? { exactColumns: 1 }
            : { preferredColumns: policy.columns ?? Math.ceil(Math.sqrt(children.length)) }),
          allowDeck: false,
        }
      );
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
      const titleInset = zoneContentTopInset(zone);
      changedNodes = children.map((node) => {
        const placement = placementById.get(node.id);
        return placement
          ? { ...node, position: { x: placement.x, y: placement.y + titleInset } }
          : node;
      });
      const positionChanged = changedNodes.some((node) => {
        const current = children.find((child) => child.id === node.id);
        return (
          !current ||
          Math.abs(current.position.x - node.position.x) >= 0.5 ||
          Math.abs(current.position.y - node.position.y) >= 0.5
        );
      });
      const nextZoneHeight = policy.autoResizeHeight
        ? Math.max(200, Math.ceil(layout.height + titleInset))
        : zone.height;
      const zoneHeightChanged = Math.abs(nextZoneHeight - zone.height) >= 0.5;
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

      const compactChanged =
        policy.preset === 'compact_list' &&
        children.some((node) => placementByNodeId.get(node.id)?.compact !== true);
      if (!positionChanged && !zoneHeightChanged && !compactChanged) return;
      const changedById = new Map(changedNodes.map((node) => [node.id, node]));
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id === zoneId && zoneHeightChanged) {
            return {
              ...node,
              height: nextZoneHeight,
              style: { ...node.style, height: nextZoneHeight },
              data: { ...node.data, height: nextZoneHeight },
            };
          }
          return changedById.get(node.id) ?? node;
        })
      );

      if (changedNodes.length === 0) return;

      try {
        if (zoneHeightChanged) {
          await client.service('boards').patch(currentBoard.board_id, {
            _action: 'upsertObject',
            objectId: zoneId,
            objectData: { ...zone, height: nextZoneHeight },
          } as unknown as Partial<Board>);
        }
        await Promise.all(
          changedNodes.map(async (node) => {
            const placement = placementByNodeId.get(node.id);
            if (!placement) return;
            const { width, height } =
              policy.preset === 'compact_list'
                ? {
                    width: node.type === 'branchNode' ? 500 : 380,
                    height: node.type === 'branchNode' ? 88 : 56,
                  }
                : itemSize(node);
            if (policy.preset === 'compact_list' && placement.compact !== true) {
              await client.service('board-objects').patch(placement.object_id, { compact: true });
            }
            if (positionChanged) {
              await client.service('board-objects').patch(placement.object_id, {
                position: node.position,
              });
            }
            await client.service('board-objects').patch(placement.object_id, {
              size: { width, height },
            });
          })
        );
        if (overflowCount > 0) {
          showWarning(
            `Arranged ${changedNodes.length} items, but ${overflowCount} cannot fit inside this zone.`
          );
        } else if (layoutMode === 'deck') {
          showWarning(
            `The zone is too small for a non-overlapping grid. Arranged ${changedNodes.length} items in compact decks.`
          );
        } else if (!options.silent) {
          showSuccess(`Arranged ${changedNodes.length} items in a non-overlapping grid.`);
        }
      } catch (error) {
        console.error('Failed to arrange zone contents:', error);
        showError('Failed to arrange zone contents');
      }
    },
    [boardObjectsForBoard, client, setNodes, showError, showSuccess, showWarning]
  );
  arrangeZoneContentsRef.current = arrangeZoneContents;

  useEffect(() => {
    const autoZones = Object.entries(boardObjects ?? {}).flatMap(([objectId, object]) =>
      object.type === 'zone' && normalizeZoneLayoutPolicy(object.layout).mode === 'auto'
        ? ([[objectId, object]] as const)
        : []
    );
    if (!client || autoZones.length === 0) return;

    const signature = autoZones
      .map(([zoneId, zone]) => {
        const children = nodes
          .filter(
            (node) =>
              node.parentId === zoneId && (node.type === 'branchNode' || node.type === 'cardNode')
          )
          .map((node) => {
            const measured = (node as ReactFlowNode).measured;
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
            return [
              node.id,
              node.position.x,
              node.position.y,
              measured?.width ?? node.width,
              measured?.height ?? node.height,
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
            ];
          });
        return [zoneId, zone.width, zone.height, zone.layout, children];
      })
      .map((value) => JSON.stringify(value))
      .join('|');
    if (signature === lastAutoLayoutSignatureRef.current) return;
    lastAutoLayoutSignatureRef.current = signature;
    if (autoArrangeTimerRef.current) clearTimeout(autoArrangeTimerRef.current);
    autoArrangeTimerRef.current = setTimeout(() => {
      void Promise.all(autoZones.map(([zoneId]) => arrangeZoneContents(zoneId, { silent: true })));
    }, 400);
    return () => {
      if (autoArrangeTimerRef.current) clearTimeout(autoArrangeTimerRef.current);
    };
  }, [arrangeZoneContents, boardObjects, client, nodes]);

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
              onOpenSession: onSessionClick,
              client,
              currentUserId,
              boardId: board?.board_id,
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
        // Tracked alongside the pinned count so the zone toolbar can derive
        // whether its density button should collapse or expand.
        let compactItemCount = 0;
        if (objectData.type === 'zone') {
          for (const boardObj of boardObjectsForBoard) {
            if (boardObj.zone_id === objectId && (boardObj.branch_id || boardObj.card_id)) {
              pinnedItemCount += 1;
              if (boardObj.compact === true) compactItemCount += 1;
            }
          }
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
            compactItemCount,
            onUpdate: handleUpdateObject,
            onDelete: deleteZone,
            onReorder: reorderObject,
            onArrangeContents: arrangeZoneContents,
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
    setZoneContentsCompact,
    eraserMode,
    activeUrlTargetArtifactId,
    onSessionClick,
    currentUserId,
    onEditMarkdown,
    client,
    board?.board_id,
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
    async (updates: Record<string, { x: number; y: number }>) => {
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
          };
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
    setZoneContentsCompact,
    batchUpdateObjectPositions,
  };
};
