import type { Node } from 'reactflow';
import { getNodeAbsolutePosition } from './coordinateTransforms';

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

function nodeSize(node: Node): { width: number; height: number } {
  return {
    width: Number(node.width ?? node.style?.width ?? 0),
    height: Number(node.height ?? node.style?.height ?? 0),
  };
}

/**
 * Return nodes wholly enclosed by a marquee. Full containment keeps a marquee
 * drawn inside a zone from selecting the zone itself while still selecting its
 * children. This is the container behavior users expect from design tools.
 */
export function getNodesInsideMarquee(nodes: Node[], rect: SelectionRect): Node[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  return nodes.filter((node) => {
    if (node.hidden || node.selectable === false) return false;
    const { width, height } = nodeSize(node);
    if (width <= 0 || height <= 0) return false;
    const position = getNodeAbsolutePosition(node, nodes);
    return (
      position.x >= rect.x &&
      position.y >= rect.y &&
      position.x + width <= right &&
      position.y + height <= bottom
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
  additive: boolean
): Set<string> {
  const selected = additive ? new Set(initialSelectedIds) : new Set<string>();
  for (const node of getNodesInsideMarquee(nodes, rect)) selected.add(node.id);
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
