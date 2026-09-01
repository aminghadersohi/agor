/**
 * Auto-layout signatures include positions so a user's manual move can reflow
 * an automatic zone. Consume the next position signature produced by the
 * arranger itself, otherwise that output schedules a redundant second pass.
 */
export function zonesNeedingAutoArrange<T extends readonly [string, unknown]>(
  zones: readonly T[],
  skipOnce: Set<string>
): T[] {
  return zones.filter(([zoneId]) => {
    if (!skipOnce.has(zoneId)) return true;
    skipOnce.delete(zoneId);
    return false;
  });
}

export interface ExpectedExplicitLayoutSignature {
  signature: string;
  acknowledged: boolean;
}

/**
 * An explicit atomic layout can still rebuild board and placement selectors in
 * separate React renders. Suppress every intermediate observer signature; the
 * authoritative target settles the guard only after the service acknowledges
 * the write. A caller keeps its normal coalesced fallback armed while an
 * acknowledged non-target signature remains, so a genuine async size change
 * is handled once rather than masked.
 */
export function expectedExplicitLayoutState(
  currentSignature: string | undefined,
  expected: ExpectedExplicitLayoutSignature | undefined
): { suppress: boolean; settled: boolean; needsFallback: boolean } {
  if (!expected) return { suppress: false, settled: false, needsFallback: false };
  const settled = expected.acknowledged && currentSignature === expected.signature;
  return {
    suppress: true,
    settled,
    needsFallback: expected.acknowledged && !settled,
  };
}
