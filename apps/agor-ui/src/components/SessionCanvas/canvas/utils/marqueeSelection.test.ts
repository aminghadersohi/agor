import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';
import {
  getMarqueeSelection,
  getNodesInsideMarquee,
  getSelectedLayoutNodes,
  removeSelectedDescendants,
} from './marqueeSelection';

const nodes: Node[] = [
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
  {
    id: 'note-1',
    type: 'markdown',
    position: { x: 800, y: 100 },
    width: 200,
    height: 150,
    data: {},
  },
];

describe('marquee selection', () => {
  it('selects zone children in absolute board coordinates without selecting the containing zone', () => {
    const inside = getNodesInsideMarquee(nodes, { x: 130, y: 160, width: 480, height: 160 });
    expect(inside.map((node) => node.id)).toEqual(['branch-1', 'card-1']);
  });

  it('selects a whole zone as one hierarchy instead of also selecting its descendants', () => {
    const selected = getMarqueeSelection(
      nodes,
      { x: 90, y: 90, width: 620, height: 520 },
      new Set(),
      false
    );
    expect([...selected]).toEqual(['zone-1']);
  });

  it('preserves an existing selection for modifier-drag marquee', () => {
    const selected = getMarqueeSelection(
      nodes,
      { x: 130, y: 160, width: 220, height: 150 },
      new Set(['note-1']),
      true
    );
    expect([...selected]).toEqual(['note-1', 'branch-1']);
  });

  it('removes descendants when their selected parent is selected', () => {
    expect([...removeSelectedDescendants(nodes, new Set(['zone-1', 'card-1']))]).toEqual([
      'zone-1',
    ]);
  });

  it('keeps eligible selected children available to layout actions', () => {
    const selectedNodes = nodes.map((node) => ({
      ...node,
      selected: node.id === 'branch-1' || node.id === 'card-1',
    }));
    expect(getSelectedLayoutNodes(selectedNodes).map((node) => node.id)).toEqual([
      'branch-1',
      'card-1',
    ]);
  });
});
