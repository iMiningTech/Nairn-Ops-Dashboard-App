/**
 * Nairn Det Plant — Dashboard read-only API (Google Apps Script Web App)
 * ──────────────────────────────────────────────────────────────────────────────
 * Read-only JSON endpoints for the Inventory Operations dashboard. This is the
 * data layer that the static Next.js front-end (S3 + CloudFront) fetches from.
 * It returns JSON ALREADY IN THE SHAPE the dashboard's lib/api.ts expects, so the
 * future migration to AWS is a backend swap: re-implement these same shapes
 * behind an AWS API and re-point NEXT_PUBLIC_API_BASE — nothing in the UI changes.
 *
 * This script ONLY READS. It never writes inventory data — all writes happen
 * through the BlastStock scanner app's existing flows.
 *
 * ── Deploy ──────────────────────────────────────────────────────────────────
 *  1. Open the "Nairn Det Plant Inventory Labels" spreadsheet.
 *  2. Extensions → Apps Script. Paste this file (or add it as a new .gs).
 *     (Or run it standalone and set SHEET_ID below to the spreadsheet id.)
 *  3. Deploy → New deployment → type "Web app".
 *       Execute as: Me   ·   Who has access: Anyone
 *     (Read-only public data on an internal screen; add a token below to gate it.)
 *  4. Copy the /exec URL → set it as NEXT_PUBLIC_API_BASE in the web app's
 *     .env.local, with NEXT_PUBLIC_DATA_MODE=appsscript.
 *
 * Endpoints (GET ?action=…):
 *   ?action=stockOnHand    → { generated_at, count, items: [InventoryItem] }
 *   ?action=transactions   → { generated_at, count, items: [Transaction] }
 *   ?action=users          → { items: [User] }   (from User_Management)
 *   ?action=targets        → { items: [DailyTarget] }  (from Daily_Targets, if present)
 *
 * The dashboard computes production, pool flows, reconciliation and operator
 * stats client-side from these feeds, so that logic is identical in dev (gviz)
 * and prod (Apps Script) and survives the AWS swap. This script just serves the
 * raw-ish shapes.
 */

// Leave blank if this script is BOUND to the spreadsheet (Extensions → Apps
// Script). Set to the spreadsheet id only if running it as a standalone script.
var SHEET_ID = '';

// Optional shared-secret. If non-empty, requests must include &token=THIS_VALUE
// (the web app sets NEXT_PUBLIC_API_TOKEN to match). Blank = no token check.
var API_TOKEN = '';

function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    if (API_TOKEN && params.token !== API_TOKEN) {
      return _json({ error: 'unauthorized' });
    }
    switch (params.action) {
      case 'stockOnHand':  return _json(stockOnHand_());
      case 'transactions': return _json(transactions_());
      case 'users':        return _json(users_());
      case 'targets':      return _json(targets_());
      default:             return _json({ error: 'unknown action', actions: ['stockOnHand', 'transactions', 'users', 'targets'] });
    }
  } catch (err) {
    return _json({ error: String(err && err.message || err) });
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

function stockOnHand_() {
  var rows = readTab_('Inventory_Master');
  var items = rows.map(mapInventory_);
  return { generated_at: new Date().toISOString(), count: items.length, items: items };
}

function transactions_() {
  var rows = readTab_('Transaction_Log');
  var items = rows.map(mapTransaction_);
  return { generated_at: new Date().toISOString(), count: items.length, items: items };
}

function users_() {
  var rows = readTab_('User_Management');
  var items = rows.map(function (r) {
    return { name: str_(r['Name']), pin: str_(r['PIN']), auth_level: str_(r['Auth_Level']),
             active: str_(r['Active']), email: str_(r['Email']) };
  }).filter(function (u) { return u.name; });
  return { items: items };
}

// Daily_Targets is a tab the team still needs to create — return [] if absent.
function targets_() {
  var sheet = _ss().getSheetByName('Daily_Targets');
  if (!sheet) return { items: [] };
  var rows = readTab_('Daily_Targets');
  var items = rows.map(function (r) {
    return { date: iso_(r['Date']), production_line: str_(r['Production_Line']), product: str_(r['Product']),
             specifics: str_(r['Specifics']), quantity: num_(r['Target_Quantity'] || r['Quantity']) };
  });
  return { items: items };
}

// ── Mapping (sheet headers → contract shape) ─────────────────────────────────

function mapInventory_(r) {
  return {
    qr: str_(r['QR']),
    description: str_(r['Description']),
    type: str_(r['Type']) || 'Unknown',
    current_quantity: num_(r['Current_Quantity']),
    original_quantity: num_(r['Original_Quantity']),
    critical_level: str_(r['Original_Critical_Level']) ? num_(r['Original_Critical_Level']) : null,
    current_location: str_(r['Current_Location']),
    current_sub_location: str_(r['Current_Sub_Location']),
    status: str_(r['Status']) || 'Unknown',
    last_updated_at: iso_(r['Last_Updated_At']),
    last_updated_by: str_(r['Last_Updated_By']),
    first_seen_at: iso_(r['First_Seen_At']),
    product_type: str_(r['ProductType']),
    delay_display: str_(r['DelayDisplay']),
    length: str_(r['Length_M_String']),
    weight_kg: num_(r['WeightKg']),
    machine: str_(r['Machine']),
    manufacturer: str_(r['Manufacturer']),
    customer: str_(r['Customer']),
    po_number: str_(r['PO_Number']),
    sale_status: str_(r['Sale_Status']),
    prod_purpose: str_(r['ProdPurpose']),
    prod_date: iso_(r['ProdDate_Formatted']),
    prod_shift: str_(r['ProdShift']),
    qc_person: str_(r['QC_Person'])
  };
}

function mapTransaction_(r) {
  return {
    // Naive plant-local wall-clock (matches the gviz CSV exactly), so the
    // dashboard's shift-start/deadtime clock math is identical in both modes.
    timestamp: localTs_(r['Timestamp']),
    qr: str_(r['QR']),
    type: str_(r['Type']),
    field: str_(r['Field']),
    old_value: str_(r['Old_Value']),
    new_value: str_(r['New_Value']),
    reason: str_(r['Reason']),
    user: str_(r['User']),
    source: str_(r['Source']),
    notes: str_(r['Notes']),
    correlation_id: str_(r['Correlation_ID'])
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _ss() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

// Read a tab into an array of header-keyed objects.
function readTab_(name) {
  var sheet = _ss().getSheetByName(name);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = row[j];
    out.push(obj);
  }
  return out;
}

function str_(v) { return v == null ? '' : String(v).trim(); }
function num_(v) {
  var n = Number(String(v == null ? '' : v).replace(/[, ]/g, ''));
  return isNaN(n) ? 0 : n;
}
function iso_(v) {
  if (v == null || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v.toISOString();
  var t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

// Naive plant-local timestamp string "M/d/yyyy H:mm:ss" (preserves wall clock).
function localTs_(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, _ss().getSpreadsheetTimeZone(), 'M/d/yyyy H:mm:ss');
  }
  return String(v);
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
