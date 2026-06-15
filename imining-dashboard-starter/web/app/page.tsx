"use client";

import { useEffect, useMemo, useState, useContext, type ReactNode } from "react";
import Image from "next/image";
import {
  LayoutDashboard, AlertCircle, AlertTriangle, BarChart3, ClipboardCheck, Timer, CalendarRange,
  User, Activity, RefreshCw, Truck, FileText, Mail, Check,
} from "lucide-react";
import { api, type DashboardData, type MmuStatus, type Asset, type LiveShift } from "@/lib/api";
import { Card, CardBody, Stat, Badge } from "@/components/ui";
import { ChartCard, BarH, BarV, StackedBar, Donut, AreaTrend, DataTable, ResponsibilityBar, HourHeatmap, PrintContext } from "@/components/charts";
import {
  filterTimeline, filterPrestart, sessionSummary, sessionsWithEnd, activityTimeline,
  kpis, uniqueSorted, groupSum, groupCount,
} from "@/lib/data";
import { ACTIVITY_COLOURS, CATEGORY_COLOURS, MASTER_PALETTE, activityColour,
  responsibilityOf, RESPONSIBILITY_ORDER, RESPONSIBILITY_COLOURS } from "@/lib/colors";
import { fmtTime } from "@/lib/utils";

const VIEWS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "logouts", label: "Operator Metrics", icon: User },
  { id: "util", label: "MMU Utilization", icon: BarChart3 },
  { id: "prestart", label: "Faults & Breakdowns", icon: ClipboardCheck },
  { id: "perf", label: "Shift Performance", icon: Timer },
  { id: "timeline", label: "Shift Timeline", icon: CalendarRange },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

// Pivot grouped (x, series) sums into [{x, seriesA, seriesB,...}] + series list.
function pivot<T>(rows: T[], xKey: (r: T) => string, sKey: (r: T) => string, val: (r: T) => number) {
  const xs: string[] = []; const ss = new Set<string>();
  const m = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const x = xKey(r), s = sKey(r);
    if (!m.has(x)) { m.set(x, { x }); xs.push(x); }
    const row = m.get(x)!;
    row[s] = (Number(row[s]) || 0) + val(r);
    ss.add(s);
  }
  return { data: xs.map((x) => m.get(x)!), series: Array.from(ss) };
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const REPORT_API = process.env.NEXT_PUBLIC_REPORT_API || "";  // PDF render service base URL
const SUBSCRIBE_API = process.env.NEXT_PUBLIC_SUBSCRIBE_API || "";  // report subscription service base URL
// Bucket logged hours by responsibility (who owns the time) for the hero bar.
function responsibilitySegments(act: { activity_type?: string; duration_hours: number }[]) {
  const m = new Map<string, number>();
  for (const r of act) m.set(responsibilityOf(r.activity_type || ""), (m.get(responsibilityOf(r.activity_type || "")) || 0) + (r.duration_hours || 0));
  const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
  return RESPONSIBILITY_ORDER.filter((b) => (m.get(b) || 0) > 0)
    .map((b) => ({ name: b, hours: m.get(b) || 0, pct: Math.round(((m.get(b) || 0) / total) * 100) }));
}
// Inclusive day count between two YYYY-MM-DD strings (e.g. 1 May–30 May = 30).
const rangeDays = (lo: string, hi: string) =>
  lo && hi ? Math.round((Date.parse(hi + "T00:00:00Z") - Date.parse(lo + "T00:00:00Z")) / 86400000) + 1 : 0;
// Internal / QA submissions hidden from the customer view by default: anything
// containing "test" (e.g. "Justin James is testing") plus an explicit list of
// internal/dev names (matched exactly, case-insensitive — so a real operator
// named e.g. "Justin Banda" is NOT filtered).
const INTERNAL_OPERATORS = new Set(["justin james"]);
const isTestOperator = (name?: string | null) => {
  const n = (name || "").trim().toLowerCase();
  return /test/i.test(n) || INTERNAL_OPERATORS.has(n);
};

const PRINT_TITLES: Record<string, string> = {
  overview: "Overview", logouts: "Operator Metrics", util: "MMU Utilization",
  prestart: "Faults & Breakdowns", perf: "Shift Performance", timeline: "Shift Timeline",
};

// Print/report layout: each selected tab rendered on its own A4 page with a
// branded header + footer. Interaction handlers are no-ops here.
const REPORT_KIND_LABEL: Record<string, string> = {
  daily: "Daily Report", weekly: "Weekly Report", monthly: "Monthly Report",
  operator: "Operator Performance Report", custom: "Custom Report",
};

function PrintReport({ tabs, reportKind, d, live, assets, lo, hi, fleet, selectedDays, effMmus, mmuLabel }:
  { tabs: string[]; reportKind: string; d: D; live: MmuStatus[]; assets: Asset[]; lo: string; hi: string; fleet: number; selectedDays: number; effMmus: Set<string>; mmuLabel: string }) {
  const noop = () => {};
  const kindLabel = REPORT_KIND_LABEL[reportKind] || "Report";
  const hideTiles = reportKind !== "daily";   // live MMU tiles only add value on the daily
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ");

  // MMUs that logged anything in the window — drives the per-MMU timeline pages
  // (the "timeline-each" token). At a 5am send these are yesterday's active units.
  const activeMmuList = uniqueSorted(d.tl.map((r) => r.mmu_id)).filter(Boolean) as string[];

  // Build the flat page list. "timeline-each" expands to one timeline per active MMU.
  type Page = { key: string; title: string; sub?: string; node: ReactNode };
  const pages: Page[] = [];
  for (const t of tabs) {
    if (t === "timeline-each") {
      if (!activeMmuList.length) {
        pages.push({ key: "tl-none", title: "Shift Timelines", node: <Card><CardBody><div className="text-sm text-muted">No MMUs logged activity for this day.</div></CardBody></Card> });
      } else {
        activeMmuList.forEach((m) => pages.push({
          key: `tl-${m}`, title: `Shift Timeline — ${m}`, sub: `MMU Operations — Kansanshi · ${lo} to ${hi} · ${m}`,
          node: <TimelineView selected={new Set([m])} />,
        }));
      }
      continue;
    }
    const node =
      t === "overview" ? <OverviewView d={d} live={live} assets={assets} onOpenTimeline={noop} onNavigate={noop} hideSiteStatus={hideTiles} /> :
      t === "logouts" ? <OperatorMetricsView d={d} onPickDate={noop} /> :
      t === "util" ? <UtilView d={d} fleet={fleet} selectedDays={selectedDays} onPickDate={noop} onPickMmu={noop} /> :
      t === "prestart" ? <PrestartView d={d} onPickMmu={noop} /> :
      t === "perf" ? <PerfView d={d} onPickMmu={noop} /> :
      t === "timeline" ? <TimelineView selected={effMmus} /> : null;
    pages.push({ key: t, title: PRINT_TITLES[t] || t, node });
  }

  // Signal the render service when the report is ready. Rather than a fixed timer
  // (which blanks timeline pages once there are more MMUs than the timer allows for),
  // wait until every per-MMU timeline has finished loading — each TimelineView
  // decrements __timelinesPending when its fetch settles — then a short settle for
  // charts to paint. A hard cap guarantees we never stall a hung fetch.
  useEffect(() => {
    const w = window as unknown as { __reportReady?: boolean; __timelinesPending?: number };
    w.__timelinesPending = activeMmuList.length;
    w.__reportReady = false;
    const start = Date.now();
    let done = false;
    const ready = () => { if (!done) { done = true; w.__reportReady = true; } };
    const poll = setInterval(() => {
      if ((w.__timelinesPending ?? 0) <= 0 && Date.now() - start >= 1800) {
        clearInterval(poll); setTimeout(ready, 1200);
      }
    }, 200);
    const cap = setTimeout(() => { clearInterval(poll); ready(); }, 17000);  // before the render's 20s wait
    return () => { clearInterval(poll); clearTimeout(cap); };
  }, [activeMmuList.length]);

  return (
    <PrintContext.Provider value={true}>
      <div className="report-root">
        {pages.map((p) => (
          <section key={p.key} className="report-page">
            <header className="report-head">
              <div className="report-band">
                <img src="/imining_white.png" alt="iMining" className="report-band-logo" />
                <span className="report-kind">{kindLabel}</span>
              </div>
              <div className="report-rule" />
              <div className="report-titlerow">
                <div className="report-meta">
                  <div className="report-title">MMU Operations — Kansanshi · {p.title}</div>
                  <div className="report-sub">{p.sub ? p.sub.replace(/^MMU Operations — Kansanshi · /, "") : `${lo} to ${hi} · ${mmuLabel}`}</div>
                  <div className="report-by">Generated {generated} (UTC) · Powered by iMining</div>
                </div>
                <img src="/orica_logo.png" alt="Orica" className="report-orica" />
              </div>
            </header>
            <div className="report-body">{p.node}</div>
          </section>
        ))}
      </div>
    </PrintContext.Provider>
  );
}

