"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer, X, FileText, AlertTriangle } from "lucide-react";
import type { InventoryItem } from "@/lib/api";
import { buildBol, draftBolNumber, type Bol } from "@/lib/bol";
import { Card, CardBody, Stat } from "@/components/ui";
import { fmtNum, fmtDate } from "@/lib/utils";

const CONSIGNOR_FROM = "Nairn Det Plant";

export function BolView({ items }: { items: InventoryItem[] }) {
  // Eligible = boxes marked Sold (scanned + set aside for collection).
  const eligible = useMemo(() => items.filter((i) => i.status === "Sold").sort((a, b) =>
    (Date.parse(b.last_updated_at || "") || 0) - (Date.parse(a.last_updated_at || "") || 0)), [items]);
  const groups = useMemo(() => {
    const m = new Map<string, InventoryItem[]>();
    for (const i of eligible) { const k = i.customer || "(no customer)"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(i); }
    return Array.from(m, ([customer, boxes]) => ({ customer, boxes }));
  }, [eligible]);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState({ date: fmtDate(new Date().toISOString()), shipTo: "", truck: "", trailer: "", consignor: "", driver: "" });
  const [includeNeq, setIncludeNeq] = useState(false);
  const [preview, setPreview] = useState(false);

  const selectedBoxes = useMemo(() => eligible.filter((i) => sel.has(i.qr)), [eligible, sel]);
  const bol = useMemo(() => buildBol(selectedBoxes), [selectedBoxes]);
  const number = useMemo(() => draftBolNumber(selectedBoxes), [selectedBoxes]);
  const shipTo = fields.shipTo.trim() || bol.customers.join(", ");

  const toggle = (qr: string) => setSel((s) => { const n = new Set(s); n.has(qr) ? n.delete(qr) : n.add(qr); return n; });
  const toggleGroup = (boxes: InventoryItem[]) => setSel((s) => {
    const n = new Set(s); const all = boxes.every((b) => n.has(b.qr));
    boxes.forEach((b) => all ? n.delete(b.qr) : n.add(b.qr)); return n;
  });

  // Toggle a body class so print CSS can isolate the document.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("bol-open", preview);
    return () => document.body.classList.remove("bol-open");
  }, [preview]);

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Boxes set aside (Sold)" value={fmtNum(eligible.length)} />
        <Stat label="Selected for this BOL" value={fmtNum(sel.size)} status={sel.size ? "ok" : undefined} />
        <Stat label="Line items" value={bol.lines.length} />
        <Stat label="Total units" value={fmtNum(bol.totalQuantity)} />
      </div>

      {bol.customers.length > 1 && (
        <Card className="border-t-4 border-t-warn"><CardBody>
          <div className="flex items-center gap-2 text-sm font-semibold text-warn"><AlertTriangle size={16} /> Selection spans {bol.customers.length} customers ({bol.customers.join(", ")}) — a BOL is normally one consignee.</div>
        </CardBody></Card>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Box selection */}
        <Card className="xl:col-span-2"><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Select boxes for this collection</div>
          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted">No boxes are marked Sold yet. Scan + sell boxes in the app, then they appear here to put on a BOL.</div>
          ) : (
            <div className="max-h-[26rem] space-y-3 overflow-auto">
              {groups.map(({ customer, boxes }) => (
                <div key={customer} className="rounded-xl border border-border">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-border bg-bg px-3 py-2 text-sm font-semibold text-fg">
                    <input type="checkbox" checked={boxes.every((b) => sel.has(b.qr))} onChange={() => toggleGroup(boxes)} />
                    {customer} <span className="font-normal text-muted">· {boxes.length} box(es)</span>
                  </label>
                  <div className="divide-y divide-border">
                    {boxes.map((b) => (
                      <label key={b.qr} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg/60">
                        <input type="checkbox" checked={sel.has(b.qr)} onChange={() => toggle(b.qr)} />
                        <span className="flex-1">{b.description || b.qr}</span>
                        <span className="tabular-nums text-muted">{fmtNum(b.original_quantity)} u</span>
                        <span className="w-28 truncate text-right text-xs text-muted">{b.qr}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody></Card>

        {/* Header fields */}
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
          <button disabled={!sel.size} onClick={() => setPreview(true)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <FileText size={16} /> Generate BOL
          </button>
          <div className="mt-2 text-center text-xs text-muted">Provisional No: <span className="font-mono">{number}</span></div>
        </CardBody></Card>
      </div>

      {preview && (
        <div className="bol-overlay">
          <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 bg-[#2b2d31] px-4 py-3 text-sm text-white">
            <span>Bill of Lading preview — <span className="font-mono">{number}</span> · review, then print 2 copies (customer + file).</span>
            <span className="flex gap-2">
              <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 font-semibold text-white"><Printer size={15} /> Print / Save PDF</button>
              <button onClick={() => setPreview(false)} className="flex items-center gap-1 rounded-lg border border-white/30 px-3 py-1.5"><X size={15} /> Close</button>
            </span>
          </div>
          <BolDocument bol={bol} number={number} date={fields.date} shipTo={shipTo} truck={fields.truck} trailer={fields.trailer} consignor={fields.consignor} driver={fields.driver} includeNeq={includeNeq} />
        </div>
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
            <th>Product description</th>
            <th className="num"># Packages</th><th className="num">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {bol.lines.map((l, i) => (
            <tr key={i}>
              <td className="un">{l.un}</td>
              <td>{l.name}</td>
              <td className="cls"><span className="cls-badge">{l.cls}</span></td>
              <td className="pg">{l.pg}</td>
              <td>{l.description}</td>
              <td className="n">{fmtNum(l.packages)}</td>
              <td className="n">{fmtNum(l.quantity)}</td>
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
