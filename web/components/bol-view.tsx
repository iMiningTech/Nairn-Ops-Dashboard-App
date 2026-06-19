"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X, FileText, AlertTriangle, RotateCcw } from "lucide-react";
import { api, type InventoryItem, type Transaction, type IssuedBol } from "@/lib/api";
import { buildBol, draftBolNumber, type Bol, type BolLine } from "@/lib/bol";
import { Card, CardBody, Stat } from "@/components/ui";
import { fmtNum, fmtDate, fmtTime } from "@/lib/utils";

const CONSIGNOR_FROM = "Nairn Det Plant";

type DocState = {
  bol: Bol; number: string; date: string; shipTo: string; truck: string; trailer: string;
  consignor: string; driver: string; includeNeq: boolean; qrs: string[]; issued: boolean;
};

export function BolView({ items, txns }: { items: InventoryItem[]; txns: Transaction[] }) {
  // When each box was marked Sold (set aside) — from the Status→Sold transaction.
  const soldAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of txns) {
      if (t.field !== "Status" || t.new_value !== "Sold" || !t.timestamp) continue;
      const prev = m.get(t.qr);
      if (!prev || (Date.parse(t.timestamp) || 0) > (Date.parse(prev) || 0)) m.set(t.qr, t.timestamp);
    }
    return m;
  }, [txns]);
  const soldOn = (i: InventoryItem) => soldAt.get(i.qr) || i.last_updated_at;

  const eligible = useMemo(() => items.filter((i) => i.status === "Sold")
    .sort((a, b) => (Date.parse(soldOn(b) || "") || 0) - (Date.parse(soldOn(a) || "") || 0)), [items, soldAt]); // eslint-disable-line
  const groups = useMemo(() => {
    const m = new Map<string, InventoryItem[]>();
    for (const i of eligible) { const k = i.customer || "(no customer)"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(i); }
    return Array.from(m, ([customer, boxes]) => ({ customer, boxes }));
  }, [eligible]);

  // Issued-BOL history + which box QRs are already on a BOL.
  const [history, setHistory] = useState<IssuedBol[]>([]);
  const loadHistory = () => api.bols().then((r) => setHistory(r.items)).catch(() => {});
  useEffect(() => { loadHistory(); }, []);
  const usedQr = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of history) b.box_qrs.split(",").map((s) => s.trim()).filter(Boolean).forEach((qr) => m.set(qr, b.bol_no));
    return m;
  }, [history]);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState({ date: fmtDate(new Date().toISOString()), shipTo: "", truck: "", trailer: "", consignor: "", driver: "" });
  const [includeNeq, setIncludeNeq] = useState(false);
  const [doc, setDoc] = useState<DocState | null>(null);
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const selectedBoxes = useMemo(() => eligible.filter((i) => sel.has(i.qr)), [eligible, sel]);
  const bol = useMemo(() => buildBol(selectedBoxes), [selectedBoxes]);
  const draftNo = useMemo(() => draftBolNumber(selectedBoxes), [selectedBoxes]);

  const toggle = (qr: string) => setSel((s) => { const n = new Set(s); n.has(qr) ? n.delete(qr) : n.add(qr); return n; });
  const toggleGroup = (boxes: InventoryItem[]) => setSel((s) => {
    const n = new Set(s); const all = boxes.every((b) => n.has(b.qr));
    boxes.forEach((b) => all ? n.delete(b.qr) : n.add(b.qr)); return n;
  });

  function generate() {
    const shipTo = fields.shipTo.trim() || bol.customers.join(", ");
    setRegError(null);
    setDoc({ bol, number: draftNo, date: fields.date, shipTo, truck: fields.truck, trailer: fields.trailer,
      consignor: fields.consignor, driver: fields.driver, includeNeq, qrs: selectedBoxes.map((b) => b.qr), issued: false });
  }

  async function registerAndPrint() {
    if (!doc) return;
    setRegistering(true); setRegError(null);
    try {
      const r = await api.registerBol({
        created_by: doc.consignor || "dashboard", date: doc.date, ship_from: CONSIGNOR_FROM, ship_to: doc.shipTo,
        truck: doc.truck, trailer: doc.trailer, consignor: doc.consignor, driver: doc.driver, include_neq: doc.includeNeq,
        total_packages: doc.bol.totalPackages, total_quantity: doc.bol.totalQuantity, total_neq_kg: +doc.bol.totalNemKg.toFixed(3),
        classes: doc.bol.classes.join(", "), box_qrs: doc.qrs.join(","), lines_json: JSON.stringify(doc.bol.lines),
      });
      setDoc((d) => (d ? { ...d, number: r.bol_no, issued: true } : d));
      setSel(new Set());
      loadHistory();
      setTimeout(() => window.print(), 250);   // let the issued number paint first
    } catch (e) {
      setRegError(e instanceof Error ? e.message : String(e));
    } finally { setRegistering(false); }
  }

  function reprint(r: IssuedBol) {
    let lines: BolLine[] = [];
    try { lines = JSON.parse(r.lines_json || "[]"); } catch { /* ignore */ }
    const bolObj: Bol = { lines, totalPackages: r.total_packages, totalQuantity: r.total_quantity, totalNemKg: r.total_neq_kg,
      classes: r.classes.split(",").map((s) => s.trim()).filter(Boolean), customers: [] };
    setDoc({ bol: bolObj, number: r.bol_no, date: r.date, shipTo: r.ship_to, truck: r.truck, trailer: r.trailer,
      consignor: r.consignor_name, driver: r.driver_name, includeNeq: r.include_neq, qrs: r.box_qrs.split(","), issued: true });
  }

  // Body flag for print isolation + filename via document.title.
  useEffect(() => {
    if (typeof document === "undefined" || !doc) return;
    const prevTitle = document.title;
    document.body.classList.add("bol-open");
    document.title = `Nairn Det Plant - ${doc.number}`;
    return () => { document.body.classList.remove("bol-open"); document.title = prevTitle; };
  }, [doc]);

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Boxes set aside (Sold)" value={fmtNum(eligible.length)} />
        <Stat label="Selected for this BOL" value={fmtNum(sel.size)} status={sel.size ? "ok" : undefined} />
        <Stat label="Line items" value={bol.lines.length} />
        <Stat label="Issued BOLs" value={fmtNum(history.length)} />
      </div>

      {!api.bolEnabled && (
        <Card className="border-t-4 border-t-warn"><CardBody>
          <div className="flex items-center gap-2 text-sm text-warn"><AlertTriangle size={16} /> Register not configured — BOLs print with a <b>DRAFT</b> number and aren&apos;t saved. Deploy the Apps Script web app and set <span className="font-mono">NEXT_PUBLIC_BOL_API</span> to enable numbered, saved BOLs.</div>
        </CardBody></Card>
      )}
      {bol.customers.length > 1 && (
        <Card className="border-t-4 border-t-warn"><CardBody>
          <div className="flex items-center gap-2 text-sm font-semibold text-warn"><AlertTriangle size={16} /> Selection spans {bol.customers.length} customers — a BOL is normally one consignee.</div>
        </CardBody></Card>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2"><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Select boxes for this collection</div>
          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted">No boxes are marked Sold yet. Scan + sell boxes in the app, then they appear here.</div>
          ) : (
            <div className="max-h-[26rem] space-y-3 overflow-auto">
              {groups.map(({ customer, boxes }) => (
                <div key={customer} className="rounded-xl border border-border">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-border bg-bg px-3 py-2 text-sm font-semibold text-fg">
                    <input type="checkbox" checked={boxes.every((b) => sel.has(b.qr))} onChange={() => toggleGroup(boxes)} />
                    {customer} <span className="font-normal text-muted">· {boxes.length} box(es)</span>
                  </label>
                  <div className="divide-y divide-border">
                    {boxes.map((b) => {
                      const used = usedQr.get(b.qr);
                      return (
                        <label key={b.qr} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg/60">
                          <input type="checkbox" checked={sel.has(b.qr)} onChange={() => toggle(b.qr)} />
                          <span className="flex-1 truncate">{b.description || b.qr}</span>
                          {used && <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger" title="Already on a BOL">on {used}</span>}
                          <span className="w-32 shrink-0 text-right text-xs text-muted" title="Marked Sold / set aside">{fmtTime(soldOn(b))}</span>
                          <span className="w-16 shrink-0 text-right tabular-nums text-muted">{fmtNum(b.original_quantity)} u</span>
                          <span className="hidden w-28 shrink-0 truncate text-right text-xs text-muted sm:inline">{b.qr}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody></Card>

        <Card><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Document details (editable)</div>
          <div className="space-y-2 text-sm">
            <Field label="Date" value={fields.date} onChange={(v) => setFields((f) => ({ ...f, date: v }))} />
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Ship to (consignee) + delivery address</div>
              <textarea value={fields.shipTo} onChange={(e) => setFields((f) => ({ ...f, shipTo: e.target.value }))}
                rows={3} placeholder={bol.customers.join(", ") || "Customer + address"}
                className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
            </div>
            <Field label="Truck #" value={fields.truck} onChange={(v) => setFields((f) => ({ ...f, truck: v }))} />
            <Field label="Trailer #" value={fields.trailer} onChange={(v) => setFields((f) => ({ ...f, trailer: v }))} />
            <Field label="Consignor name" value={fields.consignor} onChange={(v) => setFields((f) => ({ ...f, consignor: v }))} />
            <Field label="Driver name" value={fields.driver} onChange={(v) => setFields((f) => ({ ...f, driver: v }))} />
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-muted">
              <input type="checkbox" checked={includeNeq} onChange={(e) => setIncludeNeq(e.target.checked)} /> include Total NEQ on the document
            </label>
          </div>
          <button disabled={!sel.size} onClick={generate}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <FileText size={16} /> Generate BOL
          </button>
        </CardBody></Card>
      </div>

      {/* Issued BOL history */}
      <Card><CardBody>
        <div className="mb-3 text-sm font-semibold text-fg">Issued BOLs ({history.length})</div>
        {history.length === 0 ? (
          <div className="text-sm text-muted">{api.bolEnabled ? "No BOLs issued yet." : "History appears here once the register is configured and BOLs are issued."}</div>
        ) : (
          <div className="max-h-[24rem] overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">BOL No.</th><th className="px-3 py-2 font-medium">Issued</th>
                  <th className="px-3 py-2 font-medium">Ship to</th><th className="px-3 py-2 text-right font-medium">Pkgs</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th><th className="px-3 py-2 font-medium">Classes</th><th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {history.slice().sort((a, b) => b.bol_no.localeCompare(a.bol_no)).map((r) => (
                  <tr key={r.bol_no} className="border-t border-border hover:bg-bg/60">
                    <td className="px-3 py-2 font-semibold text-fg">{r.bol_no}</td>
                    <td className="px-3 py-2 text-muted">{fmtTime(r.created_at)}</td>
                    <td className="px-3 py-2">{r.ship_to}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.total_packages)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.total_quantity)}</td>
                    <td className="px-3 py-2">{r.classes}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => reprint(r)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-bg"><RotateCcw size={13} /> Reprint</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody></Card>

      {doc && typeof document !== "undefined" && createPortal(
        <div className="bol-overlay">
          <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 bg-[#2b2d31] px-4 py-3 text-sm text-white">
            <span>
              {doc.issued ? <>Issued <span className="font-mono">{doc.number}</span> ✓ — print 2 copies (customer + file).</>
                : <>Preview <span className="font-mono">{doc.number}</span>{regError && <span className="ml-2 text-[#ffb4b0]">· {regError}</span>}</>}
            </span>
            <span className="flex gap-2">
              {doc.issued ? (
                <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 font-semibold text-white"><Printer size={15} /> Print</button>
              ) : api.bolEnabled ? (
                <button onClick={registerAndPrint} disabled={registering} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 font-semibold text-white disabled:opacity-60">
                  <Printer size={15} /> {registering ? "Registering…" : "Register & Print"}
                </button>
              ) : (
                <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 font-semibold text-white"><Printer size={15} /> Print (draft)</button>
              )}
              <button onClick={() => setDoc(null)} className="flex items-center gap-1 rounded-lg border border-white/30 px-3 py-1.5"><X size={15} /> Close</button>
            </span>
          </div>
          <BolDocument bol={doc.bol} number={doc.number} date={doc.date} shipTo={doc.shipTo} truck={doc.truck} trailer={doc.trailer} consignor={doc.consignor} driver={doc.driver} includeNeq={doc.includeNeq} />
        </div>,
        document.body
      )}
    </>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
    </div>
  );
}

function BolDocument({ bol, number, date, shipTo, truck, trailer, consignor, driver, includeNeq }:
  { bol: Bol; number: string; date: string; shipTo: string; truck: string; trailer: string; consignor: string; driver: string; includeNeq: boolean }) {
  const placard = (c: string) => bol.classes.includes(c);
  return (
    <div className="bol-doc">
      <div className="titlebar">Dangerous Goods / Explosives — Shipping Document</div>

      <div className="head">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bme_logo_v2.png" alt="BME" />
          <div className="co">
            <div className="grp">Consignor</div>
            <b>BME Mining Canada Inc.</b><br />
            2736 Belisle Dr.<br />
            Val Caron, ON, P3N 1B3<br />
            Tel: (705) 897-4971
          </div>
        </div>
        <div className="doc">
          <div className="f"><span className="k">Date</span><span className="v">{date}</span></div>
          <div className="f"><span className="k">BOL No.</span><span className="v">{number.startsWith("DRAFT") ? <span className="draft-stamp">{number}</span> : number}</span></div>
        </div>
      </div>

      <div className="parties">
        <div className="col">
          <div className="field"><span className="lbl">Shipped from</span><div className="box mid">{CONSIGNOR_FROM}</div></div>
          <div className="field"><span className="lbl">Ship to (consignee) — name &amp; delivery address</span><div className="box addr">{shipTo}</div></div>
        </div>
        <div className="col">
          <div className="field"><span className="lbl">Truck #</span><div className="box mid">{truck}</div></div>
          <div className="field"><span className="lbl">Trailer #</span><div className="box mid">{trailer}</div></div>
        </div>
      </div>

      <table>
        <caption>Dangerous goods description</caption>
        <thead>
          <tr>
            <th>UN No.</th><th>Shipping name</th><th className="num">Class</th><th className="num">PG</th>
            <th>Product description</th><th className="num"># Packages</th><th className="num">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {bol.lines.map((l, i) => (
            <tr key={i}>
              <td className="un">{l.un}</td><td>{l.name}</td>
              <td className="cls"><span className="cls-badge">{l.cls}</span></td>
              <td className="pg">{l.pg}</td><td>{l.description}</td>
              <td className="n">{fmtNum(l.packages)}</td><td className="n">{fmtNum(l.quantity)}</td>
            </tr>
          ))}
          <tr className="empty"><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
        </tbody>
      </table>

      <div className="footrow">
        <div className="box2">
          <div className="placards">
            <div className="ttl">Placards applied (check if applicable)</div>
            {["1.1B", "1.4B", "1.4S"].map((c) => (
              <span key={c} className="pk"><span className={`chk${placard(c) ? " on" : ""}`}>{placard(c) ? "✓" : ""}</span>{c}</span>
            ))}
          </div>
        </div>
        <div className="box2">
          <div className="totals">
            <div className="t"><div className="tk">Total packages</div><div className="tv">{fmtNum(bol.totalPackages)}</div></div>
            <div className="t"><div className="tk">Total quantity</div><div className="tv">{fmtNum(bol.totalQuantity)}</div></div>
            {includeNeq && <div className="t opt"><div className="tk">Total NEQ</div><div className="tv">{bol.totalNemKg.toFixed(2)} kg</div></div>}
          </div>
        </div>
      </div>

      <div className="erap">
        <div>
          <b>24-Hour Number:</b> 1-888-CAN-UTEC (226-8832) or (*666 from cell phone)<br />
          CANUTEC (Canadian Transport Emergency Centre) — “use in case of a dangerous goods emergency”
        </div>
        <div className="ref">
          ERAP Reference #: <b>2-0781</b><br />
          ERAP Activation Number: <b>1-800-877-0985</b>
        </div>
      </div>

      <div className="cert">
        <div className="h">Consignor&apos;s Certification</div>
        <p>“I hereby declare that the contents of this consignment are fully and accurately described above by the proper shipping name, are properly classified and packaged, have dangerous goods safety marks properly affixed or displayed on them, and are in all respects in proper condition for transport according to the Transportation of Dangerous Goods Regulations.”</p>
      </div>

      <div className="signs">
        <div className="s">
          <div className="role">Consignor</div>
          <div className="sigline"><div className="l"><div className="cap">Print name</div><div className="u">{consignor}</div></div></div>
          <div className="sigline"><div className="l"><div className="cap">Signature</div><div className="u"></div></div><div className="l" style={{ maxWidth: "32mm" }}><div className="cap">Date</div><div className="u"></div></div></div>
        </div>
        <div className="s">
          <div className="role">Driver / carrier</div>
          <div className="sigline"><div className="l"><div className="cap">Driver name</div><div className="u">{driver}</div></div></div>
          <div className="sigline"><div className="l"><div className="cap">Signature</div><div className="u"></div></div><div className="l" style={{ maxWidth: "32mm" }}><div className="cap">Date</div><div className="u"></div></div></div>
        </div>
      </div>
    </div>
  );
}
