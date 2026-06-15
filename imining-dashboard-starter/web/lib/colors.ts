// Chart colours — ported verbatim from the Streamlit dashboard so charts keep
// the exact same look. (Theme/CI is iMining navy+orange; these are the data
// colours, where we want the full distinct set.)

export const MASTER_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#499894",
  "#D37295", "#86BCB6", "#FABFD2", "#E8AC0F", "#BAB0AC",
];

export const ACTIVITY_COLOURS: Record<string, string> = {
  "Loading Explosives": "#4E79A7",
  "FQMO - Dipping & Priming": "#499894",
  "Reload": "#76B7B2",
  "Travel": "#59A14F",
  "Standby": "#BAB0AC",
  "Waiting For Explosives": "#9C755F",
  "Waiting For Personnel": "#B07AA1",
  "Refueling": "#EDC948",
  "Breakdown": "#E15759",
  "Toolbox Talk": "#F28E2B",
  "Tool Box Meeting": "#E8AC0F",
  "Unsafe Condition": "#D37295",
  "Safety Violation": "#E15759",
  "Shift Start": "#86BCB6",
  "Shift End": "#FABFD2",
};

export const CATEGORY_COLOURS: Record<string, string> = {
  "IN CAB CHECKS": "#4E79A7",
  "EXTERNAL CHECKS": "#F28E2B",
  "QUALITY": "#59A14F",
  "BEFORE DRIVING OFF": "#E15759",
};

export const BUCKET_COLOURS: Record<string, string> = {
  Productive: "#59A14F",
  Movement: "#4E79A7",
  Downtime: "#E15759",
  Maintenance: "#EDC948",
  "Safety/Admin": "#F28E2B",
  Other: "#BAB0AC",
};

export const ACTIVITY_BUCKET: Record<string, string> = {
  "Loading Explosives": "Productive",
  "FQMO - Dipping & Priming": "Productive",
  "Reload": "Productive",
  "Travel": "Movement",
  "Standby": "Downtime",
  "Waiting For Explosives": "Downtime",
  "Waiting For Personnel": "Downtime",
  "Refueling": "Maintenance",
  "Breakdown": "Maintenance",
  "Toolbox Talk": "Safety/Admin",
  "Tool Box Meeting": "Safety/Admin",
  "Unsafe Condition": "Safety/Admin",
  "Safety Violation": "Safety/Admin",
};

// Brand + semantic colours. Use ONE brand colour on categorical bars and spend
// the accent only on the thing to act on; reserve red for genuine exceptions.
export const BRAND_NAVY = "#002841";
export const BRAND_ORANGE = "#f5911e";
export const STATUS = { ok: "#59A14F", warn: "#f5911e", bad: "#E15759" };

// Responsibility lens — every logged hour bucketed by WHO OWNS the time, so
// "Waiting on mine" can be defended separately from "Idle/Standby".
export const RESPONSIBILITY_BUCKET: Record<string, string> = {
  "Loading Explosives": "Productive",
  "FQMO - Dipping & Priming": "Productive",
  "Reload": "Productive",
  "Travel": "Movement",
  "Toolbox Talk": "Safety/Admin",
  "Tool Box Meeting": "Safety/Admin",
  "Unsafe Condition": "Safety/Admin",
  "Safety Violation": "Safety/Admin",
  "Waiting For Explosives": "Waiting on mine",
  "Waiting For Personnel": "Waiting on mine",
  "Standby": "Idle/Standby",
  "Lunch": "Idle/Standby",
  "Breakdown": "Breakdown",
  "Refueling": "Breakdown",
};
// Left→right order for the stacked responsibility bar.
export const RESPONSIBILITY_ORDER = ["Productive", "Movement", "Safety/Admin", "Waiting on mine", "Idle/Standby", "Breakdown"];
export const RESPONSIBILITY_COLOURS: Record<string, string> = {
  Productive: "#59A14F",       // green
  Movement: "#4E79A7",         // steel blue
  "Safety/Admin": "#B07AA1",   // muted purple
  "Waiting on mine": "#f5911e",// brand amber — the exhibit
  "Idle/Standby": "#BAB0AC",   // grey (idle is neutral, not an alarm)
  Breakdown: "#E15759",        // red — a genuine exception
};
export const responsibilityOf = (activity: string) => RESPONSIBILITY_BUCKET[activity] || "Idle/Standby";

// Stable distinct colour per category (mirrors palette_map).
export function paletteMap(categories: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const uniq = Array.from(new Set(categories.filter((c) => c != null && c !== "")));
  uniq.forEach((c, i) => { out[c] = MASTER_PALETTE[i % MASTER_PALETTE.length]; });
  return out;
}

// Activity colour with master-palette fallback.
export function activityColour(act: string, idx: number): string {
  return ACTIVITY_COLOURS[act] || MASTER_PALETTE[idx % MASTER_PALETTE.length];
}
