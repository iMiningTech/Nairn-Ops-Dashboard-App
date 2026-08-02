// Consolidated monthly report builder. Emits ONE Markdown document for a
// selected month, pulling the exact same aggregations the dashboard tabs use so
// the figures always match. Designed as an input for an LLM (Claude Desktop)
// that drafts the human monthly report — every tab rendered as clean Markdown
// tables rather than a PDF an LLM would have to parse.
//
// Period model: the report is calendar-month oriented. Production, breakdowns
// and QC are computed per month prefix (YYYY-MM); operators, destruction, sales
// and reconciliation use the exact [from,to] day range of that month (capped at
// today for the in-progress month). Inventory sections are a live "as of now"
// snapshot and are labelled as such.

import type { InventoryItem, Transaction, User, DailyTarget, Breakdown, QcCheck, BatchContent } from "@/lib/api";
import { fmtNum, fmtMins, fmtClock, shortDay, fmtDate, fmtTime } from "@/lib/utils";
import {
  monthTotals, productionByDay, productionVariants, startDeadtimeByDay,
  inventoryMatrix, agedFinishedGoods, lowStock, SITE_ROOMS, PROD_FAMILIES, type MatrixResult,
} from "@/lib/production";
import { operatorStats, inactiveRosterUsers } from "@/lib/operators";
import { breakdownSummary, qcSummary, logDayKey } from "@/lib/logs";
import { destroyedInRange, wasteInRange, consolidateDestroyed, awaitingDestruction } from "@/lib/destruction";
import { saleEvents, salesSummary } from "@/lib/sales";
import { reconcilePools, reconcileRooms, inRange, type DateRange } from "@/lib/pools";

export type ReportInput = {
  items: InventoryItem[];
  txns: Transaction[];
  users: User[];
  targets: DailyTarget[];
  breakdowns: Breakdown[];
  qc: QcCheck[];
  contents: BatchContent[];
  month: string;               // "YYYY-MM"
  todayKey: string;            // site-local today, YYYY-MM-DD
  generatedAt?: string | null; // data freshness
  shiftStartHour?: number;
};

const nf = (n: number) => fmtNum(n);
const esc = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

