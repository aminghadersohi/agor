import { describe, expect, it } from 'vitest';
import { parseEntityColorOverride } from './entity-color.js';

describe('parseEntityColorOverride', () => {
  it('treats empty as no color and lowercases valid hex', () => {
    expect(parseEntityColorOverride(undefined)).toBeNull();
    expect(parseEntityColorOverride('  ')).toBeNull();
    expect(parseEntityColorOverride('#FFaa00cc')).toBe('#ffaa00cc');
  });

  it('names the offending field when rejecting non-hex input', () => {
    expect(() => parseEntityColorOverride('red', 'cards[2].colorOverride')).toThrow(
      'cards[2].colorOverride must be a hex color like #ff5630 (received "red")'
    );
  });
});
