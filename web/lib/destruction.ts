// Destruction & waste logic. Two destruction mechanisms:
//   1. NDT batches (Type=NDT_BATCH) — sealed then destroyed at T1; contents in
//      NDT_Batch_Contents. "Awaiting" = not yet Destroyed.
//   2. Direct-to-T1 — any label whose Status = "Destroyed" (e.g. finished goods
//      taken straight from a magazine to destruction).
// Destruction date is resolved from the NDT_BATCH_DESTROYED / Status→Destroyed
// transaction (most reliable), falling back to Destruction_Date / last updated.
// Waste: captured today as NDT_Batch_Contents Entry_Type=Waste (standalone
// bag-weight waste isn't tagged in the data yet).

import type { InventoryItem, Transaction, BatchContent } from "@/lib/api";
import { dateKey } from "@/lib/utils";

const isNDT = (i: InventoryItem) => i.type === "NDT_BATCH";
const ms = (s?: string | null) => (s ? Date.parse(s) : NaN);

export type ContentSummary = { line: string; lines: number; pieces: number; meters: number; items: { item: string; qty: number; unit: string }[] };

export function summarizeContents(contents: BatchContent[]): Map<string, ContentSummary> {
  const byQr = new Map<string, BatchContent[]>();
  for (const c of contents) { if (!byQr.has(c.batch_qr)) byQr.set(c.batch_qr, []); byQr.get(c.batch_qr)!.push(c); }
  const out = new Map<string, ContentSummary>();
  for (const [qr, rows] of byQr) {
    const g = new Map<string, { item: string; qty: number; unit: string }>();
    for (const r of rows) { const k = `${r.item}|${r.unit}`; const e = g.get(k) || { item: r.item, qty: 0, unit: r.unit }; e.qty += r.quantity; g.set(k, e); }
    out.set(qr, {
      line: rows.find((r) => r.line)?.line || "",
      lines: rows.length,
      pieces: rows.filter((r) => /piece/i.test(r.unit)).reduce((s, r) => s + r.quantity, 0),
      meters: rows.filter((r) => /met/i.test(r.unit)).reduce((s, r) => s + r.quantity, 0),
      items: Array.from(g.values()).sort((a, b) => b.qty - a.qty),
    });
  }
  return out;
}

// Latest destruction timestamp per QR (NDT_BATCH_DESTROYED or Status→Destroyed).
export function destructionDates(txns: Transaction[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of txns) {
    const isDestroy = t.type === "NDT_BATCH_DESTROYED" || (t.field === "Status" && t.new_value === "Destroyed");
    if (!isDestroy || !t.timestamp) continue;
    const prev = m.get(t.qr);
    if (!prev || (ms(t.timestamp) || 0) > (ms(prev) || 0)) m.set(t.qr, t.timestamp);
  }
  return m;
}
// Who confirmed destruction, per QR.
function destroyerByQr(txns: Transaction[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of txns) if ((t.type === "NDT_BATCH_DESTROYED" || (t.field === "Status" && t.new_value === "Destroyed")) && t.user) m.set(t.qr, t.user);
  return m;
}

export type AwaitingBatch = { qr: string; line: string; opened: string | null; lines: number; pieces: number; meters: number };
export function awaitingDestruction(items: InventoryItem[], contents: BatchContent[]): AwaitingBatch[] {
  const sum = summarizeContents(contents);
  return items.filter((i) => isNDT(i) && i.status !== "Destroyed").map((i) => {
    const s = sum.get(i.qr);
    return { qr: i.qr, line: s?.line || "", opened: i.first_seen_at, lines: s?.lines || 0, pieces: s?.pieces || 0, meters: s?.meters || 0 };
  }).sort((a, b) => (ms(a.opened) || 0) - (ms(b.opened) || 0));
}

export type DestroyedBatch = { qr: string; at: string | null; line: string; destroyer: string; lines: number; pieces: number; meters: number };
export type DirectDestruction = { qr: string; description: string; type: string; qty: number; at: string | null };

export function destroyedInRange(items: InventoryItem[], txns: Transaction[], contents: BatchContent[], from: string, to: string) {
  const dd = destructionDates(txns);
  const who = destroyerByQr(txns);
  const sum = summarizeContents(contents);
  const resolved = (i: InventoryItem) => dd.get(i.qr) || i.destruction_date || i.last_updated_at;
  const inRange = (at: string | null | undefined) => { const k = dateKey(at || ""); return !!k && k >= from && k <= to; };

  const destroyed = items.filter((i) => i.status === "Destroyed");
  const batches: DestroyedBatch[] = destroyed.filter(isNDT).map((i) => {
    const at = resolved(i); const s = sum.get(i.qr);
    return { qr: i.qr, at, line: s?.line || "", destroyer: who.get(i.qr) || i.last_updated_by, lines: s?.lines || 0, pieces: s?.pieces || 0, meters: s?.meters || 0 };
  }).filter((b) => inRange(b.at)).sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0));

  const direct: DirectDestruction[] = destroyed.filter((i) => !isNDT(i)).map((i) => ({
    qr: i.qr, description: i.description, type: i.type, qty: i.original_quantity, at: resolved(i),
  })).filter((d) => inRange(d.at)).sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0));

  // Detailed line items of the in-range destroyed batches.
  const batchQrs = new Set(batches.map((b) => b.qr));
  const lineItems = contents.filter((c) => batchQrs.has(c.batch_qr));
  return { batches, direct, lineItems };
}

export type WasteEntry = { at: string | null; batch_qr: string; line: string; item: string; qty: number; unit: string; logged_by: string };
export function wasteInRange(contents: BatchContent[], from: string, to: string): WasteEntry[] {
  return contents
    .filter((c) => /waste/i.test(c.entry_type))
    .filter((c) => { const k = dateKey(c.timestamp || ""); return !!k && k >= from && k <= to; })
    .map((c) => ({ at: c.timestamp, batch_qr: c.batch_qr, line: c.line, item: c.item, qty: c.quantity, unit: c.unit, logged_by: c.logged_by }))
    .sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0));
}
