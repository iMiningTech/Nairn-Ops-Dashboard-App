// Station dropdown lists per production line (Tickets.Station, Decon_Log.Station).
// ── IMPORTANT ────────────────────────────────────────────────────────────────
// These are HARDCODED and must match the BlastStock app's copy verbatim — exact
// case & punctuation (incl. trailing "." in "WIRE BEND VIS." and "CONN." prefixes).
// If a station is added/renamed in the app, update this list too. Station values
// are stored verbatim; filter with EXACT equality, never by parsing the number.
// Numbers are NOT unique across lines (both lines have a 30-20 / 30-30 with
// different names) — always match Line + Station together.

export const STATIONS: Record<string, string[]> = {
  ViperDet: [
    "10_100 UNCOILER",
    "10_300 INDEX TABLE",
    "10_400 COILING",
    "10_500 ROBOT",
    "10_600 BANDING",
    "10_700 UNLOADER",
    "10_800 CONVEYOR",
    "30-20 END TAIL-ALIGN",
    "30-30 LABEL APPLICATOR",
    "30-50 CRIMPING",
    "30-60 PULL TEST",
    "30-90 CONN. INSERT",
    "30-95 CONN. CHECKING",
    "30-100 CONN. REROUTING",
    "30-110 OFFLOAD",
    "30-120 CPM/REJECT",
    "40-10 ROBOT",
    "40-20 STACKING",
    "40-30 TRANSFER",
    "40-40 LORAPACK",
    "OTHER",
  ],
  Axxis: [
    "20-05 1ST SLIDER",
    "20-10 LOADING",
    "20-20 PLUG INSERT",
    "20-30 WIRE BEND VIS.",
    "20-40 ROBOT TRANSFER",
    "20-50 EBOARD SOLDER",
    "20-60 VISION & CONTINUITY",
    "20-70 2ND SLIDER",
    "20-80 DETONATOR CRIMPING",
    "20-90 PULL TEST & E TEST",
    "20-100 UNLOADER",
    "20-110 GREASING",
    "20-120 LABEL APPLICATOR",
    "20-130 OFFLOAD CONVEYOR",
    "20-140 REJECT DRAWER",
    "30-10 ROBOT PICKER",
    "30-20 EBOARD LOAD & CUT",
    "30-30 SLEEVE INSERT",
    "30-40 DETONATOR LOADING",
    "OTHER",
  ],
};

// Stations to offer for a ticket's line. Unknown/"Other" line → union of both
// (deduped), so a station can still be picked.
export function stationsForLine(line: string): string[] {
  if (STATIONS[line]) return STATIONS[line];
  return Array.from(new Set([...STATIONS.ViperDet, ...STATIONS.Axxis]));
}
