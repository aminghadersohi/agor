import { describe, expect, it } from 'vitest';
import { snapRectToPeers } from './layoutGuides';

describe('snapRectToPeers', () => {
  it('snaps edges and centers to nearby peers', () => {
    const result = snapRectToPeers({ id: 'moving', x: 101, y: 199, width: 100, height: 50 }, [
      { id: 'peer', x: 0, y: 0, width: 100, height: 200 },
    ]);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(result.guides).toEqual([
      { orientation: 'vertical', offset: 100 },
      { orientation: 'horizontal', offset: 200 },
    ]);
  });

  it('does not move when no alignment is close enough', () => {
    expect(
      snapRectToPeers({ id: 'moving', x: 300, y: 300, width: 100, height: 50 }, [
        { id: 'peer', x: 0, y: 0, width: 100, height: 100 },
      ])
    ).toEqual({ x: 300, y: 300, guides: [] });
  });
});
