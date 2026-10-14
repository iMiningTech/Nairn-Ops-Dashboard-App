// Bill of Lading logic. Builds DG line items from selected sold boxes using a
// dangerous-goods classification per product. NOTE: this mapping is hardcoded for
// the current product set — it will move to an editable `Dangerous_Goods` sheet
// tab when we wire the register. NEM per unit confirmed with Justin:
//   MS DUAL = 1 g in-hole + 0.25 g surface = 1.25 g · QS = 0.25 g · Axxis = 1.0 g

import type { InventoryItem } from "@/lib/api";
import { productionLine } from "@/lib/production";

export type Dg = { un: string; name: string; cls: string; pg: string; nemPerUnitG: number };

// UN number per hazard class, by detonator type (standard DG pairings):
//   ViperDet = non-electric detonator assemblies · Axxis = electronic detonators.
// The hazard class comes from the box's Packaging_Class; the UN tracks the class.
const UN_BY_CLASS: Record<string, Record<string, string>> = {
  ViperDet: { "1.1B": "UN 0360", "1.4B": "UN 0361", "1.4S": "UN 0500" },
  Axxis: { "1.1B": "UN 0511", "1.4B": "UN 0512", "1.4S": "UN 0513" },
};
const DG_NAME: Record<string, string> = {
  ViperDet: "DETONATOR ASSEMBLIES, NON-ELECTRIC",
  Axxis: "DETONATORS, ELECTRONIC PROGRAMMABLE",
};

// Normalise a Packaging_Class value to one of the three hazard classes.
function hazClass(raw: string): "1.1B" | "1.4B" | "1.4S" | null {
  const s = (raw || "").toUpperCase().replace(/\s+/g, "");
  if (s === "1.1B") return "1.1B";
  if (s === "1.4B") return "1.4B";
  if (s === "1.4S") return "1.4S";
  return null;
}

export function dgFor(i: InventoryItem): Dg | null {
  const pt = i.product_type.toUpperCase();
  const line = productionLine(i);
  if (!line) return null;
  const nem = pt === "MS DUAL" ? 1.25 : pt === "QS" ? 0.25 : (line === "Axxis" ? 1.0 : 0);
  const byClass = UN_BY_CLASS[line];
  if (!byClass) return null;
  // Use the box's actual DG class; fall back to 1.1B (the higher hazard — never
  // under-classify a shipping document) only when Packaging_Class is blank/unknown.
  const cls = hazClass(i.packaging_class) ?? "1.1B";
  return { un: byClass[cls], name: DG_NAME[line], cls, pg: "II", nemPerUnitG: nem };
}

export type BolLine = { un: string; name: string; cls: string; pg: string; description: string; packages: number; quantity: number; nemG: number };
export type Bol = {
  lines: BolLine[];
  totalPackages: number;
  totalQuantity: number;
  totalNemKg: number;
  classes: string[];        // distinct hazard classes present (for placards)
  customers: string[];      // distinct customers in the selection (>1 = warning)
};

export function buildBol(boxes: InventoryItem[]): Bol {
  const m = new Map<string, BolLine>();
  for (const b of boxes) {
    const dg = dgFor(b);
    if (!dg) continue;
    const key = `${dg.un}|${b.description}`;
    const line = m.get(key) || { un: dg.un, name: dg.name, cls: dg.cls, pg: dg.pg, description: b.description, packages: 0, quantity: 0, nemG: 0 };
    line.packages += 1;
    line.quantity += b.original_quantity;
    line.nemG += b.original_quantity * dg.nemPerUnitG;
    m.set(key, line);
  }
  const lines = Array.from(m.values()).sort((a, b) => a.un.localeCompare(b.un) || a.description.localeCompare(b.description));
  return {
    lines,
    totalPackages: lines.reduce((s, l) => s + l.packages, 0),
    totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
    totalNemKg: lines.reduce((s, l) => s + l.nemG, 0) / 1000,
    classes: Array.from(new Set(lines.map((l) => l.cls))).sort(),
    customers: Array.from(new Set(boxes.map((b) => b.customer).filter(Boolean))),
  };
}

// Provisional draft number until the Apps Script register assigns the real
// sequential BOL-YYYY-NNNN. Deterministic from the selected box QRs so the same
// selection always shows the same draft id.
export function draftBolNumber(boxes: InventoryItem[]): string {
  const key = boxes.map((b) => b.qr).sort().join("|");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `DRAFT-${yyyymmdd}-${h.toString(36).toUpperCase().slice(0, 4).padStart(4, "0")}`;
}
