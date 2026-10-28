import { describe, expect, it } from 'vitest';
import type { ZoneBoardObject, ZoneLayoutPolicy } from '../types/board';
import { normalizeZoneLayoutPolicy } from './zone-layout';
import {
  arrangedZoneLayout,
  arrangedZoneShownSize,
  resolveZoneLayoutWrite,
} from './zone-layout-arrangement';

const autoPolicy: ZoneLayoutPolicy = {
  mode: 'auto',
  preset: 'compact_list',
  sortBy: 'updated',
  sortDirection: 'desc',
  resize: 'height',
  onOverflow: 'reflow_board',
};

function zone(overrides: Partial<ZoneBoardObject> = {}): ZoneBoardObject {
  return { type: 'zone', x: 0, y: 0, width: 760, height: 400, label: 'Review', ...overrides };
}

describe('arrangedZoneLayout', () => {
  it('names row, column and grid zones and nothing else', () => {
    expect(arrangedZoneLayout(zone({ layout: 'grid' }))).toBe('grid');
    expect(arrangedZoneLayout(zone({ layout: 'row' }))).toBe('row');
    expect(arrangedZoneLayout(zone({ layout: 'free' }))).toBeUndefined();
    expect(arrangedZoneLayout(zone({ layout: autoPolicy }))).toBeUndefined();
    expect(arrangedZoneLayout(zone())).toBeUndefined();
  });
});

describe('resolveZoneLayoutWrite', () => {
  it('parks the policy an arranged layout replaces, binding included', () => {
    const existing = zone({ layout: autoPolicy, layout_binding: 'override' });
    const next = resolveZoneLayoutWrite(existing, { ...existing, layout: 'grid' });

    expect(next.layout).toBe('grid');
    expect(next.layout_binding).toBeUndefined();
    expect(next.suspended_layout).toEqual({ layout: autoPolicy, layout_binding: 'override' });
  });

  it('keeps the parked policy across switches between arranged layouts and other edits', () => {
    const parked = { layout: autoPolicy, layout_binding: 'override' as const };
    const existing = zone({ layout: 'grid', suspended_layout: parked });

    // A client echoing the zone (rename) never carries the server-maintained field.
    const { suspended_layout: _dropped, ...echoed } = existing;
    expect(
      resolveZoneLayoutWrite<ZoneBoardObject>(existing, { ...echoed, label: 'Renamed' })
        .suspended_layout
    ).toEqual(parked);
    expect(
      resolveZoneLayoutWrite<ZoneBoardObject>(existing, { ...echoed, layout: 'column' })
        .suspended_layout
    ).toEqual(parked);
  });

  it('ignores a parked layout the caller tries to set', () => {
    const forged = resolveZoneLayoutWrite(zone({ layout: 'grid' }), {
      ...zone({ layout: 'grid' }),
      suspended_layout: { layout: autoPolicy },
    });
    expect(forged.suspended_layout).toBeUndefined();
  });

  it('restores the parked policy when the zone switches back to free', () => {
    const existing = zone({
      layout: 'grid',
      suspended_layout: { layout: autoPolicy, layout_binding: 'override' },
    });
    const next = resolveZoneLayoutWrite(existing, { ...existing, layout: 'free' });

    expect(next.layout).toEqual(normalizeZoneLayoutPolicy(autoPolicy));
    expect(next.layout_binding).toBe('override');
    expect(next.suspended_layout).toBeUndefined();
  });

  it('restores an inheriting zone onto the current board defaults', () => {
    const defaults: ZoneLayoutPolicy = { ...autoPolicy, preset: 'grid', columns: 3 };
    const existing = zone({ layout: 'row', suspended_layout: { layout_binding: 'inherit' } });
    const next = resolveZoneLayoutWrite(existing, { ...existing, layout: 'free' }, defaults);

    expect(next.layout).toEqual(normalizeZoneLayoutPolicy(defaults));
    expect(next.layout_binding).toBe('inherit');
  });

  it('never lets free erase an existing policy', () => {
    const existing = zone({ layout: autoPolicy, layout_binding: 'override' });
    const next = resolveZoneLayoutWrite(existing, { ...existing, layout: 'free', label: 'B' });

    expect(next.layout).toBe(autoPolicy);
    expect(next.layout_binding).toBe('override');
    expect(next.label).toBe('B');
  });

  it('hands a zone with no policy to the board defaults on free', () => {
    const next = resolveZoneLayoutWrite(undefined, zone({ layout: 'free' }));
    expect(next.layout).toBeUndefined();
    expect(next.layout_binding).toBe('inherit');
  });

  it('drops a parked policy once a policy is chosen explicitly', () => {
    const existing = zone({ layout: 'grid', suspended_layout: { layout: autoPolicy } });
    const policy = normalizeZoneLayoutPolicy({ mode: 'manual' });
    const next = resolveZoneLayoutWrite(existing, { ...existing, layout: policy });

    expect(next.layout).toBe(policy);
    expect(next.suspended_layout).toBeUndefined();
  });
});

describe('arrangedZoneShownSize', () => {
  it('sizes an arranged zone the way the canvas lays out its cards', () => {
    const items = [
      { id: 'a', position: { x: 0, y: 0 }, height: 200 },
      { id: 'b', position: { x: 0, y: 300 }, height: 120 },
    ];
    // Header 80, 200 + gap 20 → 300, 120 → 420, padding 20 → 440.
    expect(arrangedZoneShownSize(zone({ layout: 'column', width: 600 }), items)).toEqual({
      width: 600,
      height: 440,
    });
  });

  it('leaves free and policy zones to their stored size', () => {
    expect(arrangedZoneShownSize(zone({ layout: autoPolicy }), [])).toBeUndefined();
    expect(arrangedZoneShownSize(zone({ layout: 'free' }), [])).toBeUndefined();
  });
});
