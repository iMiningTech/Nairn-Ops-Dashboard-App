// Chart/data colours for the Nairn inventory dashboard. Brand tokens stay in
// globals.css; these are the categorical data colours.

export const MASTER_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#499894",
  "#D37295", "#86BCB6", "#FABFD2", "#E8AC0F", "#BAB0AC",
];

// Brand + semantic colours. Use ONE brand colour on categorical bars and spend
// the accent only on the thing to act on; reserve red for genuine exceptions.
export const BRAND_NAVY = "#002841";
export const BRAND_ORANGE = "#f5911e";
export const STATUS = { ok: "#59A14F", warn: "#f5911e", bad: "#E15759" };

// Inventory item types (Inventory_Master.Type). Stable colour per type so the
// same category reads the same across every chart.
export const TYPE_COLOURS: Record<string, string> = {
  RAW_MATERIAL: "#4E79A7",
  FINISHED_GOOD: "#59A14F",
  POOL: "#f5911e",
  NDT_BATCH: "#B07AA1",
  Unknown: "#BAB0AC",
};

// Stable distinct colour per category, master-palette fallback.
export function paletteMap(categories: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  Array.from(new Set(categories.filter((c) => c != null && c !== "")))
    .forEach((c, i) => { out[c] = MASTER_PALETTE[i % MASTER_PALETTE.length]; });
  return out;
}

export const typeColour = (t: string, i = 0) => TYPE_COLOURS[t] || MASTER_PALETTE[i % MASTER_PALETTE.length];

// Consumed by the drop-in ResponsibilityBar chart (not used by the current Nairn
// views, but kept so components/charts.tsx stays a verbatim, reusable drop-in).
export const RESPONSIBILITY_COLOURS: Record<string, string> = {
  Productive: "#59A14F",
  Movement: "#4E79A7",
  "Safety/Admin": "#B07AA1",
  "Waiting on mine": "#f5911e",
  "Idle/Standby": "#BAB0AC",
  Breakdown: "#E15759",
};
