/**
 * Space reserved above auto-arranged zone contents for the zone label and its
 * optional status. Zone children render above the zone background, so placing
 * an item at the ordinary edge padding can obscure the label.
 */
export function zoneContentTopInset(zone: { fontSize?: number; status?: string }): number {
  const labelFontSize =
    typeof zone.fontSize === 'number' && Number.isFinite(zone.fontSize)
      ? Math.min(48, Math.max(10, zone.fontSize))
      : 14;
  const labelHeight = Math.ceil(labelFontSize * 1.2);
  const statusHeight = zone.status ? 8 + Math.ceil(labelFontSize * 1.05) : 0;

  // 16px top/bottom breathing room, with a 64px baseline for ordinary zones.
  return Math.max(64, 32 + labelHeight + statusHeight);
}
