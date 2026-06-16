// Sales history derived from Transaction_Log. A sale is a box whose Status moved
// to "Sold" (reason "Sale", box sent Off-Site); the PO is set by a paired
// PO_UPDATE transaction. Volume = the box's Original_Quantity.

import type { InventoryItem, Transaction } from "@/lib/api";
import { dateKey } from "@/lib/utils";

export type SaleEvent = {
  at: string | null;
  qr: string;
  description: string;
  product: string;
  qty: number;
  po: string;
  customer: string;
};

export function saleEvents(items: InventoryItem[], txns: Transaction[]): SaleEvent[] {
  const byQr = new Map(items.map((i) => [i.qr, i]));
  // Latest PO seen per box, from PO_UPDATE rows (field PO_Number).
  const poByQr = new Map<string, string>();
  for (const t of txns) if (t.field === "PO_Number" && t.new_value) poByQr.set(t.qr, t.new_value);

  const events: SaleEvent[] = [];
  for (const t of txns) {
    if (t.field !== "Status" || t.new_value !== "Sold") continue;
    const i = byQr.get(t.qr);
    events.push({
      at: t.timestamp,
      qr: t.qr,
      description: i?.description || t.qr,
      product: i?.product_type || "",
      qty: i?.original_quantity || 0,
      po: i?.po_number || poByQr.get(t.qr) || "",
      customer: i?.customer || "",
    });
  }
  return events.sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0));
}

export type PoRollup = { po: string; customer: string; boxes: number; volume: number };
export type SalesSummary = {
  events: SaleEvent[];
  volume: number;
  boxes: number;
  byPo: PoRollup[];
  customers: string[];
};

export function salesSummary(events: SaleEvent[], from: string, to: string): SalesSummary {
  const scoped = events.filter((e) => { const k = dateKey(e.at); return !!k && k >= from && k <= to; });
  const poMap = new Map<string, PoRollup>();
  for (const e of scoped) {
    const key = e.po || "(no PO)";
    const r = poMap.get(key) || { po: key, customer: e.customer, boxes: 0, volume: 0 };
    r.boxes++; r.volume += e.qty;
    if (!r.customer && e.customer) r.customer = e.customer;
    poMap.set(key, r);
  }
  return {
    events: scoped,
    volume: scoped.reduce((s, e) => s + e.qty, 0),
    boxes: scoped.length,
    byPo: Array.from(poMap.values()).sort((a, b) => b.volume - a.volume),
    customers: Array.from(new Set(scoped.map((e) => e.customer).filter(Boolean))),
  };
}
