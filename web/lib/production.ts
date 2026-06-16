// Production + daily-ops logic for the Overview, derived from Inventory_Master
// (printed labels) + Transaction_Log (magazine moves). Verified against the
// reference sheet dashboard:
//   • a finished-good item's First_Seen_At = the day it was printed/produced
//   • Original_Quantity = the quantity on that label
//   • today's printed stickers grouped by product/delay/length reproduce the
//     sheet's "Production Printed Stickers (Today)" panel exactly.

import type { InventoryItem, Transaction } from "@/lib/api";
import { dateKey, todayKey, clockMinutes } from "@/lib/utils";

export const isFinishedGood = (i: InventoryItem) => i.type === "FINISHED_GOOD";
export const prodDateKey = (i: InventoryItem) => dateKey(i.first_seen_at || i.prod_date);

// Production line for a finished good (drives the ViperDet / Axxis split).
export function productionLine(i: InventoryItem): "ViperDet" | "Axxis" | null {
  if (i.machine === "ViperDet") return "ViperDet";
  if (i.machine === "Axxis") return "Axxis";
  const pt = i.product_type.toUpperCase();
  if (pt === "MS DUAL" || pt === "QS") return "ViperDet";
  if (pt === "TITANIUM" || /silver|titanium/i.test(i.description)) return "Axxis";
  return null;
}

// Product family for the per-day stacked chart.
export const PROD_FAMILIES = ["MS DUAL", "QS", "TITANIUM", "SILVER"] as const;
export function prodFamily(i: InventoryItem): string | null {
  const pt = i.product_type.toUpperCase();
  if (pt === "MS DUAL") return "MS DUAL";
  if (pt === "QS") return "QS";
  if (pt === "TITANIUM") return "TITANIUM";
  if (i.machine === "Axxis" && /silver/i.test(i.description)) return "SILVER";
  return null;
}

export type LineRecord = {
  line: string;
  quantity: number;     // units printed today
  boxes: number;        // distinct labels (≈ boxes/trays)
  windowMins: number | null;   // first→last print span today (mins)
  perPartSecs: number | null;  // windowMins×60 / quantity
};

// Today's records per production line (mirrors the sheet's "Today's Records").
export function todaysRecords(items: InventoryItem[], txns: Transaction[], line: "ViperDet" | "Axxis"): LineRecord {
  const today = todayKey();
  const todays = items.filter((i) => isFinishedGood(i) && productionLine(i) === line && prodDateKey(i) === today);
  const quantity = todays.reduce((s, i) => s + i.original_quantity, 0);
  const boxes = todays.length;
  // Print span from LABEL_CREATED timestamps of today's items.
  const qrSet = new Set(todays.map((i) => i.qr));
  const ts = txns
    .filter((t) => t.type === "LABEL_CREATED" && qrSet.has(t.qr) && dateKey(t.timestamp) === today)
    .map((t) => (t.timestamp ? Date.parse(t.timestamp) : NaN))
    .filter((n) => !isNaN(n));
  const windowMins = ts.length >= 2 ? Math.round((Math.max(...ts) - Math.min(...ts)) / 60000) : null;
  const perPartSecs = windowMins != null && quantity > 0 ? Math.round((windowMins * 60 * 100) / quantity) / 100 : null;
  return { line, quantity, boxes, windowMins, perPartSecs };
}

// Per-day production for the current month: [{ day, "MS DUAL", QS, … }] + the
// best single day (the "record to beat").
export function productionByDay(items: InventoryItem[], monthPrefix: string) {
  const byDay = new Map<string, Record<string, number>>();
  for (const i of items) {
    if (!isFinishedGood(i)) continue;
    const fam = prodFamily(i);
    if (!fam) continue;
    const day = prodDateKey(i);
    if (!day.startsWith(monthPrefix)) continue;
    const row = byDay.get(day) || {};
    row[fam] = (row[fam] || 0) + i.original_quantity;
    byDay.set(day, row);
  }
  const rows = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, fams]) => ({ day, ...fams }));
  let best = { day: "", total: 0 };
  for (const r of rows) {
    const total = PROD_FAMILIES.reduce((s, f) => s + (Number((r as unknown as Record<string, number>)[f]) || 0), 0);
    if (total > best.total) best = { day: r.day, total };
  }
  return { rows, best };
}

export type PrintedRow = { product: string; delay: string; length: string; quantity: number };

