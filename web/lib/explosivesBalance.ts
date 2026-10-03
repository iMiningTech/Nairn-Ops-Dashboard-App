// Month-end explosives balance ("nothing went missing" check).
//
// The whole production flow is logged per component: cases leave the magazine and
// credit a production pool (issue), production backflushes each component out of
// its pool into finished goods (POOL_BOM_DECREMENT), and NDT batches destroy
// components (NDT_Batch_Contents). This builds a per-component ledger over a date
// range so detonator shells, connector blocks (EZ-blocks), bushings/plugs and
// shock tube can each be reconciled: Opening + Issued − Consumed(FG) − Destroyed
// − Other ± Corrections = Closing, with the audit columns and physical-sanity
// flags shown rather than a single pass/fail (manual Reconcile corrections are
// real and must stay visible).

import type { InventoryItem, Transaction, BatchContent } from "@/lib/api";
import { dateKey } from "@/lib/utils";
import { isExplosivePool } from "@/lib/pools";
import type { DateRange } from "@/lib/pools";

const num = (v: string) => {
  const n = Number(String(v ?? "").replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
};

// Component classes the balance tracks, in display order. Everything else on an
// explosive pool (glue, grease, boxes, labels, printer consumables, e-boards…) is
// ignored — this is an explosives/energetics balance.
export const BALANCE_CLASSES = ["Detonators", "Connector blocks (EZ-Block)", "Bushings & plugs", "Shock tube"] as const;
export type BalanceClass = (typeof BALANCE_CLASSES)[number];

export function classifyComponent(desc: string): BalanceClass | null {
  const d = (desc || "").toLowerCase();
  if (/^detonator/.test(d)) return "Detonators";
  if (/ez-?bl/.test(d)) return "Connector blocks (EZ-Block)";
  if (/bushing|plug/.test(d)) return "Bushings & plugs";
  if (/shock\s*tube/.test(d)) return "Shock tube";
  return null;
}

// Normalise a description so a pool and an NDT line item for the same component
// match: lowercase, drop a trailing "(meters)"/"(metres)" unit hint, collapse
// whitespace. Detonator/shock-tube names line up; EZ-blocks/bushings have no NDT
// line (they're destroyed inside a detonator assembly), so their NDT = 0.
const normDesc = (d: string) => (d || "").toLowerCase().replace(/\(met(?:er|re)s?\)/g, "").replace(/\s+/g, " ").trim();

const CORRECTION_REASONS = new Set(["Reconcile", "Correction", "Stock Correction"]);
const DESTROY_REASONS = new Set(["Waste", "Testing"]);

export type ComponentBalance = {
  cls: BalanceClass;
  variant: string;          // friendly description (first-seen casing)
  variantKey: string;       // normalised description, for the daily-ledger lookup
  unit: string;             // "m" for shock tube, else "u"
  pools: number;            // how many pool QRs rolled up
  opening: number;
  issued: number;           // material credited into production (case opens, transfers, stock-in, +manual)
  consumedFg: number;       // backflush into finished goods (POOL_BOM_DECREMENT)
  destroyedPool: number;    // pool decrements with reason Waste/Testing
  destroyedNdt: number;     // independent: NDT_Batch_Contents for this component
  corrections: number;      // signed net of manual Reconcile/Correction
  otherOut: number;         // other negative movements (returns, unclassified manual out)
  closing: number;          // opening + issued − consumedFg − destroyedPool + corrections − otherOut
  actualOnHand: number | null; // live current_quantity sum (when period includes today), for sanity
  flags: string[];
};

export type ClassBalance = {
  cls: BalanceClass;
  unit: string;
  rows: ComponentBalance[];
  opening: number; issued: number; consumedFg: number; destroyedPool: number;
  destroyedNdt: number; corrections: number; otherOut: number; closing: number;
  flagged: number;
};

export type ExplosivesBalance = {
  classes: ClassBalance[];
  flaggedCount: number;
  totalVariants: number;
};

export function explosivesBalance(
  items: InventoryItem[], txns: Transaction[], contents: BatchContent[], range: DateRange,
  todayKey: string,
): ExplosivesBalance {
  const periodIncludesToday = range.to >= todayKey;

  // Pools in scope, keyed by variant (normalised description) → its class + pools.
  type Agg = {
    cls: BalanceClass; variant: string; unit: string; qrs: Set<string>;
    opening: number; issued: number; consumedFg: number; destroyedPool: number;
    corrections: number; otherOut: number; deltaInPeriod: number; actual: number;
  };
  const byVariant = new Map<string, Agg>();
  const qrToKey = new Map<string, string>();

  for (const i of items) {
    if (!isExplosivePool(i)) continue;
    const cls = classifyComponent(i.description);
    if (!cls) continue;
    const key = `${cls}||${normDesc(i.description)}`;
    qrToKey.set(i.qr, key);
    let a = byVariant.get(key);
    if (!a) {
      a = {
        cls, variant: i.description.trim(), unit: cls === "Shock tube" ? "m" : "u", qrs: new Set(),
        opening: 0, issued: 0, consumedFg: 0, destroyedPool: 0, corrections: 0, otherOut: 0, deltaInPeriod: 0, actual: 0,
      };
      byVariant.set(key, a);
    }
    a.qrs.add(i.qr);
    a.actual += i.current_quantity;
  }

  // Opening balance per pool = latest logged absolute value (New_Value) strictly
  // before the period start. Tracked per QR, then summed into its variant.
  const openingByQr = new Map<string, { at: number; v: number }>();
  for (const t of txns) {
    if (t.field !== "Current_Quantity") continue;
    const key = qrToKey.get(t.qr);
    if (!key) continue;
    const k = dateKey(t.timestamp);
    if (!k || k >= range.from) continue;
    const at = t.timestamp ? Date.parse(t.timestamp) : NaN;
    const prev = openingByQr.get(t.qr);
    if (!isNaN(at) && (!prev || at >= prev.at)) openingByQr.set(t.qr, { at, v: num(t.new_value) });
  }
  for (const [qr, o] of openingByQr) {
    const a = byVariant.get(qrToKey.get(qr)!);
    if (a) a.opening += o.v;
  }

  // In-period pool flows, categorised.
  for (const t of txns) {
    if (t.field !== "Current_Quantity") continue;
    const key = qrToKey.get(t.qr);
    if (!key) continue;
    const k = dateKey(t.timestamp);
    if (!k || k < range.from || k > range.to) continue;
    const a = byVariant.get(key)!;
    const d = num(t.new_value) - num(t.old_value);
    if (!d) continue;
    a.deltaInPeriod += d;
    if (t.type === "POOL_BOM_DECREMENT") a.consumedFg += -d;           // backflush into FG
    else if (CORRECTION_REASONS.has(t.reason)) a.corrections += d;      // manual reconcile (signed)
    else if (DESTROY_REASONS.has(t.reason)) a.destroyedPool += -d;      // pool waste/testing
    else if (d > 0) a.issued += d;                                      // case opens, transfers, stock-in
    else a.otherOut += -d;                                              // returns / other manual out
  }

  // Independent destroyed total from the NDT batch contents, per variant.
  const ndtByKey = new Map<string, number>();
  for (const c of contents) {
    const cls = classifyComponent(c.item);
    if (!cls) continue;
    const k = dateKey(c.timestamp);
    if (!k || k < range.from || k > range.to) continue;
    const key = `${cls}||${normDesc(c.item)}`;
    ndtByKey.set(key, (ndtByKey.get(key) || 0) + c.quantity);
  }

  const rows: ComponentBalance[] = [];
  for (const [key, a] of byVariant) {
    const closing = a.opening + a.deltaInPeriod;
    const destroyedNdt = ndtByKey.get(key) || 0;
    // Flags are only the unambiguous "something is wrong" signals. NDT-vs-pool is
    // shown as a column, not flagged: NDT destruction is not consistently booked
    // against the pools under a waste reason, so a mismatch is usually a booking
    // route, not missing material.
    const flags: string[] = [];
    if (closing < -0.5) flags.push("negative stock");
    if (a.corrections !== 0 && Math.abs(a.corrections) >= Math.max(500, 0.25 * (a.issued + a.opening)))
      flags.push("large correction");
    if (periodIncludesToday && Math.abs(closing - a.actual) > 0.5)
      flags.push("ledger ≠ live stock");
    rows.push({
      cls: a.cls, variant: a.variant, variantKey: normDesc(a.variant), unit: a.unit, pools: a.qrs.size,
      opening: a.opening, issued: a.issued, consumedFg: a.consumedFg, destroyedPool: a.destroyedPool,
      destroyedNdt, corrections: a.corrections, otherOut: a.otherOut, closing,
      actualOnHand: periodIncludesToday ? a.actual : null, flags,
    });
  }

  const classes: ClassBalance[] = BALANCE_CLASSES.map((cls) => {
    const rs = rows.filter((r) => r.cls === cls)
      .sort((a, b) => (b.flags.length - a.flags.length) || a.variant.localeCompare(b.variant, undefined, { numeric: true }));
    const sum = (f: (r: ComponentBalance) => number) => rs.reduce((s, r) => s + f(r), 0);
    return {
      cls, unit: rs[0]?.unit ?? "u", rows: rs,
      opening: sum((r) => r.opening), issued: sum((r) => r.issued), consumedFg: sum((r) => r.consumedFg),
      destroyedPool: sum((r) => r.destroyedPool), destroyedNdt: sum((r) => r.destroyedNdt),
      corrections: sum((r) => r.corrections), otherOut: sum((r) => r.otherOut), closing: sum((r) => r.closing),
      flagged: rs.filter((r) => r.flags.length).length,
    };
  }).filter((c) => c.rows.length);

  return {
    classes,
    flaggedCount: rows.filter((r) => r.flags.length).length,
    totalVariants: rows.length,
  };
}

// ── Per-component day-by-day ledger (drill-down) ─────────────────────────────
// Every pool movement for one component, grouped by day, with the NDT batch
// entries that destroyed it that day — for tracing where a month-end discrepancy
// enters (e.g. a lone manual correction on one delay, or NDT not booked to stock).
export type NdtDayEntry = { batch: string; qty: number; entry: string; line: string };
// Three numbers per day for one component, on the PRODUCTION FLOOR pool.
export type DayLedger = {
  day: string;
  issued: number;      // net shells issued to production = onto floor − returned
                       // (every non-production move is a transfer: leaving the
                       // component room adds, a return subtracts — any reason)
  production: number;  // consumed into finished goods that day (backflush)
  ndt: number;         // destroyed in NDT batches that day (from the batch contents)
  ndtEntries: NdtDayEntry[];
};

export function componentDailyLedger(
  items: InventoryItem[], txns: Transaction[], contents: BatchContent[],
  cls: BalanceClass, variantKey: string, range: DateRange,
): DayLedger[] {
  // Production-floor pool(s) only ("-PF") — where shells land when issued from the
  // component room and are consumed into finished goods. On this pool every move is
  // either a backflush (production) or a transfer; a transfer in = issued, a
  // transfer back = returned, regardless of its reason.
  const qrs = new Set(
    items.filter((i) => isExplosivePool(i) && i.qr.endsWith("-PF") && classifyComponent(i.description) === cls && normDesc(i.description) === variantKey)
      .map((i) => i.qr));
  const byDay = new Map<string, DayLedger>();
  const get = (d: string) => {
    let r = byDay.get(d);
    if (!r) { r = { day: d, issued: 0, production: 0, ndt: 0, ndtEntries: [] }; byDay.set(d, r); }
    return r;
  };

  for (const t of txns) {
    if (t.field !== "Current_Quantity" || !qrs.has(t.qr)) continue;
    const k = dateKey(t.timestamp);
    if (!k || k < range.from || k > range.to) continue;
    const d = num(t.new_value) - num(t.old_value);
    if (!d) continue;
    const r = get(k);
    if (t.type === "POOL_BOM_DECREMENT") r.production += -d;   // consumed into finished goods
    else r.issued += d;                                        // transfer: onto floor (+) / returned (−)
  }

  for (const c of contents) {
    if (classifyComponent(c.item) !== cls || normDesc(c.item) !== variantKey) continue;
    const k = dateKey(c.timestamp);
    if (!k || k < range.from || k > range.to) continue;
    const r = get(k);
    r.ndt += c.quantity;
    r.ndtEntries.push({ batch: c.batch_qr, qty: c.quantity, entry: c.entry_type || "—", line: c.line });
  }

  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}
