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
  critical_level: number | null;  // Original_Critical_Level (set for only some items)
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
  po_number: string;
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

export type User = {
  name: string;
  pin: string;
  auth_level: string;
  active: string;     // "TRUE" / "FALSE"
  email: string;
};

// Daily production targets — sourced from a NEW "Daily_Targets" tab (date,
// production line, product, specifics, target qty). Absent tab → empty list.
export type DailyTarget = {
  date: string;             // YYYY-MM-DD (normalised)
  production_line: string;  // ViperDet | Axxis
  product: string;          // MS DUAL | QS | …
  specifics: string;        // e.g. "25/500 · 15m"
  quantity: number;
};

// ── External JotForm-backed log sheets (separate spreadsheets) ───────────────
// These live in their own shared Google Sheets, fetched by gid in the browser.
export type Breakdown = {
  at: string;               // raw timestamp string
  line: "ViperDet" | "Axxis";
  duration_min: number;
  station: string;
  nature: string;           // Critical / Minor / Recurring Issue / Never Seen Before
  info: string;
  personnel: string;
};
export type QcCheck = {
  at: string;
  type: string;             // Mid Crimp at Station | Production Line Check
  status: string;           // Pass | Fail | ""
  mid_mm: number | null;
  inhole_mm: number | null;
  outhole_mm: number | null;
  personnel: string;
};
export type Decon = { at: string; line: string; hmx_spill: boolean };

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

// External log spreadsheets (their own files; fetched by gid, browser-side, in
// both data modes — they're separate sources with their own link-sharing).
const EXT = {
  breakdownViper: { id: "1NpWPun3bcZTnjcxw5fWhcbe3Z5LiAxqhrd77dI4lVbg", gid: "911349347" },
  breakdownAxxis: { id: "1jFimYAgEhWPg0Yze8YB5CCurGXTmPK9fDarCH5OasRU", gid: "564198776" },
  qcCrimp:        { id: "1YXtZAyYqxvpKQRITdgqPC7UVpNGM7xcX0MarLq5hjH0", gid: "942289539" },
  deconViper:     { id: "1j-uKuqCYTTIi9eo36QRVcLTiw-Eo7TwdgQ7-O6HDp0c", gid: "664101187" },
} as const;

async function gvizByGid(id: string, gid: string): Promise<Record<string, string>[]> {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`External sheet ${res.status}`);
  return csvToObjects(await res.text());
}

function mapBreakdown(r: Record<string, string>, line: "ViperDet" | "Axxis"): Breakdown {
  return {
    at: r["Submission Date"] || r["Date & Time"] || "",
    line,
    duration_min: toNum(r["Duration of breakdown (min)"]),
    station: r["Station"] ?? "",
    nature: r["Nature"] ?? "",
    info: r["Additional Information (optional)"] ?? "",
    personnel: r["Authorized Personnel"] || [r["Full Name - First Name"], r["Full Name - Last Name"]].filter(Boolean).join(" "),
  };
}
function mapQc(r: Record<string, string>): QcCheck {
  return {
    at: r["Submission Date"] || r["Date & Time"] || "",
    type: r["Crimp"] ?? "",
    status: r["Status"] ?? "",
    mid_mm: r["Mid Crimp (mm)"]?.trim() ? toNum(r["Mid Crimp (mm)"]) : null,
    inhole_mm: r["Inhole Crimp (mm)"]?.trim() ? toNum(r["Inhole Crimp (mm)"]) : null,
    outhole_mm: r["Outhole Crimp (mm)"]?.trim() ? toNum(r["Outhole Crimp (mm)"]) : null,
    personnel: r["Authorized Personnel"] ?? "",
  };
}
function mapDecon(r: Record<string, string>): Decon {
  const hmx = Object.entries(r).some(([k, v]) => k.includes("HMX powder spill") && String(v).trim() !== "");
  return { at: r["Submission Date"] || r["Date & Time"] || "", line: "ViperDet", hmx_spill: hmx };
}

function mapInventoryRow(r: Record<string, string>): InventoryItem {
  return {
    qr: r["QR"] ?? "",
    description: r["Description"] ?? "",
    type: r["Type"] || "Unknown",
    current_quantity: toNum(r["Current_Quantity"]),
    original_quantity: toNum(r["Original_Quantity"]),
    critical_level: r["Original_Critical_Level"]?.trim() ? toNum(r["Original_Critical_Level"]) : null,
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
    po_number: r["PO_Number"] ?? "",
    sale_status: r["Sale_Status"] ?? "",
    prod_purpose: r["ProdPurpose"] ?? "",
    prod_date: orNull(r["ProdDate_Formatted"] ?? ""),
    prod_shift: r["ProdShift"] ?? "",
    qc_person: r["QC_Person"] ?? "",
  };
}

function mapUserRow(r: Record<string, string>): User {
  return {
    name: r["Name"] ?? "",
    pin: r["PIN"] ?? "",
    auth_level: r["Auth_Level"] ?? "",
    active: r["Active"] ?? "",
    email: r["Email"] ?? "",
  };
}

function mapTargetRow(r: Record<string, string>): DailyTarget {
  const raw = r["Date"] ?? "";
  const m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return {
    date: m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : raw.slice(0, 10),
    production_line: r["Production_Line"] ?? "",
    product: r["Product"] ?? "",
    specifics: r["Specifics"] ?? "",
    quantity: toNum(r["Target_Quantity"] ?? r["Quantity"]),
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
  async users(): Promise<{ items: User[] }> {
    if (MODE === "gviz") return { items: (await gvizTab("User_Management")).map(mapUserRow).filter((u) => u.name) };
    return getJson<{ items: User[] }>("users");
  },
  // Daily_Targets is a tab the team still needs to create — tolerate its absence.
  async targets(): Promise<{ items: DailyTarget[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Daily_Targets")).map(mapTargetRow).filter((t) => t.date) };
      return await getJson<{ items: DailyTarget[] }>("targets");
    } catch {
      return { items: [] };
    }
  },
  // External log sheets — fetched directly by gid, graceful per-source.
  async breakdowns(): Promise<{ items: Breakdown[] }> {
    const [v, a] = await Promise.all([
      gvizByGid(EXT.breakdownViper.id, EXT.breakdownViper.gid).then((rs) => rs.map((r) => mapBreakdown(r, "ViperDet"))).catch(() => [] as Breakdown[]),
      gvizByGid(EXT.breakdownAxxis.id, EXT.breakdownAxxis.gid).then((rs) => rs.map((r) => mapBreakdown(r, "Axxis"))).catch(() => [] as Breakdown[]),
    ]);
    return { items: [...v, ...a] };
  },
  async qcChecks(): Promise<{ items: QcCheck[] }> {
    try { return { items: (await gvizByGid(EXT.qcCrimp.id, EXT.qcCrimp.gid)).map(mapQc) }; }
    catch { return { items: [] }; }
  },
  async decon(): Promise<{ items: Decon[] }> {
    try { return { items: (await gvizByGid(EXT.deconViper.id, EXT.deconViper.gid)).map(mapDecon).filter((d) => d.at) }; }
    catch { return { items: [] }; }
  },
};
