import { describe, expect, it } from 'vitest';
import { isValidEntityColor, normalizeEntityColor } from './entity-color';

describe('normalizeEntityColor', () => {
  it('accepts the three hex forms and lowercases them', () => {
    expect(normalizeEntityColor('#F53')).toBe('#f53');
    expect(normalizeEntityColor('#FF5630')).toBe('#ff5630');
    expect(normalizeEntityColor('#FF563080')).toBe('#ff563080');
  });

  it('tolerates surrounding whitespace from pasted values', () => {
    expect(normalizeEntityColor('  #ff5630 ')).toBe('#ff5630');
  });

  it('treats absence as no color', () => {
    expect(normalizeEntityColor(undefined)).toBeNull();
    expect(normalizeEntityColor(null)).toBeNull();
    expect(normalizeEntityColor('')).toBeNull();
  });

  it('rejects anything that is not hex rather than storing it unchecked', () => {
    // CSS would happily render some of these; the column stays hex-only so
    // every renderer can assume one shape.
    expect(normalizeEntityColor('red')).toBeNull();
    expect(normalizeEntityColor('rgb(255, 86, 48)')).toBeNull();
    expect(normalizeEntityColor('#ff56')).toBeNull();
    expect(normalizeEntityColor('#ff5630; background: url(x)')).toBeNull();
    expect(normalizeEntityColor('var(--ant-red-6)')).toBeNull();
    expect(normalizeEntityColor(0xff5630)).toBeNull();
  });
});

describe('isValidEntityColor', () => {
  it('narrows to string only for hex values', () => {
    expect(isValidEntityColor('#ff5630')).toBe(true);
    expect(isValidEntityColor('teal')).toBe(false);
    expect(isValidEntityColor(null)).toBe(false);
  });
});
