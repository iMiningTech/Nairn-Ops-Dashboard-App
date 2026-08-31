// Maintenance / breakdown ticket logic for the Breakdowns tab. Pure functions
// over the Tickets (current state) + Ticket_Events (audit) feeds.
// Key rules from the data contract:
//   • Cancelled is separate from Closed everywhere — check Status, not the
//     Closed_At timestamp (Cancelled also fills Closed_By/At).
//   • Time to resolve = Closed_At − Created_At, Status=Closed only.
//   • Time to first response = earliest ASSIGNED (to a tech) − Created_At.

import type { Ticket, TicketEvent } from "@/lib/api";
import { dateKey } from "@/lib/utils";

export const OPEN_STATUSES = ["Open", "In Progress", "Awaiting Parts"];
export const isOpen = (t: Ticket) => OPEN_STATUSES.includes(t.status);
export const isClosed = (t: Ticket) => t.status === "Closed";

const ms = (s?: string | null) => (s ? Date.parse(s) : NaN);
const hoursBetween = (from?: string | null, to?: string | null) => {
  const a = ms(from), b = ms(to);
  return isNaN(a) || isNaN(b) || b < a ? null : (b - a) / 3_600_000;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const inRange = (at: string | null, from: string, to: string) => { const k = dateKey(at || ""); return !!k && k >= from && k <= to; };

// Earliest assignment to a technician per ticket → first-response clock.
export function firstAssignAt(events: TicketEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    if (e.event_type !== "ASSIGNED" || !e.to_value.trim() || !e.timestamp) continue;
    const prev = m.get(e.ticket_id);
    if (!prev || (ms(e.timestamp) || 0) < (ms(prev) || 0)) m.set(e.ticket_id, e.timestamp);
  }
  return m;
}

export type TicketRow = Ticket & { line_full: string; resolve_hours: number | null; first_response_hours: number | null };
export function ticketRows(tickets: Ticket[], events: TicketEvent[]): TicketRow[] {
  const fa = firstAssignAt(events);
  return tickets.map((t) => ({
    ...t,
    line_full: t.line === "Other" && t.line_detail ? `Other — ${t.line_detail}` : t.line,
    resolve_hours: isClosed(t) ? hoursBetween(t.created_at, t.closed_at) : null,
    first_response_hours: hoursBetween(t.created_at, fa.get(t.id) || null),
  })).sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0));
}

export type TicketMetrics = {
  openTotal: number; inProgress: number; awaitingParts: number; openCriticalHigh: number;
  raised: number; closed: number; cancelled: number;
  avgResolveHours: number | null; avgFirstResponseHours: number | null;
  byStatus: { name: string; value: number }[];
  bySeverityOpen: { name: string; value: number }[];
};
export function ticketMetrics(tickets: Ticket[], events: TicketEvent[], from: string, to: string): TicketMetrics {
  const open = tickets.filter(isOpen);
  const fa = firstAssignAt(events);
  // Period slices (by Created for raised; by Closed for closed/cancelled).
  const raised = tickets.filter((t) => inRange(t.created_at, from, to));
  const closed = tickets.filter((t) => t.status === "Closed" && inRange(t.closed_at, from, to));
  const cancelled = tickets.filter((t) => t.status === "Cancelled" && inRange(t.closed_at, from, to));
  const resolveHrs = closed.map((t) => hoursBetween(t.created_at, t.closed_at)).filter((h): h is number => h != null);
  const frHrs = raised.map((t) => hoursBetween(t.created_at, fa.get(t.id) || null)).filter((h): h is number => h != null);
  const tally = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x || "—", (m.get(x || "—") || 0) + 1); return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value); };
  return {
    openTotal: open.length,
    inProgress: tickets.filter((t) => t.status === "In Progress").length,
    awaitingParts: tickets.filter((t) => t.status === "Awaiting Parts").length,
    openCriticalHigh: open.filter((t) => t.severity === "Critical" || t.severity === "High").length,
    raised: raised.length,
    closed: closed.length,
    cancelled: cancelled.length,
    avgResolveHours: avg(resolveHrs),
    avgFirstResponseHours: avg(frHrs),
    byStatus: tally(tickets.map((t) => t.status)),
    bySeverityOpen: tally(open.map((t) => t.severity)),
  };
}

// Human duration from hours: "3.4h" under a day, else "2d 5h".
export function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24); const r = Math.round(h - d * 24);
  return `${d}d ${r}h`;
}
