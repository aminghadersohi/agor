// biome-ignore-all lint/plugin/noHardcodedColorLiteral: fixtures for the user-selectable entity palette
import { describe, expect, it } from 'vitest';
import { resolveEntityStripeColor } from './boardEntityColors';

describe('resolveEntityStripeColor', () => {
  const fallback = '#d9d9d9';

  it("keeps the user's color when the entity is pinned into a zone", () => {
    // Pinning must not erase the grouping signal the user just chose.
    expect(
      resolveEntityStripeColor({
        userColor: '#ff5630',
        zoneColor: '#1677ff',
        isPinned: true,
        fallback,
      })
    ).toBe('#ff5630');
  });

  it('falls back to the zone color only when the user set none', () => {
    expect(resolveEntityStripeColor({ zoneColor: '#1677ff', isPinned: true, fallback })).toBe(
      '#1677ff'
    );
  });

  it("ignores a zone color the entity isn't pinned to", () => {
    expect(resolveEntityStripeColor({ zoneColor: '#1677ff', fallback })).toBe(fallback);
  });

  it('falls back to the entity default when nothing else applies', () => {
    expect(resolveEntityStripeColor({ fallback })).toBe(fallback);
  });
});
