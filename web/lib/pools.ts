// Domain logic for the Nairn inventory dashboard — pure functions over the two
// raw feeds (InventoryItem[], Transaction[]). Lives in one place so it's
// identical in both data modes and survives the AWS backend swap.

import type { InventoryItem, Transaction } from "@/lib/api";
import { dateKey } from "@/lib/utils";

// Inclusive date-range filter on a transaction (by its YYYY-MM-DD day key).
export type DateRange = { from: string; to: string };
export const inRange = (t: Transaction, r: DateRange) => {
  const k = dateKey(t.timestamp);
  return !!k && k >= r.from && k <= r.to;
};

// ── Classification ───────────────────────────────────────────────────────────
// The "POOL" type is overloaded in the sheet:
//   • Explosive / production pools — QR starts "POOL-" (POOL-MS500-*): aggregated
//     detonator/component counts in Component Room, E-board Room, Warehouse 17, …
//   • Maintenance spares — everything else typed POOL (BMEMC*, all in Maintenance
//     Room): MRO parts tracked as count-pools. Not explosives.
export const isExplosivePool = (i: InventoryItem) => i.type === "POOL" && i.qr.startsWith("POOL-");
export const isMaintenancePool = (i: InventoryItem) => i.type === "POOL" && !i.qr.startsWith("POOL-");

export const explosivePools = (items: InventoryItem[]) => items.filter(isExplosivePool);
export const maintenancePools = (items: InventoryItem[]) => items.filter(isMaintenancePool);

// ── Quantity transactions ────────────────────────────────────────────────────
// Quantity moves are Old_Value → New_Value on rows where field = "Current_Quantity".
const num = (v: string) => {
  const n = Number(String(v ?? "").replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
};
export const isQtyTxn = (t: Transaction) => t.field === "Current_Quantity";
export const txnDelta = (t: Transaction) => num(t.new_value) - num(t.old_value);

const ms = (t: string | null) => (t ? Date.parse(t) : NaN);

// Manual interventions = a human had to correct a count (evidence of a prior
// scanning gap). These reasons / types mark them.
const INTERVENTION_REASONS = new Set(["Reconcile", "Stock Correction", "Correction"]);
export const isIntervention = (t: Transaction) =>
  isQtyTxn(t) && (INTERVENTION_REASONS.has(t.reason) || t.type === "POOL_MANUAL_CHANGE" || t.type === "QUANTITY_CHANGE");

// ── Pool flows (net in/out over a rolling window) ────────────────────────────
export type PoolFlow = { qr: string; in_qty: number; out_qty: number; net: number };

export function poolFlows(txns: Transaction[], poolQrs: Set<string>, range: DateRange): Map<string, PoolFlow> {
  const out = new Map<string, PoolFlow>();
  for (const t of txns) {
    if (!isQtyTxn(t) || !poolQrs.has(t.qr) || !inRange(t, range)) continue;
    const d = txnDelta(t);
    if (!d) continue;
    const f = out.get(t.qr) || { qr: t.qr, in_qty: 0, out_qty: 0, net: 0 };
    if (d > 0) f.in_qty += d; else f.out_qty += -d;
    f.net += d;
    out.set(t.qr, f);
  }
  return out;
}

// ── Reconciliation: calculated (per the log) vs actual (the sheet) ───────────
// For each pool, the latest logged New_Value of a Current_Quantity transaction is
// what the transaction log says the pool should hold. If that differs from the
// sheet's Current_Quantity, the pool value changed outside the logged flow — the
// "someone didn't scan properly" signal. We also count manual interventions and
// the in/out flow in the window.
export type PoolRecon = {
  qr: string;
  description: string;
  location: string;
  actual: number;          // Inventory_Master.Current_Quantity
  calculated: number | null; // latest logged New_Value (null if pool has no qty txns)
  diff: number;            // actual − calculated (0 = matches)
  matches: boolean;
  in_qty: number;
  out_qty: number;
  net: number;
  interventions: number;   // manual corrections in the window
  last_txn: string | null;
};

export type RoomRecon = {
  room: string;
  pools: number;
  actual: number;
  in_qty: number;
  out_qty: number;
  net: number;
  flagged: number;         // pools where calc ≠ actual
  interventions: number;
  balanced: boolean;
};

export function reconcilePools(items: InventoryItem[], txns: Transaction[], range: DateRange): PoolRecon[] {
  const pools = explosivePools(items);
  const poolSet = new Set(pools.map((p) => p.qr));

  // Latest qty txn per pool (by timestamp) → "calculated" value (range-independent).
  const latest = new Map<string, { at: number; newV: number }>();
  // Flow + interventions per pool, within the selected range.
  const flow = new Map<string, { in: number; out: number; net: number; interventions: number }>();

  for (const t of txns) {
    if (!isQtyTxn(t) || !poolSet.has(t.qr)) continue;
    const at = ms(t.timestamp);
    const prev = latest.get(t.qr);
    if (!isNaN(at) && (!prev || at >= prev.at)) latest.set(t.qr, { at, newV: num(t.new_value) });

    if (!inRange(t, range)) continue;
    const d = txnDelta(t);
    const f = flow.get(t.qr) || { in: 0, out: 0, net: 0, interventions: 0 };
    if (d > 0) f.in += d; else f.out += -d;
    f.net += d;
    if (isIntervention(t)) f.interventions++;
    flow.set(t.qr, f);
  }

  return pools.map((p) => {
    const calc = latest.has(p.qr) ? latest.get(p.qr)!.newV : null;
    const f = flow.get(p.qr) || { in: 0, out: 0, net: 0, interventions: 0 };
    const diff = calc === null ? 0 : p.current_quantity - calc;
    return {
      qr: p.qr,
      description: p.description,
      location: p.current_location,
      actual: p.current_quantity,
      calculated: calc,
      diff,
      matches: calc === null || diff === 0,
      in_qty: f.in,
      out_qty: f.out,
      net: f.net,
      interventions: f.interventions,
      last_txn: latest.has(p.qr) && !isNaN(latest.get(p.qr)!.at) ? new Date(latest.get(p.qr)!.at).toISOString() : null,
    };
  });
}

export function reconcileRooms(recon: PoolRecon[]): RoomRecon[] {
  const m = new Map<string, RoomRecon>();
  for (const p of recon) {
    const room = p.location || "Unassigned";
    const r = m.get(room) || { room, pools: 0, actual: 0, in_qty: 0, out_qty: 0, net: 0, flagged: 0, interventions: 0, balanced: true };
    r.pools++;
    r.actual += p.actual;
    r.in_qty += p.in_qty;
    r.out_qty += p.out_qty;
    r.net += p.net;
    if (!p.matches) r.flagged++;
    r.interventions += p.interventions;
    m.set(room, r);
  }
  return Array.from(m.values()).map((r) => ({ ...r, balanced: r.flagged === 0 })).sort((a, b) => b.actual - a.actual);
}
