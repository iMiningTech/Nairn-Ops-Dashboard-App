// End-of-shift (EOS) reporting logic. Pure functions over the Shift_Reports feed.
// Rules from the data contract:
//   • One row per Date+Shift, append-only; Day shift only in practice.
//   • "Clean shift" = both start statuses On Time, and No on dead-time / QC /
//     materials, with all staff present. Everything else is a flag.
//   • Dead time has NO minutes — it's Yes/No + free text, never a duration.
//   • A missing report for a working day is itself a signal (compute gaps
//     against production days in the view).

import type { ShiftReport } from "@/lib/api";
import { dateKey } from "@/lib/utils";

export const eosDay = (r: ShiftReport) => dateKey(r.date);

export function isCleanShift(r: ShiftReport): boolean {
  return r.start_viper === "On Time" && r.start_axxis === "On Time"
    && !r.dead_time && !r.qc_issues && !r.materials_shortage && r.staff_all_present;
}

// Human-readable issue flags for a report (empty = clean).
export function shiftFlags(r: ShiftReport): string[] {
  const f: string[] = [];
  if (r.start_viper && r.start_viper !== "On Time") f.push(`ViperDet: ${r.start_viper}`);
  if (r.start_axxis && r.start_axxis !== "On Time") f.push(`Axxis: ${r.start_axxis}`);
  if (r.dead_time) f.push("Dead time");
  if (!r.staff_all_present) f.push(`Staff short${r.staff_missing_count ? ` (${r.staff_missing_count})` : ""}`);
  if (r.qc_issues) f.push("QC issue");
  if (r.materials_shortage) f.push("Materials shortage");
  return f;
}

export function reportForDay(reports: ShiftReport[], dayKey: string, shift = "Day"): ShiftReport | null {
  return reports.find((r) => eosDay(r) === dayKey && (!shift || r.shift === shift)) || null;
}

// Reports whose shift Date falls in [from,to], newest first.
export function eosInRange(reports: ShiftReport[], from: string, to: string): ShiftReport[] {
  return reports
    .filter((r) => { const k = eosDay(r); return !!k && k >= from && k <= to; })
    .sort((a, b) => eosDay(b).localeCompare(eosDay(a)));
}

const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x || "—", (m.get(x || "—") || 0) + 1);
  return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
};

export type EosSummary = {
  count: number; clean: number; flagged: number;
  viperOnTime: number; axxisOnTime: number;
  deadTimeDays: number; qcDays: number; materialsDays: number; staffMissingDays: number; staffMissingTotal: number;
  startViper: { name: string; value: number }[];
  startAxxis: { name: string; value: number }[];
};
export function eosSummary(reports: ShiftReport[]): EosSummary {
  return {
    count: reports.length,
    clean: reports.filter(isCleanShift).length,
    flagged: reports.filter((r) => !isCleanShift(r)).length,
    viperOnTime: reports.filter((r) => r.start_viper === "On Time").length,
    axxisOnTime: reports.filter((r) => r.start_axxis === "On Time").length,
    deadTimeDays: reports.filter((r) => r.dead_time).length,
    qcDays: reports.filter((r) => r.qc_issues).length,
    materialsDays: reports.filter((r) => r.materials_shortage).length,
    staffMissingDays: reports.filter((r) => !r.staff_all_present).length,
    staffMissingTotal: reports.reduce((s, r) => s + (r.staff_missing_count || 0), 0),
    startViper: tally(reports.map((r) => r.start_viper)),
    startAxxis: tally(reports.map((r) => r.start_axxis)),
  };
}
