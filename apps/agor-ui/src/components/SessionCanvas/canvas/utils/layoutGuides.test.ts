import { describe, expect, it } from 'vitest';
import { snapRectToPeers } from './layoutGuides';

describe('snapRectToPeers', () => {
  it('snaps edges and centers to nearby peers', () => {
    const result = snapRectToPeers({ id: 'moving', x: 101, y: 199, width: 100, height: 50 }, [
      { id: 'peer', x: 0, y: 0, width: 100, height: 200 },
    ]);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(result.guides).toEqual(
      expect.arrayContaining([
        { orientation: 'vertical', offset: 100 },
        { orientation: 'horizontal', offset: 200 },
      ])
    );
  });

  it('does not move when no alignment is close enough', () => {
    const result = snapRectToPeers({ id: 'moving', x: 300, y: 300, width: 100, height: 50 }, [
      { id: 'peer', x: 0, y: 0, width: 100, height: 100 },
    ]);
    expect(result).toMatchObject({ x: 300, y: 300 });
    expect(result.guides).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'size', label: '100px wide' })])
    );
  });

  it('shows equal-size and equal-gap indicators while moving between peers', () => {
    const result = snapRectToPeers({ id: 'moving', x: 100, y: 100, width: 100, height: 50 }, [
      { id: 'left', x: 0, y: 100, width: 76, height: 50 },
      { id: 'right', x: 224, y: 100, width: 100, height: 50 },
    ]);

    expect(result.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'size', label: '100px wide' }),
        expect.objectContaining({ kind: 'size', label: '50px high' }),
        expect.objectContaining({ kind: 'gap', label: '24px gap' }),
      ])
    );
  });
});
