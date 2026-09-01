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
// Apps Script /exec URL for the BOL register (the one write-back). When unset,
// BOL registration is disabled and the UI stays on draft numbers.
const BOL_API = (process.env.NEXT_PUBLIC_BOL_API || "").trim();
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
  financial_no: string;
  current_location: string;
  current_sub_location: string;
  status: string;               // Active | Sold | Destroyed | Inactive | Print Error
  last_updated_at: string | null;
  last_updated_by: string;
  first_seen_at: string | null;
  destruction_date: string | null;
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

// ── Maintenance / breakdown tickets (new BlastStock ticketing) ───────────────
// Tickets tab = one row per ticket (current state); Ticket_Events = append-only
// audit trail. Replaces the old JotForm breakdown sheets for the Breakdowns tab.
export type Ticket = {
  id: string; line: string; line_detail: string; title: string; description: string;
  severity: string; status: string;
  created_by: string; created_at: string | null;
  assigned_to: string; assigned_at: string | null;
  closed_by: string; closed_at: string | null; resolution: string;
  parts_count: number; photo_count: number; reopen_count: number;
  last_updated_at: string | null; last_updated_by: string;
};
export type TicketEvent = {
  timestamp: string | null; ticket_id: string; event_type: string; user: string;
  from_value: string; to_value: string; notes: string; photo_url: string;
  part_qr: string; part_description: string; qty_used: number; correlation_id: string;
};

// End-of-shift report (Shift_Reports tab). One row per Date+Shift, append-only.
export type ShiftReport = {
  report_id: string; date: string; shift: string;
  start_viper: string; start_viper_notes: string;
  start_axxis: string; start_axxis_notes: string;
  dead_time: boolean; dead_time_reasons: string;
  staff_all_present: boolean; staff_missing_count: number; staff_missing_reason: string; staff_notes: string;
  qc_issues: boolean; qc_notes: string;
  materials_shortage: boolean; materials_notes: string;
  handover_notes: string; other_notes: string;
  submitted_by: string; submitted_at: string | null;
};

// Reference / cheat-sheet data for the Capabilities tab.
export type ManufacturableLength = { line: string; length_display: string; length_numeric: number; active: boolean };

// One production capability (from Manufacturing_Capabilities — auto-generated
// from historical finished-good boxes). Box weights/dimensions per variant.
export type Capability = {
  line: string; product_type: string; length: string; delay: string; packaging_class: string;
  financial_no: string; mfr_part_no: string; units_per_box: number; box_dimensions: string;
  weight_avg: number; weight_min: number; weight_max: number; boxes_recorded: number;
  first_produced: string; last_produced: string;
};
// Editable Manufacturing_Reference tab: rows grouped by Section.
export type RefRow = { section: string; item: string; value: string; detail: string; colour: string };

// An issued Bill of Lading, from the BOL_Register tab (immutable once written).
export type IssuedBol = {
  bol_no: string; created_at: string; created_by: string; date: string;
  ship_from: string; ship_to: string; truck: string; trailer: string;
  consignor_name: string; driver_name: string;
  total_packages: number; total_quantity: number; total_neq_kg: number;
  include_neq: boolean; classes: string; box_qrs: string; lines_json: string; status: string;
  signature_url: string;   // captured receiver signature (embedded on reprint)
};

// A captured receiver signature, from the Signatures tab. Written automatically
// by the BlastStock scanner app when an operator completes a bulk sale with a
// signature. Looked up by PO_Number when building a BOL. The Drive_URL serves
// the transparent PNG directly (publicly, no auth) for use as an <img> src.
export type Signature = {
  timestamp: string;
  po_number: string;
  receiver_name: string;
  drive_file_id: string;
  drive_url: string;
  operator: string;
  item_count: number;
};