// Printed stickers grouped by product/delay/length for a given day key.
export function printedOn(items: InventoryItem[], dayKey: string): PrintedRow[] {
  const m = new Map<string, PrintedRow>();
  for (const i of items) {
    if (!isFinishedGood(i) || prodDateKey(i) !== dayKey) continue;
    const k = `${i.product_type}|${i.delay_display}|${i.length}`;
    const r = m.get(k) || { product: i.product_type, delay: i.delay_display, length: i.length, quantity: 0 };
    r.quantity += i.original_quantity;
    m.set(k, r);
  }
  return Array.from(m.values()).sort((a, b) => b.quantity - a.quantity);
}

// Quantity moved INTO a magazine on a given day (LOCATION_CHANGE → "Magazine …"),
// joined to Inventory_Master for the quantity. Returns total + last entries.
export function movedToMagazinesOn(items: InventoryItem[], txns: Transaction[], dayKey: string) {
  const qtyByQr = new Map(items.map((i) => [i.qr, i]));
  const moves = txns.filter((t) =>
    t.type === "LOCATION_CHANGE" && /magazine/i.test(t.new_value) && dateKey(t.timestamp) === dayKey);
  let total = 0;
  for (const m of moves) total += qtyByQr.get(m.qr)?.original_quantity || 0;
  return { total, count: moves.length };
}

export type MagEntry = { at: string | null; product: string; length: string; delay: string; quantity: number; user: string; to: string };

// Most-recent magazine entries (newest first).
export function recentMagazineEntries(items: InventoryItem[], txns: Transaction[], n = 5): MagEntry[] {
  const byQr = new Map(items.map((i) => [i.qr, i]));
  return txns
    .filter((t) => t.type === "LOCATION_CHANGE" && /magazine/i.test(t.new_value))
    .sort((a, b) => (Date.parse(b.timestamp || "") || 0) - (Date.parse(a.timestamp || "") || 0))
    .slice(0, n)
    .map((t) => {
      const i = byQr.get(t.qr);
      return {
        at: t.timestamp, to: t.new_value, user: t.user,
        product: i?.product_type || i?.description || t.qr,
        length: i?.length || "", delay: i?.delay_display || "",
        quantity: i?.original_quantity || 0,
      };
    });
}

// Finished goods on hand in the magazines, by family.
export function finishedGoodsInMagazines(items: InventoryItem[]) {
  const fg = items.filter((i) => isFinishedGood(i) && /magazine/i.test(i.current_location));
  const fam = (i: InventoryItem) => {
    const line = productionLine(i);
    const pt = i.product_type.toUpperCase();
    if (line === "ViperDet") return pt === "QS" ? "ViperDet QS" : "ViperDet MS Dual";
    if (line === "Axxis") return pt === "TITANIUM" ? "Axxis Titanium" : "Axxis Silver";
    return "Other";
  };
  const order = ["ViperDet MS Dual", "ViperDet QS", "Axxis Silver", "Axxis Titanium"];
  const m = new Map<string, number>(order.map((k) => [k, 0]));
  let m1 = 0, m2 = 0;
  for (const i of fg) {
    m.set(fam(i), (m.get(fam(i)) || 0) + i.current_quantity);
    if (/m1/i.test(i.current_location)) m1 += i.current_quantity;
    else if (/m2/i.test(i.current_location)) m2 += i.current_quantity;
  }
  return { families: order.map((k) => ({ name: k, value: m.get(k) || 0 })), m1, m2, total: m1 + m2 };
}

// ── Shift start & deadtime (the kitchen motivator) ───────────────────────────
// Operators start at SHIFT_START_HOUR (06:00 local). We highlight how long after
// shift start the FIRST production sticker landed (machine-start deadtime), and
// the longest gap between stickers during the day (extended deadtime).
export type ShiftInfo = {
  shiftStartMin: number;
  firstStickerMin: number | null;
  lastStickerMin: number | null;
  startDeadtimeMin: number;       // first sticker − shift start
  longestGapMin: number;          // biggest gap between consecutive stickers
  longestGapAtMin: number | null; // when that gap started
  totalDeadtimeMin: number;       // start deadtime + gaps over threshold
  count: number;
  ongoingMin: number | null;      // if nothing produced yet but shift has started
};

