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
