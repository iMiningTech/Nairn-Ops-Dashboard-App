"use client";

import { useMemo, useState } from "react";
import { PackageCheck, Download } from "lucide-react";
import { Card, CardBody, Stat } from "@/components/ui";
import { indexReceived } from "@/lib/received";
import type { InventoryItem, Transaction } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

// Format a YYYY-MM-DD day key as "11 Nov 2026" WITHOUT timezone shifting (parsing
// the key as a local Date would roll it back a day west of UTC).
function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y) return key || "—";
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// Raw-material deliveries: what was first labelled into inventory on a given day.
// See lib/received.ts for the "first LABEL_CREATED per box" rule.
export function ReceivedView({ items, txns }: { items: InventoryItem[]; txns: Transaction[] }) {
  const idx = useMemo(() => indexReceived(items, txns, { type: "RAW_MATERIAL" }), [items, txns]);
  const [day, setDay] = useState<string>("");
  const selected = day || idx.days[0]?.day || "";
  const detail = idx.byDay.get(selected);

  function exportCsv() {
    if (!detail) return;
    const head = ["Description", "Manufacturer", "Financial_No", "Boxes", "Units"];
    const lines = detail.rows.map((r) => [r.description, r.manufacturer, r.financial_no, r.boxes, r.quantity]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv = [head.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `received-${selected}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (!idx.days.length) {
    return (
      <Card><CardBody>
        <div className="flex items-center gap-2 text-sm text-muted">
          <PackageCheck size={16} /> No raw-material deliveries found in the transaction log yet.
        </div>
      </CardBody></Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card><CardBody>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <PackageCheck size={18} /> Raw materials received
          </div>
          <div className="flex items-center gap-2">
            <select value={selected} onChange={(e) => setDay(e.target.value)}
              className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-fg">
              {idx.days.map((d) => (
                <option key={d.day} value={d.day}>{dayLabel(d.day)} — {fmtNum(d.boxes)} box{d.boxes === 1 ? "" : "es"}</option>
              ))}
            </select>
            <button onClick={exportCsv} disabled={!detail}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg disabled:opacity-50">
              <Download size={14} /> CSV
            </button>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label={`Received ${dayLabel(selected)}`} value={fmtNum(detail?.boxes ?? 0)} sub="boxes" />
          <Stat label="Units" value={fmtNum(detail?.quantity ?? 0)} />
          <Stat label="Line items" value={fmtNum(detail?.rows.length ?? 0)} />
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Manufacturer</th>
                <th className="px-3 py-2 text-right font-medium">Boxes</th>
                <th className="px-3 py-2 text-right font-medium">Units</th>
              </tr>
            </thead>
            <tbody>
              {detail?.rows.map((r) => (
                <tr key={r.description} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 text-fg">{r.description}</td>
                  <td className="px-3 py-2 text-muted">{r.manufacturer || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.boxes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.quantity)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td className="px-3 py-2 text-fg" colSpan={2}>Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(detail?.boxes ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(detail?.quantity ?? 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardBody></Card>

      <Card><CardBody>
        <div className="mb-3 text-sm font-semibold text-fg">Delivery days ({idx.days.length})</div>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Day</th>
                <th className="px-3 py-2 text-right font-medium">Line items</th>
                <th className="px-3 py-2 text-right font-medium">Boxes</th>
                <th className="px-3 py-2 text-right font-medium">Units</th>
              </tr>
            </thead>
            <tbody>
              {idx.days.map((d) => (
                <tr key={d.day} onClick={() => setDay(d.day)}
                  className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-bg ${d.day === selected ? "bg-accent/10" : ""}`}>
                  <td className="px-3 py-2 text-fg">{dayLabel(d.day)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(d.items)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(d.boxes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(d.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody></Card>
    </div>
  );
}
