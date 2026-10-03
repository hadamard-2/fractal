export interface ReadingAnchor { id: string; offset: number }
interface MeasuredRow { key: string | number | bigint; start: number; end: number }

/** A reader this close to the bottom is carried along to new output rather than held at their reading point. */
export const FOLLOW_BOTTOM_DISTANCE = 96;

export function nextScrollAction({ distanceFromBottom, appended, resizedAboveAnchor }: {
  distanceFromBottom: number;
  appended: boolean;
  resizedAboveAnchor: boolean;
}): 'follow-bottom' | 'preserve-anchor' | 'none' {
  if (!appended && !resizedAboveAnchor) return 'none';
  return distanceFromBottom <= FOLLOW_BOTTOM_DISTANCE ? 'follow-bottom' : 'preserve-anchor';
}

export function readingAnchor(rows: readonly MeasuredRow[], scrollTop: number): ReadingAnchor | null {
  const row = rows.find((item) => item.end > scrollTop);
  return row ? { id: String(row.key), offset: Math.max(0, scrollTop - row.start) } : null;
}

export function restoreAnchor(anchor: ReadingAnchor | null, rows: readonly MeasuredRow[]): number | null {
  if (!anchor) return null;
  const row = rows.find((item) => String(item.key) === anchor.id);
  return row ? row.start + Math.min(anchor.offset, Math.max(0, row.end - row.start - 1)) : null;
}
