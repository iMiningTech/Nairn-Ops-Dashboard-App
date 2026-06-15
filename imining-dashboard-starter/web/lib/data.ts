// Data-shaping — ports the Streamlit dashboard's derivations (apply_filters,
// session_summary, sessions_no_end, activity_tl, KPIs, site status) to TS so
// every widget computes the same numbers. Operates on the API's JSON arrays.

import type { TimelineRow, PrestartRow } from "@/lib/api";

export type Session = {
  session_id: string;
  mmu_id: string | null;
  operator_name: string | null;
  reporting_date: string | null;
  shift_start: string | null;
  shift_end: string | null;
  clocked_out: boolean;
};

const SHIFT_MARKERS = new Set(["Shift Start", "Shift End"]);

export function uniqueSorted<T>(xs: (T | null | undefined)[]): T[] {
  return Array.from(new Set(xs.filter((x): x is T => x != null && x !== ""))).sort() as T[];
}

export function inRange(d: string | null | undefined, lo: string, hi: string): boolean {
  if (!d) return false;
  const day = String(d).slice(0, 10);
  return day >= lo && day <= hi;
}

// Rows with no MMU assigned are junk (operator didn't use the app properly) and
// are never displayed. `mmus` is the explicit set of selected MMUs — an empty
// set shows nothing (the page initialises it to "all" until the user changes it).
export function filterTimeline(rows: TimelineRow[], mmus: Set<string>, lo: string, hi: string): TimelineRow[] {
  return rows.filter((r) => {
    const mmu = (r.mmu_id || "").trim();
    return mmu !== "" && mmus.has(mmu) && inRange(r.reporting_date, lo, hi);
  });
}
export function filterPrestart(rows: PrestartRow[], mmus: Set<string>, lo: string, hi: string): PrestartRow[] {
  return rows.filter((r) => {
    const mmu = (r.mmu_id || "").trim();
    return mmu !== "" && mmus.has(mmu) && inRange(r.reporting_date, lo, hi);
  });
}

export function sessionsWithEnd(timeline: TimelineRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of timeline) if (r.activity_type === "Shift End" && r.session_id) s.add(r.session_id);
  return s;
}

export function sessionSummary(timeline: TimelineRow[]): Session[] {
  const ended = sessionsWithEnd(timeline);
  const byId = new Map<string, Session>();
  for (const r of timeline) {
    if (r.activity_type !== "Shift Start" || !r.session_id) continue;
    if (!byId.has(r.session_id)) {
      byId.set(r.session_id, {
        session_id: r.session_id,
        mmu_id: r.mmu_id ?? null,
        operator_name: r.operator_name ?? null,
        reporting_date: r.reporting_date ?? null,
        shift_start: r.start_timestamp ?? null,
        shift_end: (r as { shift_end_timestamp?: string }).shift_end_timestamp ?? null,
        clocked_out: ended.has(r.session_id),
      });
    }
  }
  return Array.from(byId.values());
}

export type ActivityRow = TimelineRow & { duration_hours: number };
export function activityTimeline(timeline: TimelineRow[]): ActivityRow[] {
  return timeline
    .filter((r) => !SHIFT_MARKERS.has(r.activity_type || ""))
    .map((r) => ({ ...r, duration_hours: Math.min(Number(r.duration_minutes) || 0, 240) / 60 }));
}

export type Kpis = { totalSessions: number; activeMmus: number; missingLogouts: number; missingPct: number; faults: number };
export function kpis(timeline: TimelineRow[], prestart: PrestartRow[]): Kpis {
  const sessions = sessionSummary(timeline);
  const totalSessions = new Set(sessions.map((s) => s.session_id)).size;
  const missing = sessions.filter((s) => !s.clocked_out).length;
  return {
    totalSessions,
    activeMmus: uniqueSorted(timeline.map((r) => r.mmu_id)).length,
    missingLogouts: missing,
    missingPct: totalSessions ? (missing / totalSessions) * 100 : 0,
    faults: prestart.filter((p) => p.fault_flag).length,
  };
}

// Generic group-and-sum / group-and-count helpers
export function groupSum<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): { name: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + val(r)); }
  return Array.from(m, ([name, value]) => ({ name, value }));
}
export function groupCount<T>(rows: T[], key: (r: T) => string): { name: string; value: number }[] {
  return groupSum(rows, key, () => 1);
}
