import { describe, expect, it } from 'vitest';
import { translateTrackedChildPositions } from './coordinateTransforms';

describe('translateTrackedChildPositions', () => {
  it('moves only optimistic direct children by the parent delta', () => {
    const tracked = {
      worktree: { x: 140, y: 180 },
      unrelated: { x: 900, y: 900 },
    };

    expect(
      translateTrackedChildPositions(
        [
          { id: 'worktree', parentId: 'zone' },
          { id: 'untracked', parentId: 'zone' },
          { id: 'unrelated', parentId: 'other-zone' },
        ],
        'zone',
        { x: 100, y: 100 },
        { x: 180, y: 140 },
        tracked
      )
    ).toBe(1);
    expect(tracked).toEqual({
      worktree: { x: 220, y: 220 },
      unrelated: { x: 900, y: 900 },
    });
  });

  it('is a no-op when an alignment event repeats the accepted parent position', () => {
    const tracked = { worktree: { x: 220, y: 220 } };
    expect(
      translateTrackedChildPositions(
        [{ id: 'worktree', parentId: 'zone' }],
        'zone',
        { x: 180, y: 140 },
        { x: 180, y: 140 },
        tracked
      )
    ).toBe(0);
    expect(tracked.worktree).toEqual({ x: 220, y: 220 });
  });
});
