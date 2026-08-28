"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, X, FileText, AlertTriangle, RotateCcw, PenLine } from "lucide-react";
import { api, type InventoryItem, type Transaction, type IssuedBol, type Signature } from "@/lib/api";
import { buildBol, draftBolNumber, type Bol, type BolLine } from "@/lib/bol";
import { Card, CardBody, Stat } from "@/components/ui";
import { fmtNum, fmtDate, fmtTime } from "@/lib/utils";

const CONSIGNOR_FROM = "Nairn Det Plant";
const CONSIGNOR_SIGNER = "Justin James";
// Transparent PNG of the consignor's signature — place at web/public/consignor_sig.png.
const CONSIGNOR_SIG_URL = "/consignor_sig.png";

type DocState = {
  bol: Bol; number: string; date: string; po: string; shipTo: string; truck: string; trailer: string;
  consignor: string; driver: string; signatureUrl: string; includeNeq: boolean; qrs: string[]; issued: boolean;
  receiverDate: string; consignorSigUrl: string; consignorDate: string;
};

const poNorm = (s: string) => s.trim().toUpperCase();

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

  // Captured receiver signatures (Signatures tab), looked up by PO number.
  const [signatures, setSignatures] = useState<Signature[]>([]);
  useEffect(() => { api.signatures().then((r) => setSignatures(r.items)).catch(() => {}); }, []);
  // Latest PO per box from PO_UPDATE transactions (field PO_Number) — matches the
  // sales-history derivation, so a box's PO is found even when it's only in the log.
  const poByQr = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of txns) if (t.field === "PO_Number" && t.new_value) m.set(t.qr, t.new_value);
    return m;
  }, [txns]);
  const itemByQr = useMemo(() => new Map(items.map((i) => [i.qr, i])), [items]);
  const poForQr = (qr: string) => itemByQr.get(qr)?.po_number || poByQr.get(qr) || "";
  const poFor = (i: InventoryItem) => i.po_number || poByQr.get(i.qr) || "";

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState({ date: fmtDate(new Date().toISOString()), shipTo: "", truck: "", trailer: "", consignor: "", driver: "", signatureUrl: "", receiverDate: "" });
  const [consignorSign, setConsignorSign] = useState(() => { try { return localStorage.getItem("nairn_consignor_sign") === "1"; } catch { return false; } });
  const [includeNeq, setIncludeNeq] = useState(false);
  const [doc, setDoc] = useState<DocState | null>(null);
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const selectedBoxes = useMemo(() => eligible.filter((i) => sel.has(i.qr)), [eligible, sel]);
  const bol = useMemo(() => buildBol(selectedBoxes), [selectedBoxes]);
  const draftNo = useMemo(() => draftBolNumber(selectedBoxes), [selectedBoxes]);

  // Signatures whose PO matches a PO on the current selection. A PO can have more
  // than one signature (split deliveries / multiple scan sessions) → show them all.
  const matchingSigs = useMemo(() => {
    const pos = new Set(selectedBoxes.map(poFor).filter(Boolean).map(poNorm));
    if (!pos.size) return [];
    return signatures.filter((s) => s.po_number && s.drive_url && pos.has(poNorm(s.po_number)))
      .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  }, [selectedBoxes, signatures, poByQr]); // eslint-disable-line react-hooks/exhaustive-deps
  const matchPos = useMemo(() => Array.from(new Set(matchingSigs.map((s) => s.po_number))), [matchingSigs]);

  const applySignature = (s: Signature) =>
    setFields((f) => ({ ...f, driver: s.receiver_name || f.driver, signatureUrl: s.drive_url, receiverDate: s.timestamp ? fmtDate(s.timestamp) : f.receiverDate }));
  const clearSignature = () => setFields((f) => ({ ...f, signatureUrl: "", receiverDate: "" }));

  const toggle = (qr: string) => setSel((s) => { const n = new Set(s); n.has(qr) ? n.delete(qr) : n.add(qr); return n; });
  const toggleGroup = (boxes: InventoryItem[]) => setSel((s) => {
    const n = new Set(s); const all = boxes.every((b) => n.has(b.qr));
    boxes.forEach((b) => all ? n.delete(b.qr) : n.add(b.qr)); return n;
  });
  // Master "select all": every eligible box NOT already on a BOL (so a large
  // collection is one click, and boxes already shipped aren't re-selected).
  const selectable = useMemo(() => eligible.filter((b) => !usedQr.has(b.qr)), [eligible, usedQr]);
  const allSelectableSelected = selectable.length > 0 && selectable.every((b) => sel.has(b.qr));
  const toggleSelectAll = () => setSel((s) => {
    const n = new Set(s);
    if (selectable.every((b) => n.has(b.qr))) selectable.forEach((b) => n.delete(b.qr));
    else selectable.forEach((b) => n.add(b.qr));
    return n;
  });
  // Ordering: boxes/collections NOT yet on a BOL float to the top (the actionable
  // ones); already-shipped boxes sink. Ties break by most-recently sold.
  const grpOpen = (bs: InventoryItem[]) => bs.some((b) => !usedQr.has(b.qr));
  const boxOrder = (a: InventoryItem, b: InventoryItem) =>
    (usedQr.has(a.qr) ? 1 : 0) - (usedQr.has(b.qr) ? 1 : 0)
    || (Date.parse(soldOn(b) || "") || 0) - (Date.parse(soldOn(a) || "") || 0);

  function generate() {
    const shipTo = fields.shipTo.trim() || bol.customers.join(", ");
    const po = Array.from(new Set(selectedBoxes.map(poFor).filter(Boolean))).join(", ");
    setRegError(null);
    const consignor = consignorSign && !fields.consignor.trim() ? CONSIGNOR_SIGNER : fields.consignor;
    // Consignor date mirrors the consignee's signed date when there is one, else the document date.
    const consignorDate = consignorSign ? (fields.receiverDate || fields.date) : "";
    setDoc({ bol, number: draftNo, date: fields.date, po, shipTo, truck: fields.truck, trailer: fields.trailer,
      consignor, driver: fields.driver, signatureUrl: fields.signatureUrl, includeNeq, qrs: selectedBoxes.map((b) => b.qr), issued: false,
      receiverDate: fields.receiverDate, consignorSigUrl: consignorSign ? CONSIGNOR_SIG_URL : "", consignorDate });
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
        signature_url: doc.signatureUrl,
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
    const qrs = r.box_qrs.split(",").map((s) => s.trim()).filter(Boolean);
    const po = Array.from(new Set(qrs.map(poForQr).filter(Boolean))).join(", ");
    // Recover the receiver's signed date from the matching captured signature.
    const sig = r.signature_url ? signatures.find((s) => s.drive_url && s.drive_url === r.signature_url) : undefined;
    const receiverDate = sig?.timestamp ? fmtDate(sig.timestamp) : "";
    const consignor = r.consignor_name || (consignorSign ? CONSIGNOR_SIGNER : "");
    const consignorDate = consignorSign ? (receiverDate || r.date) : "";
    setDoc({ bol: bolObj, number: r.bol_no, date: r.date, po, shipTo: r.ship_to, truck: r.truck, trailer: r.trailer,
      consignor, driver: r.driver_name, signatureUrl: r.signature_url, includeNeq: r.include_neq, qrs, issued: true,
      receiverDate, consignorSigUrl: consignorSign ? CONSIGNOR_SIG_URL : "", consignorDate });
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

      {matchingSigs.length > 0 && (
        <Card className="border-t-4 border-t-accent"><CardBody>
          <div className="flex items-start gap-2">
            <PenLine size={16} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-fg">
                A receiver signature was captured for PO {matchPos.join(", ")} — auto-fill the receiver name and signature?
              </div>
              <div className="mt-2 space-y-2">
                {matchingSigs.map((s) => {
                  const active = fields.signatureUrl === s.drive_url;
                  return (
                    <div key={s.drive_file_id || s.timestamp} className="flex items-center gap-3 rounded-lg border border-border p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.drive_url} alt="Captured signature" className="h-10 w-24 shrink-0 rounded bg-[#f3f4f6] object-contain" />
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="truncate font-medium text-fg">{s.receiver_name || "(no name recorded)"}</div>
                        <div className="text-muted">PO {s.po_number} · {fmtTime(s.timestamp)}{s.operator ? ` · ${s.operator}` : ""}{s.item_count ? ` · ${fmtNum(s.item_count)} item(s)` : ""}</div>
                      </div>
                      {active ? (
                        <button onClick={clearSignature} className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-bg">Attached ✓ · Remove</button>
                      ) : (
                        <button onClick={() => applySignature(s)} className="shrink-0 rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white">Auto-fill</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </CardBody></Card>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2"><CardBody>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-fg">Select boxes for this collection</div>
            <div className="flex items-center gap-3 text-xs">
              {sel.size > 0 && <span className="text-muted">{fmtNum(sel.size)} selected</span>}
              <label className="flex cursor-pointer items-center gap-1.5 font-medium text-fg">
                <input type="checkbox" checked={allSelectableSelected} onChange={toggleSelectAll} disabled={!selectable.length} />
                Select all{selectable.length ? ` (${fmtNum(selectable.length)})` : ""}
              </label>
              {sel.size > 0 && <button onClick={() => setSel(new Set())} className="underline text-muted hover:text-fg">clear</button>}
            </div>
          </div>
          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted">No boxes are marked Sold yet. Scan + sell boxes in the app, then they appear here.</div>
          ) : (
            <div className="max-h-[26rem] space-y-3 overflow-auto">
              {groups.slice().sort((a, b) => (grpOpen(b.boxes) ? 1 : 0) - (grpOpen(a.boxes) ? 1 : 0)).map(({ customer, boxes }) => {
                // Split each customer's boxes by PO so separate collections are
                // distinguishable — each PO cluster gets its own select-all toggle.
                // Open (not-yet-on-a-BOL) collections and boxes float to the top.
                const byPo = new Map<string, InventoryItem[]>();
                for (const b of boxes) { const k = poForQr(b.qr) || "(no PO)"; if (!byPo.has(k)) byPo.set(k, []); byPo.get(k)!.push(b); }
                const poGroups = Array.from(byPo, ([po, bs]) => ({ po, bs: bs.slice().sort(boxOrder) }))
                  .sort((a, b) => (grpOpen(b.bs) ? 1 : 0) - (grpOpen(a.bs) ? 1 : 0)
                    || (a.po === "(no PO)" ? 1 : 0) - (b.po === "(no PO)" ? 1 : 0)
                    || a.po.localeCompare(b.po, undefined, { numeric: true }));
                return (
                <div key={customer} className="rounded-xl border border-border">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-border bg-bg px-3 py-2 text-sm font-semibold text-fg">
                    <input type="checkbox" checked={boxes.every((b) => sel.has(b.qr))} onChange={() => toggleGroup(boxes)} />
                    {customer} <span className="font-normal text-muted">· {boxes.length} box(es) · {poGroups.length} PO(s)</span>
                  </label>
                  {poGroups.map(({ po, bs }) => (
                    <div key={po}>
                      <label className="flex cursor-pointer items-center gap-2 border-b border-border bg-bg/50 px-3 py-1.5 pl-5 text-xs font-medium text-fg">
                        <input type="checkbox" checked={bs.every((b) => sel.has(b.qr))} onChange={() => toggleGroup(bs)} />
                        <span className={po === "(no PO)" ? "text-warn" : "text-accent"}>PO {po}</span>
                        <span className="font-normal text-muted">· {bs.length} box(es) · {fmtNum(bs.reduce((s, b) => s + b.original_quantity, 0))} u</span>
                      </label>
                      <div className="divide-y divide-border">
                        {bs.map((b) => {
                          const used = usedQr.get(b.qr);
                          return (
                            <label key={b.qr} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 pl-8 text-sm hover:bg-bg/60">
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
                );
              })}
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
            <Field label="Driver / carrier / consignee name" value={fields.driver} onChange={(v) => setFields((f) => ({ ...f, driver: v }))} />
            {fields.signatureUrl && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2 py-1 text-xs text-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fields.signatureUrl} alt="Attached signature" className="h-6 w-16 shrink-0 object-contain" />
                <span className="flex-1">Signature attached</span>
                <button onClick={clearSignature} className="underline hover:text-fg">clear</button>
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-muted">
              <input type="checkbox" checked={consignorSign}
                onChange={(e) => {
                  const on = e.target.checked; setConsignorSign(on);
                  try { localStorage.setItem("nairn_consignor_sign", on ? "1" : "0"); } catch { /* ignore */ }
                  if (on && !fields.consignor.trim()) setFields((f) => ({ ...f, consignor: CONSIGNOR_SIGNER }));
                }} /> sign as consignor ({CONSIGNOR_SIGNER})
            </label>
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
          <BolDocument bol={doc.bol} number={doc.number} date={doc.date} po={doc.po} shipTo={doc.shipTo} truck={doc.truck} trailer={doc.trailer} consignor={doc.consignor} driver={doc.driver} signatureUrl={doc.signatureUrl} includeNeq={doc.includeNeq} receiverDate={doc.receiverDate} consignorSigUrl={doc.consignorSigUrl} consignorDate={doc.consignorDate} />
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

function BolDocument({ bol, number, date, po, shipTo, truck, trailer, consignor, driver, signatureUrl, includeNeq, receiverDate, consignorSigUrl, consignorDate }:
  { bol: Bol; number: string; date: string; po: string; shipTo: string; truck: string; trailer: string; consignor: string; driver: string; signatureUrl: string; includeNeq: boolean; receiverDate: string; consignorSigUrl: string; consignorDate: string }) {
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
          {po && <div className="f"><span className="k">PO No.</span><span className="v">{po}</span></div>}
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
          <div className="sigline">
            <div className="l">
              <div className="cap">Signature</div>
              {consignorSigUrl ? (
                <div className="u sig">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="sig-img sig-consignor" src={consignorSigUrl} alt="Consignor signature" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                </div>
              ) : <div className="u"></div>}
            </div>
            <div className="l" style={{ maxWidth: "32mm" }}><div className="cap">Date</div><div className="u">{consignorDate}</div></div>
          </div>
        </div>
        <div className="s">
          <div className="role">Driver / carrier / consignee</div>
          <div className="sigline"><div className="l"><div className="cap">Name</div><div className="u">{driver}</div></div></div>
          <div className="sigline">
            <div className="l">
              <div className="cap">Signature</div>
              {signatureUrl ? (
                <div className="u sig">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="sig-img sig-consignee" src={signatureUrl} alt="Receiver signature" />
                </div>
              ) : <div className="u"></div>}
            </div>
            <div className="l" style={{ maxWidth: "32mm" }}><div className="cap">Date</div><div className="u">{receiverDate}</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}
