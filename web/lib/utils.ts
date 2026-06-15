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
