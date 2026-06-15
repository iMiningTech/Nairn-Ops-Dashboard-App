// Generic, project-agnostic data helpers used by the views. Domain logic (what a
// "pool" is, what a discrepancy is) lives in the views; these just reshape arrays.

export function uniqueSorted<T>(xs: (T | null | undefined)[]): T[] {
  return Array.from(new Set(xs.filter((x): x is T => x != null && x !== ""))).sort((a, b) =>
    String(a).localeCompare(String(b))
  );
}

// Sum `val` grouped by `key` → [{ name, value }].
export function groupSum<T>(rows: T[], key: (r: T) => string, val: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + val(r));
  return Array.from(m, ([name, value]) => ({ name, value }));
}

// Count rows grouped by `key` → [{ name, value }].
export function groupCount<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1);
  return Array.from(m, ([name, value]) => ({ name, value }));
}

// Latest parseable ISO timestamp in a list (for "last updated" tiles).
export function maxDate(isos: (string | null | undefined)[]): string | null {
  let best = -Infinity, out: string | null = null;
  for (const s of isos) {
    if (!s) continue;
    const t = Date.parse(s);
    if (!isNaN(t) && t > best) { best = t; out = s; }
  }
  return out;
}
