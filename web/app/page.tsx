"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  Package, Waves, Wrench, Scale, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, Search, Download,
} from "lucide-react";
import { api, type InventoryItem, type Transaction } from "@/lib/api";
import { Card, CardBody, Stat, Badge } from "@/components/ui";
import { ChartCard, BarH, Donut } from "@/components/charts";
import { uniqueSorted, groupSum, maxDate } from "@/lib/data";
import {
  explosivePools, maintenancePools, poolFlows, reconcilePools, reconcileRooms,
  type PoolRecon, type RoomRecon,
} from "@/lib/pools";
import { TYPE_COLOURS } from "@/lib/colors";
import { fmtTime, fmtNum } from "@/lib/utils";

const CUSTOMER = "Nairn Det Plant";

const VIEWS = [
  { id: "stock", label: "Stock on Hand", icon: Package },
  { id: "pool", label: "Pool Dashboard", icon: Waves },
  { id: "recon", label: "Reconciliation", icon: Scale },
  { id: "maint", label: "Maintenance Stores", icon: Wrench },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const WINDOWS = [7, 30, 90] as const;
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
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("stock");
  const [authed, setAuthed] = useState(false);
  const [tv, setTv] = useState(false);
  const [windowDays, setWindowDays] = useState<number>(7);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [stock, tx] = await Promise.all([api.stockOnHand(), api.transactions()]);
      setItems(stock.items || []);
      setTxns(tx.items || []);
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
    if (p.has("tv")) { setTv(true); setView("pool"); }
    if (!process.env.NEXT_PUBLIC_ACCESS_HASH) { setAuthed(true); return; }
    try { if (localStorage.getItem("nairn_access") === "1") setAuthed(true); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, []);

  const lastUpdated = useMemo(() => maxDate(items.map((i) => i.last_updated_at)) || generatedAt, [items, generatedAt]);
  const headerTitle = VIEWS.find((v) => v.id === view)?.label ?? "Inventory Operations";

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
              <button key={id} onClick={() => setView(id)}
                className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm ${view === id ? "bg-accent font-medium text-white" : "text-sidebarfg/80 hover:bg-white/10"}`}>
                <Icon size={18} /> {label}
              </button>
            ))}
          </nav>
          {(view === "pool" || view === "recon") && (
            <div className="mt-4 border-t border-white/10 px-4 py-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sidebarfg/60">Flow window</div>
              <div className="grid grid-cols-3 gap-1">
                {WINDOWS.map((w) => (
                  <button key={w} onClick={() => setWindowDays(w)}
                    className={`rounded-lg border py-1 text-center text-xs ${windowDays === w ? "border-accent bg-accent font-semibold text-white" : "border-white/15 bg-white/5 hover:bg-white/15"}`}>{w}d</button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-auto px-4 py-4 text-xs text-sidebarfg/50">
            Data: {api.mode === "gviz" ? "Google Sheet (live CSV)" : "Apps Script API"}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-6">
          <span className={`font-semibold text-fg ${tv ? "text-2xl" : "text-lg"}`}>{CUSTOMER} — {headerTitle}</span>
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
              {view === "stock" && <StockView items={items} tv={tv} />}
              {view === "pool" && <PoolView items={items} txns={txns} windowDays={windowDays} tv={tv} />}
              {view === "recon" && <ReconView items={items} txns={txns} windowDays={windowDays} />}
              {view === "maint" && <MaintenanceView items={items} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Generic table with optional row tone + per-column formatting ─────────────
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
            <button onClick={() => csvDownload(`stock_${new Date().toISOString().slice(0, 10)}.csv`, cols, df.map((i) => ({ ...i, last_updated_at: fmtTime(i.last_updated_at) })))}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
          </div>
          <Grid cols={cols} rows={df as unknown as Record<string, unknown>[]} />
        </CardBody>
      </Card>
    </>
  );
}

// ── Pool Dashboard (explosive pools only) ────────────────────────────────────
function PoolView({ items, txns, windowDays, tv }: { items: InventoryItem[]; txns: Transaction[]; windowDays: number; tv: boolean }) {
  const pools = useMemo(() => explosivePools(items), [items]);
  const flows = useMemo(() => poolFlows(txns, new Set(pools.map((p) => p.qr)), windowDays), [txns, pools, windowDays]);
  const negative = pools.filter((p) => p.current_quantity < 0);
  const empty = pools.filter((p) => p.current_quantity === 0);
  const moved = [...flows.values()].filter((f) => f.net !== 0).length;
  const netTotal = [...flows.values()].reduce((s, f) => s + f.net, 0);

  const bars = useMemo(() =>
    [...pools].filter((p) => p.current_quantity > 0).sort((a, b) => b.current_quantity - a.current_quantity).slice(0, 25)
      .map((p) => ({ name: p.description || p.qr, value: p.current_quantity })), [pools]);

  const rows = useMemo(() => [...pools]
    .sort((a, b) => b.current_quantity - a.current_quantity)
    .map((p) => {
      const f = flows.get(p.qr);
      return {
        qr: p.qr, description: p.description, current_quantity: p.current_quantity,
        location: p.current_location,
        net: f ? signed(f.net) : "—", in_qty: f ? f.in_qty : 0, out_qty: f ? f.out_qty : 0,
        last_updated_at: fmtTime(p.last_updated_at), _neg: p.current_quantity < 0,
      };
    }), [pools, flows]);

  const cols: Col[] = [
    { key: "qr", label: "QR" }, { key: "description", label: "Pool" },
    { key: "current_quantity", label: "Qty", num: true, fmt: fmtQty },
    { key: "in_qty", label: `In ${windowDays}d`, num: true, fmt: fmtQty },
    { key: "out_qty", label: `Out ${windowDays}d`, num: true, fmt: fmtQty },
    { key: "net", label: `Net ${windowDays}d`, num: true },
    { key: "location", label: "Location" }, { key: "last_updated_at", label: "Updated" },
  ];

  return (
    <>
      {negative.length > 0 ? (
        <Card className="border-t-4 border-t-danger"><CardBody className={`flex items-center gap-3 font-semibold text-danger ${tv ? "text-2xl" : "text-base"}`}>
          <AlertTriangle size={tv ? 30 : 20} /> {negative.length} POOL(S) WITH NEGATIVE QUANTITY — DISCREPANCY FLAG
        </CardBody></Card>
      ) : (
        <Card className="border-t-4 border-t-ok"><CardBody className={`flex items-center gap-3 font-semibold text-ok ${tv ? "text-2xl" : "text-base"}`}>
          <CheckCircle2 size={tv ? 30 : 20} /> All explosive pools non-negative — no negative-quantity discrepancies.
        </CardBody></Card>
      )}

      <div className={`grid gap-4 ${tv ? "grid-cols-5" : "grid-cols-2 lg:grid-cols-5"}`}>
        <Stat label="Explosive pools" value={pools.length} />
        <Stat label="Total quantity" value={fmtNum(pools.reduce((s, p) => s + p.current_quantity, 0))} />
        <Stat label="Empty pools" value={empty.length} status={empty.length ? "warn" : "ok"} />
        <Stat label={`Pools moved (${windowDays}d)`} value={moved} />
        <Stat label={`Net flow (${windowDays}d)`} value={signed(netTotal)} status={netTotal < 0 ? "warn" : undefined} />
      </div>

      <ChartCard title="Current pool quantities" subtitle={`Top ${bars.length} stocked pools of ${pools.length}`}>
        <BarH data={bars} height={Math.max(320, bars.length * 26)} />
      </ChartCard>

      <Card><CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">Pool details ({pools.length})</div>
          <button onClick={() => csvDownload(`pools_${new Date().toISOString().slice(0, 10)}.csv`, cols, rows)}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg"><Download size={14} /> CSV</button>
        </div>
        <Grid cols={cols} rows={rows} tone={(r) => (r._neg ? "bad" : undefined)} maxH="32rem" />
      </CardBody></Card>
    </>
  );
}

// ── Reconciliation (calculated vs actual) ────────────────────────────────────
function ReconView({ items, txns, windowDays }: { items: InventoryItem[]; txns: Transaction[]; windowDays: number }) {
  const recon: PoolRecon[] = useMemo(() => reconcilePools(items, txns, windowDays), [items, txns, windowDays]);
  const rooms: RoomRecon[] = useMemo(() => reconcileRooms(recon), [recon]);
  const flagged = recon.filter((p) => !p.matches);
  const interventions = recon.reduce((s, p) => s + p.interventions, 0);

  const cols: Col[] = [
    { key: "qr", label: "Pool QR" }, { key: "description", label: "Description" }, { key: "location", label: "Room" },
    { key: "actual", label: "Actual", num: true, fmt: fmtQty },
    { key: "calculated", label: "Calc (log)", num: true, fmt: (v) => (v == null ? "—" : fmtNum(Number(v))) },
    { key: "diff", label: "Diff", num: true, fmt: (v) => (Number(v) === 0 ? "0" : signed(Number(v))) },
    { key: "in_qty", label: `In ${windowDays}d`, num: true, fmt: fmtQty },
    { key: "out_qty", label: `Out ${windowDays}d`, num: true, fmt: fmtQty },
    { key: "interventions", label: "Manual fixes", num: true },
    { key: "last_txn", label: "Last move", fmt: fmtTs },
  ];
  const rows = recon
    .slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.actual - a.actual)
    .map((p) => ({ ...p })) as unknown as Record<string, unknown>[];

  return (
    <>
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
        <Stat label={`Manual fixes (${windowDays}d)`} value={interventions} status={interventions ? "warn" : "ok"} sub="reconcile / stock-correction moves" />
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
                <div><div className="text-xs text-muted">In {windowDays}d</div><div className="font-semibold text-ok">{fmtNum(r.in_qty)}</div></div>
                <div><div className="text-xs text-muted">Out {windowDays}d</div><div className="font-semibold text-danger">{fmtNum(r.out_qty)}</div></div>
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

// ── Maintenance Stores (non-explosive count-pools) ───────────────────────────
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
            <button onClick={() => csvDownload(`maintenance_${new Date().toISOString().slice(0, 10)}.csv`, cols, df.map((i) => ({ ...i, last_updated_at: fmtTime(i.last_updated_at) })))}
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