export function shiftTimeline(
  items: InventoryItem[], txns: Transaction[], startHour: number, nowMin: number, gapThresholdMin = 30,
): ShiftInfo {
  const today = todayKey();
  const fg = new Set(items.filter(isFinishedGood).map((i) => i.qr));
  const mins = txns
    .filter((t) => t.type === "LABEL_CREATED" && fg.has(t.qr) && dateKey(t.timestamp) === today)
    .map((t) => clockMinutes(t.timestamp))
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b);
  const shiftStartMin = startHour * 60;
  if (!mins.length) {
    return { shiftStartMin, firstStickerMin: null, lastStickerMin: null, startDeadtimeMin: 0,
      longestGapMin: 0, longestGapAtMin: null, totalDeadtimeMin: 0, count: 0,
      ongoingMin: nowMin > shiftStartMin ? nowMin - shiftStartMin : null };
  }
  const first = mins[0], last = mins[mins.length - 1];
  const startDeadtimeMin = Math.max(0, first - shiftStartMin);
  let longestGapMin = 0, longestGapAtMin: number | null = null, gapsOverThreshold = 0;
  for (let i = 1; i < mins.length; i++) {
    const g = mins[i] - mins[i - 1];
    if (g > longestGapMin) { longestGapMin = g; longestGapAtMin = mins[i - 1]; }
    if (g > gapThresholdMin) gapsOverThreshold += g;
  }
  return { shiftStartMin, firstStickerMin: first, lastStickerMin: last, startDeadtimeMin,
    longestGapMin, longestGapAtMin, totalDeadtimeMin: startDeadtimeMin + gapsOverThreshold,
    count: mins.length, ongoingMin: null };
}

