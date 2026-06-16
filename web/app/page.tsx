"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  LayoutDashboard, Users, Package, Boxes, Wrench, Scale, RefreshCw, AlertCircle, AlertTriangle,
  CheckCircle2, Search, Download, Factory, ArrowRightLeft, Target, PackageCheck, Flame, ShieldCheck,
  CalendarRange, Wrench as WrenchIcon, ClipboardCheck, Receipt, Clock, X,
} from "lucide-react";
import { api, type InventoryItem, type Transaction, type User, type DailyTarget, type Breakdown, type QcCheck, type Decon } from "@/lib/api";
import { Card, CardBody, Stat, Badge } from "@/components/ui";
import { ChartCard, BarH, Donut, StackedBar } from "@/components/charts";
import { uniqueSorted, groupSum, maxDate } from "@/lib/data";
import {
  maintenancePools, reconcilePools, reconcileRooms, inRange,
  type PoolRecon, type RoomRecon, type DateRange,
} from "@/lib/pools";
import {
  todaysRecords, productionByDay, printedOn, movedToMagazinesOn,
  finishedGoodsInMagazines, lowStock, shiftTimeline, lastT1Destruction, startDeadtimeByDay, monthTotals,
  inventoryMatrix, agedFinishedGoods, SITE_ROOMS, PROD_FAMILIES,
  type LineRecord, type ShiftInfo, type MatrixResult, type AgedBox,
} from "@/lib/production";
import { operatorStats, inactiveRosterUsers, activeOperatorsOn, type OperatorStat } from "@/lib/operators";
import { breakdownSummary, qcSummary, lastDecon, logDayKey } from "@/lib/logs";
import { saleEvents, salesSummary } from "@/lib/sales";
import { TYPE_COLOURS } from "@/lib/colors";
import { fmtTime, fmtDate, fmtNum, todayKey, dayKeyOffset, shortDay, fmtMins, fmtClock, nowMinutesInTz } from "@/lib/utils";

const CUSTOMER = "Nairn Det Plant";
const SHIFT_START_HOUR = Number(process.env.NEXT_PUBLIC_SHIFT_START_HOUR) || 6;

const VIEWS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "monthly", label: "Monthly Report", icon: CalendarRange },
  { id: "operators", label: "Operators", icon: Users },
  { id: "breakdowns", label: "Breakdowns", icon: WrenchIcon },
  { id: "finished", label: "Finished Goods", icon: Boxes },
  { id: "rawmaterials", label: "Raw Materials", icon: Package },
  { id: "sales", label: "Sales History", icon: Receipt },
  { id: "stock", label: "Filtered Inventory", icon: Search },
  { id: "recon", label: "Reconciliation", icon: Scale },
  { id: "maint", label: "Maintenance Stores", icon: Wrench },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const FAMILY_COLOURS: Record<string, string> = { "MS DUAL": "#f5911e", QS: "#EDC948", TITANIUM: "#D37295", SILVER: "#4E79A7" };
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en-GB")}`;

// ── Soft access gate ─────────────────────────────────────────────────────────
function AccessGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(false);
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex === process.env.NEXT_PUBLIC_ACCESS_HASH) {
        try { localStorage.setItem("nairn_access", "1"); } catch { /* ignore */ }
        onUnlock();
      } else { setErr(true); setBusy(false); }
    } catch { setErr(true); setBusy(false); }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-2xl">
        <Image src="/imining_blue.png" alt="iMining" width={200} height={48} style={{ height: 40, width: "auto" }} className="mb-6" priority />
        <div className="text-lg font-semibold text-fg">{CUSTOMER} — Inventory Operations</div>
        <div className="mb-5 mt-1 text-sm text-muted">Enter the password to continue.</div>
        <input type="password" autoFocus value={pw} onChange={(e) => { setPw(e.target.value); setErr(false); }}
          placeholder="Password"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
        {err && <div className="mt-2 text-sm text-danger">Incorrect password.</div>}
        <button type="submit" disabled={busy || !pw}
          className="mt-4 w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Checking…" : "Enter"}
        </button>
        <div className="mt-5 text-center text-xs text-muted">Powered by iMining</div>
      </form>
    </div>
  );
}

