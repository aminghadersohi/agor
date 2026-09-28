import { describe, expect, it } from 'vitest';
import { formatTimeUntil } from './time';

describe('formatTimeUntil', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const later = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it('formats seconds, minutes, hours and days ahead', () => {
    expect(formatTimeUntil(later(42_000), now)).toBe('in 42s');
    expect(formatTimeUntil(later(4 * 60_000 + 5_000), now)).toBe('in 4m');
    expect(formatTimeUntil(later(2 * 3_600_000 + 15 * 60_000), now)).toBe('in 2h 15m');
    expect(formatTimeUntil(later(3 * 86_400_000), now)).toBe('in 3d');
  });

  it('treats a passed-but-unprocessed deadline as imminent', () => {
    expect(formatTimeUntil(later(-10_000), now)).toBe('any moment now');
  });

  it('returns undefined for missing or invalid input', () => {
    expect(formatTimeUntil(undefined, now)).toBeUndefined();
    expect(formatTimeUntil('not a date', now)).toBeUndefined();
  });
});
