import { describe, expect, it } from 'vitest';
import { expectedExplicitLayoutState, zonesNeedingAutoArrange } from './autoArrangeGuard';

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

  it('suppresses staged explicit echoes until the acknowledged target arrives', () => {
    expect(expectedExplicitLayoutState('intermediate', undefined)).toEqual({
      suppress: false,
      settled: false,
      needsFallback: false,
    });
    expect(
      expectedExplicitLayoutState('intermediate', {
        signature: 'final',
        acknowledged: false,
      })
    ).toEqual({ suppress: true, settled: false, needsFallback: false });
    expect(
      expectedExplicitLayoutState('intermediate', {
        signature: 'final',
        acknowledged: true,
      })
    ).toEqual({ suppress: true, settled: false, needsFallback: true });
    expect(
      expectedExplicitLayoutState('final', { signature: 'final', acknowledged: true })
    ).toEqual({ suppress: true, settled: true, needsFallback: false });
  });
});
