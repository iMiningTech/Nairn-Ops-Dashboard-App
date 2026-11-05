// Goods returns. A sold box that comes back is recorded in the Transaction_Log as
// two moves on the same QR: Current_Location "Off-Site" → a real location AND
// Status "Sold" → "Active" (type STATUS_CHANGE, reason "Return"). We detect those
// returned boxes, enrich them with the original sale PO/customer, and roll them up
// into DG line items with the SAME classification used for a BOL — so a return
// note is the same piece of paper as an outbound Bill of Lading.

import type { InventoryItem, Transaction } from "@/lib/api";
import { buildBol, type Bol } from "@/lib/bol";

const isOffSite = (s: string) => s.trim().toLowerCase() === "off-site";
const ms = (s?: string | null) => (s ? Date.parse(s) || 0 : 0);

export type ReturnedBox = {
  item: InventoryItem;
  returnedAt: string | null;   // Status Sold→Active timestamp (the return date)
  returnLocation: string;      // where it came back to (Off-Site → here)
  returnedBy: string;          // operator who processed the return
  po: string;                  // original sale PO
  customer: string;            // original sale customer (the party returning)
};

export type ReturnGroup = {
  customer: string;
  po: string;
  boxes: ReturnedBox[];
  returnedAt: string | null;   // most recent return in the group
};

// Every box that has come back: a Status Sold→Active AND a Current_Location
// Off-Site→(real location) transition for the same QR. PO/customer come from the
// current inventory row, falling back to the latest PO/customer update in the log.
export function detectReturns(items: InventoryItem[], txns: Transaction[]): ReturnedBox[] {
  const itemByQr = new Map(items.map((i) => [i.qr, i]));

  // Latest PO / customer per QR from the log (fallback when the row has none).
  const poByQr = new Map<string, string>();
  const custByQr = new Map<string, string>();
  for (const t of txns) {
    if (t.field === "PO_Number" && t.new_value) poByQr.set(t.qr, t.new_value);
    if (t.field === "Customer" && t.new_value) custByQr.set(t.qr, t.new_value);
  }

  // Per QR: the Sold→Active status moves and the Off-Site→real location moves.
  const soldToActive = new Map<string, Transaction[]>();
  const offSiteBack = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.field === "Status" && t.old_value === "Sold" && t.new_value === "Active") {
      (soldToActive.get(t.qr) || soldToActive.set(t.qr, []).get(t.qr)!).push(t);
    } else if (t.field === "Current_Location" && isOffSite(t.old_value) && !isOffSite(t.new_value) && t.new_value.trim()) {
      (offSiteBack.get(t.qr) || offSiteBack.set(t.qr, []).get(t.qr)!).push(t);
    }
  }

  const out: ReturnedBox[] = [];
  for (const [qr, statusMoves] of soldToActive) {
    const locMoves = offSiteBack.get(qr);
    if (!locMoves || !locMoves.length) continue;       // needs BOTH signals
    const item = itemByQr.get(qr);
    if (!item) continue;                                // need the row for DG details

    // The return event = the latest Sold→Active; the location it came back to is
    // the Off-Site→location move closest in time to it (else the current row).
    const ret = statusMoves.slice().sort((a, b) => ms(b.timestamp) - ms(a.timestamp))[0];
    const retMs = ms(ret.timestamp);
    const loc = locMoves.slice().sort((a, b) => Math.abs(ms(a.timestamp) - retMs) - Math.abs(ms(b.timestamp) - retMs))[0];

    out.push({
      item,
      returnedAt: ret.timestamp,
      returnLocation: loc?.new_value || item.current_location,
      returnedBy: ret.user || "",
      po: item.po_number || poByQr.get(qr) || "",
      customer: item.customer || custByQr.get(qr) || "",
    });
  }
  return out.sort((a, b) => ms(b.returnedAt) - ms(a.returnedAt));
}

// Group returned boxes by customer then PO (one return note per PO collection),
// newest-return-first.
export function groupReturns(returns: ReturnedBox[]): ReturnGroup[] {
  const m = new Map<string, ReturnGroup>();
  for (const r of returns) {
    const key = `${r.customer || "(no customer)"}||${r.po || "(no PO)"}`;
    const g = m.get(key) || { customer: r.customer || "(no customer)", po: r.po || "(no PO)", boxes: [], returnedAt: null };
    g.boxes.push(r);
    if (ms(r.returnedAt) > ms(g.returnedAt)) g.returnedAt = r.returnedAt;
    m.set(key, g);
  }
  return Array.from(m.values()).sort((a, b) => ms(b.returnedAt) - ms(a.returnedAt));
}

// DG line items for a set of returned boxes — identical classification to a BOL.
export function buildReturn(boxes: ReturnedBox[]): Bol {
  return buildBol(boxes.map((b) => b.item));
}

// Provisional return-note number, deterministic from the selected box QRs (no
// register tab exists for returns — these print as un-numbered return notes).
export function draftReturnNumber(boxes: ReturnedBox[]): string {
  const key = boxes.map((b) => b.item.qr).sort().join("|");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `RTN-${yyyymmdd}-${h.toString(36).toUpperCase().slice(0, 4).padStart(4, "0")}`;
}
