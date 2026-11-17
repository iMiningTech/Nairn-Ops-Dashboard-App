"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Download, Camera, Check, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardBody, Stat } from "@/components/ui";
import { api, type Snapshot } from "@/lib/api";
import { fmtNum, fmtTime, todayKey } from "@/lib/utils";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Verify = { ok: boolean; msg: string };

// Month-end inventory snapshots: an append-only, hash-chained audit record.
// Capture runs server-side from Inventory_Master; this view lists, downloads and
// verifies snapshots, and lets a manager take one after reconciling.
export function SnapshotsView() {
  const [items, setItems] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); api.snapshots().then((r) => setItems(r.items)).catch(() => setItems([])).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);

  const period = todayKey().slice(0, 7);                 // YYYY-MM
  const thisMonth = items.filter((s) => s.period === period);

  const [by, setBy] = useState<string>(() => { try { return localStorage.getItem("nairn_editor") || ""; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, Verify | "checking">>({});
  const [dl, setDl] = useState<string | null>(null);

  // Chain check: each snapshot's Prev_Chain must equal the previous row's Chain
  // (manifest order). A mismatch means a past snapshot was altered/removed.
  const chainBreak = useMemo(() => {
    const broken = new Set<string>();
    for (let i = 1; i < items.length; i++) {
      if ((items[i].prev_chain || "") !== (items[i - 1].chain || "")) broken.add(items[i].snapshot_id);
    }
    return broken;
  }, [items]);

  async function snapshot() {
    const who = by.trim();
    if (!who) { setErr("Enter your name first — it's recorded as the reconciler."); return; }
    const warn = thisMonth.length
      ? `A snapshot for ${period} already exists. Take another? It's kept as a new version alongside the existing one(s) — nothing is overwritten.`
      : `Take the ${period} inventory snapshot now? This freezes every on-site box as an immutable, auditable record signed by ${who}.`;
    if (!window.confirm(warn)) return;
    try { localStorage.setItem("nairn_editor", who); } catch { /* ignore */ }
    setBusy(true); setErr(null);
    try {
      await api.createSnapshot({ captured_by: who });
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function download(s: Snapshot) {
    setDl(s.snapshot_id); setErr(null);
    try {
      const { csv } = await api.snapshotCsv(s.detail_tab);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `inventory_snapshot_${s.period}_${s.snapshot_id}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setDl(null); }
  }

  async function check(s: Snapshot) {
    setVerify((v) => ({ ...v, [s.snapshot_id]: "checking" }));
    try {
      const { csv } = await api.snapshotCsv(s.detail_tab);
      const got = await sha256Hex(csv);
      const hashOk = got === s.sha256;
      const chainOk = !chainBreak.has(s.snapshot_id);
      const ok = hashOk && chainOk;
      const msg = ok ? "Intact — data matches its fingerprint and the chain is unbroken."
        : !hashOk ? "ALTERED — the detail no longer matches its stored SHA-256."
        : "CHAIN BROKEN — a surrounding snapshot was changed or removed.";
      setVerify((v) => ({ ...v, [s.snapshot_id]: { ok, msg } }));
    } catch (e) {
      setVerify((v) => ({ ...v, [s.snapshot_id]: { ok: false, msg: e instanceof Error ? e.message : String(e) } }));
    }
  }

  const sorted = useMemo(() => items.slice().sort((a, b) => b.snapshot_id.localeCompare(a.snapshot_id)), [items]);

  return (
    <div className="space-y-4">
      <Card><CardBody>
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
          <ShieldCheck size={18} /> Month-end inventory snapshots
        </div>
        <p className="mb-4 max-w-3xl text-sm text-muted">
          An append-only, hash-chained record of on-site inventory for the external audit trail. Each snapshot freezes
          every Active box (raw materials, WIP and finished goods) and stores a SHA-256 fingerprint of it, chained to the
          previous snapshot — so any later change to a past record is provable. Captured from the master inventory itself,
          not from this screen. Take one after your month-end reconciliation; if a month is missed, one is captured
          automatically on the 1st.
        </p>

        {!api.snapshotEnabled ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
            Snapshots aren&apos;t configured — the Apps Script write-back endpoint isn&apos;t set.
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted">Reconciled by</span>
              <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="your name"
                className="w-56 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent" />
            </label>
            <button onClick={snapshot} disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
              {busy ? "Capturing…" : `Reconcile & snapshot ${period}`}
            </button>
            {thisMonth.length > 0 && (
              <span className="text-xs text-muted">{period} already has {thisMonth.length} snapshot{thisMonth.length === 1 ? "" : "s"}.</span>
            )}
          </div>
        )}
        {err && <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}
      </CardBody></Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Snapshots on record" value={fmtNum(items.length)} />
        <Stat label="Months covered" value={fmtNum(new Set(items.map((s) => s.period)).size)} />
        <Stat label="Latest capture" value={sorted[0] ? fmtTime(sorted[0].captured_at) : "—"} />
        <Stat label="Chain" value={chainBreak.size ? "Broken" : items.length ? "Intact" : "—"} status={chainBreak.size ? "bad" : items.length ? "ok" : undefined} />
      </div>

      <Card><CardBody>
        <div className="mb-3 text-sm font-semibold text-fg">Record ({items.length})</div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : !items.length ? (
          <div className="text-sm text-muted">No snapshots yet. Take the first after your next month-end count.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Snapshot</th>
                  <th className="px-3 py-2 font-medium">Captured</th>
                  <th className="px-3 py-2 font-medium">By</th>
                  <th className="px-3 py-2 text-right font-medium">Boxes</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 font-medium">Fingerprint</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => {
                  const vr = verify[s.snapshot_id];
                  return (
                    <tr key={s.snapshot_id} className="border-b border-border/60 last:border-0 align-top">
                      <td className="px-3 py-2">
                        <div className="font-mono text-fg">{s.snapshot_id}</div>
                        <div className="mt-0.5 flex items-center gap-1">
                          {s.reconciled
                            ? <span className="rounded border border-ok/40 bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok">Reconciled</span>
                            : <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-warn">Auto</span>}
                          {chainBreak.has(s.snapshot_id) && <span className="rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Chain break</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted">{fmtTime(s.captured_at)}</td>
                      <td className="px-3 py-2 text-muted">{s.captured_by || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(s.item_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(s.total_quantity)}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-[11px] text-muted" title={s.sha256}>{s.sha256 ? s.sha256.slice(0, 12) + "…" : "—"}</span>
                        {vr && vr !== "checking" && (
                          <div className={`mt-0.5 flex items-center gap-1 text-[11px] ${vr.ok ? "text-ok" : "text-danger"}`}>
                            {vr.ok ? <Check size={12} /> : <AlertTriangle size={12} />} {vr.msg}
                          </div>
                        )}
                        {vr === "checking" && <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted"><Loader2 size={12} className="animate-spin" /> checking…</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => download(s)} disabled={dl === s.snapshot_id}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-bg disabled:opacity-50">
                            {dl === s.snapshot_id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} CSV
                          </button>
                          <button onClick={() => check(s)} disabled={vr === "checking"}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-bg disabled:opacity-50">
                            <ShieldCheck size={12} /> Verify
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody></Card>
    </div>
  );
}
