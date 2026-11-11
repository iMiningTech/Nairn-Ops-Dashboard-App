import { InventoryItem, Transaction } from "@/lib/api";
import { dateKey } from "@/lib/utils";

// "Received" = goods first labelled into inventory on a given day. The intake
// event is LABEL_CREATED in the Transaction_Log (written by the scanner app when
// a box is registered). A box can be reprinted, which writes a *second*
// LABEL_CREATED later — so we key each box off its EARLIEST LABEL_CREATED, and a
// reprint of old stock never shows up as a fresh receipt.
//
// Scope is RAW_MATERIAL by default: that's an incoming supplier delivery.
// FINISHED_GOOD LABEL_CREATED is in-house production (covered by other tabs).

export type ReceivedRow = {
  description: string;
  manufacturer: string;
  financial_no: string;
  boxes: number;        // number of labelled packages (QRs) received that day
  quantity: number;     // units on hand (current box quantity — matches inventory)
};

export type ReceivedDay = {
  day: string;          // YYYY-MM-DD
  boxes: number;
  quantity: number;
  items: number;        // distinct descriptions
};

export type ReceivedIndex = {
  days: ReceivedDay[];                                            // most recent first
  byDay: Map<string, { rows: ReceivedRow[]; boxes: number; quantity: number }>;
};

// Earliest LABEL_CREATED day-key per QR.
function firstReceiptDay(txns: Transaction[]): Map<string, string> {
  const firstMs = new Map<string, number>();
  const day = new Map<string, string>();
  for (const t of txns) {
    if (t.type !== "LABEL_CREATED" || !t.qr || !t.timestamp) continue;
    const ms = Date.parse(t.timestamp);
    if (isNaN(ms)) continue;
    const prev = firstMs.get(t.qr);
    if (prev === undefined || ms < prev) {
      firstMs.set(t.qr, ms);
      day.set(t.qr, dateKey(t.timestamp));
    }
  }
  return day;
}

export function indexReceived(
  items: InventoryItem[],
  txns: Transaction[],
  opts: { type?: string } = {},
): ReceivedIndex {
  const type = opts.type ?? "RAW_MATERIAL";
  const byQr = new Map(items.map((i) => [i.qr, i]));
  const firstDay = firstReceiptDay(txns);

  // day -> description -> row
  const grouped = new Map<string, Map<string, ReceivedRow>>();
  for (const [qr, day] of firstDay) {
    if (!day) continue;
    const item = byQr.get(qr);
    if (!item || item.type !== type) continue;
    let dayMap = grouped.get(day);
    if (!dayMap) { dayMap = new Map(); grouped.set(day, dayMap); }
    const key = item.description || "(unlabelled)";
    let row = dayMap.get(key);
    if (!row) {
      row = { description: key, manufacturer: item.manufacturer || "", financial_no: item.financial_no || "", boxes: 0, quantity: 0 };
      dayMap.set(key, row);
    }
    row.boxes += 1;
    // Current_Quantity, not Original_Quantity: raw-material boxes are labelled from
    // a template (e.g. 5400) and then reconciled to the real contents (e.g. 1800)
    // via a QUANTITY_CHANGE, so Original is the inflated template. Current matches
    // what the Raw Materials / inventory on-hand shows.
    row.quantity += item.current_quantity || 0;
    if (!row.manufacturer && item.manufacturer) row.manufacturer = item.manufacturer;
    if (!row.financial_no && item.financial_no) row.financial_no = item.financial_no;
  }

  const byDay = new Map<string, { rows: ReceivedRow[]; boxes: number; quantity: number }>();
  const days: ReceivedDay[] = [];
  for (const [day, dayMap] of grouped) {
    const rows = Array.from(dayMap.values()).sort(
      (a, b) => b.boxes - a.boxes || a.description.localeCompare(b.description),
    );
    const boxes = rows.reduce((s, r) => s + r.boxes, 0);
    const quantity = rows.reduce((s, r) => s + r.quantity, 0);
    byDay.set(day, { rows, boxes, quantity });
    days.push({ day, boxes, quantity, items: rows.length });
  }
  days.sort((a, b) => b.day.localeCompare(a.day));
  return { days, byDay };
}
