import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Display everything in the SITE's timezone — never the viewer's — so an
// operational timestamp reads the same on the kitchen TV, on a phone, and in the
// office. Nairn Det Plant is in Nairn Centre, Ontario, Canada → Toronto time.
// Override per-deployment with NEXT_PUBLIC_SITE_TZ (an IANA tz name).
export const SITE_TZ = process.env.NEXT_PUBLIC_SITE_TZ || "America/Toronto";

export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
    hour12: false,
    timeZone: SITE_TZ,
  });
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    timeZone: SITE_TZ,
  });
}

export const fmtNum = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });

// Normalise a sheet date ("6/15/2026", "5/8/2026", or an ISO string) to a
// YYYY-MM-DD key for grouping/comparison. Returns "" if unparseable.
export function dateKey(s?: string | null): string {
  if (!s) return "";
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ }).format(d);
}

// Today / N-days-ago as a YYYY-MM-DD key in SITE_TZ.
export const todayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ }).format(new Date());
export const dayKeyOffset = (days: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: SITE_TZ }).format(new Date(Date.now() + days * 86400000));

// "2026-06-15" → "15 Jun" for compact chart axes.
export function shortDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y) return key;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

// Minute-of-day (0–1439) from a sheet timestamp's WALL CLOCK. The sheet stores
// naive plant-local times ("6/15/2026 8:30:25"), so we read the clock digits
// directly — correct regardless of the viewer's timezone. Returns null if no time.
export function clockMinutes(ts?: string | null): number | null {
  if (!ts) return null;
  const m = String(ts).match(/(?:T|\s)(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

// Minutes-since-midnight right now, in SITE_TZ.
export function nowMinutesInTz(): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: SITE_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const h = +(p.find((x) => x.type === "hour")?.value ?? "0") % 24;
  const m = +(p.find((x) => x.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

// 150 → "2h 30m"; 45 → "45m".
export function fmtMins(min: number): string {
  const v = Math.max(0, Math.round(min));
  const h = Math.floor(v / 60), m = v % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
// minute-of-day → "08:30"
export const fmtClock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