// Per-day machine-start deadtime across a month (for the monthly report): how
// long after shift start the first production sticker landed, each production day.
export function startDeadtimeByDay(items: InventoryItem[], txns: Transaction[], startHour: number, monthPrefix: string) {
  const fg = new Set(items.filter(isFinishedGood).map((i) => i.qr));
  const firstByDay = new Map<string, number>();
  for (const t of txns) {
    if (t.type !== "LABEL_CREATED" || !fg.has(t.qr)) continue;
    const day = dateKey(t.timestamp);
    if (!day.startsWith(monthPrefix)) continue;
    const cm = clockMinutes(t.timestamp);
    if (cm == null) continue;
    const cur = firstByDay.get(day);
    if (cur == null || cm < cur) firstByDay.set(day, cm);
  }
  const rows = Array.from(firstByDay, ([day, firstMin]) => ({ day, firstMin, startDeadtimeMin: Math.max(0, firstMin - startHour * 60) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.startDeadtimeMin, 0) / rows.length) : 0;
  const worst = rows.slice().sort((a, b) => b.startDeadtimeMin - a.startDeadtimeMin)[0] || null;
  const best = rows.slice().sort((a, b) => a.startDeadtimeMin - b.startDeadtimeMin)[0] || null;
  return { rows, avg, worst, best };
}

// Month production totals by family + grand total.
export function monthTotals(items: InventoryItem[], monthPrefix: string) {
  const byFam = new Map<string, number>();
  for (const i of items) {
    if (!isFinishedGood(i)) continue;
    const fam = prodFamily(i);
    if (!fam || !prodDateKey(i).startsWith(monthPrefix)) continue;
    byFam.set(fam, (byFam.get(fam) || 0) + i.original_quantity);
  }
  const families = PROD_FAMILIES.map((f) => ({ name: f, value: byFam.get(f) || 0 }));
  return { families, total: families.reduce((s, f) => s + f.value, 0) };
}

// ── Facility: last T1 destruction (from NDT_BATCH_DESTROYED) ──────────────────
export type T1Destruction = { at: string | null; user: string; qr: string; daysSince: number; monthCount: number } | null;
export function lastT1Destruction(txns: Transaction[]): T1Destruction {
  const ds = txns
    .filter((t) => t.type === "NDT_BATCH_DESTROYED")
    .map((t) => ({ ...t, ms: Date.parse(t.timestamp || "") }))
    .filter((t) => !isNaN(t.ms))
    .sort((a, b) => b.ms - a.ms);
  if (!ds.length) return null;
  const month = todayKey().slice(0, 7);
  const monthCount = ds.filter((t) => dateKey(t.timestamp).startsWith(month)).length;
  return { at: ds[0].timestamp, user: ds[0].user, qr: ds[0].qr, daysSince: Math.floor((Date.now() - ds[0].ms) / 86400000), monthCount };
}

// ── Inventory matrix: description × location pivot of on-hand quantity ───────
// One row per description, one column per ROOM (limited to SITE_ROOMS — other
// locations like the Maintenance Room are deliberately excluded), a per-row total
// (the description's quantity across the shown rooms) + column + grand totals.
// Active stock only.
export const SITE_ROOMS = ["Magazine M1", "Magazine M2", "Sea Can 6", "Sea Can 7", "Component Room", "E-board Room", "DAB-16A", "NDT Room"] as const;

export type MatrixRow = { description: string; cells: Record<string, number>; total: number; family: string | null };
// Display/sort order for finished-good product families.
const FAMILY_ORDER = ["MS DUAL", "QS", "SILVER", "TITANIUM"];
export type MatrixResult = {
  locations: string[];
  rows: MatrixRow[];
  colTotals: Record<string, number>;
  grandTotal: number;
};

export function inventoryMatrix(items: InventoryItem[], finishedGoods: boolean, rooms: readonly string[]): MatrixResult {
  const norm = (s: string) => s.trim().toLowerCase();
  // Map a location to its canonical room name, or undefined if not a shown room.
  const canonRoom = (loc: string) => rooms.find((r) => norm(r) === norm(loc));

  const sel = items.filter((i) =>
    i.status === "Active" &&
    (finishedGoods ? i.type === "FINISHED_GOOD" : i.type !== "FINISHED_GOOD") &&
    canonRoom(i.current_location) !== undefined);

  const byDesc = new Map<string, Map<string, number>>();
  const colTotal = new Map<string, number>();
  const descFamily = new Map<string, string | null>();
  for (const i of sel) {
    const room = canonRoom(i.current_location)!;
    const desc = i.description || "(no description)";
    if (!byDesc.has(desc)) { byDesc.set(desc, new Map()); descFamily.set(desc, prodFamily(i)); }
    const lm = byDesc.get(desc)!;
    lm.set(room, (lm.get(room) || 0) + i.current_quantity);
    colTotal.set(room, (colTotal.get(room) || 0) + i.current_quantity);
  }

  const locations = rooms.filter((r) => colTotal.has(r));  // only rooms that hold stock, in listed order

  const rows = Array.from(byDesc, ([description, lm]) => {
    const cells: Record<string, number> = {};
    let total = 0;
    for (const loc of locations) { const q = lm.get(loc) || 0; cells[loc] = q; total += q; }
    return { description, cells, total, family: finishedGoods ? (descFamily.get(description) ?? null) : null };
  }).filter((r) => r.total !== 0);

  // Finished goods: group by product family (in FAMILY_ORDER) then alphabetically.
  // Raw materials & other: alphabetical by description.
  const famRank = (f: string | null) => { const i = f ? FAMILY_ORDER.indexOf(f) : -1; return i === -1 ? FAMILY_ORDER.length : i; };
  rows.sort(finishedGoods
    ? (a, b) => famRank(a.family) - famRank(b.family) || a.description.localeCompare(b.description)
    : (a, b) => a.description.localeCompare(b.description));

  const colTotals: Record<string, number> = {};
  for (const l of locations) colTotals[l] = colTotal.get(l) || 0;
  return { locations: [...locations], rows, colTotals, grandTotal: rows.reduce((s, r) => s + r.total, 0) };
}

// ── Finished-goods shelf age (from ProdDate_Formatted) ───────────────────────
// Detonators have a sellable shelf life from manufacture: >12 months = warning,
// >24 months = can no longer be sold. Age is per individual box (barcode).
export type AgedBox = { qr: string; description: string; product: string; prod_date: string | null; ageDays: number; ageMonths: number; location: string; qty: number };
export function agedFinishedGoods(items: InventoryItem[]): AgedBox[] {
  const now = Date.now();
  return items
    .filter((i) => i.type === "FINISHED_GOOD" && i.status === "Active")
    .map((i) => {
      const t = i.prod_date ? Date.parse(i.prod_date) : NaN;
      const ageDays = isNaN(t) ? -1 : Math.floor((now - t) / 86400000);
      return { qr: i.qr, description: i.description, product: i.product_type, prod_date: i.prod_date, ageDays, ageMonths: Math.floor(ageDays / 30.44), location: i.current_location, qty: i.original_quantity };
    })
    .filter((b) => b.ageDays >= 0)
    .sort((a, b) => b.ageDays - a.ageDays);
}

export type LowStock = { description: string; qr: string; quantity: number; critical: number; location: string };

// Items below their critical level (Original_Critical_Level set in Inventory_Master).
// NOTE: only a handful of items currently carry a critical level in the sheet —
// the reference dashboard's fuller "Low Material Alerts" needs critical levels
// populated for more materials (see the Overview note).
export function lowStock(items: InventoryItem[]): LowStock[] {
  return items
    .filter((i) => i.critical_level != null && i.critical_level > 0 && i.current_quantity < i.critical_level)
    .map((i) => ({ description: i.description, qr: i.qr, quantity: i.current_quantity, critical: i.critical_level as number, location: i.current_location }))
    .sort((a, b) => a.quantity / a.critical - b.quantity / b.critical);
}
