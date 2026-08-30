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
  it('finds every partially intersected node in absolute board coordinates', () => {
    const inside = getNodesInsideMarquee(nodes, { x: 130, y: 160, width: 360, height: 80 });
    expect(inside.map((node) => node.id)).toEqual(['zone-1', 'branch-1', 'card-1']);
  });

  it('can ignore the origin zone surface while selecting its intersected children', () => {
    const selected = getMarqueeSelection(
      nodes,
      { x: 130, y: 160, width: 360, height: 80 },
      new Set(),
      false,
      new Set(['zone-1'])
    );
    expect([...selected]).toEqual(['branch-1', 'card-1']);
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
      true,
      new Set(['zone-1'])
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

  it.each(['branchNode', 'cardNode', 'zone', 'markdown', 'appNode', 'artifactNode'])(
    'selects a partially intersected %s entity',
    (type) => {
      const entity: Node = {
        id: type,
        type,
        position: { x: 100, y: 100 },
        width: 100,
        height: 100,
        data: {},
      };
      expect(
        getNodesInsideMarquee([entity], { x: 190, y: 190, width: 20, height: 20 }).map(
          (node) => node.id
        )
      ).toEqual([type]);
    }
  );

  it('excludes zero-area edge/corner touches and zero-area marquees', () => {
    const entity: Node = {
      id: 'note',
      type: 'markdown',
      position: { x: 100, y: 100 },
      width: 100,
      height: 100,
      data: {},
    };
    expect(getNodesInsideMarquee([entity], { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
    expect(getNodesInsideMarquee([entity], { x: 0, y: 120, width: 100, height: 20 })).toEqual([]);
    expect(getNodesInsideMarquee([entity], { x: 120, y: 0, width: 20, height: 100 })).toEqual([]);
    expect(getNodesInsideMarquee([entity], { x: 200, y: 200, width: 20, height: 20 })).toEqual([]);
    expect(getNodesInsideMarquee([entity], { x: 100, y: 100, width: 0, height: 20 })).toEqual([]);
  });

  it.each([
    ['hidden', { hidden: true }],
    ['locked', { data: { locked: true } }],
    ['non-selectable', { selectable: false }],
    ['non-draggable', { draggable: false }],
  ])('excludes %s entities from marquee selection', (_label, overrides) => {
    const entity: Node = {
      id: 'artifact',
      type: 'artifactNode',
      position: { x: 100, y: 100 },
      width: 100,
      height: 100,
      data: {},
      ...overrides,
    };
    expect(getNodesInsideMarquee([entity], { x: 90, y: 90, width: 120, height: 120 })).toEqual([]);
  });
});
