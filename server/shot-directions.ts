/** Directional evidence computed before hiding a target's identity. No camera transform is assumed. */
export interface RelativeShotDirection {
  coordinateSpace: 'room-relative';
  horizontal: 'left' | 'right';
  source: 'relative-dss-placement';
  performerAnchor: string;
  targetAnchor: string;
}

function lateralAnchor(placement: string): { label: string; axis: string; index: number } | undefined {
  // Use the actual location clause, not e.g. "clear of the chair on the right".
  const label = placement.match(/\bat\s+([^,.;]+)/i)?.[1]?.trim();
  if (!label) return;
  const normalized = label.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  const suffix = normalized.match(/^(.+?)\s+(left|center|centre|right)$/);
  const prefix = normalized.match(/^(left|center|centre|right)(?: side)? of (?:the )?(.+)$/);
  const axis = suffix?.[1] ?? prefix?.[2];
  const side = suffix?.[2] ?? prefix?.[1];
  if (!axis || !side) return;
  return { label, axis, index: side === 'left' ? -1 : side === 'right' ? 1 : 0 };
}

export function relativeShotDirection(performerPlacement: string, targetPlacement: string): RelativeShotDirection | undefined {
  const performer = lateralAnchor(performerPlacement);
  const target = lateralAnchor(targetPlacement);
  // Different landmarks or equal lateral positions supply no reliable left/right delta.
  if (!performer || !target || performer.axis !== target.axis || performer.index === target.index) return;
  return { coordinateSpace: 'room-relative', horizontal: target.index < performer.index ? 'left' : 'right',
    source: 'relative-dss-placement', performerAnchor: performer.label, targetAnchor: target.label };
}
