import type { Node } from 'reactflow';
import { getVisibleSelectableNodeRect } from './boardNodeGeometry';

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LAYOUT_NODE_TYPES = new Set([
  'zone',
  'branchNode',
  'cardNode',
  'markdown',
  'appNode',
  'artifactNode',
]);

/**
 * Return every eligible node with a positive-area overlap with the marquee.
 * Strict inequalities intentionally exclude an edge/corner touch. Selecting a
 * container still suppresses its descendants in `getMarqueeSelection`.
 */
export function getNodesInsideMarquee(nodes: Node[], rect: SelectionRect): Node[] {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  if (right <= left || bottom <= top) return [];

  return nodes.filter((node) => {
    const nodeRect = getVisibleSelectableNodeRect(node, nodes);
    if (!nodeRect) return false;
    return (
      nodeRect.x < right &&
      nodeRect.x + nodeRect.width > left &&
      nodeRect.y < bottom &&
      nodeRect.y + nodeRect.height > top
    );
  });
}

/**
 * A selected container owns its selected descendants. Removing descendants
 * prevents a zone and its children from being moved twice during group drag.
 */
export function removeSelectedDescendants(nodes: Node[], selectedIds: Set<string>): Set<string> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Set(selectedIds);

  for (const id of selectedIds) {
    let parentId = nodeById.get(id)?.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (selectedIds.has(parentId)) {
        result.delete(id);
        break;
      }
      visited.add(parentId);
      parentId = nodeById.get(parentId)?.parentId;
    }
  }

  return result;
}

export function getMarqueeSelection(
  nodes: Node[],
  rect: SelectionRect,
  initialSelectedIds: ReadonlySet<string>,
  additive: boolean,
  excludedIds: ReadonlySet<string> = new Set()
): Set<string> {
  const selected = additive ? new Set(initialSelectedIds) : new Set<string>();
  for (const node of getNodesInsideMarquee(nodes, rect)) {
    if (!excludedIds.has(node.id)) selected.add(node.id);
  }
  return removeSelectedDescendants(nodes, selected);
}

/** Nodes that support the existing align/arrange/size persistence contract. */
export function getSelectedLayoutNodes(nodes: Node[]): Node[] {
  const eligibleIds = new Set(
    nodes
      .filter(
        (node) =>
          node.selected &&
          !node.hidden &&
          node.selectable !== false &&
          LAYOUT_NODE_TYPES.has(node.type ?? '') &&
          node.data?.locked !== true
      )
      .map((node) => node.id)
  );
  const rootIds = removeSelectedDescendants(nodes, eligibleIds);
  return nodes.filter((node) => rootIds.has(node.id));
}