// A line item inside an NDT batch (NDT_Batch_Contents tab).
export type BatchContent = {
  timestamp: string | null;
  batch_qr: string;
  line: string;            // Production_Line
  item: string;            // Item_Description
  quantity: number;
  unit: string;            // pieces | meters | …
  entry_type: string;      // QC Sample | Waste | Production | …
  logged_by: string;
  assembly_group: string;
  notes: string;
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

function mapTicket(r: Record<string, string>): Ticket {
  return {
    id: r["Ticket_ID"] ?? "", line: r["Line"] ?? "", line_detail: r["Line_Detail"] ?? "",
    title: r["Title"] ?? "", description: r["Description"] ?? "",
    severity: r["Severity"] ?? "", status: r["Status"] ?? "",
    created_by: r["Created_By"] ?? "", created_at: orNull(r["Created_At"]),
    assigned_to: r["Assigned_To"] ?? "", assigned_at: orNull(r["Assigned_At"]),
    closed_by: r["Closed_By"] ?? "", closed_at: orNull(r["Closed_At"]), resolution: r["Resolution"] ?? "",
    parts_count: toNum(r["Parts_Count"]), photo_count: toNum(r["Photo_Count"]), reopen_count: toNum(r["Reopen_Count"]),
    last_updated_at: orNull(r["Last_Updated_At"]), last_updated_by: r["Last_Updated_By"] ?? "",
  };
}
function mapTicketEvent(r: Record<string, string>): TicketEvent {
  return {
    timestamp: orNull(r["Timestamp"]), ticket_id: r["Ticket_ID"] ?? "", event_type: r["Event_Type"] ?? "",
    user: r["User"] ?? "", from_value: r["From_Value"] ?? "", to_value: r["To_Value"] ?? "",
    notes: r["Notes"] ?? "", photo_url: r["Photo_URL"] ?? "", part_qr: r["Part_QR"] ?? "",
    part_description: r["Part_Description"] ?? "", qty_used: toNum(r["Qty_Used"]), correlation_id: r["Correlation_ID"] ?? "",
  };
}

// Numbers in Manufacturing_Capabilities that Sheets auto-formatted as dates
// (small integers like a box count) come back as "1900-01-23" — recover the
// underlying serial. Plain numeric strings pass straight through.
function capNum(v?: string): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.slice(0, 10) + "T00:00:00Z"), base = Date.parse("1899-12-30T00:00:00Z");
    if (!isNaN(t)) return Math.round((t - base) / 86400000);
  }
  const n = parseFloat(s.replace(/[, ]/g, ""));
  return isNaN(n) ? 0 : n;
}
function mapCapability(r: Record<string, string>): Capability {
  // The first column header is merged with a title note, so resolve it by suffix.
  const lineKey = r["Production_Line"] !== undefined ? "Production_Line" : (Object.keys(r).find((k) => k.trim().endsWith("Production_Line")) ?? "Production_Line");
  return {
    line: (r[lineKey] ?? "").trim(), product_type: r["ProductType"] ?? "", length: r["Length"] ?? "",
    delay: r["Delay_Combination"] ?? "", packaging_class: r["Packaging_Class"] ?? "",
    financial_no: r["Financial_No"] ?? "", mfr_part_no: r["Mfr_Part_No"] ?? "",
    units_per_box: capNum(r["Units_Per_Box"]), box_dimensions: r["Box_Dimensions"] ?? "",
    weight_avg: capNum(r["Box_Weight_Kg_Avg"]), weight_min: capNum(r["Box_Weight_Kg_Min"]), weight_max: capNum(r["Box_Weight_Kg_Max"]),
    boxes_recorded: capNum(r["Boxes_Recorded"]),
    first_produced: r["First_Produced"] ?? "", last_produced: r["Last_Produced"] ?? "",
  };
}

function mapShiftReport(r: Record<string, string>): ShiftReport {
  const yn = (v: string | undefined) => /^y/i.test(String(v ?? "").trim());   // "Yes" → true
  return {
    report_id: r["Report_ID"] ?? "", date: r["Date"] ?? "", shift: r["Shift"] ?? "",
    start_viper: r["Start_Status_ViperDet"] ?? "", start_viper_notes: r["Start_Notes_ViperDet"] ?? "",
    start_axxis: r["Start_Status_Axxis"] ?? "", start_axxis_notes: r["Start_Notes_Axxis"] ?? "",
    dead_time: yn(r["Dead_Time"]), dead_time_reasons: r["Dead_Time_Reasons"] ?? "",
    staff_all_present: yn(r["Staff_All_Present"]), staff_missing_count: toNum(r["Staff_Missing_Count"]),
    staff_missing_reason: r["Staff_Missing_Reason"] ?? "", staff_notes: r["Staff_Notes"] ?? "",
    qc_issues: yn(r["QC_Issues"]), qc_notes: r["QC_Notes"] ?? "",
    materials_shortage: yn(r["Materials_Shortage"]), materials_notes: r["Materials_Notes"] ?? "",
    handover_notes: r["Handover_Notes"] ?? "", other_notes: r["Other_Notes"] ?? "",
    submitted_by: r["Submitted_By"] ?? "", submitted_at: orNull(r["Submitted_At"]),
  };
}

