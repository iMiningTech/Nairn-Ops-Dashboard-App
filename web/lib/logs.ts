// Summaries for the external JotForm-backed log sheets (breakdowns, QC crimp
// checks, decontamination). Pure functions over the api feeds.

import type { Breakdown, QcCheck, Decon } from "@/lib/api";

// Robust date parse for the log sheets — handles "YYYY-MM-DD HH:MM:SS",
// "M-D-YYYY HH:MM", "M/D/YYYY". Returns a Date or null.
export function parseLogDate(s?: string | null): Date | null {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}
export function logDayKey(s?: string | null): string {
  const d = parseLogDate(s);
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
}
const ms = (s?: string | null) => { const d = parseLogDate(s); return d ? d.getTime() : NaN; };
const tally = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r) || "—"; m.set(k, (m.get(k) || 0) + 1); }
  return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
};

// ── Breakdowns ───────────────────────────────────────────────────────────────
export type BreakdownSummary = {
  last: Breakdown | null;
  total: number;
  monthCount: number;
  monthDowntimeMin: number;
  totalDowntimeMin: number;
  daysSinceLast: number | null;
  byLine: { ViperDet: number; Axxis: number };  // month counts
  byStation: { name: string; value: number }[];
  byNature: { name: string; value: number }[];
};

export function breakdownSummary(items: Breakdown[], monthPrefix: string): BreakdownSummary {
  const dated = items.filter((b) => !isNaN(ms(b.at)));
  const last = dated.slice().sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
  const month = items.filter((b) => logDayKey(b.at).startsWith(monthPrefix));
  return {
    last,
    total: items.length,
    monthCount: month.length,
    monthDowntimeMin: month.reduce((s, b) => s + b.duration_min, 0),
    totalDowntimeMin: items.reduce((s, b) => s + b.duration_min, 0),
    daysSinceLast: last ? Math.floor((Date.now() - ms(last.at)) / 86400000) : null,
    byLine: { ViperDet: month.filter((b) => b.line === "ViperDet").length, Axxis: month.filter((b) => b.line === "Axxis").length },
    byStation: tally(month, (b) => b.station).slice(0, 10),
    byNature: tally(month, (b) => b.nature),
  };
}

// ── QC crimp checks ──────────────────────────────────────────────────────────
export type QcSummary = {
  todayChecks: number; todayPass: number; todayFail: number; todayRate: number | null;
  monthChecks: number; monthRate: number | null;
  lastAt: string | null;
  recentFails: QcCheck[];
};
export function qcSummary(items: QcCheck[], todayKey: string, monthPrefix: string): QcSummary {
  const graded = items.filter((q) => q.status === "Pass" || q.status === "Fail");
  const today = graded.filter((q) => logDayKey(q.at) === todayKey);
  const month = graded.filter((q) => logDayKey(q.at).startsWith(monthPrefix));
  const rate = (rows: QcCheck[]) => (rows.length ? rows.filter((q) => q.status === "Pass").length / rows.length : null);
  const last = items.filter((q) => !isNaN(ms(q.at))).sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
  return {
    todayChecks: today.length,
    todayPass: today.filter((q) => q.status === "Pass").length,
    todayFail: today.filter((q) => q.status === "Fail").length,
    todayRate: rate(today),
    monthChecks: month.length,
    monthRate: rate(month),
    lastAt: last?.at ?? null,
    recentFails: graded.filter((q) => q.status === "Fail").sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 10),
  };
}

// ── Decontamination ──────────────────────────────────────────────────────────
export function lastDecon(items: Decon[]): { at: string; daysSince: number; hmx_spill: boolean } | null {
  const dated = items.filter((d) => !isNaN(ms(d.at))).sort((a, b) => ms(b.at) - ms(a.at));
  if (!dated.length) return null;
  return { at: dated[0].at, daysSince: Math.floor((Date.now() - ms(dated[0].at)) / 86400000), hmx_spill: dated[0].hmx_spill };
}
