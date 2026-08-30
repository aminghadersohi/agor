import { describe, expect, it } from 'vitest';
import { zonesNeedingAutoArrange } from './autoArrangeGuard';

describe('zonesNeedingAutoArrange', () => {
  it('consumes only the self-induced pass and leaves genuine changes scheduled', () => {
    const skipOnce = new Set(['self-arranged']);
    const pending = zonesNeedingAutoArrange(
      [
        ['self-arranged', {}],
        ['content-changed', {}],
      ] as const,
      skipOnce
    );

    expect(pending.map(([zoneId]) => zoneId)).toEqual(['content-changed']);
    expect(skipOnce.size).toBe(0);
  });
});
