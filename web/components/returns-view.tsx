"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X, FileText, Undo2, PackageOpen } from "lucide-react";
import type { InventoryItem, Transaction } from "@/lib/api";
import { type Bol } from "@/lib/bol";
import { detectReturns, groupReturns, buildReturn, draftReturnNumber, type ReturnedBox } from "@/lib/returns";
import { Card, CardBody, Stat } from "@/components/ui";
import { fmtNum, fmtDate, fmtTime } from "@/lib/utils";

// The plant receives returned goods here — mirror of the BOL's consignor block.
const CONSIGNEE_TO = "Nairn Det Plant";

type DocState = {
  bol: Bol; number: string; date: string; po: string; returnedFrom: string; receivedInto: string;
  carrier: string; receivedBy: string; truck: string; trailer: string; notes: string;
  includeNeq: boolean; receivedDate: string; qrs: string[];
};

export function ReturnsView({ items, txns }: { items: InventoryItem[]; txns: Transaction[] }) {
  const returns = useMemo(() => detectReturns(items, txns), [items, txns]);
  const groups = useMemo(() => groupReturns(returns), [returns]);
  const returnByQr = useMemo(() => new Map(returns.map((r) => [r.item.qr, r])), [returns]);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState({ date: fmtDate(new Date().toISOString()), carrier: "", receivedBy: "", truck: "", trailer: "", notes: "", receivedDate: "" });
  const [includeNeq, setIncludeNeq] = useState(false);
  const [doc, setDoc] = useState<DocState | null>(null);

  const selectedReturns = useMemo(() => returns.filter((r) => sel.has(r.item.qr)), [returns, sel]);
  const bol = useMemo(() => buildReturn(selectedReturns), [selectedReturns]);
  const draftNo = useMemo(() => draftReturnNumber(selectedReturns), [selectedReturns]);

  const toggle = (qr: string) => setSel((s) => { const n = new Set(s); n.has(qr) ? n.delete(qr) : n.add(qr); return n; });
  const toggleMany = (boxes: ReturnedBox[]) => setSel((s) => {
    const n = new Set(s); const all = boxes.every((b) => n.has(b.item.qr));
    boxes.forEach((b) => all ? n.delete(b.item.qr) : n.add(b.item.qr)); return n;
  });
  const allSelected = returns.length > 0 && returns.every((r) => sel.has(r.item.qr));
  const toggleAll = () => setSel((s) => {
    const n = new Set(s);
    if (returns.every((r) => n.has(r.item.qr))) returns.forEach((r) => n.delete(r.item.qr));
    else returns.forEach((r) => n.add(r.item.qr));
    return n;
  });

  function generate() {
    const customers = Array.from(new Set(selectedReturns.map((r) => r.customer).filter(Boolean)));
    const po = Array.from(new Set(selectedReturns.map((r) => r.po).filter(Boolean))).join(", ");
    const locs = Array.from(new Set(selectedReturns.map((r) => r.returnLocation).filter(Boolean))).join(", ");
    // Return date = when the boxes were set back to Active (newest in the selection).
    const retDates = selectedReturns.map((r) => r.returnedAt).filter(Boolean) as string[];
    const newest = retDates.sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0];
    const docDate = fields.date.trim() || (newest ? fmtDate(newest) : fmtDate(new Date().toISOString()));
    const receivedBy = fields.receivedBy.trim() || Array.from(new Set(selectedReturns.map((r) => r.returnedBy).filter(Boolean)))[0] || "";
    setDoc({
      bol, number: draftNo, date: docDate, po, returnedFrom: customers.join(", "), receivedInto: locs,
      carrier: fields.carrier, receivedBy, truck: fields.truck, trailer: fields.trailer, notes: fields.notes,
      includeNeq, receivedDate: fields.receivedDate || docDate, qrs: selectedReturns.map((r) => r.item.qr),
    });
  }

  // Body flag for print isolation + filename via document.title (shared with BOL).
  useEffect(() => {
    if (typeof document === "undefined" || !doc) return;
    const prevTitle = document.title;
    document.body.classList.add("bol-open");
    document.title = `Nairn Det Plant - ${doc.number}`;
    return () => { document.body.classList.remove("bol-open"); document.title = prevTitle; };
  }, [doc]);

  return (
    <>
      <div className="flex items-center gap-2 pt-2">
        <Undo2 size={18} className="text-accent" />
        <h2 className="text-lg font-semibold text-fg">Returns</h2>
        <span className="text-sm text-muted">— goods that came back (Sold → Active, Off-Site → on-site)</span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Returned boxes" value={fmtNum(returns.length)} />
        <Stat label="Selected for this note" value={fmtNum(sel.size)} status={sel.size ? "ok" : undefined} />
        <Stat label="Line items" value={bol.lines.length} />
        <Stat label="Return collections" value={fmtNum(groups.length)} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2"><CardBody>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-fg">Select returned boxes for this note</div>
            <div className="flex items-center gap-3 text-xs">
              {sel.size > 0 && <span className="text-muted">{fmtNum(sel.size)} selected</span>}
              <label className="flex cursor-pointer items-center gap-1.5 font-medium text-fg">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!returns.length} />
                Select all{returns.length ? ` (${fmtNum(returns.length)})` : ""}
              </label>
              {sel.size > 0 && <button onClick={() => setSel(new Set())} className="underline text-muted hover:text-fg">clear</button>}
            </div>
          </div>
          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted">
              No returns detected. A box appears here once it&apos;s brought back on-site (Status set to Active) in the app.
            </div>
          ) : (
            <div className="max-h-[26rem] space-y-3 overflow-auto">
              {groups.map((g) => (
                <div key={`${g.customer}|${g.po}`} className="rounded-xl border border-border">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-border bg-bg px-3 py-2 text-sm font-semibold text-fg">
                    <input type="checkbox" checked={g.boxes.every((b) => sel.has(b.item.qr))} onChange={() => toggleMany(g.boxes)} />
                    {g.customer} <span className="font-normal text-muted">· PO {g.po} · {g.boxes.length} box(es) · {fmtNum(g.boxes.reduce((s, b) => s + b.item.original_quantity, 0))} u · returned {fmtTime(g.returnedAt)}</span>
                  </label>
                  <div className="divide-y divide-border">
                    {g.boxes.map((b) => (
                      <label key={b.item.qr} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 pl-6 text-sm hover:bg-bg/60">
                        <input type="checkbox" checked={sel.has(b.item.qr)} onChange={() => toggle(b.item.qr)} />
                        <span className="flex-1 truncate">{b.item.description || b.item.qr}</span>
                        <span className="w-28 shrink-0 text-right text-xs text-muted" title="Back into">{b.returnLocation}</span>
                        <span className="w-28 shrink-0 text-right text-xs text-muted" title="Returned">{fmtTime(b.returnedAt)}</span>
                        <span className="w-16 shrink-0 text-right tabular-nums text-muted">{fmtNum(b.item.original_quantity)} u</span>
                        <span className="hidden w-28 shrink-0 truncate text-right text-xs text-muted sm:inline">{b.item.qr}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody></Card>

        <Card><CardBody>
          <div className="mb-3 text-sm font-semibold text-fg">Return note details (editable)</div>
          <div className="space-y-2 text-sm">
            <Field label="Date" value={fields.date} onChange={(v) => setFields((f) => ({ ...f, date: v }))} />
            <Field label="Carrier / returned by" value={fields.carrier} onChange={(v) => setFields((f) => ({ ...f, carrier: v }))} />
            <Field label="Received by (Nairn Det Plant)" value={fields.receivedBy} onChange={(v) => setFields((f) => ({ ...f, receivedBy: v }))} />
            <Field label="Truck #" value={fields.truck} onChange={(v) => setFields((f) => ({ ...f, truck: v }))} />
            <Field label="Trailer #" value={fields.trailer} onChange={(v) => setFields((f) => ({ ...f, trailer: v }))} />
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Reason / notes (optional)</div>
              <textarea value={fields.notes} onChange={(e) => setFields((f) => ({ ...f, notes: e.target.value }))}
                rows={2} placeholder="e.g. unused stock returned from site"
                className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
            </div>
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-muted">
              <input type="checkbox" checked={includeNeq} onChange={(e) => setIncludeNeq(e.target.checked)} /> include Total NEQ on the document
            </label>
          </div>
          <button disabled={!sel.size} onClick={generate}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <FileText size={16} /> Generate return note
          </button>
          <p className="mt-2 text-xs text-muted">Return notes print with a draft <span className="font-mono">RTN</span> number — they aren&apos;t written to a register.</p>
        </CardBody></Card>
      </div>

      {doc && typeof document !== "undefined" && createPortal(
        <div className="bol-overlay">
          <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 bg-[#2b2d31] px-4 py-3 text-sm text-white">
            <span>Return note <span className="font-mono">{doc.number}</span> — print 2 copies (carrier + file).</span>
            <span className="flex gap-2">
              <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 font-semibold text-white"><Printer size={15} /> Print</button>
              <button onClick={() => setDoc(null)} className="flex items-center gap-1 rounded-lg border border-white/30 px-3 py-1.5"><X size={15} /> Close</button>
            </span>
          </div>
          <ReturnDocument doc={doc} />
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

// Same printable layout as the BOL (reuses .bol-doc styles) — relabelled for a
// return: the plant is the consignee receiving the goods back.
function ReturnDocument({ doc }: { doc: DocState }) {
  const { bol } = doc;
  const placard = (c: string) => bol.classes.includes(c);
  return (
    <div className="bol-doc">
      <div className="titlebar">Dangerous Goods / Explosives — Goods Return Note</div>

      <div className="head">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bme_logo_v2.png" alt="BME" />
          <div className="co">
            <div className="grp">Consignee (returned to)</div>
            <b>BME Mining Canada Inc.</b><br />
            2736 Belisle Dr.<br />
            Val Caron, ON, P3N 1B3<br />
            Tel: (705) 897-4971
          </div>
        </div>
        <div className="doc">
          <div className="f"><span className="k">Date</span><span className="v">{doc.date}</span></div>
          <div className="f"><span className="k">Return No.</span><span className="v"><span className="draft-stamp">{doc.number}</span></span></div>
          {doc.po && <div className="f"><span className="k">PO No.</span><span className="v">{doc.po}</span></div>}
        </div>
      </div>

      <div className="parties">
        <div className="col">
          <div className="field"><span className="lbl">Returned by (consignor) — name &amp; PO</span><div className="box addr">{[doc.returnedFrom, doc.po ? `PO ${doc.po}` : ""].filter(Boolean).join("\n")}</div></div>
          <div className="field"><span className="lbl">Returned to (consignee)</span><div className="box mid">{CONSIGNEE_TO}</div></div>
        </div>
        <div className="col">
          <div className="field"><span className="lbl">Received into</span><div className="box mid">{doc.receivedInto}</div></div>
          <div className="field"><span className="lbl">Truck #</span><div className="box mid">{doc.truck}</div></div>
          <div className="field"><span className="lbl">Trailer #</span><div className="box mid">{doc.trailer}</div></div>
        </div>
      </div>

      <table>
        <caption>Dangerous goods description — returned</caption>
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
            {doc.includeNeq && <div className="t opt"><div className="tk">Total NEQ</div><div className="tv">{bol.totalNemKg.toFixed(2)} kg</div></div>}
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

      {doc.notes.trim() && (
        <div className="cert">
          <div className="h">Reason for return</div>
          <p style={{ fontStyle: "normal" }}>{doc.notes}</p>
        </div>
      )}

      <div className="cert">
        <div className="h">Declaration</div>
        <p>“I hereby declare that the contents of this consignment are fully and accurately described above by the proper shipping name, are properly classified and packaged, have dangerous goods safety marks properly affixed or displayed on them, and are in all respects in proper condition for transport according to the Transportation of Dangerous Goods Regulations.”</p>
      </div>

      <div className="signs">
        <div className="s">
          <div className="role">Returned by / carrier</div>
          <div className="sigline"><div className="l"><div className="cap">Print name</div><div className="u">{doc.carrier}</div></div></div>
          <div className="sigline">
            <div className="l"><div className="cap">Signature</div><div className="u"></div></div>
            <div className="l" style={{ maxWidth: "32mm" }}><div className="cap">Date</div><div className="u">{doc.date}</div></div>
          </div>
        </div>
        <div className="s">
          <div className="role">Received by — Nairn Det Plant</div>
          <div className="sigline"><div className="l"><div className="cap">Name</div><div className="u">{doc.receivedBy}</div></div></div>
          <div className="sigline">
            <div className="l"><div className="cap">Signature</div><div className="u"></div></div>
            <div className="l" style={{ maxWidth: "32mm" }}><div className="cap">Date</div><div className="u">{doc.receivedDate}</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}