// ── Branded preview access gate ────────────────────────────────────────────────
// Soft gate: hides the dashboard UI behind a password. The password is never stored
// in source — only the SHA-256 hash (NEXT_PUBLIC_ACCESS_HASH) is, and entries are
// hashed client-side and compared. Good enough to stop casual/link-shared viewing;
// not a hard security boundary (lock the data API for that).
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
        try { localStorage.setItem("k_access", "1"); } catch { /* ignore */ }
        onUnlock();
      } else { setErr(true); setBusy(false); }
    } catch { setErr(true); setBusy(false); }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-2xl">
        <Image src="/imining_blue.png" alt="iMining" width={200} height={48} style={{ height: 40, width: "auto" }} className="mb-6" priority />
        <div className="text-lg font-semibold text-fg">MMU Operations — Kansanshi</div>
        <div className="mb-5 mt-1 text-sm text-muted">Preview access. Enter the password to continue.</div>
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
  const [raw, setRaw] = useState<DashboardData | null>(null);
  const [live, setLive] = useState<MmuStatus[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("overview");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);  // false = "all" (default); true = explicit selection
  const [preset, setPreset] = useState<number | "mtd" | "all" | "custom">(30);  // active date-range preset
  const [hideTest, setHideTest] = useState(true);  // exclude internal test operators from customer view
  const [devMode, setDevMode] = useState(false);   // ?dev in the URL reveals the test-data toggle (for re-design only)
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  const [loBound, setLoBound] = useState("");
  const [hiBound, setHiBound] = useState("");
  const [printTabs, setPrintTabs] = useState<string[] | null>(null);  // set when ?print → render the report layout
  const [reportKind, setReportKind] = useState<string>("daily");      // daily | weekly | monthly | operator
  const [reportOpen, setReportOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportLink, setReportLink] = useState<string | null>(null);
  const [reportSel, setReportSel] = useState<Set<string>>(new Set(["overview", "logouts", "util", "prestart", "perf"]));
  const [subOpen, setSubOpen] = useState(false);
  const [subEmail, setSubEmail] = useState("");
  const [subCadences, setSubCadences] = useState<Set<string>>(new Set(["daily"]));
  const [subBusy, setSubBusy] = useState(false);
  const [subDone, setSubDone] = useState(false);
  const [subErr, setSubErr] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);  // access gate (preview password)

  async function load() {
    setLoading(true); setError(null);
    try {
      const [d, m, a] = await Promise.all([
        api.dashboard("90d"),
        api.liveMmu(),
        api.assets().catch(() => ({ items: [] as Asset[] })), // graceful if not deployed yet
      ]);
      setRaw(d); setLive(m.items || []); setAssets(a.items || []);
      const dates = uniqueSorted((d.timeline || []).map((t) => (t.reporting_date || "").slice(0, 10)));
      const min = dates[0] || "", max = dates[dates.length - 1] || "";
      // Bounds span all available data; default the VIEW to the last 30 days.
      let lo30 = min;
      if (max) {
        const d0 = new Date(max + "T00:00:00Z");
        d0.setUTCDate(d0.getUTCDate() - 29);
        const s = d0.toISOString().slice(0, 10);
        lo30 = min && s < min ? min : s;
      }
      setLoBound(min); setHiBound(max);
      // Report/print mode: filters come from the URL so the render service can drive them.
      const p = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
      if (p.has("print")) {
        setLo(p.get("from") || lo30); setHi(p.get("to") || max); setPreset("custom");
        const mmus = p.get("mmus");
        if (mmus) { setSelected(new Set(mmus.split(",").filter(Boolean))); setTouched(true); }
        else { setSelected(new Set()); setTouched(false); }
        setHideTest(p.get("test") !== "1");   // report hides test data unless explicitly asked
        setReportKind(p.get("kind") || "daily");
        setPrintTabs((p.get("tabs") || "overview").split(",").filter(Boolean));
      } else {
        setLo(lo30); setHi(max); setPreset(30);
        setSelected(new Set()); setTouched(false);   // false + empty = "all" selected
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (typeof window !== "undefined") setDevMode(new URLSearchParams(window.location.search).has("dev")); }, []);
  // Access gate: open if no password is configured, if it's the report renderer
  // (?print), or once unlocked this session/device.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.has("print") || !process.env.NEXT_PUBLIC_ACCESS_HASH) { setAuthed(true); return; }
    try { if (localStorage.getItem("k_access") === "1") setAuthed(true); } catch { /* ignore */ }
  }, []);

  function applyPreset(days: number | "mtd" | "all") {
    if (!hiBound) return;
    setPreset(days);
    if (days === "all") { setLo(loBound); setHi(hiBound); return; }
    if (days === "mtd") { setLo(hiBound.slice(0, 8) + "01"); setHi(hiBound); return; }
    const d0 = new Date(hiBound + "T00:00:00Z");
    d0.setUTCDate(d0.getUTCDate() - (days - 1));
    setLo(d0.toISOString().slice(0, 10)); setHi(hiBound);
  }

  // The active billed fleet drives the MMU universe; fall back to data-derived
  // list if the assets registry isn't deployed yet.
  const activeSet = useMemo(() => new Set(assets.map((a) => a.fleet_no)), [assets]);
  const allMmus = useMemo(
    () => (assets.length
      ? [...assets].sort((a, b) => Number(a.sort_order ?? 999) - Number(b.sort_order ?? 999)).map((a) => a.fleet_no)
      : uniqueSorted((raw?.timeline || []).map((t) => t.mmu_id))),
    [assets, raw]
  );
  // Until the user touches the filter, "all" is selected. Then it's explicit
  // (empty = none). Always intersected with the active billed fleet.
  const effectiveSel = useMemo(() => (touched ? selected : new Set(allMmus)), [touched, selected, allMmus]);
  const effMmus = useMemo(
    () => (activeSet.size ? new Set([...effectiveSel].filter((m) => activeSet.has(m))) : effectiveSel),
    [effectiveSel, activeSet]
  );

  // Operator names are not case-sensitive ("Justin" and "justin" are one person).
  // Canonicalise every operator name to the most common spelling seen, so all
  // grouping/filtering downstream treats variants as a single operator.
  const canonOp = useMemo(() => {
    const counts = new Map<string, Map<string, number>>();
    const tally = (n?: string | null) => {
      const s = (n || "").trim();
      if (!s) return;
      const k = s.toLowerCase();
      const m = counts.get(k) || new Map<string, number>();
      m.set(s, (m.get(s) || 0) + 1);
      counts.set(k, m);
    };
    for (const r of raw?.timeline || []) tally(r.operator_name);
    for (const r of raw?.prestart || []) tally(r.operator_name);
    const out = new Map<string, string>();
    for (const [k, m] of counts) {
      let best = "", bc = -1;
      for (const [sp, c] of m) if (c > bc || (c === bc && sp < best)) { best = sp; bc = c; }
      out.set(k, best);
    }
    return (n?: string | null) => out.get((n || "").trim().toLowerCase()) ?? (n || "");
  }, [raw]);

  const d = useMemo(() => {
    // Internal/QA submissions are excluded from the customer view by default;
    // the sidebar toggle exposes them when needed. Operator names canonicalised.
    const cn = <T extends { operator_name?: string }>(r: T): T => ({ ...r, operator_name: canonOp(r.operator_name) });
    const keep = (r: { operator_name?: string }) => !hideTest || !isTestOperator(r.operator_name);
    const tlSrc = (raw?.timeline || []).filter(keep).map(cn);
    const psSrc = (raw?.prestart || []).filter(keep).map(cn);
    const tl = filterTimeline(tlSrc, effMmus, lo || "0000", hi || "9999");
    const ps = filterPrestart(psSrc, effMmus, lo || "0000", hi || "9999");
    const sessions = sessionSummary(tl);
    const ended = sessionsWithEnd(tl);
    const noEnd = sessions.filter((s) => !s.clocked_out);
    const act = activityTimeline(tl);
    return { tl, ps, sessions, ended, noEnd, act, k: kpis(tl, ps) };
  }, [raw, effMmus, lo, hi, hideTest, canonOp]);

  function toggleMmu(m: string) {
    const base = touched ? selected : new Set(allMmus);
    const n = new Set(base);
    if (n.has(m)) n.delete(m); else n.add(m);
    setSelected(n); setTouched(true);
  }
  function selectAll() { setSelected(new Set(allMmus)); setTouched(true); }
  function selectNone() { setSelected(new Set()); setTouched(true); }
  const allActive = !touched || (allMmus.length > 0 && allMmus.every((m) => selected.has(m)));
  const noneActive = touched && selected.size === 0;
  // Click an MMU tile → filter to just that unit and jump to its Shift Timeline.
  function openTimeline(fleet: string) { setSelected(new Set([fleet])); setTouched(true); setView("timeline"); }
  // Click a date bar → narrow the date filter to that single day.
  function pickDate(day: string) { setLo(day); setHi(day); setPreset("custom"); }
  // Click an MMU bar → filter to just that unit (stay on the current page).
  function pickMmu(fleet: string) { setSelected(new Set([fleet])); setTouched(true); }
  // Hard floor: the date picker can't go further back than 90 days from today
  // (live data is capped at 90d; older ranges belong to the scheduled reports).
  const min90 = (() => { const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - 90); return dt.toISOString().slice(0, 10); })();
  // Cap the picker at *today* (Kansanshi time, UTC+2) — not the latest data date,
  // so you can always select yesterday/today even before that day's data lands.
  const todayCat = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);

  // Build the print/report URL from the current filters + chosen tabs.
  function reportUrl(tabsCsv: string) {
    const params = new URLSearchParams({ print: "1", tabs: tabsCsv, from: lo, to: hi, kind: "custom" });
    if (touched) params.set("mmus", [...effMmus].join(","));
    if (devMode && !hideTest) params.set("test", "1");
    return `${typeof window !== "undefined" ? window.location.pathname : "/"}?${params.toString()}`;
  }

  // Generate the report: call the render service for a PDF download. If the
  // service URL isn't configured yet, fall back to opening the print view.
  async function generateReport() {
    const tabs = VIEWS.map((v) => v.id).filter((id) => reportSel.has(id) && id !== "timeline").join(",");
    if (!tabs) return;
    if (!REPORT_API) { if (typeof window !== "undefined") window.open(reportUrl(tabs), "_blank"); setReportOpen(false); return; }
    setReportBusy(true); setReportLink(null);
    try {
      const r = await fetch(`${REPORT_API.replace(/\/$/, "")}/report`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tabs, from: lo, to: hi, mmus: touched ? [...effMmus].join(",") : "", test: devMode && !hideTest ? 1 : 0, kind: "custom" }),
      });
      const j = await r.json();
      if (j.url) {
        setReportLink(j.url);  // keep a visible link (the auto-download can be blocked by popup rules)
        if (typeof document !== "undefined") {
          const a = document.createElement("a"); a.href = j.url; a.download = "kansanshi-report.pdf";
          document.body.appendChild(a); a.click(); a.remove();
        }
      } else {
        alert("Report failed: " + (j.error || "unknown error"));
      }
    } catch (e) {
      alert("Report failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setReportBusy(false);
    }
  }

  // Subscribe to scheduled email reports (daily/weekly/monthly).
  async function subscribe() {
    setSubErr(null);
    const cadences = [...subCadences];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(subEmail.trim())) { setSubErr("Please enter a valid email address."); return; }
    if (!cadences.length) { setSubErr("Pick at least one frequency."); return; }
    if (!SUBSCRIBE_API) { setSubErr("Subscriptions aren't configured yet."); return; }
    setSubBusy(true);
    try {
      const r = await fetch(`${SUBSCRIBE_API.replace(/\/$/, "")}/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: subEmail.trim(), cadences }),
      });
      const j = await r.json();
      if (j.ok) setSubDone(true);
      else setSubErr(j.error || "Subscription failed. Please try again.");
    } catch (e) {
      setSubErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubBusy(false);
    }
  }

  // ── Report/print mode: render the paged report instead of the app shell. ──
  if (printTabs && !loading && !error) {
    const mmuLabel = !touched ? "All MMUs" : selected.size === 1 ? [...selected][0] : `${effMmus.size} of ${allMmus.length} MMUs`;
    return <PrintReport tabs={printTabs} reportKind={reportKind} d={d} live={live} assets={assets} lo={lo} hi={hi}
      fleet={effMmus.size || allMmus.length} selectedDays={rangeDays(lo, hi)} effMmus={effMmus} mmuLabel={mmuLabel} />;
  }

  // ── Access gate (preview password) — shown until unlocked. ──
  if (!authed) return <AccessGate onUnlock={() => setAuthed(true)} />;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Sidebar (iMining navy) — fixed; only the main area scrolls ── */}
      <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto bg-sidebar text-sidebarfg md:flex">
        <div className="flex h-16 items-center gap-2 px-5">
          <Image src="/imining_white.png" alt="iMining" width={240} height={56} style={{ height: 52, width: "auto" }} />
        </div>
        <nav className="px-3">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => { if (id === "overview") { applyPreset(30); setSelected(new Set()); setTouched(false); } setView(id); }}
              className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm ${view === id ? "bg-accent text-white font-medium" : "text-sidebarfg/80 hover:bg-white/10"}`}>
              <Icon size={18} /> {label}
            </button>
          ))}
        </nav>

        {/* Filters */}
        <div className="mt-4 border-t border-white/10 px-4 py-4 text-sm">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sidebarfg/60">Date range</div>
          <div className="mb-2 grid grid-cols-4 gap-1">
            {([["7d", 7], ["30d", 30], ["90d", 90], ["MTD", "mtd"]] as const).map(([label, v]) => (
              <button key={label} onClick={() => applyPreset(v as number | "mtd" | "all")}
                className={`rounded-lg border py-1 text-center text-xs ${preset === v ? "border-accent bg-accent font-semibold text-white" : "border-white/15 bg-white/5 hover:bg-white/15"}`}>{label}</button>
            ))}
          </div>
          <div className="mb-4 flex flex-col gap-2">
            <input type="date" value={lo} min={min90} max={todayCat} onChange={(e) => { setLo(e.target.value); setPreset("custom"); }}
              className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-sidebarfg" />
            <input type="date" value={hi} min={min90} max={todayCat} onChange={(e) => { setHi(e.target.value); setPreset("custom"); }}
              className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-sidebarfg" />
          </div>

          <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-sidebarfg/60">
            <span>MMUs</span>
            <span className="flex gap-1 normal-case">
              <button onClick={selectAll} className={`rounded px-2 py-0.5 ${allActive ? "bg-accent font-semibold text-white" : "text-accent2 hover:underline"}`}>All</button>
              <button onClick={selectNone} className={`rounded px-2 py-0.5 ${noneActive ? "bg-accent font-semibold text-white" : "text-accent2 hover:underline"}`}>None</button>
            </span>
          </div>
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-white/15 bg-white/5 p-1.5">
            {allMmus.map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/10">
                <input type="checkbox" checked={touched ? selected.has(m) : true} onChange={() => toggleMmu(m)} />
                <span>{m}</span>
              </label>
            ))}
          </div>

          {devMode && (
            <label className="mt-4 flex cursor-pointer items-center gap-2 border-t border-white/10 pt-4 text-xs text-sidebarfg/80">
              <input type="checkbox" checked={hideTest} onChange={() => setHideTest((v) => !v)} />
              <span>Hide test data</span>
            </label>
          )}
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-6">
          <div className="flex items-center gap-3">
            <Image src="/orica_logo.png" alt="Orica" width={180} height={56} style={{ height: 48, width: "auto" }} />
            <span className="text-lg font-semibold text-fg">MMU Operations — Kansanshi</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setReportLink(null); setReportOpen(true); }} className="flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-bg">
              <FileText size={15} /> Generate report
            </button>
            <button onClick={() => { setSubDone(false); setSubErr(null); setSubOpen(true); }} className="flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-bg">
              <Mail size={15} /> Subscribe to reports
            </button>
            <button onClick={load} className="flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-bg">
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
        </header>

        {reportOpen && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setReportOpen(false)}>
            <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="text-lg font-semibold text-fg">Generate report</div>
              <div className="mb-4 mt-1 text-sm text-muted">Pick the sections to include — each becomes its own page, using the current date range &amp; MMU filters.</div>
              <div className="space-y-1">
                {VIEWS.filter((v) => v.id !== "timeline").map(({ id, label }) => (
                  <label key={id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-bg">
                    <input type="checkbox" checked={reportSel.has(id)}
                      onChange={() => { const n = new Set(reportSel); n.has(id) ? n.delete(id) : n.add(id); setReportSel(n); }} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              {reportLink && (
                <a href={reportLink} download="kansanshi-report.pdf" target="_blank" rel="noopener"
                  className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm font-medium text-ok hover:bg-ok/20">
                  <FileText size={15} /> Report ready — download
                </a>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setReportOpen(false)} disabled={reportBusy} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg disabled:opacity-50">{reportLink ? "Close" : "Cancel"}</button>
                <button disabled={reportSel.size === 0 || reportBusy} onClick={generateReport}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                  {reportBusy ? "Generating…" : REPORT_API ? "Download report" : "Open report"}
                </button>
              </div>
            </div>
          </div>
        )}

        {subOpen && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setSubOpen(false)}>
            <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              {subDone ? (
                <div className="py-2 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ok/10 text-ok"><Check size={24} /></div>
                  <div className="text-lg font-semibold text-fg">You&apos;re subscribed</div>
                  <div className="mt-1 text-sm text-muted">A confirmation is on its way to <span className="font-medium text-fg">{subEmail}</span>. Every report includes a one-click unsubscribe link.</div>
                  <button onClick={() => setSubOpen(false)} className="mt-5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white">Done</button>
                </div>
              ) : (
                <>
                  <div className="text-lg font-semibold text-fg">Subscribe to reports</div>
                  <div className="mb-4 mt-1 text-sm text-muted">Get the Kansanshi MMU Operations report emailed automatically. Choose how often:</div>
                  <input type="email" value={subEmail} onChange={(e) => setSubEmail(e.target.value)} placeholder="you@company.com"
                    className="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
                  <div className="space-y-1">
                    {[["daily", "Daily", "Each morning — yesterday's operational snapshot"], ["weekly", "Weekly", "Monday — the past 7 days, full report"], ["monthly", "Monthly", "1st of the month — previous month, full report"]].map(([id, label, desc]) => (
                      <label key={id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-bg">
                        <input type="checkbox" className="mt-0.5" checked={subCadences.has(id)}
                          onChange={() => { const n = new Set(subCadences); n.has(id) ? n.delete(id) : n.add(id); setSubCadences(n); }} />
                        <span><span className="font-medium text-fg">{label}</span><span className="block text-xs text-muted">{desc}</span></span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-muted">
                    By subscribing you agree to receive recurring report emails from iMining at this address. We use it only to send these reports — you can unsubscribe at any time via the link in every email.
                  </p>
                  {subErr && <div className="mt-3 text-sm text-danger">{subErr}</div>}
                  <div className="mt-5 flex justify-end gap-2">
                    <button onClick={() => setSubOpen(false)} disabled={subBusy} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg disabled:opacity-50">Cancel</button>
                    <button disabled={subBusy} onClick={subscribe} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                      {subBusy ? "Subscribing…" : "Subscribe"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <main className="flex-1 overflow-auto p-6">
          {error && <Card><CardBody><div className="flex items-center gap-2 text-danger"><AlertCircle size={18} /> {error}</div></CardBody></Card>}
          {loading ? <div className="text-sm text-muted">Loading…</div> : (
            <div className="space-y-6">
              {view === "overview" && <OverviewView d={d} live={live} assets={assets} onOpenTimeline={openTimeline} onNavigate={setView} />}
              {view === "logouts" && <OperatorMetricsView d={d} onPickDate={pickDate} />}
              {view === "util" && <UtilView d={d} fleet={effMmus.size || allMmus.length} selectedDays={rangeDays(lo, hi)} onPickDate={pickDate} onPickMmu={pickMmu} />}
              {view === "prestart" && <PrestartView d={d} onPickMmu={pickMmu} />}
              {view === "perf" && <PerfView d={d} onPickMmu={pickMmu} />}
              {view === "timeline" && <TimelineView selected={effMmus} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ── Site status: one fixed tile per active billed asset, merged with live state ── */
function SiteStatus({ assets, live, onOpenTimeline }: { assets: Asset[]; live: MmuStatus[]; onOpenTimeline: (fleet: string) => void }) {
  const liveByFleet = new Map(live.map((m) => [m.fleet_no, m]));
  // Base list is the active billed fleet; fall back to live list if the assets
  // registry isn't deployed yet.
  const base: Asset[] = assets.length
    ? [...assets].sort((a, b) => Number(a.sort_order ?? 999) - Number(b.sort_order ?? 999))
    : live.map((m) => ({ fleet_no: m.fleet_no, display_name: m.fleet_no }));
  // Forgotten logout: on shift but no activity logged for 12h+ (uses last_seen,
  // a UTC timestamp, vs now — so it's timezone-safe and won't false-flag normal
  // overnight shifts that are still logging).
  const STALE_MS = 12 * 3600 * 1000;

  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-semibold text-fg"><Truck size={16} /> Site Status — live snapshot</div>
      <div className="mb-3 mt-0.5 text-xs text-muted">Real-time, ignores the date/MMU filters. Click any unit to open its Shift Timeline.</div>
      {base.length === 0 ? <div className="text-sm text-muted">No assets configured.</div> : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {base.map((asset) => {
            const m = liveByFleet.get(asset.fleet_no);
            const onShift = (m?.status || "").toUpperCase() === "ON_SHIFT";
            // Live pre-start check: warn if this shift has no pre-start logged
            // (counts a pre-start up to 3h before shift start). Real-time, off
            // current_mmu.last_prestart_at — never the lagged precompute.
            const psMs = m?.last_prestart_at ? Date.parse(m.last_prestart_at) : NaN;
            const sinceMs = m?.since ? Date.parse(m.since) : NaN;
            const noPrestart = !m ? false
              : isNaN(sinceMs) ? isNaN(psMs)
              : isNaN(psMs) ? true
              : psMs < sinceMs - 3 * 3600 * 1000;
            const lastSeenMs = m?.last_seen ? Date.parse(m.last_seen) : NaN;
            const missedEnd = onShift && !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) > STALE_MS;
            return (
              <Card key={asset.fleet_no}
                className="cursor-pointer transition hover:border-accent hover:shadow-md"
                onClick={() => onOpenTimeline(asset.fleet_no)}>
                <CardBody>
                  <div className="flex items-start justify-between">
                    <span className="font-semibold text-fg">{asset.display_name || asset.fleet_no}</span>
                    <div className="flex flex-col items-end gap-1">
                      <Badge tone={!m ? "muted" : onShift ? "ok" : "muted"}>
                        {onShift && (
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-ok shadow-[0_0_4px_1px_rgba(22,163,74,0.55)]" />
                          </span>
                        )}
                        {!m ? "No data" : onShift ? "On shift" : "Off shift"}
                      </Badge>
                      {missedEnd && (
                        <span className="flex items-center gap-1 text-xs font-medium text-danger" title="On shift with no activity for 12h+ — likely a missed shift-end">
                          <AlertTriangle size={12} /> Missed shift-end?
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-sm text-muted"><User size={14} /> {m?.operator || m?.operator_last || "—"}</div>
                  <div className="mt-1 flex items-center gap-2 text-sm text-fg"><Activity size={14} className="text-accent" /> {m?.last_activity || "—"}</div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-muted">{m ? fmtTime(m.last_seen) : "No activity logged"}</span>
                    {noPrestart && (
                      <span className="flex items-center gap-1 text-xs font-medium text-warn" title="No pre-start inspection logged for this shift">
                        <AlertTriangle size={14} /> No pre-start
                      </span>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

type D = {
  tl: ReturnType<typeof filterTimeline>; ps: ReturnType<typeof filterPrestart>;
  sessions: ReturnType<typeof sessionSummary>; ended: Set<string>;
  noEnd: ReturnType<typeof sessionSummary>; act: ReturnType<typeof activityTimeline>;
  k: ReturnType<typeof kpis>;
};

/* ── Overview: site tiles + KPIs + live status pie + activity mix ── */
function OverviewView({ d, live, assets, onOpenTimeline, onNavigate, hideSiteStatus = false }:
  { d: D; live: MmuStatus[]; assets: Asset[]; onOpenTimeline: (fleet: string) => void; onNavigate: (v: ViewId) => void; hideSiteStatus?: boolean }) {
  const print = useContext(PrintContext);  // report → KPI tiles on one row
  // Current fleet status — what each active unit is doing RIGHT NOW (live snapshot).
  const liveByFleet = new Map(live.map((m) => [m.fleet_no, m]));
  const fleet: { fleet_no: string }[] = assets.length ? assets : live.map((m) => ({ fleet_no: m.fleet_no }));
  const stateCount: Record<string, number> = {};
  for (const a of fleet) {
    const m = liveByFleet.get(a.fleet_no);
    const state = !m ? "No data"
      : (m.status || "").toUpperCase() !== "ON_SHIFT" ? "Off shift"
      : (m.last_activity || "On shift");
    stateCount[state] = (stateCount[state] || 0) + 1;
  }
  const statusData = Object.entries(stateCount).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const statusColors: Record<string, string> = { ...ACTIVITY_COLOURS, "On shift": "#59A14F", "Off shift": "#BAB0AC", "No data": "#D7DBE0" };

  // Activity mix donut — top 5 + Other so the legend stays legible (secondary view).
  const mixAll = groupSum(d.act, (r) => r.activity_type || "Other", (r) => r.duration_hours)
    .map((x) => ({ name: x.name, value: round1(x.value) })).sort((a, b) => b.value - a.value);
  const mixOther = round1(mixAll.slice(5).reduce((s, x) => s + x.value, 0));
  const mix = mixOther > 0 ? [...mixAll.slice(0, 5), { name: "Other", value: mixOther }] : mixAll;

  // Responsibility lens (the client exhibit).
  const segments = responsibilitySegments(d.act);
  const waiting = segments.find((s) => s.name === "Waiting on mine");

  const missStatus = d.k.missingPct > 25 ? "bad" : d.k.missingPct > 10 ? "warn" : "ok";

  return (
    <div className="space-y-6">
      {!hideSiteStatus && <SiteStatus assets={assets} live={live} onOpenTimeline={onOpenTimeline} />}
      <div className="flex items-center gap-3 pt-2">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted">For the selected date range &amp; MMUs</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className={print ? "grid grid-cols-4 gap-3" : "grid grid-cols-2 gap-4 lg:grid-cols-4"}>
        <Stat label="Missing shift-ends" value={d.k.missingLogouts} sub={`${d.k.missingPct.toFixed(0)}% of sessions · click to investigate`} status={missStatus} onClick={() => onNavigate("logouts")} />
        <Stat label="Active MMUs" value={d.k.activeMmus} sub="click to investigate" onClick={() => onNavigate("util")} />
        <Stat label="Pre-start faults" value={d.k.faults} sub="click to investigate" status={d.k.faults > 0 ? "warn" : "ok"} onClick={() => onNavigate("prestart")} />
        <Stat label="Shift sessions" value={d.k.totalSessions} sub="click to investigate" onClick={() => onNavigate("perf")} />
      </div>

      <ChartCard title="Where the shift went — by responsibility"
        subtitle="Every logged hour bucketed by who owns the time. One bar, one argument.">
        <ResponsibilityBar segments={segments} />
        {waiting && waiting.pct > 0 && (
          <div className="mt-4 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
            <span className="font-semibold text-accent">{waiting.pct}% ({waiting.hours.toFixed(1)}h)</span> of logged fleet time was spent <span className="font-medium">waiting on mine-supplied explosives &amp; personnel</span> — logged evidence, not idle time.
          </div>
        )}
      </ChartCard>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Current fleet status" subtitle="What each unit is doing right now (live)">
          <Donut data={statusData} colorMap={statusColors} />
        </ChartCard>
        <ChartCard title="Fleet-wide activity mix" subtitle="Share of logged hours over the selected range (top 5 + other)">
          <Donut data={mix} colorMap={{ ...ACTIVITY_COLOURS, Other: "#BAB0AC" }} />
        </ChartCard>
      </div>
    </div>
  );
}

/* ── Operator Metrics ──
   Per-operator behaviour over the filtered period: pre-start compliance,
   missing shift-ends, benches loaded, and a per-operator daily shift-quality
   timeline. Pre-start rows carry operator_name, so pre-starts are matched to a
   shift by operator + MMU + reporting date (no cross-shift ambiguity). */
const GREEN = "#59A14F", AMBER = "#F1A340", RED = "#E15759";

function OperatorPicker({ all, selected, onChange }:
  { all: string[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const label = selected.size === all.length ? "All operators"
    : selected.size === 0 ? "No operators"
    : `${selected.size} of ${all.length} operators`;
  const allActive = selected.size === all.length;
  const noneActive = selected.size === 0;
  const pill = (active: boolean) =>
    `rounded-lg border px-2.5 py-1 text-xs ${active ? "border-accent bg-accent font-semibold text-white" : "border-border bg-surface hover:bg-bg"}`;
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm hover:bg-bg">
          {label} <span className="text-muted">▾</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute z-20 mt-1 w-64 rounded-xl border border-border bg-surface p-2 shadow-lg">
              <div className="max-h-64 overflow-auto">
                {all.map((o) => (
                  <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg">
                    <input type="checkbox" checked={selected.has(o)}
                      onChange={() => { const n = new Set(selected); n.has(o) ? n.delete(o) : n.add(o); onChange(n); }} />
                    <span>{o}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      <button onClick={() => onChange(new Set(all))} className={pill(allActive)}>All</button>
      <button onClick={() => onChange(new Set())} className={pill(noneActive)}>None</button>
    </div>
  );
}

function OperatorMetricsView({ d, onPickDate }: { d: D; onPickDate: (day: string) => void }) {
  const print = useContext(PrintContext);  // report → KPI tiles on one row
  const allOps = useMemo(() => uniqueSorted(d.sessions.map((s) => s.operator_name)), [d.sessions]);
  const [opSel, setOpSel] = useState<Set<string> | null>(null);  // null = all
  const effOps = opSel ?? new Set(allOps);
  const has = (op?: string | null) => effOps.has(op || "—");
  const pickOp = (name: string) => setOpSel(new Set([name]));  // click a bar → filter to that operator

  // Pre-start presence keyed by operator + MMU + reporting date.
  const keyOf = (op?: string | null, mmu?: string | null, date?: string | null) =>
    `${(op || "").trim()}|${(mmu || "").trim()}|${(date || "").slice(0, 10)}`;
  const psKeys = useMemo(() => new Set(d.ps.map((p) => keyOf(p.operator_name, p.mmu_id, p.reporting_date))), [d.ps]);

  const sessions = d.sessions.filter((s) => has(s.operator_name));
  const noEnd = d.noEnd.filter((s) => has(s.operator_name));

  // Per-operator rollup: shifts (logins), pre-starts done, shift-ends done.
  const opMap = new Map<string, { shifts: number; prestart: number; ended: number }>();
  for (const s of sessions) {
    const op = s.operator_name || "—";
    const r = opMap.get(op) || { shifts: 0, prestart: 0, ended: 0 };
    r.shifts++;
    if (psKeys.has(keyOf(s.operator_name, s.mmu_id, s.reporting_date))) r.prestart++;
    if (s.clocked_out) r.ended++;
    opMap.set(op, r);
  }
  const opStats = Array.from(opMap, ([operator, r]) => ({ operator, ...r, compliance: r.shifts ? r.prestart / r.shifts : 0 }));

  const benchAll = d.act.filter((a) => a.activity_type === "Loading Explosives" && has(a.operator_name));
  const benches = benchAll.length;
  const operators = opStats.length;
  const totalShifts = sessions.length;
  const totalPrestart = opStats.reduce((n, o) => n + o.prestart, 0);
  const overallCompliance = totalShifts ? totalPrestart / totalShifts : 0;

  // Operators to follow up: ≥3 shifts and under 60% pre-start compliance.
  const flagged = opStats.filter((o) => o.shifts >= 3 && o.compliance < 0.6).sort((a, b) => a.compliance - b.compliance);

  const byOp = groupCount(noEnd, (s) => s.operator_name || "—").sort((a, b) => b.value - a.value);
  const byDate = groupCount(noEnd, (s) => s.reporting_date || "—").sort((a, b) => a.name.localeCompare(b.name));

  const compBars = opStats.map((o) => ({ name: o.operator, value: Math.round(o.compliance * 100) })).sort((a, b) => a.value - b.value);
  const compColors: Record<string, string> = {};
  compBars.forEach((b) => (compColors[b.name] = b.value < 60 ? RED : b.value < 85 ? AMBER : GREEN));

  const benchByOp = groupCount(benchAll, (a) => a.operator_name || "—").sort((a, b) => b.value - a.value);

  // Productivity leaderboard: productive hours (loading / FQMO / reload) per operator.
  const prodByOp = new Map<string, number>();
  for (const a of d.act) {
    if (!has(a.operator_name) || responsibilityOf(a.activity_type || "") !== "Productive") continue;
    const op = a.operator_name || "—";
    prodByOp.set(op, (prodByOp.get(op) || 0) + (a.duration_hours || 0));
  }
  const leaderboard = Array.from(prodByOp, ([name, v]) => ({ name, value: round1(v) })).sort((a, b) => b.value - a.value);

  // Single-operator daily shift-quality timeline (the per-operator drilldown).
  const single = effOps.size === 1 ? [...effOps][0] : null;
  const dayMap = new Map<string, { prestart: boolean; ended: boolean }>();
  if (single) {
    for (const s of d.sessions.filter((s) => (s.operator_name || "—") === single)) {
      const day = (s.reporting_date || "").slice(0, 10);
      if (!day) continue;
      const r = dayMap.get(day) || { prestart: false, ended: false };
      if (psKeys.has(keyOf(s.operator_name, s.mmu_id, s.reporting_date))) r.prestart = true;
      if (s.clocked_out) r.ended = true;
      dayMap.set(day, r);
    }
  }
  const dayData = Array.from(dayMap, ([day, r]) => {
    const score = (r.prestart ? 1 : 0) + (r.ended ? 1 : 0);  // 0,1,2
    return { name: day, value: score + 1 };                  // 1=poor, 2=partial, 3=good
  }).sort((a, b) => a.name.localeCompare(b.name));
  const dayColors: Record<string, string> = {};
  const dayLabels: Record<string, string> = {};
  for (const [day, r] of dayMap) {
    dayColors[day] = r.prestart && r.ended ? GREEN : r.prestart || r.ended ? AMBER : RED;
    dayLabels[day] = r.prestart && r.ended ? "Complete"
      : !r.prestart && r.ended ? "No pre-start"
      : r.prestart && !r.ended ? "No shift-end"
      : "Neither";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted">Operator filter:</span>
        <OperatorPicker all={allOps} selected={effOps} onChange={setOpSel} />
      </div>

      <div className={print ? "grid grid-cols-4 gap-3" : "grid grid-cols-2 gap-4 lg:grid-cols-4"}>
        <Stat label="Operators on shift" value={operators} sub="ran ≥1 shift in range" />
        <Stat label="Benches loaded" value={benches} sub="loading-explosives events" />
        <Stat label="Benches per operator" value={operators ? round1(benches / operators) : 0} />
        <Stat label="Pre-start compliance" value={`${Math.round(overallCompliance * 100)}%`} sub={`${totalPrestart} of ${totalShifts} shifts`}
          status={overallCompliance >= 0.85 ? "ok" : overallCompliance >= 0.6 ? "warn" : "bad"} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Missing shift-end logs by operator" subtitle="Click a bar to filter to that operator">
          <BarH data={byOp} xLabel="Sessions without shift-end" yLabel="Operator" onSelect={pickOp} />
        </ChartCard>
        <ChartCard title="Missing shift-end logs by date" subtitle="Click a bar to filter to that day">
          <BarV data={byDate} xLabel="Date" yLabel="Sessions without shift-end" onSelect={onPickDate} />
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Pre-start compliance by operator" subtitle="Share of shifts with a matching pre-start · green ≥85% · amber ≥60% · red <60% · click a bar to filter">
          <BarH data={compBars} colorMap={compColors} xLabel="Pre-start compliance (%)" yLabel="Operator" onSelect={pickOp} />
        </ChartCard>
        <Card>
          <CardBody>
            <div className="mb-1 text-sm font-semibold text-fg">Operators to follow up</div>
            <div className="mb-3 text-xs text-muted">≥3 shifts with under 60% pre-start compliance</div>
            {flagged.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted">No operators flagged — pre-start compliance looks healthy.</div>
            ) : (
              <div className="space-y-2">
                {flagged.map((o) => (
                  <div key={o.operator} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                    <span>{o.operator}</span>
                    <span className="flex items-center gap-2 text-muted">{o.prestart}/{o.shifts} shifts <Badge tone="danger">{Math.round(o.compliance * 100)}%</Badge></span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Benches loaded by operator" subtitle="Each loading-explosives event ≈ one bench loaded · click a bar to filter">
          <BarH data={benchByOp} xLabel="Benches loaded" yLabel="Operator" onSelect={pickOp} />
        </ChartCard>
        <ChartCard title="Productivity leaderboard" subtitle="Productive hours by operator (loading · FQMO · reload) · click a bar to filter">
          <BarH data={leaderboard} xLabel="Productive hours" yLabel="Operator" onSelect={pickOp} />
        </ChartCard>
      </div>

      {single ? (
        <ChartCard title={`Daily shift quality — ${single}`}
          subtitle="Per day worked · green = pre-start + shift-end done · amber = one missing · red = both missing">
          <BarV data={dayData} colorMap={dayColors} barLabels={dayLabels} xLabel="Date" yLabel="Shift quality (3 = full)" height={300} />
        </ChartCard>
      ) : (
        <Card><CardBody>
          <div className="py-10 text-center text-sm text-muted">Select a single operator in the filter above to see their day-by-day shift-quality timeline.</div>
        </CardBody></Card>
      )}
    </div>
  );
}

/* ── MMU Utilization ── */
function UtilView({ d, fleet, selectedDays, onPickDate, onPickMmu }: { d: D; fleet: number; selectedDays: number; onPickDate: (day: string) => void; onPickMmu: (fleet: string) => void }) {
  const print = useContext(PrintContext);  // report → KPI tiles on one row
  // Distinct days with loading-explosives events, vs the selected range length.
  // Loading is the metric that matters — days with none aren't productive days.
  // Matches the fleet utilization chart below.
  const loadingDays = new Set(
    d.act.filter((r) => r.activity_type === "Loading Explosives").map((r) => (r.reporting_date || "").slice(0, 10)).filter(Boolean)
  ).size;
  const piv = pivot(d.act, (r) => r.mmu_id || "—", (r) => r.activity_type || "Other", (r) => r.duration_hours);
  piv.data.forEach((row) => piv.series.forEach((s) => (row[s] = round1(Number(row[s]) || 0))));
  const colourMap: Record<string, string> = {};
  piv.series.forEach((s, i) => (colourMap[s] = activityColour(s, i)));
  const mix = groupSum(d.act, (r) => r.activity_type || "Other", (r) => r.duration_hours).map((x) => ({ name: x.name, value: round1(x.value) }));
  const daily = pivot(d.act, (r) => (r.reporting_date || "").slice(0, 10), (r) => r.activity_type || "Other", (r) => r.duration_hours);
  daily.data.sort((a, b) => String(a.x).localeCompare(String(b.x)));

  // Loading-explosives fleet utilization: per activity day, how many distinct
  // MMUs logged a Loading Explosives event (= were actively loading), against
  // the reporting fleet size.
  const loadByDay = new Map<string, Set<string>>();
  for (const r of d.act) {
    if (r.activity_type !== "Loading Explosives") continue;
    const day = (r.reporting_date || "").slice(0, 10);
    const mmu = (r.mmu_id || "").trim();
    if (!day || !mmu) continue;
    (loadByDay.get(day) || loadByDay.set(day, new Set()).get(day)!).add(mmu);
  }
  const utilData = Array.from(loadByDay, ([name, set]) => ({ name, value: set.size })).sort((a, b) => a.name.localeCompare(b.name));
  const loadingEvents = d.act.filter((r) => r.activity_type === "Loading Explosives");
  const benches = loadingEvents.length;

  // Benches loaded per day, broken down by bench location (populated once the
  // pipeline captures Bench Location — re-run precompute to backfill).
  const hasBench = loadingEvents.some((r) => (r.bench_location || "").trim());
  const benchPiv = pivot(loadingEvents, (r) => (r.reporting_date || "").slice(0, 10), (r) => (r.bench_location || "").trim() || "Unspecified", () => 1);
  benchPiv.data.sort((a, b) => String(a.x).localeCompare(String(b.x)));
  const benchColors: Record<string, string> = {};
  benchPiv.series.forEach((s, i) => (benchColors[s] = MASTER_PALETTE[i % MASTER_PALETTE.length]));
  const benchRows = loadingEvents
    .map((r) => ({
      Date: (r.reporting_date || "").slice(0, 10),
      Time: (r.start_timestamp || "").slice(11, 16) || "—",
      MMU: r.mmu_id,
      "Bench Location": r.bench_location || "—",
      Specify: r.specify || "—",
      Operator: r.operator_name,
      _ts: r.start_timestamp || "",
    }))
    // Rows that carry bench/specify float to the top; then newest day first,
    // and chronological within a day so accidental consecutive logs sit together.
    .sort((a, b) => {
      const aFilled = a["Bench Location"] !== "—" || a.Specify !== "—";
      const bFilled = b["Bench Location"] !== "—" || b.Specify !== "—";
      if (aFilled !== bFilled) return aFilled ? -1 : 1;
      if (a.Date !== b.Date) return b.Date.localeCompare(a.Date);
      return String(a._ts).localeCompare(String(b._ts));
    });
  const peak = utilData.reduce((m, x) => Math.max(m, x.value), 0);
  const avg = utilData.length ? utilData.reduce((s, x) => s + x.value, 0) / utilData.length : 0;
  // Performance-vs-target, not RAG: target = 50% of the reporting fleet loading.
  const utilTarget = Math.max(1, Math.round(fleet * 0.5));

  return (
    <div className="space-y-6">
      <div className={print ? "grid grid-cols-5 gap-3" : "grid grid-cols-2 gap-4 lg:grid-cols-5"}>
        <Stat label="Reporting fleet" value={fleet} sub="MMUs in scope" />
        <Stat label="Days of loading data" value={`${loadingDays} / ${selectedDays}`} sub="loading days / selected days" />
        <Stat label="Benches loaded" value={benches} sub="loading-explosives events" />
        <Stat label="Peak MMUs loading" value={peak} sub="busiest day" />
        <Stat label="Avg MMUs loading / day" value={round1(avg)} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Total activity hours by MMU" subtitle="Click an MMU to filter to that unit">
          <StackedBar rows={piv.data} xKey="x" series={piv.series} colorMap={colourMap} onSelect={onPickMmu} />
        </ChartCard>
        <ChartCard title="Fleet-wide activity mix"><Donut data={mix} colorMap={ACTIVITY_COLOURS} /></ChartCard>
      </div>

      <ChartCard title="Fleet utilization — MMUs loading explosives per day"
        subtitle={`Distinct MMUs loading on each activity day vs target (50% of ${fleet} = ${utilTarget}). Green = met or beat target · click a day to filter.`}>
        <BarV data={utilData} target={utilTarget} targetLabel="50% fleet" xLabel="Date" yLabel="MMUs loading explosives" height={340} onSelect={onPickDate} />
      </ChartCard>

      {hasBench && (
        <ChartCard title="Benches loaded per day by location" subtitle="Loading-explosives events stacked by bench location · click a day to filter">
          <StackedBar rows={benchPiv.data} xKey="x" series={benchPiv.series} colorMap={benchColors} onSelect={onPickDate} />
        </ChartCard>
      )}

      <ChartCard title="Daily activity hours trend"><AreaTrend rows={daily.data} xKey="x" series={daily.series} colorMap={colourMap} /></ChartCard>

      <ChartCard title="Loading-explosives detail"
        subtitle={hasBench ? "Each loading event with its bench location" : "Bench Location / Specify populate once the pipeline is re-run to capture them"}>
        <DataTable
          columns={[{ key: "Date", label: "Date" }, { key: "Time", label: "Time" }, { key: "MMU", label: "MMU" }, { key: "Bench Location", label: "Bench Location" }, { key: "Specify", label: "Specify" }, { key: "Operator", label: "Operator" }]}
          rows={benchRows} csvName="loading_explosives.csv" />
      </ChartCard>
    </div>
  );
}

/* ── Pre-start faults ── */
function PrestartView({ d, onPickMmu }: { d: D; onPickMmu: (fleet: string) => void }) {
  const print = useContext(PrintContext);  // report → KPI tiles on one row
  const faults = d.ps.filter((p) => p.fault_flag);
  const breakdowns = d.act.filter((r) => r.activity_type === "Breakdown");

  // Combined log count (pre-start faults + breakdown events) per MMU → worst unit.
  const logByMmu = new Map<string, number>();
  for (const f of faults) { const m = f.mmu_id || "—"; logByMmu.set(m, (logByMmu.get(m) || 0) + 1); }
  for (const b of breakdowns) { const m = b.mmu_id || "—"; logByMmu.set(m, (logByMmu.get(m) || 0) + 1); }
  let topMmu = "—", topN = 0;
  for (const [m, n] of logByMmu) if (n > topN) { topN = n; topMmu = m; }

  const byMmu = groupCount(faults, (p) => p.mmu_id || "—").sort((a, b) => b.value - a.value);
  const byCat = groupCount(faults, (p) => p.checklist_category || "—").sort((a, b) => b.value - a.value);
  const byItem = groupCount(faults, (p) => (p.checklist_item || "—")).sort((a, b) => b.value - a.value).slice(0, 5)
    .map((x) => ({ name: x.name.length > 48 ? x.name.slice(0, 48) + "…" : x.name, value: x.value }));
  const rows = faults.map((p) => ({ MMU: p.mmu_id, Date: p.reporting_date, Category: p.checklist_category, Item: p.checklist_item }));

  // Breakdown log: one row per breakdown event (newest first).
  const breakdownRows = breakdowns
    .map((b) => ({
      Date: (b.reporting_date || "").slice(0, 10),
      Time: (b.start_timestamp || "").slice(11, 16) || "—",
      MMU: b.mmu_id,
      Category: b.activity_category || "—",
      Type: b.breakdown_type || "—",
      "Additional info": b.activity_detail || "—",
      _ts: b.start_timestamp || "",
    }))
    .sort((a, b) => String(b._ts).localeCompare(String(a._ts)));

  // ── Used-after-fault: an MMU flagged with a pre-start fault that still
  // loaded explosives later the same day (after the flag time). ──
  const ms = (s?: string) => { const t = Date.parse(s || ""); return isNaN(t) ? null : t; };
  const keyOf = (mmu?: string | null, date?: string | null) => `${(mmu || "").trim()}|${(date || "").slice(0, 10)}`;
  // earliest fault flag time + fault count per MMU/day
  const faultGroups = new Map<string, { time: string; items: number }>();
  for (const f of faults) {
    const k = keyOf(f.mmu_id, f.reporting_date);
    const t = f.inspection_timestamp || "";
    const g = faultGroups.get(k);
    if (!g) faultGroups.set(k, { time: t, items: 1 });
    else { g.items++; if (t && (!g.time || t < g.time)) g.time = t; }
  }
  // activity events grouped by MMU/day
  const actByKey = new Map<string, typeof d.act>();
  for (const a of d.act) { const k = keyOf(a.mmu_id, a.reporting_date); (actByKey.get(k) || actByKey.set(k, []).get(k)!).push(a); }
  const incidents: Record<string, unknown>[] = [];
  for (const [k, g] of faultGroups) {
    const flagMs = ms(g.time);
    if (flagMs == null) continue;  // need a real flag time to order against
    const after = (actByKey.get(k) || [])
      .filter((a) => a.activity_type === "Loading Explosives")
      .filter((a) => { const t = ms(a.start_timestamp); return t != null && t > flagMs; })
      .sort((a, b) => (a.start_timestamp || "").localeCompare(b.start_timestamp || ""));
    if (!after.length) continue;
    const [mmu, date] = k.split("|");
    const first = after[0];
    incidents.push({
      Date: date, MMU: mmu,
      "Flagged": g.time.slice(11, 16),
      "Faults": g.items,
      "First use after": `${(first.start_timestamp || "").slice(11, 16)} · ${first.activity_type}`,
      "Uses after": after.length,
      Operator: first.operator_name,
    });
  }
  incidents.sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
  const incidentByMmu = groupCount(incidents, (r) => String(r.MMU)).sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-6">
      <div className={print ? "grid grid-cols-4 gap-3" : "grid grid-cols-2 gap-4 lg:grid-cols-4"}>
        <Stat label="Pre-start fault flags" value={faults.length} sub="over selected dates" status={faults.length > 0 ? "warn" : "ok"} />
        <Stat label="Breakdowns logged" value={breakdowns.length} sub="breakdown events" status={breakdowns.length > 0 ? "bad" : "ok"} />
        <Stat label="Most-flagged MMU" value={topMmu} sub={`${topN} faults + breakdowns · click to filter`} onClick={() => topMmu !== "—" && onPickMmu(topMmu)} />
        <Stat label="No. of times MMU used after pre-start fault" value={incidents.length} sub="loaded explosives same day" />
      </div>
      {(faults.length || breakdowns.length) ? (<>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ChartCard title="Pre-start fault flags by MMU" subtitle="Click a bar to filter to that MMU"><BarH data={byMmu} xLabel="Fault flags" yLabel="MMU" onSelect={onPickMmu} /></ChartCard>
        <ChartCard title="Pre-Start Faults by checklist category"><Donut data={byCat} colorMap={CATEGORY_COLOURS} /></ChartCard>
      </div>
      <ChartCard title="Top 5 most flagged Pre-start items"><BarH data={byItem} height={260} /></ChartCard>

      <ChartCard title="Number of times an MMU was used to load explosives after a pre-start fault was logged on same day" subtitle="By MMU · click a bar to filter to that MMU">
        {incidentByMmu.length
          ? <BarH data={incidentByMmu} xLabel="Cases" yLabel="MMU" height={Math.max(160, incidentByMmu.length * 36)} onSelect={onPickMmu} />
          : <div className="py-10 text-center text-sm text-muted">No cases — flagged MMUs didn&apos;t load explosives again the same day.</div>}
      </ChartCard>
      <ChartCard title="Loaded explosives after fault logged"
        subtitle="Each case: when the fault was flagged vs the first loading-explosives event afterwards on that MMU the same day. Relies on accurate user-entered times.">
        <DataTable
          columns={[{ key: "Date", label: "Date" }, { key: "MMU", label: "MMU" }, { key: "Flagged", label: "Fault flagged" }, { key: "Faults", label: "Faults" }, { key: "First use after", label: "First load after" }, { key: "Uses after", label: "Loads after" }, { key: "Operator", label: "Operator" }]}
          rows={incidents} csvName="loaded_after_fault.csv" />
      </ChartCard>

      <ChartCard title="Breakdown log" subtitle="Every breakdown event with its category, type and additional info">
        <DataTable
          columns={[{ key: "Date", label: "Date" }, { key: "Time", label: "Time" }, { key: "MMU", label: "MMU" }, { key: "Category", label: "Breakdown category" }, { key: "Type", label: "Breakdown type" }, { key: "Additional info", label: "Additional info" }]}
          rows={breakdownRows} csvName="breakdowns.csv" />
      </ChartCard>

      <ChartCard title="Pre-start fault records">
        <DataTable columns={[{ key: "MMU", label: "MMU" }, { key: "Date", label: "Date" }, { key: "Category", label: "Category" }, { key: "Item", label: "Item" }]}
          rows={rows} csvName="prestart_faults.csv" />
      </ChartCard>
      </>) : (
        <Card><CardBody><div className="py-10 text-center text-sm text-muted">No pre-start faults or breakdowns were logged for this period.</div></CardBody></Card>
      )}
    </div>
  );
}

/* ── Shift performance: time buckets + start summary ── */
function PerfView({ d, onPickMmu }: { d: D; onPickMmu: (fleet: string) => void }) {
  // Responsibility buckets by MMU (same lens as the Overview hero bar).
  const bucketRows = d.act.map((r) => ({ ...r, bucket: responsibilityOf(r.activity_type || "") }));
  const piv = pivot(bucketRows, (r) => r.mmu_id || "—", (r) => r.bucket, (r) => r.duration_hours);
  piv.data.forEach((row) => piv.series.forEach((s) => (row[s] = round1(Number(row[s]) || 0))));
  // Keep series in the canonical responsibility order for consistent stacking.
  piv.series.sort((a, b) => RESPONSIBILITY_ORDER.indexOf(a) - RESPONSIBILITY_ORDER.indexOf(b));

  // Activity-by-hour heatmap: responsibility × hour-of-day (logged hours), plus
  // Shift Start / Shift End rows (counts per hour) so the day's shape is visible
  // without naming operators.
  const hourGrid: Record<string, number[]> = {};
  for (const b of RESPONSIBILITY_ORDER) hourGrid[b] = new Array(24).fill(0);
  for (const r of d.act) {
    const h = parseInt((r.start_timestamp || "").slice(11, 13), 10);
    if (isNaN(h) || h < 0 || h > 23) continue;
    hourGrid[responsibilityOf(r.activity_type || "")][h] += r.duration_hours || 0;
  }
  const startHours = new Array(24).fill(0), endHours = new Array(24).fill(0);
  for (const s of d.sessions) {
    const sh = parseInt((s.shift_start || "").slice(11, 13), 10);
    if (!isNaN(sh) && sh >= 0 && sh < 24) startHours[sh]++;
    const eh = parseInt((s.shift_end || "").slice(11, 13), 10);
    if (!isNaN(eh) && eh >= 0 && eh < 24) endHours[eh]++;
  }
  const heatColors: Record<string, string> = { ...RESPONSIBILITY_COLOURS, "Shift Start": "#86BCB6", "Shift End": "#FABFD2" };
  const heatRows = [
    ...(startHours.some((v) => v > 0) ? [{ label: "Shift Start", values: startHours }] : []),
    ...RESPONSIBILITY_ORDER.filter((b) => hourGrid[b].some((v) => v > 0)).map((b) => ({ label: b, values: hourGrid[b] })),
    ...(endHours.some((v) => v > 0) ? [{ label: "Shift End", values: endHours }] : []),
  ];

  return (
    <div className="space-y-6">
      <ChartCard title="Time distribution by MMU" subtitle="Productive · Movement · Safety/Admin · Waiting on mine · Idle/Standby · Breakdown · click an MMU to filter">
        <StackedBar rows={piv.data} xKey="x" series={piv.series} colorMap={RESPONSIBILITY_COLOURS} xLabel="MMU" yLabel="Hours" onSelect={onPickMmu} />
      </ChartCard>

      <ChartCard title="Activity by hour of day" subtitle="When the day unfolds · shift start/end + each kind of work by hour · darker = busier (each row scaled to itself)">
        <HourHeatmap rows={heatRows} colors={heatColors} />
      </ChartCard>
    </div>
  );
}

/* ── Shift timeline (single MMU) — LIVE off /live/shift (no precompute). ── */
function TimelineView({ selected }: { selected: Set<string> }) {
  const mmu = selected.size === 1 ? [...selected][0] : null;
  const isPrint = useContext(PrintContext);
  const [data, setData] = useState<LiveShift | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mmu) { setData(null); return; }
    let alive = true;
    setLoading(true); setErr(null);
    api.liveShift(mmu)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => {
        if (alive) setLoading(false);
        // In a report, tell PrintReport this timeline finished loading.
        if (isPrint) { const w = window as unknown as { __timelinesPending?: number }; w.__timelinesPending = Math.max(0, (w.__timelinesPending ?? 1) - 1); }
      });
    return () => { alive = false; };
  }, [mmu, isPrint]);

  if (!mmu) return <Card><CardBody><div className="text-sm text-muted">Select a single MMU in the left panel to view its shift timeline.</div></CardBody></Card>;
  if (loading && !data) return <Card><CardBody><div className="text-sm text-muted">Loading live shift for {mmu}…</div></CardBody></Card>;
  if (err) return <Card><CardBody><div className="text-sm text-danger">Couldn’t load live shift: {err}</div></CardBody></Card>;
  if (!data || !data.found || !data.shift) return <Card><CardBody><div className="text-sm text-muted">No current or recent shift found for {mmu}.</div></CardBody></Card>;

  const shift = data.shift;
  const events = data.events || [];
  const hh = (iso?: string | null) => (iso || "").slice(11, 16) || "—";

  const startIdx = events.findIndex((e) => e.shift_event === "START");
  const startEvt = startIdx >= 0 ? events[startIdx] : undefined;
  const startTime = startEvt?.time || shift.since || events[0]?.time || null;
  const startMsForEnd = startTime ? Date.parse(startTime) : NaN;
  // Build login → logout. The closing logout must come AFTER the login in the event
  // sequence (events are time-ordered). A logout that appears BEFORE the login — even
  // in the same minute (equal timestamps) — is a stale/historical event and must NOT
  // close the timeline. Position, not clock, is the reliable signal here.
  const endEvt = (startIdx >= 0 ? events.slice(startIdx + 1) : events).find((e) => e.shift_event === "END");
  const endFromShift = shift.ended_at && Date.parse(shift.ended_at) > startMsForEnd ? shift.ended_at : null;
  const endTime = endEvt?.time || endFromShift || null;
  const acts = events.filter((e) => !e.shift_event);

  const startMs = startTime ? Date.parse(startTime) : Date.now();
  const endMs = endTime ? Date.parse(endTime) : null;
  const inProgress = endMs == null;
  const actMs = acts.map((a) => Date.parse(a.time || "")).filter((n) => !isNaN(n));
  const lastActMs = actMs.length ? Math.max(...actMs) : startMs;
  // Shift open → activities fill 0→50%; once shift-end is logged everything
  // rescales across the full 0→100% line.
  const spanEnd = endMs ?? (lastActMs > startMs ? lastActMs : startMs + 1);
  const maxPct = endMs != null ? 100 : (acts.length ? 50 : 0);
  const pct = (ms: number) => (spanEnd <= startMs ? 0 : Math.max(0, Math.min(maxPct, ((ms - startMs) / (spanEnd - startMs)) * maxPct)));
  const truckPct = endMs != null ? 100 : (acts.length ? 50 : 0);

  type Evt = { iso: string; name: string; pct: number; color: string };
  const markers: Evt[] = [];
  if (startTime) markers.push({ iso: startTime, name: "Shift Start", pct: 0, color: "#86BCB6" });
  acts.forEach((a, i) => markers.push({ iso: a.time || "", name: a.activity || "Activity", pct: pct(Date.parse(a.time || "")), color: activityColour(a.activity || "", i) }));
  if (endTime) markers.push({ iso: endTime, name: "Shift End", pct: 100, color: "#FABFD2" });

  const faultEvents = events.filter((e) => e.fault_flag);
  // Duration = gap to the next logged event (capped 4h); same-tz naive times so
  // the difference is correct regardless of viewer timezone. Open last = "—".
  const durMin = new Map<string, number>();
  for (let i = 0; i < events.length - 1; i++) {
    const t = Date.parse(events[i].time || ""), nt = Date.parse(events[i + 1].time || "");
    if (!isNaN(t) && !isNaN(nt) && nt > t) durMin.set(events[i].submission_id || String(i), Math.min(Math.round((nt - t) / 60000), 240));
  }
  // Table lists EVERY event in time order — including shift start/end — so login →
  // logout → login again (and shift-ends mid-activity) are visible for diagnosis.
  const log = events.map((e) => ({
    Time: hh(e.time),
    Activity: e.shift_event === "START" ? "● Shift Start" : e.shift_event === "END" ? "■ Shift End" : (e.activity || "—"),
    "Duration (min)": durMin.get(e.submission_id || "") ?? "—",
    Operator: e.operator || "—",
    Flag: e.fault_flag ? "⚠ fault" : "",
  }));
  const dayLabel = (startTime || "").slice(0, 10) || "—";

  // De-cluster: a run of events that are close together folds into ONE dot with
  // its members stacked as angled lines — so neighbouring labels never overlap.
  // Chain-merge (gap to previous < MERGE) but cap the cluster's total span so a
  // long even drip can't merge into one giant stack.
  const MERGE = 5, SPANCAP = 9;
  const trunc = (s: string, n = 20) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  type Cl = Evt & { members: { iso: string; name: string }[] };
  const clustered: Cl[] = [];
  let lastPct = -999;
  for (const m of markers) {
    const last = clustered[clustered.length - 1];
    if (last && (m.pct - lastPct) < MERGE && (m.pct - last.pct) < SPANCAP) {
      last.members.push({ iso: m.iso, name: m.name });
    } else {
      clustered.push({ ...m, members: [{ iso: m.iso, name: m.name }] });
    }
    lastPct = m.pct;
  }
  // SVG geometry (viewBox 0 0 1000 230). Labels angled above the line so they
  // never collide; the MMU icon sits in its own lane below the line.
  const LX = 60, RX = 940, LY = 150;
  const xOf = (p: number) => LX + (p / 100) * (RX - LX);

  return (
    <div className="space-y-6">
      <ChartCard
        title={`Shift timeline — ${mmu}`}
        subtitle={`${dayLabel} · ${shift.operator || "—"} · ${hh(startTime)} → ${inProgress ? "in progress" : hh(endTime)} · live`}>
        <svg viewBox="0 0 1000 230" width="100%" role="img" aria-label={`Shift timeline for ${mmu}`}>
          <line x1={LX} y1={LY} x2={RX} y2={LY} stroke="#e5eaef" strokeWidth={2} strokeLinecap="round" />
          <line x1={LX} y1={LY} x2={xOf(truckPct)} y2={LY} stroke="#f5911e" strokeOpacity={0.6} strokeWidth={2} strokeLinecap="round" />
          {clustered.map((e, i) => {
            const x = xOf(e.pct);
            const right = e.pct > 78;   // flip anchor near the right edge so labels stay in view
            return (
              <g key={i}>
                <line x1={x} y1={LY} x2={x} y2={LY - 12} stroke="#cbd5e1" strokeWidth={1} />
                <circle cx={x} cy={LY} r={4.5} fill={e.color} stroke="#fff" strokeWidth={2} />
                <text x={x} y={LY - 14} transform={`rotate(-38 ${x} ${LY - 14})`}
                      textAnchor={right ? "end" : "start"} fontSize={10} fill="#64748b">
                  {e.members.map((m, j) => (
                    <tspan key={j} x={x} dy={j === 0 ? 0 : 12}>
                      <tspan fontWeight={600} fill="#1f2937">{hh(m.iso)} </tspan>{trunc(m.name)}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
          {/* live pulse at the MMU's current position */}
          {inProgress && (
            <circle cx={xOf(truckPct)} cy={LY} r={6} fill="#f5911e">
              <animate attributeName="r" values="6;15;6" dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.55;0;0.55" dur="1.8s" repeatCount="indefinite" />
            </circle>
          )}
          <circle cx={xOf(truckPct)} cy={LY} r={4.5} fill="#f5911e" stroke="#fff" strokeWidth={2} />
          <image href="/mmu.svg" x={xOf(truckPct) - 18} y={LY + 12} width={36} height={20} />
          {inProgress && (
            <text x={xOf(truckPct) + 24} y={LY + 27} fontSize={10} fontStyle="italic" fill="#94a3b8">shift in progress…</text>
          )}
        </svg>
      </ChartCard>

      {faultEvents.length > 0 && (
        <ChartCard title="Flags this shift" subtitle="Submissions logged with a fault during this shift">
          <div className="flex flex-wrap gap-2">
            {faultEvents.map((f, i) => <Badge key={i} tone="danger">{(f.activity || "Fault")} · {hh(f.time)}</Badge>)}
          </div>
        </ChartCard>
      )}

      <ChartCard title="Shift activity log" subtitle="Everything logged during this shift, in order (live)">
        <DataTable
          columns={[{ key: "Time", label: "Time" }, { key: "Activity", label: "Activity" }, { key: "Duration (min)", label: "Duration (min)" }, { key: "Operator", label: "Operator" }, { key: "Flag", label: "Flag" }]}
          rows={log} csvName={`shift_${mmu}_${dayLabel}.csv`} />
      </ChartCard>
    </div>
  );
}