function mdTable(headers: string[], rows: (string | number)[][], align?: ("l" | "r")[]): string {
  if (!rows.length) return "_None._\n";
  const sep = headers.map((_, i) => (align?.[i] === "r" ? "---:" : "---"));
  const line = (cells: (string | number)[]) => `| ${cells.map((c) => esc(String(c))).join(" | ")} |`;
  return [`| ${headers.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...rows.map(line)].join("\n") + "\n";
}

function matrixTable(m: MatrixResult): string {
  if (!m.rows.length) return "_No stock._\n";
  const headers = ["Description", ...m.locations, "Total"];
  const align = headers.map((_, i) => (i === 0 ? "l" : "r")) as ("l" | "r")[];
  const rows: (string | number)[][] = m.rows.map((r) => [
    r.description, ...m.locations.map((l) => (r.cells[l] ? nf(r.cells[l]) : "—")), nf(r.total),
  ]);
  rows.push(["**Total on site**", ...m.locations.map((l) => `**${nf(m.colTotals[l])}**`), `**${nf(m.grandTotal)}**`]);
  return mdTable(headers, rows, align);
}

function monthMeta(month: string, todayKey: string) {
  const [y, mm] = month.split("-").map(Number);
  const label = new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const days = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  const from = `${month}-01`;
  const lastDay = `${month}-${String(days).padStart(2, "0")}`;
  const to = lastDay > todayKey ? todayKey : lastDay;   // cap the in-progress month at today
  return { label, from, to, range: { from, to } as DateRange };
}

export function buildMonthlyReport(inp: ReportInput): string {
  const { items, txns, users, targets, breakdowns, qc, contents, month, todayKey } = inp;
  const shiftStart = inp.shiftStartHour ?? 6;
  const { label, from, to, range } = monthMeta(month, todayKey);
  const out: string[] = [];
  const P = (s = "") => out.push(s);

  // ── Header ────────────────────────────────────────────────────────────────
  P(`# Nairn Det Plant — Monthly Operations Report`);
  P(`**Period:** ${label}  ·  ${shortDay(from)} → ${shortDay(to)}`);
  P(`**Generated:** ${fmtTime(inp.generatedAt) || "—"} (data freshness) · export ${label}`);
  P(`> Production, breakdowns and QC are for the whole calendar month. Operators, destruction, sales and reconciliation cover ${shortDay(from)}–${shortDay(to)}. Inventory sections are a live snapshot as of the generated time above.`);
  P();

  // ── 1. Executive KPIs ───────────────────────────────────────────────────────
  const sd = startDeadtimeByDay(items, txns, shiftStart, month);
  const tot = monthTotals(items, month);
  const prod = productionByDay(items, month);
  const qcS = qcSummary(qc, todayKey, month);
  const bdS = breakdownSummary(breakdowns, month);
  const targetByDay = new Map<string, number>();
  for (const t of targets) if (t.date.startsWith(month)) targetByDay.set(t.date, (targetByDay.get(t.date) || 0) + t.quantity);
  const prodByDay = new Map(prod.rows.map((r) => [r.day, PROD_FAMILIES.reduce((s, f) => s + (Number((r as unknown as Record<string, number>)[f]) || 0), 0)]));
  const targetDays = [...targetByDay.keys()];
  const metDays = targetDays.filter((d) => (prodByDay.get(d) || 0) >= (targetByDay.get(d) || 0)).length;

  P(`## 1. Executive summary`);
  P(mdTable(["Metric", "Value", "Detail"], [
    ["Production (units)", nf(tot.total), `best day ${prod.best.day ? shortDay(prod.best.day) : "—"} · ${sd.rows.length} production day(s)`],
    ["Avg start deadtime", fmtMins(sd.avg), `time from shift start (${fmtClock(shiftStart * 60)}) to first sticker`],
    ["Targets met", targetDays.length ? `${metDays}/${targetDays.length}` : "—", "days at/above target"],
    ["QC pass rate", qcS.monthRate != null ? `${Math.round(qcS.monthRate * 100)}%` : "—", `${qcS.monthChecks} checks`],
    ["Breakdowns", nf(bdS.monthCount), `${bdS.byLine.ViperDet} ViperDet · ${bdS.byLine.Axxis} Axxis`],
    ["Downtime", fmtMins(bdS.monthDowntimeMin), "logged breakdown time"],
  ], ["l", "r", "l"]));
  P();

  // ── 2. Production & efficiency ──────────────────────────────────────────────
  P(`## 2. Production & efficiency`);
  P(`### Production totals by product family`);
  P(mdTable(["Family", "Units"], [
    ...tot.families.map((f) => [f.name, nf(f.value)]),
    ["**Grand total**", `**${nf(tot.total)}**`],
  ], ["l", "r"]));

  P(`### Production by day`);
  P(mdTable(["Day", ...PROD_FAMILIES, "Total"],
    prod.rows.map((r) => {
      const fam = PROD_FAMILIES.map((f) => Number((r as unknown as Record<string, number>)[f]) || 0);
      return [shortDay(r.day), ...fam.map(nf), nf(fam.reduce((s, n) => s + n, 0))];
    }),
    ["l", "r", "r", "r", "r", "r"]));

  P(`### Manufactured by product & length`);
  const variants = productionVariants(items, (d) => d.startsWith(month));
  P(mdTable(["Product", "Delay", "Length", "Boxes", "Units"],
    variants.map((v) => [v.product, v.delay, v.length, nf(v.boxes), nf(v.qty)]),
    ["l", "l", "l", "r", "r"]));
  P(`_${variants.length} variant(s) · ${nf(variants.reduce((s, v) => s + v.qty, 0))} units._`);

  P(`### Shift-start deadtime by day`);
  P(`Time from shift start (${fmtClock(shiftStart * 60)}) to the first production sticker each day — the metric to drive down. Avg **${fmtMins(sd.avg)}**${sd.worst ? ` · worst ${shortDay(sd.worst.day)} (${fmtMins(sd.worst.startDeadtimeMin)})` : ""}${sd.best ? ` · best ${shortDay(sd.best.day)} (${fmtMins(sd.best.startDeadtimeMin)})` : ""}.`);
  P(mdTable(["Day", "First sticker", "Start deadtime"],
    sd.rows.map((r) => [shortDay(r.day), fmtClock(r.firstMin), fmtMins(r.startDeadtimeMin)]),
    ["l", "r", "r"]));
  P();

  // ── 3. Operators ────────────────────────────────────────────────────────────
  P(`## 3. Operators`);
  const scoped = txns.filter((t) => inRange(t, range));
  const stats = operatorStats(scoped, users);
  const inactive = inactiveRosterUsers(scoped, users);
  const flagged = stats.filter((s) => s.flags.length);
  P(`${stats.length} operator(s) active in period · ${flagged.length} flagged · ${inactive.length} on roster with no activity${inactive.length ? ` (${inactive.join(", ")})` : ""}.`);
  P(mdTable(["Operator", "Actions", "Active days", "Reasons used", "Top reason", "% corrections", "Last activity", "Flags"],
    stats.map((s) => [
      s.user, nf(s.actions), nf(s.activeDays), nf(s.distinctReasons),
      s.reasons[0]?.name ?? "—", `${Math.round(s.correctionShare * 100)}%`,
      fmtTime(s.lastActivity), s.flags.join(" · ") || "—",
    ]),
    ["l", "r", "r", "r", "l", "r", "l", "l"]));
  P();

  // ── 4. Breakdowns & QC ──────────────────────────────────────────────────────
  P(`## 4. Breakdowns & QC`);
  P(`### Breakdowns — ${label}`);
  P(`${nf(bdS.monthCount)} breakdown(s) · ${fmtMins(bdS.monthDowntimeMin)} downtime · ${bdS.byLine.ViperDet} ViperDet / ${bdS.byLine.Axxis} Axxis.`);
  if (bdS.byStation.length) {
    P(`**By station:** ` + bdS.byStation.map((s) => `${s.name} (${s.value})`).join(", "));
  }
  if (bdS.byNature.length) {
    P(`**By nature:** ` + bdS.byNature.map((s) => `${s.name} (${s.value})`).join(", "));
  }
  const bdLog = breakdowns
    .filter((b) => logDayKey(b.at).startsWith(month))
    .slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  P(`### Breakdown log`);
  P(mdTable(["When", "Line", "Station", "Nature", "Mins", "By", "Detail"],
    bdLog.map((b) => [fmtTime(b.at), b.line, b.station || "—", b.nature, nf(b.duration_min), b.personnel || "—", b.info || "—"]),
    ["l", "l", "l", "l", "r", "l", "l"]));

  P(`### QC crimp checks — ${label}`);
  const qcFailsMonth = qc.filter((q) => q.status === "Fail" && logDayKey(q.at).startsWith(month))
    .slice().sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0));
  P(`${nf(qcS.monthChecks)} check(s) · pass rate ${qcS.monthRate != null ? `${Math.round(qcS.monthRate * 100)}%` : "—"} · ${qcFailsMonth.length} fail(s).`);
  if (qcFailsMonth.length) {
    const mm = (n: number | null) => (n == null ? "—" : `${n}mm`);
    P(mdTable(["When", "Operator", "Check", "Mid", "Inhole", "Outhole"],
      qcFailsMonth.map((q) => [fmtTime(q.at), q.personnel || "—", q.type || "—", mm(q.mid_mm), mm(q.inhole_mm), mm(q.outhole_mm)]),
      ["l", "l", "l", "r", "r", "r"]));
  }
  P();

  // ── 5. Destruction & Waste ──────────────────────────────────────────────────
  P(`## 5. Destruction & waste`);
  const { batches, direct, lineItems } = destroyedInRange(items, txns, contents, from, to);
  const consolidated = consolidateDestroyed(lineItems);
  const waste = wasteInRange(contents, from, to);
  const awaiting = awaitingDestruction(items, contents);
  P(`${batches.length} NDT batch(es) destroyed · ${direct.length} direct destruction(s) · ${waste.length} waste entr(y/ies) · ${awaiting.length} batch(es) awaiting destruction (live).`);

  P(`### Consolidated destruction summary`);
  P(`Every distinct item destroyed across all batches in the period, quantities summed. Includes waste entries logged inside batches.`);
  P(mdTable(["Item", "Entry types", "Batches", "Unit", "Total Qty"],
    consolidated.map((c) => [c.item, c.entryTypes, nf(c.batches), c.unit, nf(c.qty)]),
    ["l", "l", "r", "l", "r"]));

  P(`### NDT batches destroyed`);
  P(mdTable(["Destroyed", "Batch QR", "Line", "Items", "Pieces", "Metres", "By"],
    batches.map((b) => [fmtTime(b.at), b.qr, b.line || "—", nf(b.lines), nf(b.pieces), nf(b.meters), b.destroyer || "—"]),
    ["l", "l", "l", "r", "r", "r", "l"]));

  P(`### Direct destructions (labels → T1)`);
  P(mdTable(["Destroyed", "Barcode", "Description", "Type", "Qty"],
    direct.map((d) => [fmtTime(d.at), d.qr, d.description, d.type, nf(d.qty)]),
    ["l", "l", "l", "l", "r"]));

  P(`### Waste entries`);
  P(mdTable(["When", "Batch QR", "Line", "Item", "Qty", "Unit", "Logged by"],
    waste.map((w) => [fmtTime(w.at), w.batch_qr, w.line || "—", w.item, nf(w.qty), w.unit, w.logged_by || "—"]),
    ["l", "l", "l", "l", "r", "l", "l"]));
  P();

  // ── 6. Sales ────────────────────────────────────────────────────────────────
  P(`## 6. Sales`);
  const sales = salesSummary(saleEvents(items, txns), from, to);
  P(`${nf(sales.volume)} units sold · ${nf(sales.boxes)} boxes · ${sales.byPo.length} PO(s) · customers: ${sales.customers.join(", ") || "—"}.`);
  P(`### Sales by PO`);
  P(mdTable(["PO number", "Customer", "Boxes", "Volume (units)"],
    sales.byPo.map((p) => [p.po, p.customer || "—", nf(p.boxes), nf(p.volume)]),
    ["l", "l", "r", "r"]));
  P(`### Sale log`);
  P(mdTable(["Sold", "Barcode", "Description", "Product", "Qty", "PO", "Customer"],
    sales.events.map((e) => [fmtTime(e.at), e.qr, e.description, e.product || "—", nf(e.qty), e.po || "—", e.customer || "—"]),
    ["l", "l", "l", "l", "r", "l", "l"]));
  P();

  // ── 7. Current inventory snapshot (live) ────────────────────────────────────
  P(`## 7. Current inventory snapshot`);
  P(`_Live "as of now" figures — not bound to the reporting period._`);

  const fg = inventoryMatrix(items, true, SITE_ROOMS);
  const aged = agedFinishedGoods(items);
  const over12 = aged.filter((b) => b.ageDays > 365);
  const over24 = aged.filter((b) => b.ageDays > 730);
  const sumQty = (xs: typeof aged) => xs.reduce((s, b) => s + b.qty, 0);
  P(`### Finished goods on hand — by location`);
  P(`${nf(aged.length)} sellable boxes · ${nf(sumQty(aged))} units. Shelf-age: ${nf(over12.length)} box(es) over 12 months (${nf(sumQty(over12))} units), ${nf(over24.length)} over 24 months — expired, cannot be sold (${nf(sumQty(over24))} units).`);
  P(matrixTable(fg));

  P(`### Raw materials on hand — by location`);
  P(matrixTable(inventoryMatrix(items, false, SITE_ROOMS)));

  P(`### Low material alerts`);
  const low = lowStock(items);
  P(mdTable(["Description", "On hand", "Critical", "Location"],
    low.map((l) => [l.description, nf(l.quantity), nf(l.critical), l.location || "—"]),
    ["l", "r", "r", "l"]));

  P(`### Reconciliation (explosive pools)`);
  const recon = reconcilePools(items, txns, range);
  const rooms = reconcileRooms(recon);
  const reconFlagged = recon.filter((p) => !p.matches);
  const interventions = recon.reduce((s, p) => s + p.interventions, 0);
  P(`${recon.length} pool(s) reconciled · ${reconFlagged.length} out of balance · ${interventions} manual fix(es) in period.`);
  P(mdTable(["Room", "Pools", "On hand", "In", "Out", "Net", "Flagged", "Manual fixes"],
    rooms.map((r) => [r.room, nf(r.pools), nf(r.actual), nf(r.in_qty), nf(r.out_qty), (r.net > 0 ? "+" : "") + nf(r.net), nf(r.flagged), nf(r.interventions)]),
    ["l", "r", "r", "r", "r", "r", "r", "r"]));
  if (reconFlagged.length) {
    P(`**Pools out of balance:**`);
    P(mdTable(["Pool QR", "Description", "Room", "Actual", "Calc (log)", "Diff"],
      reconFlagged.map((p) => [p.qr, p.description, p.location || "—", nf(p.actual), p.calculated == null ? "—" : nf(p.calculated), (p.diff > 0 ? "+" : "") + nf(p.diff)]),
      ["l", "l", "l", "r", "r", "r"]));
  }
  P();
  P(`---`);
  P(`_Generated from the Nairn Det Plant dashboard. Figures mirror the corresponding dashboard tabs for ${label}._`);

  return out.join("\n");
}