function mapInventoryRow(r: Record<string, string>): InventoryItem {
  return {
    qr: r["QR"] ?? "",
    description: r["Description"] ?? "",
    type: r["Type"] || "Unknown",
    current_quantity: toNum(r["Current_Quantity"]),
    original_quantity: toNum(r["Original_Quantity"]),
    critical_level: r["Original_Critical_Level"]?.trim() ? toNum(r["Original_Critical_Level"]) : null,
    financial_no: r["Financial_No"] ?? "",
    current_location: r["Current_Location"] ?? "",
    current_sub_location: r["Current_Sub_Location"] ?? "",
    status: r["Status"] || "Unknown",
    last_updated_at: orNull(r["Last_Updated_At"] ?? ""),
    last_updated_by: r["Last_Updated_By"] ?? "",
    first_seen_at: orNull(r["First_Seen_At"] ?? ""),
    destruction_date: orNull(r["Destruction_Date"] ?? ""),
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

function mapIssuedBol(r: Record<string, string>): IssuedBol {
  return {
    bol_no: r["BOL_No"] ?? "", created_at: r["Created_At"] ?? "", created_by: r["Created_By"] ?? "",
    date: r["Date"] ?? "", ship_from: r["Ship_From"] ?? "", ship_to: r["Ship_To"] ?? "",
    truck: r["Truck"] ?? "", trailer: r["Trailer"] ?? "", consignor_name: r["Consignor_Name"] ?? "",
    driver_name: r["Driver_Name"] ?? "", total_packages: toNum(r["Total_Packages"]),
    total_quantity: toNum(r["Total_Quantity"]), total_neq_kg: toNum(r["Total_NEQ_kg"]),
    include_neq: /true/i.test(r["Include_NEQ"] ?? ""), classes: r["Classes"] ?? "",
    box_qrs: r["Box_QRs"] ?? "", lines_json: r["Lines_JSON"] ?? "", status: r["Status"] ?? "",
    signature_url: r["Signature_URL"] ?? "",
  };
}

// Extract a Drive file id from an explicit id field or any Drive URL shape.
function driveFileId(idField: string, urlField: string): string {
  if (idField && idField.trim()) return idField.trim();
  const s = urlField || "";
  const m = s.match(/\/d\/([-\w]+)/) || s.match(/[?&]id=([-\w]+)/) || s.match(/[-\w]{25,}/);
  return m ? (m[1] || m[0]) : "";
}
function mapSignatureRow(r: Record<string, string>): Signature {
  const id = driveFileId(r["Drive_File_ID"] ?? "", r["Drive_URL"] ?? "");
  // Drive's thumbnail endpoint embeds reliably in <img> and prints, unlike
  // uc?export=view (the file must be shared "anyone with link").
  const url = id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : (r["Drive_URL"] ?? "").trim();
  return {
    timestamp: r["Timestamp"] ?? "",
    po_number: r["PO_Number"] ?? "",
    receiver_name: r["Receiver_Name"] ?? "",
    drive_file_id: id,
    drive_url: url,
    operator: r["Operator"] ?? "",
    item_count: toNum(r["Item_Count"]),
  };
}

function mapBatchContentRow(r: Record<string, string>): BatchContent {
  return {
    timestamp: orNull(r["Timestamp"] ?? ""),
    batch_qr: r["Batch_QR"] ?? "",
    line: r["Production_Line"] ?? "",
    item: r["Item_Description"] ?? "",
    quantity: toNum(r["Quantity"]),
    unit: r["Unit"] ?? "",
    entry_type: r["Entry_Type"] ?? "",
    logged_by: r["Logged_By"] ?? "",
    assembly_group: r["Assembly_Group_Id"] ?? "",
    notes: r["Notes"] ?? "",
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

// On-demand LIVE reads that bypass the gviz cache by hitting the Apps Script
// /exec directly. Google caches the gviz CSV for minutes, so a just-written
// correction won't show via gviz; these give an immediate, authoritative read
// after a write or a manual refresh. Cheap because they run only on demand.
const LIVE_BASE = API_BASE || BOL_API;
async function liveJson<T>(action: string): Promise<T> {
  const res = await fetch(`${LIVE_BASE}?action=${encodeURIComponent(action)}`, { cache: "no-store" });
  const j = await res.json();
  if (j && (j as { error?: string }).error) throw new Error((j as { error?: string }).error);
  return j as T;
}

// ── Public client — the only thing the UI imports ───────────────────────────
export const api = {
  mode: MODE,
  liveEnabled: !!LIVE_BASE,
  stockOnHandLive(): Promise<StockResponse> { return liveJson<StockResponse>("stockOnHand"); },
  transactionsLive(): Promise<TransactionResponse> { return liveJson<TransactionResponse>("transactions"); },
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
  async batchContents(): Promise<{ items: BatchContent[] }> {
    if (MODE === "gviz") return { items: (await gvizTab("NDT_Batch_Contents")).map(mapBatchContentRow).filter((c) => c.batch_qr) };
    return getJson<{ items: BatchContent[] }>("batchContents");
  },
  // Maintenance/breakdown tickets (Tickets + Ticket_Events tabs). Tolerate absence.
  async tickets(): Promise<{ items: Ticket[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Tickets")).map(mapTicket).filter((t) => t.id) };
      return await getJson<{ items: Ticket[] }>("tickets");
    } catch { return { items: [] }; }
  },
  async ticketEvents(): Promise<{ items: TicketEvent[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Ticket_Events")).map(mapTicketEvent).filter((e) => e.ticket_id) };
      return await getJson<{ items: TicketEvent[] }>("ticketEvents");
    } catch { return { items: [] }; }
  },
  async eosReports(): Promise<{ items: ShiftReport[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Shift_Reports")).map(mapShiftReport).filter((r) => r.report_id) };
      return await getJson<{ items: ShiftReport[] }>("eosReports");
    } catch { return { items: [] }; }
  },
  async manufacturableLengths(): Promise<{ items: ManufacturableLength[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Manufacturable_Lengths")).map((r) => ({
        line: r["Production_Line"] ?? "", length_display: r["Length_Display"] ?? "",
        length_numeric: toNum(r["Length_Numeric"]), active: /true/i.test(r["Active"] ?? ""),
      })).filter((l) => l.line) };
      return await getJson<{ items: ManufacturableLength[] }>("manufacturableLengths");
    } catch { return { items: [] }; }
  },
  async manufacturingCapabilities(): Promise<{ items: Capability[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Manufacturing_Capabilities")).map(mapCapability).filter((c) => c.line === "ViperDet" || c.line === "Axxis") };
      return await getJson<{ items: Capability[] }>("manufacturingCapabilities");
    } catch { return { items: [] }; }
  },
  // Manufacturing_Reference is a tab the team creates — tolerate its absence.
  async manufacturingReference(): Promise<{ items: RefRow[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Manufacturing_Reference")).map((r) => ({
        section: r["Section"] ?? "", item: r["Item"] ?? "", value: r["Value"] ?? "",
        detail: r["Detail"] ?? "", colour: r["Colour"] ?? "",
      })).filter((r) => r.section) };
      return await getJson<{ items: RefRow[] }>("manufacturingReference");
    } catch { return { items: [] }; }
  },

  // ── Bill of Lading register (write-back) ───────────────────────────────────
  bolEnabled: !!BOL_API,
  async registerBol(payload: Record<string, unknown>): Promise<{ bol_no: string; created_at: string }> {
    if (!BOL_API) throw new Error("BOL register not configured (set NEXT_PUBLIC_BOL_API).");
    // text/plain avoids a CORS preflight Apps Script can't answer.
    const res = await fetch(BOL_API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "createBol", ...payload }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    return j;
  },
  // Amend the PO number and/or customer on one or more sold boxes (manager
  // correction from the dashboard). Writes to Inventory_Master and appends an
  // audited PO_UPDATE / CUSTOMER_UPDATE transaction per changed field. Empty
  // values are left unchanged. Reprinting a box's BOL then carries the new PO.
  async amendSale(qrs: string[], changes: { po?: string; customer?: string; markSold?: boolean }, user: string): Promise<{ updated: number; txns: number; qrs: string[]; po: string; customer: string }> {
    if (!BOL_API) throw new Error("Sale amendment not configured (set NEXT_PUBLIC_BOL_API).");
    const res = await fetch(BOL_API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "amendSale", qrs, po: changes.po ?? "", customer: changes.customer ?? "", mark_sold: !!changes.markSold, user }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    return j;
  },
  async bols(): Promise<{ items: IssuedBol[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("BOL_Register")).map(mapIssuedBol).filter((b) => b.bol_no) };
      return await getJson<{ items: IssuedBol[] }>("bols");
    } catch { return { items: [] }; }
  },
  // Captured receiver signatures (Signatures tab). Tolerate the tab's absence.
  async signatures(): Promise<{ items: Signature[] }> {
    try {
      if (MODE === "gviz") return { items: (await gvizTab("Signatures")).map(mapSignatureRow).filter((s) => s.po_number) };
      return await getJson<{ items: Signature[] }>("signatures");
    } catch { return { items: [] }; }
  },
};
