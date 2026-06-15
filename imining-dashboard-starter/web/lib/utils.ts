import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  // Always display in Kansanshi site time (CAT, UTC+2) — never the viewer's local
  // timezone — so the operational timestamp is the same for everyone, anywhere.
  return d.toLocaleString("en-GB", {
    hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
    hour12: false,
    timeZone: "Africa/Lusaka",
  });
}