export default function Dashboard() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [targets, setTargets] = useState<DailyTarget[]>([]);
  const [breakdowns, setBreakdowns] = useState<Breakdown[]>([]);
  const [qc, setQc] = useState<QcCheck[]>([]);
  const [decon, setDecon] = useState<Decon[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("overview");
  const [authed, setAuthed] = useState(false);
  const [tv, setTv] = useState(false);
  // Permanent date-range filter (applies to Operators, Breakdowns, Pool, Reconciliation).
  const [lo, setLo] = useState<string>(() => dayKeyOffset(-29));
  const [hi, setHi] = useState<string>(() => todayKey());
  const [preset, setPreset] = useState<string>("30d");
  function applyPreset(p: string) {
    const t = todayKey();
    setPreset(p);
    if (p === "today") { setLo(t); setHi(t); }
    else if (p === "7d") { setLo(dayKeyOffset(-6)); setHi(t); }
    else if (p === "30d") { setLo(dayKeyOffset(-29)); setHi(t); }
    else if (p === "mtd") { setLo(t.slice(0, 7) + "-01"); setHi(t); }
    else if (p === "all") { setLo("2000-01-01"); setHi(t); }
  }
  const range = { from: lo, to: hi };
  const rangeLabel = `${shortDay(lo)}–${shortDay(hi)}`;

  async function load() {
    setLoading(true); setError(null);
    try {
      const [stock, tx, us, tg, bd, qcr, dc] = await Promise.all([
        api.stockOnHand(), api.transactions(),
        api.users().catch(() => ({ items: [] as User[] })),
        api.targets().catch(() => ({ items: [] as DailyTarget[] })),
        api.breakdowns().catch(() => ({ items: [] as Breakdown[] })),
        api.qcChecks().catch(() => ({ items: [] as QcCheck[] })),
        api.decon().catch(() => ({ items: [] as Decon[] })),
      ]);
      setItems(stock.items || []);
      setTxns(tx.items || []);
      setUsers(us.items || []);
      setTargets(tg.items || []);
      setBreakdowns(bd.items || []);
      setQc(qcr.items || []);
      setDecon(dc.items || []);
      setGeneratedAt(stock.generated_at);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.has("tv")) setTv(true);
    if (!process.env.NEXT_PUBLIC_ACCESS_HASH) { setAuthed(true); return; }
    try { if (localStorage.getItem("nairn_access") === "1") setAuthed(true); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, []);

  const lastUpdated = useMemo(() => maxDate(items.map((i) => i.last_updated_at)) || generatedAt, [items, generatedAt]);
  const headerTitle = VIEWS.find((v) => v.id === view)?.label ?? "Overview";

  if (!authed) return <AccessGate onUnlock={() => setAuthed(true)} />;

  return (
    <div className={`flex h-screen overflow-hidden ${tv ? "tv-mode" : ""}`}>
      {!tv && (
        <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebarfg md:flex">
          <div className="flex h-16 items-center px-5">
            <Image src="/imining_white.png" alt="iMining" width={220} height={52} style={{ height: 46, width: "auto" }} />
          </div>
          <nav className="px-3">
            {VIEWS.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => { if (id === "monthly") { setLo(hi); setPreset("custom"); } setView(id); }}
                className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm ${view === id ? "bg-accent font-medium text-white" : "text-sidebarfg/80 hover:bg-white/10"}`}>
                <Icon size={18} /> {label}
              </button>
            ))}
          </nav>
          <div className="mt-4 border-t border-white/10 px-4 py-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sidebarfg/60">Date range</div>
            <div className="mb-2 grid grid-cols-4 gap-1">
              {([["7d", "7d"], ["30d", "30d"], ["MTD", "mtd"], ["All", "all"]] as const).map(([label, p]) => (
                <button key={p} onClick={() => applyPreset(p)}
                  className={`rounded-lg border py-1 text-center text-xs ${preset === p ? "border-accent bg-accent font-semibold text-white" : "border-white/15 bg-white/5 hover:bg-white/15"}`}>{label}</button>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <input type="date" value={lo} max={view === "monthly" ? undefined : hi}
                onChange={(e) => { const v = e.target.value; setLo(v); if (view === "monthly") setHi(v); setPreset("custom"); }}
                className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-sm text-sidebarfg outline-none" />
              <input type="date" value={hi} min={view === "monthly" ? undefined : lo} max={todayKey()}
                onChange={(e) => { const v = e.target.value; setHi(v); if (view === "monthly") setLo(v); setPreset("custom"); }}
                className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-sm text-sidebarfg outline-none" />
            </div>
            <div className="mt-2 text-[11px] leading-snug text-sidebarfg/50">
              {view === "monthly"
                ? "Pick any day — the Monthly Report shows that whole month. Both pickers stay in sync."
                : "Applies to Operators, Breakdowns, Pool & Reconciliation. The Overview is always live (today)."}
            </div>
          </div>
          <div className="mt-auto px-4 py-4 text-xs text-sidebarfg/50">
            Data: {api.mode === "gviz" ? "Google Sheet (live CSV)" : "Apps Script API"}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-3">
            <Image src="/bme_logo_v2.png" alt="BME" width={267} height={188} style={{ height: tv ? 88 : 72, width: "auto" }} priority />
            <span className={`font-semibold text-fg ${tv ? "text-2xl" : "text-lg"}`}>{CUSTOMER} — {headerTitle}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">Updated {fmtTime(lastUpdated)} · auto every 60s</span>
            {!tv && (
              <button onClick={load} className="flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-bg">
                <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-auto p-6">
          {error && (
            <Card><CardBody><div className="flex items-center gap-2 text-danger"><AlertCircle size={18} /> Failed to load data: {error}</div></CardBody></Card>
          )}
          {loading && !items.length ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : (
            <div className="space-y-6">
              {view === "overview" && <OverviewView items={items} txns={txns} targets={targets} breakdowns={breakdowns} qc={qc} decon={decon} tv={tv} />}
              {view === "monthly" && <MonthlyView items={items} txns={txns} targets={targets} breakdowns={breakdowns} qc={qc} month={hi.slice(0, 7)} />}
              {view === "operators" && <OperatorsView txns={txns} users={users} range={range} rangeLabel={rangeLabel} />}
              {view === "breakdowns" && <BreakdownsView breakdowns={breakdowns} range={range} rangeLabel={rangeLabel} />}
              {view === "finished" && <FinishedGoodsView items={items} />}
              {view === "rawmaterials" && <RawMaterialsView items={items} />}
              {view === "sales" && <SalesHistoryView items={items} txns={txns} range={range} rangeLabel={rangeLabel} />}
              {view === "stock" && <StockView items={items} tv={tv} />}
              {view === "recon" && <ReconView items={items} txns={txns} range={range} rangeLabel={rangeLabel} />}
              {view === "maint" && <MaintenanceView items={items} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Generic table ────────────────────────────────────────────────────────────
type Col = { key: string; label: string; num?: boolean; fmt?: (v: unknown, row: Record<string, unknown>) => string };
function Grid({ cols, rows, tone, maxH = "28rem" }: {
  cols: Col[]; rows: Record<string, unknown>[]; tone?: (r: Record<string, unknown>) => "bad" | "warn" | undefined; maxH?: string;
}) {
  return (
    <div className="overflow-auto rounded-xl border border-border" style={{ maxHeight: maxH }}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-bg text-left text-xs uppercase tracking-wide text-muted">
          <tr>{cols.map((c) => <th key={c.key} className={`px-3 py-2 font-medium ${c.num ? "text-right" : ""}`}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} className="px-3 py-6 text-center text-muted">No records.</td></tr>
          ) : rows.map((r, i) => {
            const t = tone?.(r);
            const cls = t === "bad" ? "bg-danger/10 text-danger" : t === "warn" ? "bg-warn/10" : "hover:bg-bg/60";
            return (
              <tr key={i} className={`border-t border-border ${cls}`}>
                {cols.map((c) => (
                  <td key={c.key} className={`px-3 py-2 ${c.num ? "text-right tabular-nums" : ""}`}>
                    {c.fmt ? c.fmt(r[c.key], r) : String(r[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function csvDownload(name: string, cols: Col[], rows: Record<string, unknown>[]) {
  const header = cols.map((c) => `"${c.label}"`).join(",");
  const body = rows.map((r) => cols.map((c) => `"${String(r[c.key] ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

const fmtQty = (v: unknown) => fmtNum(Number(v) || 0);
const fmtTs = (v: unknown) => fmtTime(v as string);

// ── Today's production card (ViperDet / Axxis) ───────────────────────────────
function TodayCard({ rec, accent }: { rec: LineRecord; accent: string }) {
  return (
    <Card className="border-t-4" >
      <CardBody>
        <div className="flex items-center gap-2">
          <Factory size={16} style={{ color: accent }} />
          <span className="font-semibold text-fg">Today — {rec.line}</span>
        </div>
        <div className="mt-2 flex items-end justify-between">
          <div><div className="text-xs text-muted">Quantity</div><div className="text-3xl font-semibold tracking-tight text-fg">{fmtNum(rec.quantity)}</div></div>
          <div className="text-right text-sm">
            <div className="text-muted">Boxes <span className="font-semibold text-fg">{rec.boxes}</span></div>
            <div className="text-muted">Per part <span className="font-semibold text-fg">{rec.perPartSecs != null ? `${rec.perPartSecs}s` : "—"}</span></div>
            <div className="text-muted">Window <span className="font-semibold text-fg">{rec.windowMins != null ? `${rec.windowMins}m` : "—"}</span></div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Shift start & deadtime banner ────────────────────────────────────────────
function ShiftDeadtimeCard({ shift, operators, tv }: { shift: ShiftInfo; operators: string[]; tv: boolean }) {
  // Severity from the start deadtime (machine-start lag): >60m red, >30m amber.
  const sev = (m: number) => (m > 60 ? "danger" : m > 30 ? "warn" : "ok");
  const tone = shift.count === 0 && shift.ongoingMin != null ? sev(shift.ongoingMin) : sev(shift.startDeadtimeMin);
  const border = tone === "danger" ? "border-t-danger" : tone === "warn" ? "border-t-warn" : "border-t-ok";
  const valCls = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ok";
  const big = tv ? "text-5xl" : "text-4xl";

  const Cell = ({ label, value, hint, cls = "text-fg" }: { label: string; value: string; hint?: string; cls?: string }) => (
    <div className="text-center">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 font-semibold tracking-tight ${big} ${cls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );

  return (
    <Card className={`border-t-4 ${border}`}>
      <CardBody>
        <div className="mb-3 flex items-center gap-2">
          <Flame size={tv ? 22 : 18} className={valCls} />
          <span className={`font-semibold text-fg ${tv ? "text-xl" : ""}`}>Shift start &amp; deadtime — today</span>
          <span className="text-xs text-muted">shift starts {fmtClock(shift.shiftStartMin)}</span>
        </div>
        {shift.count === 0 ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Cell label="First production sticker" value="— none yet —" />
            <Cell label="Deadtime since shift start" value={shift.ongoingMin != null ? fmtMins(shift.ongoingMin) : "—"} cls={valCls} hint={shift.ongoingMin != null ? "machine not started" : "before shift start"} />
            <Cell label="Operators on shift" value={String(operators.length)} hint={operators.join(", ") || "none logged in yet"} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Cell label="First sticker" value={fmtClock(shift.firstStickerMin!)} hint={`shift start ${fmtClock(shift.shiftStartMin)}`} />
            <Cell label="Start deadtime" value={fmtMins(shift.startDeadtimeMin)} cls={valCls} hint="time to first part" />
            <Cell label="Longest idle gap" value={fmtMins(shift.longestGapMin)} cls={shift.longestGapMin > 60 ? "text-warn" : "text-fg"} hint={shift.longestGapAtMin != null ? `between stickers, from ${fmtClock(shift.longestGapAtMin)}` : "between stickers"} />
            <Cell label="Stickers today" value={String(shift.count)} hint={shift.lastStickerMin != null ? `last ${fmtClock(shift.lastStickerMin)}` : undefined} />
            <Cell label="Operators on shift" value={String(operators.length)} hint={operators.join(", ") || "none"} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
function OverviewView({ items, txns, targets, breakdowns, qc, decon, tv }:
  { items: InventoryItem[]; txns: Transaction[]; targets: DailyTarget[]; breakdowns: Breakdown[]; qc: QcCheck[]; decon: Decon[]; tv: boolean }) {
  const today = todayKey();
  const tomorrow = dayKeyOffset(1);
  const month = today.slice(0, 7);

  const viper = useMemo(() => todaysRecords(items, txns, "ViperDet"), [items, txns]);
  const axxis = useMemo(() => todaysRecords(items, txns, "Axxis"), [items, txns]);
  const shift = useMemo(() => shiftTimeline(items, txns, SHIFT_START_HOUR, nowMinutesInTz()), [items, txns]);
  const operators = useMemo(() => activeOperatorsOn(txns, today), [txns, today]);
  const t1 = useMemo(() => lastT1Destruction(txns), [txns]);
  const bd = useMemo(() => breakdownSummary(breakdowns, month), [breakdowns, month]);
  const qcSum = useMemo(() => qcSummary(qc, today, month), [qc, today, month]);
  const dcn = useMemo(() => lastDecon(decon), [decon]);
  const { rows: perDay, best } = useMemo(() => productionByDay(items, month), [items, month]);
  const printed = useMemo(() => printedOn(items, today), [items, today]);
  const moved = useMemo(() => movedToMagazinesOn(items, txns, today), [items, txns, today]);
  const fg = useMemo(() => finishedGoodsInMagazines(items), [items]);
  const low = useMemo(() => lowStock(items), [items]);

  const printedTotal = printed.reduce((s, p) => s + p.quantity, 0);
  const reconcileDiff = printedTotal - moved.total;

  const todayTargets = targets.filter((t) => t.date === today);
  const tomoTargets = targets.filter((t) => t.date === tomorrow);

  // Target-days met this month (gauge).
  const targetByDay = new Map<string, number>();
  for (const t of targets) if (t.date.startsWith(month)) targetByDay.set(t.date, (targetByDay.get(t.date) || 0) + t.quantity);
  const prodByDay = new Map(perDay.map((r) => [r.day, PROD_FAMILIES.reduce((s, f) => s + (Number((r as unknown as Record<string, number>)[f]) || 0), 0)]));
  const targetDays = [...targetByDay.keys()];
  const metDays = targetDays.filter((d) => (prodByDay.get(d) || 0) >= (targetByDay.get(d) || 0)).length;

  return (
    <>
      {/* Shift start & deadtime — the kitchen motivator, first thing on screen */}
      <ShiftDeadtimeCard shift={shift} operators={operators} tv={tv} />

      {/* Today's production + target gauge */}
      <div className={`grid gap-4 ${tv ? "grid-cols-3" : "grid-cols-1 md:grid-cols-3"}`}>
        <TodayCard rec={viper} accent="#f5911e" />
        <TodayCard rec={axxis} accent="#4E79A7" />
        <Card><CardBody>
          <div className="flex items-center gap-2"><Target size={16} className="text-accent" /><span className="font-semibold text-fg">Targets met this month</span></div>
          {targetDays.length ? (
            <div className="mt-2 flex items-end justify-between">
              <div className="text-3xl font-semibold text-fg">{metDays}<span className="text-lg text-muted"> / {targetDays.length}</span></div>
              <div className="text-right text-sm text-muted">days at or above target<br />best day: <span className="font-semibold text-fg">{best.day ? `${shortDay(best.day)} · ${fmtNum(best.total)}` : "—"}</span></div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-muted">No targets yet. Create a <span className="font-mono text-fg">Daily_Targets</span> tab to light this up. Best day so far: <span className="font-semibold text-fg">{best.day ? `${shortDay(best.day)} · ${fmtNum(best.total)}` : "—"}</span></div>
          )}
        </CardBody></Card>
      </div>

      {/* Printed vs moved-to-magazine reconciliation */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card><CardBody>
          <div className="mb-3 flex items-center gap-2"><PackageCheck size={16} className="text-accent" /><span className="text-sm font-semibold text-fg">Printed stickers — today</span></div>
          <Grid maxH="18rem"
            cols={[{ key: "product", label: "Product" }, { key: "delay", label: "Delay" }, { key: "length", label: "Length" }, { key: "quantity", label: "Qty", num: true, fmt: fmtQty }]}
            rows={printed as unknown as Record<string, unknown>[]} />
        </CardBody></Card>
        <Card><CardBody>
          <div className="mb-3 flex items-center gap-2"><ArrowRightLeft size={16} className="text-accent" /><span className="text-sm font-semibold text-fg">Production reconciliation — today</span></div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-border p-3"><div className="text-xs text-muted">Printed</div><div className="text-2xl font-semibold text-fg">{fmtNum(printedTotal)}</div></div>
            <div className="rounded-xl border border-border p-3"><div className="text-xs text-muted">Into magazines</div><div className="text-2xl font-semibold text-fg">{fmtNum(moved.total)}</div></div>
            <div className={`rounded-xl border p-3 ${reconcileDiff !== 0 ? "border-danger bg-danger/10" : "border-ok bg-ok/10"}`}>
              <div className="text-xs text-muted">To reconcile</div>
              <div className={`text-2xl font-semibold ${reconcileDiff !== 0 ? "text-danger" : "text-ok"}`}>{signed(reconcileDiff)}</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-muted">Printed today minus quantity moved into Magazine M1/M2 today. A non-zero figure is stock printed but not yet stored.</div>
        </CardBody></Card>
      </div>

      {/* Targets today / tomorrow */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Today&apos;s targets · {shortDay(today)}</div>
          <TargetTable rows={todayTargets} />
        </CardBody></Card>
        <Card><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Tomorrow&apos;s targets · {shortDay(tomorrow)}</div>
          <TargetTable rows={tomoTargets} />
        </CardBody></Card>
      </div>

      {/* Finished goods + low material */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Finished goods in magazines</div>
          <div className="grid grid-cols-2 gap-3">
            {fg.families.map((f) => (
              <div key={f.name} className="rounded-xl border border-border p-3">
                <div className="text-xs text-muted">{f.name}</div><div className="text-2xl font-semibold text-fg">{fmtNum(f.value)}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-between border-t border-border pt-2 text-xs text-muted">
            <span>Magazine M1: <span className="font-semibold text-fg">{fmtNum(fg.m1)}</span></span>
            <span>Magazine M2: <span className="font-semibold text-fg">{fmtNum(fg.m2)}</span></span>
            <span>Total: <span className="font-semibold text-fg">{fmtNum(fg.total)}</span></span>
          </div>
        </CardBody></Card>
        <Card className={low.length ? "border-t-4 border-t-danger" : ""}><CardBody>
          <div className="mb-3 flex items-center gap-2"><AlertTriangle size={16} className={low.length ? "text-danger" : "text-muted"} /><span className="text-sm font-semibold text-fg">Low material alerts</span></div>
          <Grid maxH="16rem"
            cols={[{ key: "description", label: "Material" }, { key: "quantity", label: "Stock", num: true, fmt: fmtQty }, { key: "critical", label: "Critical", num: true, fmt: fmtQty }]}
            rows={low as unknown as Record<string, unknown>[]} tone={() => "bad"} />
          <div className="mt-2 text-xs text-muted">Sourced from items with a critical level set in Inventory_Master ({low.length} below threshold). More materials need critical levels populated to match the full reference panel.</div>
        </CardBody></Card>
      </div>

      {/* Facility logs */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Card className={t1 && t1.daysSince > 14 ? "border-t-4 border-t-danger" : t1 && t1.daysSince > 7 ? "border-t-4 border-t-warn" : ""}>
          <CardBody>
            <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-accent" /><span className="text-sm font-semibold text-fg">Last T1 destruction</span></div>
            {t1 ? (
              <>
                <div className="mt-2 text-2xl font-semibold text-fg">{fmtTime(t1.at)}</div>
                <div className="mt-1 text-sm">
                  <span className={t1.daysSince > 14 ? "font-semibold text-danger" : t1.daysSince > 7 ? "font-semibold text-warn" : "text-muted"}>
                    {t1.daysSince === 0 ? "today" : `${t1.daysSince} day(s) ago`}
                  </span>
                  <span className="text-muted"> · by {t1.user || "—"} · {t1.monthCount} this month</span>
                </div>
              </>
            ) : <div className="mt-2 text-sm text-muted">No destruction events logged.</div>}
          </CardBody>
        </Card>
        <Card><CardBody>
          <div className="flex items-center gap-2"><ClipboardCheck size={16} className="text-accent" /><span className="text-sm font-semibold text-fg">QC crimp checks</span></div>
          {qc.length ? (
            <>
              <div className="mt-2 flex items-end gap-2">
                <span className="text-2xl font-semibold text-fg">{qcSum.todayRate != null ? `${Math.round(qcSum.todayRate * 100)}%` : "—"}</span>
                <span className="mb-1 text-xs text-muted">pass today ({qcSum.todayChecks} checks)</span>
              </div>
              <div className="mt-1 text-sm text-muted">
                {qcSum.todayFail > 0 ? <span className="font-semibold text-danger">{qcSum.todayFail} fail today · </span> : null}
                month {qcSum.monthRate != null ? `${Math.round(qcSum.monthRate * 100)}%` : "—"} ({qcSum.monthChecks}) · last {fmtTime(qcSum.lastAt)}
              </div>
            </>
          ) : <div className="mt-2 text-sm text-muted">No QC data available.</div>}
        </CardBody></Card>
        <Card className={bd.last && bd.last.nature === "Critical Breakdown" ? "border-t-4 border-t-danger" : ""}><CardBody>
          <div className="flex items-center gap-2"><WrenchIcon size={16} className="text-accent" /><span className="text-sm font-semibold text-fg">Breakdowns</span></div>
          {bd.last ? (
            <>
              <div className="mt-2 text-sm">Last: <span className="font-semibold text-fg">{fmtTime(bd.last.at)}</span> · {bd.last.line} {bd.last.station ? `· ${bd.last.station}` : ""}</div>
              <div className="mt-1 text-sm text-muted">{bd.monthCount} this month · {fmtMins(bd.monthDowntimeMin)} downtime · {bd.daysSinceLast === 0 ? "today" : `${bd.daysSinceLast}d ago`}</div>
            </>
          ) : <div className="mt-2 text-sm text-muted">No breakdowns logged.</div>}
        </CardBody></Card>
        <Card><CardBody>
          <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-accent" /><span className="text-sm font-semibold text-fg">Last decontamination</span></div>
          {dcn ? (
            <>
              <div className="mt-2 text-2xl font-semibold text-fg">{fmtTime(dcn.at)}</div>
              <div className="mt-1 text-sm text-muted">{dcn.daysSince === 0 ? "today" : `${dcn.daysSince} day(s) ago`} · ViperDet{dcn.hmx_spill ? " · " : ""}{dcn.hmx_spill ? <span className="font-semibold text-warn">HMX spill noted</span> : ""}</div>
              <div className="mt-1 text-xs text-muted">Axxis decon log still to be created.</div>
            </>
          ) : <div className="mt-2 text-sm text-muted">No decontamination log available.</div>}
        </CardBody></Card>
      </div>
    </>
  );
}

function TargetTable({ rows }: { rows: DailyTarget[] }) {
  if (!rows.length) return <div className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted">No targets set. Add rows to the <span className="font-mono">Daily_Targets</span> tab (Date · Production_Line · Product · Specifics · Target_Quantity).</div>;
  return (
    <Grid maxH="16rem"
      cols={[{ key: "production_line", label: "Line" }, { key: "product", label: "Product" }, { key: "specifics", label: "Specifics" }, { key: "quantity", label: "Target", num: true, fmt: fmtQty }]}
      rows={rows as unknown as Record<string, unknown>[]} />
  );
}

// ── MONTHLY REPORT ───────────────────────────────────────────────────────────
// Month is driven by the sidebar date picker (any day in the month).
function MonthlyView({ items, txns, targets, breakdowns, qc, month: m }:
  { items: InventoryItem[]; txns: Transaction[]; targets: DailyTarget[]; breakdowns: Breakdown[]; qc: QcCheck[]; month: string }) {
  const sd = useMemo(() => startDeadtimeByDay(items, txns, SHIFT_START_HOUR, m), [items, txns, m]);
  const tot = useMemo(() => monthTotals(items, m), [items, m]);
  const prod = useMemo(() => productionByDay(items, m), [items, m]);
  const qcS = useMemo(() => qcSummary(qc, "", m), [qc, m]);
  const bdS = useMemo(() => breakdownSummary(breakdowns, m), [breakdowns, m]);

  const targetByDay = new Map<string, number>();
  for (const t of targets) if (t.date.startsWith(m)) targetByDay.set(t.date, (targetByDay.get(t.date) || 0) + t.quantity);
  const prodByDay = new Map(prod.rows.map((r) => [r.day, PROD_FAMILIES.reduce((s, f) => s + (Number((r as unknown as Record<string, number>)[f]) || 0), 0)]));
  const targetDays = [...targetByDay.keys()];
  const metDays = targetDays.filter((d) => (prodByDay.get(d) || 0) >= (targetByDay.get(d) || 0)).length;

  const monthLabel = (() => { const [y, mm] = m.split("-").map(Number); return new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }); })();

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-fg">{monthLabel}</div>
        <div className="text-xs text-muted">Change month with the sidebar date picker</div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Avg start deadtime" value={fmtMins(sd.avg)} status={sd.avg > 60 ? "bad" : sd.avg > 30 ? "warn" : "ok"} sub={`${sd.rows.length} production day(s)`} />
        <Stat label="Production (units)" value={fmtNum(tot.total)} sub={`best ${prod.best.day ? shortDay(prod.best.day) : "—"}`} />
        <Stat label="Targets met" value={targetDays.length ? `${metDays}/${targetDays.length}` : "—"} status={targetDays.length && metDays < targetDays.length ? "warn" : "ok"} sub="days at/above target" />
        <Stat label="QC pass rate" value={qcS.monthRate != null ? `${Math.round(qcS.monthRate * 100)}%` : "—"} status={qcS.monthRate != null && qcS.monthRate < 0.98 ? "warn" : "ok"} sub={`${qcS.monthChecks} checks`} />
        <Stat label="Breakdowns" value={bdS.monthCount} status={bdS.monthCount ? "warn" : "ok"} sub={`${bdS.byLine.ViperDet} VD · ${bdS.byLine.Axxis} AX`} />
        <Stat label="Downtime" value={fmtMins(bdS.monthDowntimeMin)} status={bdS.monthDowntimeMin > 120 ? "warn" : "ok"} sub="logged breakdown time" />
      </div>

      <Card><CardBody>
        <div className="mb-1 text-sm font-semibold text-fg">Shift-start deadtime by day — {monthLabel}</div>
        <div className="mb-3 text-xs text-muted">Time from shift start ({fmtClock(SHIFT_START_HOUR * 60)}) to the first production sticker each day. This is the metric to drive down.</div>
        <Grid maxH="22rem"
          cols={[
            { key: "day", label: "Day", fmt: (v) => shortDay(String(v)) },
            { key: "firstMin", label: "First sticker", fmt: (v) => fmtClock(Number(v)) },
            { key: "startDeadtimeMin", label: "Start deadtime", num: true, fmt: (v) => fmtMins(Number(v)) },
          ]}
          rows={sd.rows.slice().reverse() as unknown as Record<string, unknown>[]}
          tone={(r) => ((r.startDeadtimeMin as number) > 60 ? "bad" : (r.startDeadtimeMin as number) > 30 ? "warn" : undefined)} />
      </CardBody></Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title={`Production by day — ${monthLabel}`}>
          {prod.rows.length
            ? <StackedBar rows={prod.rows.map((r) => ({ x: shortDay(r.day), ...PROD_FAMILIES.reduce((o, f) => ({ ...o, [f]: Number((r as unknown as Record<string, number>)[f]) || 0 }), {}) }))} xKey="x" series={[...PROD_FAMILIES]} colorMap={FAMILY_COLOURS} height={300} />
            : <div className="py-10 text-center text-sm text-muted">No production this month.</div>}
        </ChartCard>
        <Card><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Production totals — {monthLabel}</div>
          <div className="grid grid-cols-2 gap-3">
            {tot.families.map((f) => (
              <div key={f.name} className="rounded-xl border border-border p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: FAMILY_COLOURS[f.name] }} />{f.name}</div>
                <div className="text-2xl font-semibold text-fg">{fmtNum(f.value)}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-border pt-2 text-sm">Grand total <span className="text-xl font-semibold text-fg">{fmtNum(tot.total)}</span> units across {sd.rows.length} production day(s)</div>
        </CardBody></Card>
      </div>
    </>
  );
}

// ── BREAKDOWNS ───────────────────────────────────────────────────────────────
function BreakdownsView({ breakdowns, range, rangeLabel }: { breakdowns: Breakdown[]; range: DateRange; rangeLabel: string }) {
  const [line, setLine] = useState<"All" | "ViperDet" | "Axxis">("All");
  const rows = useMemo(() => breakdowns
    .filter((b) => (line === "All" || b.line === line) && (() => { const k = logDayKey(b.at); return k >= range.from && k <= range.to; })())
    .slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)), [breakdowns, line, range]);
  const totalDowntime = rows.reduce((s, b) => s + b.duration_min, 0);
  const byStation = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of rows) m.set(b.station || "—", (m.get(b.station || "—") || 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 12);
  }, [rows]);
  const critical = rows.filter((b) => b.nature === "Critical Breakdown").length;

  const cols: Col[] = [
    { key: "at", label: "When", fmt: (v) => fmtTime(String(v)) },
    { key: "line", label: "Line" }, { key: "station", label: "Station" },
    { key: "nature", label: "Nature" }, { key: "duration_min", label: "Mins", num: true, fmt: fmtQty },
    { key: "personnel", label: "By" }, { key: "info", label: "Detail" },
  ];

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {(["All", "ViperDet", "Axxis"] as const).map((l) => (
            <button key={l} onClick={() => setLine(l)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${line === l ? "border-accent bg-accent font-semibold text-white" : "border-border bg-surface hover:bg-bg"}`}>{l}</button>
          ))}
        </div>
        <span className="text-sm text-muted">{breakdowns.length === 0 ? "No breakdown data loaded." : `Showing ${rangeLabel}`}</span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Breakdowns" value={fmtNum(rows.length)} />
        <Stat label="Total downtime" value={fmtMins(totalDowntime)} />
        <Stat label="Critical" value={critical} status={critical ? "bad" : "ok"} />
        <Stat label="Avg per breakdown" value={rows.length ? fmtMins(totalDowntime / rows.filter((b) => b.duration_min > 0).length || 0) : "—"} />
      </div>

      <ChartCard title="Breakdowns by station" subtitle="Count (top 12)">
        <BarH data={byStation} height={Math.max(240, byStation.length * 28)} />
      </ChartCard>

      <Card><CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">Breakdown log ({fmtNum(rows.length)})</div>
          <button onClick={() => csvDownload(`breakdowns_${today()}.csv`, cols, rows.map((b) => ({ ...b, at: fmtTime(b.at) })))}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
        </div>
        <Grid cols={cols} rows={rows as unknown as Record<string, unknown>[]} tone={(r) => (r.nature === "Critical Breakdown" ? "bad" : undefined)} maxH="34rem" />
      </CardBody></Card>
    </>
  );
}

// ── OPERATORS ────────────────────────────────────────────────────────────────
function OperatorsView({ txns, users, range, rangeLabel }: { txns: Transaction[]; users: User[]; range: DateRange; rangeLabel: string }) {
  const [includeSystem, setIncludeSystem] = useState(false);
  const scoped = useMemo(() => txns.filter((t) => inRange(t, range)), [txns, range]);
  const stats: OperatorStat[] = useMemo(() => operatorStats(scoped, users, { includeSystem }), [scoped, users, includeSystem]);
  const inactive = useMemo(() => inactiveRosterUsers(scoped, users), [scoped, users]);
  const flagged = stats.filter((s) => s.flags.length);

  const bars = stats.slice(0, 12).map((s) => ({ name: s.user, value: s.actions }));

  const cols: Col[] = [
    { key: "user", label: "Operator" },
    { key: "actions", label: "Actions", num: true, fmt: fmtQty },
    { key: "activeDays", label: "Active days", num: true },
    { key: "distinctReasons", label: "Reasons used", num: true },
    { key: "topReason", label: "Most-used reason" },
    { key: "correctionShare", label: "% corrections", num: true, fmt: (v) => `${Math.round(Number(v) * 100)}%` },
    { key: "lastActivity", label: "Last activity", fmt: fmtTs },
    { key: "flagText", label: "Flags" },
  ];
  const rows = stats.map((s) => ({
    ...s, topReason: s.reasons[0]?.name ?? "—", flagText: s.flags.join(" · ") || "—",
  })) as unknown as Record<string, unknown>[];

  return (
    <>
      <div className="text-sm text-muted">Showing {rangeLabel}</div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active operators" value={stats.filter((s) => !s.flags.includes("Not on roster") && !s.test).length} />
        <Stat label="Flagged operators" value={flagged.length} status={flagged.length ? "warn" : "ok"} sub="check usage" />
        <Stat label="Off-roster users" value={stats.filter((s) => s.flags.includes("Not on roster")).length} status={stats.some((s) => s.flags.includes("Not on roster")) ? "bad" : "ok"} />
        <Stat label="Roster, no activity" value={inactive.length} status={inactive.length ? "warn" : "ok"} sub={inactive.join(", ") || "—"} />
      </div>

      {flagged.length > 0 && (
        <Card className="border-t-4 border-t-warn"><CardBody>
          <div className="mb-2 flex items-center gap-2 font-semibold text-warn"><AlertTriangle size={18} /> {flagged.length} operator(s) to review</div>
          <ul className="space-y-1 text-sm">
            {flagged.map((s) => (
              <li key={s.user} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{s.user}</span>
                {s.flags.map((f) => <Badge key={f} tone={f === "Not on roster" || f === "Test account" ? "danger" : "warn"}>{f}</Badge>)}
                <span className="text-muted">· {s.actions} actions, {s.distinctReasons} reason(s)</span>
              </li>
            ))}
          </ul>
        </CardBody></Card>
      )}

      <ChartCard title="Activity by operator" subtitle="Transaction count (top 12)">
        <BarH data={bars} height={Math.max(240, bars.length * 30)} />
      </ChartCard>

      <Card><CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">Operator activity ({stats.length})</div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} /> show system / automation accounts
          </label>
        </div>
        <Grid cols={cols} rows={rows} tone={(r) => ((r.flags as string[]).includes("Not on roster") || (r.flags as string[]).includes("Test account") ? "bad" : (r.flags as string[]).length ? "warn" : undefined)} maxH="32rem" />
      </CardBody></Card>
    </>
  );
}

// ── Stock on Hand ─────────────────────────────────────────────────────────────
function StockView({ items, tv }: { items: InventoryItem[]; tv: boolean }) {
  const [selTypes, setSelTypes] = useState<Set<string> | null>(null);
  const [selStatuses, setSelStatuses] = useState<Set<string> | null>(() => new Set(["Active"]));
  const [selLoc, setSelLoc] = useState("");
  const [search, setSearch] = useState("");

  const types = useMemo(() => uniqueSorted(items.map((i) => i.type)), [items]);
  const statuses = useMemo(() => uniqueSorted(items.map((i) => i.status)), [items]);
  const locations = useMemo(() => uniqueSorted(items.map((i) => i.current_location)), [items]);

  const df = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) =>
      (!selTypes || selTypes.has(i.type)) &&
      (!selStatuses || selStatuses.has(i.status)) &&
      (!selLoc || i.current_location === selLoc) &&
      (!q || i.qr.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
    );
  }, [items, selTypes, selStatuses, selLoc, search]);

  const totalQty = df.reduce((s, i) => s + i.current_quantity, 0);
  const byType = groupSum(df, (i) => i.type, (i) => i.current_quantity).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const byLoc = groupSum(df.filter((i) => i.current_location), (i) => i.current_location, (i) => i.current_quantity).sort((a, b) => b.value - a.value).slice(0, 12);

  const cols: Col[] = [
    { key: "qr", label: "QR" }, { key: "description", label: "Description" },
    { key: "type", label: "Type" }, { key: "product_type", label: "Product" },
    { key: "delay_display", label: "Delay" }, { key: "length", label: "Length" },
    { key: "current_quantity", label: "Qty", num: true, fmt: fmtQty },
    { key: "current_location", label: "Location" }, { key: "status", label: "Status" },
    { key: "last_updated_at", label: "Updated", fmt: fmtTs }, { key: "last_updated_by", label: "By" },
  ];

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-2xl border border-border bg-surface p-4">
        <Chips label="Type" all={types} sel={selTypes ?? new Set(types)} onChange={setSelTypes} />
        <Chips label="Status" all={statuses} sel={selStatuses ?? new Set(statuses)} onChange={setSelStatuses} />
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Location</div>
          <select value={selLoc} onChange={(e) => setSelLoc(e.target.value)}
            className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent">
            <option value="">All locations</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="ml-auto">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Search</div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="QR / description"
              className="w-56 rounded-lg border border-border bg-bg py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent" />
          </div>
        </div>
      </div>

      <div className={`grid gap-4 ${tv ? "grid-cols-4" : "grid-cols-2 lg:grid-cols-4"}`}>
        <Stat label="Items (filtered)" value={fmtNum(df.length)} />
        <Stat label="Total quantity" value={fmtNum(totalQty)} />
        <Stat label="Locations" value={uniqueSorted(df.map((i) => i.current_location)).length} />
        <Stat label="Item types" value={byType.length} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Quantity by item type"><Donut data={byType} colorMap={TYPE_COLOURS} /></ChartCard>
        <ChartCard title="Quantity by location" subtitle="Top 12"><BarH data={byLoc} height={360} /></ChartCard>
      </div>

      <Card>
        <CardBody>
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-fg">Inventory records ({fmtNum(df.length)})</div>
            <button onClick={() => csvDownload(`stock_${today()}.csv`, cols, df.map((i) => ({ ...i, last_updated_at: fmtTime(i.last_updated_at) })))}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
          </div>
          <Grid cols={cols} rows={df as unknown as Record<string, unknown>[]} />
        </CardBody>
      </Card>
    </>
  );
}
const today = () => new Date().toISOString().slice(0, 10);

// Shared: CSV export of a pivot matrix.
function exportMatrix(name: string, data: MatrixResult) {
  const cols: Col[] = [{ key: "description", label: "Description" }, ...data.locations.map((l) => ({ key: l, label: l })), { key: "__total", label: "Total" }];
  const rows = data.rows.map((r) => ({ description: r.description, ...r.cells, __total: r.total }));
  csvDownload(name, cols, rows);
}
function MatrixHeader({ data, onExport }: { data: MatrixResult; onExport: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm text-muted">{data.rows.length} descriptions · <span className="font-semibold text-fg">{fmtNum(data.grandTotal)}</span> units across {data.locations.length} rooms</div>
      <button onClick={onExport} className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
    </div>
  );
}

// ── Raw Materials: non-finished-goods pivot (description × room) ─────────────
function RawMaterialsView({ items }: { items: InventoryItem[] }) {
  const data = useMemo(() => inventoryMatrix(items, false, SITE_ROOMS), [items]);
  return (
    <Card><CardBody>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-fg">Raw materials on hand — by location</div>
        <MatrixHeader data={data} onExport={() => exportMatrix(`raw_materials_${today()}.csv`, data)} />
      </div>
      <MatrixTable data={data} />
    </CardBody></Card>
  );
}

// ── Finished Goods: sellable stock pivot (colour-keyed) + shelf-age alerts ───
function FinishedGoodsView({ items }: { items: InventoryItem[] }) {
  const data = useMemo(() => inventoryMatrix(items, true, SITE_ROOMS), [items]);
  const [pt, setPt] = useState<string>("all");
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = data.rows.filter((r) => (pt === "all" || r.family === pt) && (!needle || r.description.toLowerCase().includes(needle)));
    const locations = data.locations.filter((l) => rows.some((r) => r.cells[l]));
    const colTotals: Record<string, number> = {};
    for (const l of locations) colTotals[l] = rows.reduce((s, r) => s + (r.cells[l] || 0), 0);
    return { locations, rows, colTotals, grandTotal: rows.reduce((s, r) => s + r.total, 0) };
  }, [data, pt, q]);

  const aged = useMemo(() => agedFinishedGoods(items), [items]);
  const over12 = useMemo(() => aged.filter((b) => b.ageDays > 365), [aged]);
  const over24 = useMemo(() => aged.filter((b) => b.ageDays > 730), [aged]);
  const [filter, setFilter] = useState<null | "12" | "24">(null);
  const sumQty = (xs: AgedBox[]) => xs.reduce((s, b) => s + b.qty, 0);

  const list = filter === "24" ? over24 : filter === "12" ? over12 : [];
  const listCols: Col[] = [
    { key: "qr", label: "Barcode" }, { key: "description", label: "Description" }, { key: "product", label: "Product" },
    { key: "prod_date", label: "Produced", fmt: (v) => fmtDate(v as string) },
    { key: "ageMonths", label: "Age (mo)", num: true },
    { key: "location", label: "Location" }, { key: "qty", label: "Qty", num: true, fmt: fmtQty },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label="Sellable finished goods" value={fmtNum(aged.length)} sub={`${fmtNum(sumQty(aged))} units · ${data.locations.length} rooms`} />
        <Stat label="Over 12 months" value={fmtNum(over12.length)} status={over12.length ? "warn" : "ok"}
          sub={`${fmtNum(sumQty(over12))} units · click to list`} onClick={() => setFilter(filter === "12" ? null : "12")} />
        <Stat label="Over 24 months — expired" value={fmtNum(over24.length)} status={over24.length ? "bad" : "ok"}
          sub={`${fmtNum(sumQty(over24))} units · cannot be sold · click to list`} onClick={() => setFilter(filter === "24" ? null : "24")} />
      </div>

      {filter && (
        <Card className={filter === "24" ? "border-t-4 border-t-danger" : "border-t-4 border-t-warn"}><CardBody>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Clock size={16} className={filter === "24" ? "text-danger" : "text-warn"} />
              {filter === "24" ? "Expired — over 24 months old" : "Aging — over 12 months old"} ({list.length} boxes)
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => csvDownload(`finished_goods_over_${filter}mo_${today()}.csv`, listCols, list.map((b) => ({ ...b, prod_date: fmtDate(b.prod_date) })))}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
              <button onClick={() => setFilter(null)} className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs hover:bg-bg"><X size={14} /> Close</button>
            </div>
          </div>
          <Grid cols={listCols} rows={list as unknown as Record<string, unknown>[]} tone={() => (filter === "24" ? "bad" : "warn")} maxH="26rem" />
        </CardBody></Card>
      )}

      <Card><CardBody>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-fg">Finished goods on hand — by location</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">What are you looking for?</span>
            <select value={pt} onChange={(e) => setPt(e.target.value)}
              className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent">
              <option value="all">All product types</option>
              {["MS DUAL", "QS", "SILVER", "TITANIUM"].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="length or delay — e.g. 12.0m, 25 / 500"
                className="w-64 rounded-lg border border-border bg-bg py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent" />
            </div>
            <button onClick={() => exportMatrix(`finished_goods_${today()}.csv`, filtered)}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
          </div>
        </div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {Object.entries(FAMILY_COLOURS).map(([fam, col]) => (
              <span key={fam} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: col }} /> {fam}</span>
            ))}
          </div>
          <div className="text-xs text-muted">{filtered.rows.length} of {data.rows.length} descriptions · <span className="font-semibold text-fg">{fmtNum(filtered.grandTotal)}</span> units</div>
        </div>
        <MatrixTable data={filtered} familyColours={FAMILY_COLOURS} />
      </CardBody></Card>
    </>
  );
}

// ── Sales History: sold boxes, PO rollup, volume — within the date range ─────
function SalesHistoryView({ items, txns, range, rangeLabel }: { items: InventoryItem[]; txns: Transaction[]; range: DateRange; rangeLabel: string }) {
  const events = useMemo(() => saleEvents(items, txns), [items, txns]);
  const sum = useMemo(() => salesSummary(events, range.from, range.to), [events, range]);

  const poCols: Col[] = [
    { key: "po", label: "PO number" }, { key: "customer", label: "Customer" },
    { key: "boxes", label: "Boxes", num: true, fmt: fmtQty }, { key: "volume", label: "Volume (units)", num: true, fmt: fmtQty },
  ];
  const logCols: Col[] = [
    { key: "at", label: "Sold", fmt: fmtTs }, { key: "qr", label: "Barcode" }, { key: "description", label: "Description" },
    { key: "product", label: "Product" }, { key: "qty", label: "Qty", num: true, fmt: fmtQty },
    { key: "po", label: "PO" }, { key: "customer", label: "Customer" },
  ];

  return (
    <>
      <div className="text-sm text-muted">Showing {rangeLabel}</div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Volume sold" value={fmtNum(sum.volume)} sub="units" />
        <Stat label="Boxes sold" value={fmtNum(sum.boxes)} />
        <Stat label="PO numbers" value={sum.byPo.length} />
        <Stat label="Customers" value={sum.customers.length} sub={sum.customers.join(", ") || "—"} />
      </div>

      <Card><CardBody>
        <div className="mb-3 text-sm font-semibold text-fg">Sales by PO</div>
        <Grid cols={poCols} rows={sum.byPo as unknown as Record<string, unknown>[]} maxH="20rem" />
      </CardBody></Card>

      <Card><CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">Sale log ({fmtNum(sum.boxes)} boxes)</div>
          <button onClick={() => csvDownload(`sales_${today()}.csv`, logCols, sum.events.map((e) => ({ ...e, at: fmtTime(e.at) })))}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
        </div>
        <Grid cols={logCols} rows={sum.events as unknown as Record<string, unknown>[]} maxH="30rem" />
      </CardBody></Card>
    </>
  );
}

// Blend a hex colour toward white by (1-amt) — a solid pale tint for row backgrounds.
function tint(hex: string, amt: number) {
  const h = hex.replace("#", "");
  const mix = (c: number) => Math.round(c * amt + 255 * (1 - amt));
  return `rgb(${mix(parseInt(h.slice(0, 2), 16))}, ${mix(parseInt(h.slice(2, 4), 16))}, ${mix(parseInt(h.slice(4, 6), 16))})`;
}

// Pivot table: sticky header + sticky description column + a totals footer.
// When familyColours is supplied, rows are tinted/keyed by product family.
function MatrixTable({ data, familyColours }: { data: MatrixResult; familyColours?: Record<string, string> }) {
  const { locations, rows, colTotals, grandTotal } = data;
  if (!rows.length) return <div className="py-12 text-center text-sm text-muted">No stock for this category.</div>;
  const cell = (n: number) => (n ? fmtNum(n) : "—");
  return (
    <div className="overflow-auto rounded-xl border border-border" style={{ maxHeight: "38rem" }}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-bg text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="sticky left-0 z-20 bg-bg px-3 py-2 text-left font-medium">Description</th>
            {locations.map((l) => <th key={l} className="whitespace-nowrap px-3 py-2 text-right font-medium">{l}</th>)}
            <th className="px-3 py-2 text-right font-semibold text-fg">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const col = r.family && familyColours ? familyColours[r.family] : undefined;
            const bg = col ? tint(col, 0.16) : undefined;
            return (
              <tr key={i} className="border-t border-border" style={bg ? { background: bg } : undefined}>
                <td className="sticky left-0 z-10 whitespace-nowrap px-3 py-2 font-medium text-fg"
                  style={{ background: bg || "rgb(var(--surface))", borderLeft: col ? `3px solid ${col}` : undefined }}>
                  {r.description}
                </td>
                {locations.map((l) => <td key={l} className="px-3 py-2 text-right tabular-nums text-muted">{cell(r.cells[l])}</td>)}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-fg">{fmtNum(r.total)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="sticky bottom-0 bg-bg">
          <tr className="border-t-2 border-border">
            <td className="sticky left-0 z-10 bg-bg px-3 py-2 font-semibold text-fg">Total on site</td>
            {locations.map((l) => <td key={l} className="px-3 py-2 text-right font-semibold tabular-nums text-fg">{fmtNum(colTotals[l])}</td>)}
            <td className="px-3 py-2 text-right font-bold tabular-nums text-fg">{fmtNum(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Reconciliation ───────────────────────────────────────────────────────────
function ReconView({ items, txns, range, rangeLabel }: { items: InventoryItem[]; txns: Transaction[]; range: DateRange; rangeLabel: string }) {
  const recon: PoolRecon[] = useMemo(() => reconcilePools(items, txns, range), [items, txns, range]);
  const rooms: RoomRecon[] = useMemo(() => reconcileRooms(recon), [recon]);
  const flagged = recon.filter((p) => !p.matches);
  const interventions = recon.reduce((s, p) => s + p.interventions, 0);

  const cols: Col[] = [
    { key: "qr", label: "Pool QR" }, { key: "description", label: "Description" }, { key: "location", label: "Room" },
    { key: "actual", label: "Actual", num: true, fmt: fmtQty },
    { key: "calculated", label: "Calc (log)", num: true, fmt: (v) => (v == null ? "—" : fmtNum(Number(v))) },
    { key: "diff", label: "Diff", num: true, fmt: (v) => (Number(v) === 0 ? "0" : signed(Number(v))) },
    { key: "in_qty", label: "In", num: true, fmt: fmtQty },
    { key: "out_qty", label: "Out", num: true, fmt: fmtQty },
    { key: "interventions", label: "Manual fixes", num: true },
    { key: "last_txn", label: "Last move", fmt: fmtTs },
  ];
  const rows = recon.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.actual - a.actual).map((p) => ({ ...p })) as unknown as Record<string, unknown>[];

  return (
    <>
      <div className="text-sm text-muted">Calc-vs-actual is all-time · flows &amp; manual fixes for {rangeLabel}</div>
      {flagged.length > 0 ? (
        <Card className="border-t-4 border-t-danger"><CardBody className="flex items-center gap-3 font-semibold text-danger">
          <AlertTriangle size={20} /> {flagged.length} pool(s) where the sheet quantity ≠ the transaction log — investigate a missed/incorrect scan.
        </CardBody></Card>
      ) : (
        <Card className="border-t-4 border-t-ok"><CardBody className="flex items-center gap-3 font-semibold text-ok">
          <CheckCircle2 size={20} /> Every explosive pool reconciles — sheet quantities match the transaction log.
        </CardBody></Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Pools reconciled" value={recon.length} />
        <Stat label="Out of balance" value={flagged.length} status={flagged.length ? "bad" : "ok"} />
        <Stat label="Manual fixes" value={interventions} status={interventions ? "warn" : "ok"} sub={`${rangeLabel} · reconcile/correction`} />
        <Stat label="Rooms" value={rooms.length} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rooms.map((r) => (
          <Card key={r.room} className={r.balanced ? "" : "border-t-4 border-t-danger"}>
            <CardBody>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-fg">{r.room}</span>
                <Badge tone={r.balanced ? "ok" : "danger"}>{r.balanced ? "Balanced" : `${r.flagged} flagged`}</Badge>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-xs text-muted">In</div><div className="font-semibold text-ok">{fmtNum(r.in_qty)}</div></div>
                <div><div className="text-xs text-muted">Out</div><div className="font-semibold text-danger">{fmtNum(r.out_qty)}</div></div>
                <div><div className="text-xs text-muted">Net</div><div className="font-semibold text-fg">{signed(r.net)}</div></div>
              </div>
              <div className="mt-3 flex justify-between border-t border-border pt-2 text-xs text-muted">
                <span>{r.pools} pools · {fmtNum(r.actual)} on hand</span>
                {r.interventions > 0 && <span className="text-warn">{r.interventions} manual fix(es)</span>}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card><CardBody>
        <div className="mb-1 text-sm font-semibold text-fg">Pool-level reconciliation</div>
        <div className="mb-3 text-xs text-muted">Actual = sheet quantity · Calc = latest value in the transaction log · Diff ≠ 0 means the pool changed outside the logged flow.</div>
        <Grid cols={cols} rows={rows} tone={(r) => (!(r.matches as boolean) ? "bad" : (r.interventions as number) > 0 ? "warn" : undefined)} maxH="32rem" />
      </CardBody></Card>
    </>
  );
}

// ── Maintenance Stores ───────────────────────────────────────────────────────
function MaintenanceView({ items }: { items: InventoryItem[] }) {
  const [search, setSearch] = useState("");
  const spares = useMemo(() => maintenancePools(items), [items]);
  const df = useMemo(() => {
    const q = search.trim().toLowerCase();
    return spares.filter((i) => !q || i.qr.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.current_sub_location.toLowerCase().includes(q));
  }, [spares, search]);

  const cols: Col[] = [
    { key: "qr", label: "QR" }, { key: "description", label: "Part" },
    { key: "current_quantity", label: "Qty", num: true, fmt: fmtQty },
    { key: "current_location", label: "Location" }, { key: "current_sub_location", label: "Sub-location" },
    { key: "status", label: "Status" }, { key: "last_updated_at", label: "Updated", fmt: fmtTs },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Spare parts" value={fmtNum(spares.length)} />
        <Stat label="Total on hand" value={fmtNum(spares.reduce((s, i) => s + i.current_quantity, 0))} />
        <Stat label="Out of stock" value={spares.filter((i) => i.current_quantity === 0).length} status="warn" />
        <Stat label="Sub-locations" value={uniqueSorted(spares.map((i) => i.current_sub_location)).length} />
      </div>
      <Card><CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">Maintenance Room spares ({fmtNum(df.length)})</div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="part / location"
                className="w-56 rounded-lg border border-border bg-bg py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent" />
            </div>
            <button onClick={() => csvDownload(`maintenance_${today()}.csv`, cols, df.map((i) => ({ ...i, last_updated_at: fmtTime(i.last_updated_at) })))}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
          </div>
        </div>
        <Grid cols={cols} rows={df as unknown as Record<string, unknown>[]} tone={(r) => ((r.current_quantity as number) === 0 ? "warn" : undefined)} maxH="34rem" />
      </CardBody></Card>
    </>
  );
}

// ── Chip multi-select ────────────────────────────────────────────────────────
function Chips({ label, all, sel, onChange }: { label: string; all: string[]; sel: Set<string>; onChange: (s: Set<string>) => void }) {
  const toggle = (v: string) => { const n = new Set(sel); n.has(v) ? n.delete(v) : n.add(v); onChange(n); };
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {all.map((v) => {
          const on = sel.has(v);
          return (
            <button key={v} onClick={() => toggle(v)}
              className={`rounded-lg border px-2 py-1 text-xs ${on ? "border-accent bg-accent font-semibold text-white" : "border-border bg-bg text-muted hover:bg-surface"}`}>{v}</button>
          );
        })}
      </div>
    </div>
  );
}
