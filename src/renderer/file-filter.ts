/** How many matches the filter shows; rendering more would cost more than it helps. */
export const FILTER_RESULT_LIMIT = 200;

/** Paths containing `query`, ignoring case: those whose file name contains it first, then shorter paths. */
export function filterPaths(paths: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Array<{ path: string; rank: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!lower.includes(needle)) continue;
    matches.push({ path, rank: lower.slice(lower.lastIndexOf('/') + 1).includes(needle) ? 0 : 1 });
  }
  matches.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return matches.slice(0, limit).map((match) => match.path);
}
