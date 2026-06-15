// ─────────────────────────────────────────────────────────────────────────────
// THE DATA CONTRACT — the one boundary that makes the Sheets→AWS migration a
// backend swap, not a rebuild. The UI ONLY ever calls `api.*` and consumes these
// typed shapes. It never knows whether the JSON came from Google Sheets (today)
// or an AWS API (later). Keep this boundary sacred: no fetching/parsing in
// components. All DOMAIN logic (what a pool is, reconciliation) lives in
// lib/pools.ts, computed from these raw-ish feeds — so it's identical in both
// data modes and survives the AWS swap untouched.
//
// Two data modes, chosen by env (NEXT_PUBLIC_DATA_MODE):
//   "appsscript" (prod) — calls the Apps Script Web App (NEXT_PUBLIC_API_BASE =
//      the /exec URL), which returns JSON already in these shapes.
//   "gviz" (dev/zero-backend) — reads the published Sheet tabs as CSV in the
//      browser and maps them to the same shapes. Lets `npm run dev` hit live data
//      with nothing deployed.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || "";
const SHEET_ID = process.env.NEXT_PUBLIC_SHEET_ID || "15eiq1d-w5av0JIf1u_x4kPAhUiDU_wJIMd3JgmQOxPM";
const MODE = (process.env.NEXT_PUBLIC_DATA_MODE || (API_BASE ? "appsscript" : "gviz")).toLowerCase();

// ── Contract types (snake_case, decoupled from sheet headers) ────────────────
export type InventoryItem = {
  qr: string;
  description: string;
  type: string;                 // RAW_MATERIAL | FINISHED_GOOD | POOL | NDT_BATCH | …
  current_quantity: number;
  original_quantity: number;
  current_location: string;
  current_sub_location: string;
  status: string;               // Active | Sold | Destroyed | Inactive | Print Error
  last_updated_at: string | null;
  last_updated_by: string;
  first_seen_at: string | null;
  // Product attributes (mostly populated for FINISHED_GOOD / RAW_MATERIAL).
  product_type: string;         // e.g. "MS DUAL"
  delay_display: string;        // e.g. "25 / 500 ms"
  length: string;               // e.g. "12.0m"
  weight_kg: number;
  machine: string;              // ViperDet | Axxis | …
  manufacturer: string;
  customer: string;
  sale_status: string;
  prod_purpose: string;
  prod_date: string | null;
  prod_shift: string;
  qc_person: string;
};

export type StockResponse = {
  generated_at: string | null;
  count: number;
  items: InventoryItem[];
};

// One row of the append-only Transaction_Log. Quantity moves are recorded as
// old_value → new_value on rows where field = "Current_Quantity".
export type Transaction = {
  timestamp: string | null;
  qr: string;
  type: string;                 // LABEL_CREATED | LOCATION_CHANGE | QUANTITY_CHANGE | POOL_AUTO_INCREMENT | …
  field: string;                // Current_Quantity | Current_Location | Status | …
  old_value: string;
  new_value: string;
  reason: string;
  user: string;
  source: string;
  notes: string;
  correlation_id: string;
};

export type TransactionResponse = {
  generated_at: string | null;
  count: number;
  items: Transaction[];
};

// ── Apps Script transport (JSON) ─────────────────────────────────────────────
async function getJson<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ action, ...params });
  if (API_TOKEN) qs.set("token", API_TOKEN);
  const res = await fetch(`${API_BASE}?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status} on ${action}`);
  return res.json();
}

// ── gviz transport (CSV, browser-side) ──────────────────────────────────────
function gvizUrl(tab: string) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

// Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas, escaped
// quotes, CRLF). Good enough for Google's gviz CSV output.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c === "\r") {
      /* skip */
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

async function gvizTab(tab: string): Promise<Record<string, string>[]> {
  const res = await fetch(gvizUrl(tab), { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet ${res.status} on ${tab}`);
  return csvToObjects(await res.text());
}

const toNum = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
};
const orNull = (v: string) => (v && v.trim() ? v.trim() : null);

function mapInventoryRow(r: Record<string, string>): InventoryItem {
  return {
    qr: r["QR"] ?? "",
    description: r["Description"] ?? "",
    type: r["Type"] || "Unknown",
    current_quantity: toNum(r["Current_Quantity"]),
    original_quantity: toNum(r["Original_Quantity"]),
    current_location: r["Current_Location"] ?? "",
    current_sub_location: r["Current_Sub_Location"] ?? "",
    status: r["Status"] || "Unknown",
    last_updated_at: orNull(r["Last_Updated_At"] ?? ""),
    last_updated_by: r["Last_Updated_By"] ?? "",
    first_seen_at: orNull(r["First_Seen_At"] ?? ""),
    product_type: r["ProductType"] ?? "",
    delay_display: r["DelayDisplay"] ?? "",
    length: r["Length_M_String"] ?? "",
    weight_kg: toNum(r["WeightKg"]),
    machine: r["Machine"] ?? "",
    manufacturer: r["Manufacturer"] ?? "",
    customer: r["Customer"] ?? "",
    sale_status: r["Sale_Status"] ?? "",
    prod_purpose: r["ProdPurpose"] ?? "",
    prod_date: orNull(r["ProdDate_Formatted"] ?? ""),
    prod_shift: r["ProdShift"] ?? "",
    qc_person: r["QC_Person"] ?? "",
  };
}

function mapTransactionRow(r: Record<string, string>): Transaction {
  return {
    timestamp: orNull(r["Timestamp"] ?? ""),
    qr: r["QR"] ?? "",
    type: r["Type"] ?? "",
    field: r["Field"] ?? "",
    old_value: r["Old_Value"] ?? "",
    new_value: r["New_Value"] ?? "",
    reason: r["Reason"] ?? "",
    user: r["User"] ?? "",
    source: r["Source"] ?? "",
    notes: r["Notes"] ?? "",
    correlation_id: r["Correlation_ID"] ?? "",
  };
}

// ── Public client — the only thing the UI imports ───────────────────────────
export const api = {
  mode: MODE,
  async stockOnHand(): Promise<StockResponse> {
    if (MODE === "gviz") {
      const items = (await gvizTab("Inventory_Master")).map(mapInventoryRow);
      return { generated_at: new Date().toISOString(), count: items.length, items };
    }
    return getJson<StockResponse>("stockOnHand");
  },
  async transactions(): Promise<TransactionResponse> {
    if (MODE === "gviz") {
      const items = (await gvizTab("Transaction_Log")).map(mapTransactionRow);
      return { generated_at: new Date().toISOString(), count: items.length, items };
    }
    return getJson<TransactionResponse>("transactions");
  },
};
