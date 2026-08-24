import { describe, expect, it } from 'vitest';
import {
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  type ZoneLayoutSortItem,
} from './zone-layout';

const item = (id: string, overrides: Partial<ZoneLayoutSortItem> = {}) => ({
  id,
  position: { x: 0, y: 0 },
  ...overrides,
});

describe('normalizeZoneLayoutPolicy', () => {
  it('keeps legacy zones manual and sanitizes persisted values', () => {
    expect(normalizeZoneLayoutPolicy(undefined)).toMatchObject({
      mode: 'manual',
      preset: 'grid',
      sortBy: 'position',
      sortDirection: 'asc',
      autoResizeHeight: false,
    });
    expect(normalizeZoneLayoutPolicy({ mode: 'auto', columns: 2.9 })).toMatchObject({
      mode: 'auto',
      columns: 2,
    });
  });
});

describe('sortZoneLayoutItems', () => {
  it('sorts urgent and ranked work first while leaving missing priority last', () => {
    const result = sortZoneLayoutItems(
      [
        item('missing'),
        item('low', { priority: 'low' }),
        item('urgent', { priority: 'urgent' }),
        item('ranked', { rank: -1 }),
      ],
      { sortBy: 'priority', sortDirection: 'asc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['ranked', 'urgent', 'low', 'missing']);
  });

  it('sorts latest first without pulling missing timestamps forward', () => {
    const result = sortZoneLayoutItems(
      [
        item('missing'),
        item('older', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        item('newer', { updatedAt: '2026-02-01T00:00:00.000Z' }),
      ],
      { sortBy: 'updated', sortDirection: 'desc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['newer', 'older', 'missing']);
  });

  it('keeps unknown workflow labels after known statuses in descending order', () => {
    const result = sortZoneLayoutItems(
      [
        item('custom', { status: 'someday' }),
        item('urgent', { status: 'urgent' }),
        item('done', { status: 'done' }),
      ],
      { sortBy: 'status', sortDirection: 'desc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['done', 'urgent', 'custom']);
  });

  it('uses spatial order for manual sorting and stable ids for ties', () => {
    const result = sortZoneLayoutItems(
      [item('c', { position: { x: 0, y: 10 } }), item('b'), item('a')],
      { sortBy: 'position', sortDirection: 'asc' }
    );
    expect(result.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });
});
