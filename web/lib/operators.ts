// Operator activity summary from Transaction_Log — built to answer "who isn't
// using the system correctly?". Surfaces, per operator: volume, recency, the
// spread of reasons/transaction types they use, and misuse flags.

import type { Transaction, User } from "@/lib/api";
import { dateKey } from "@/lib/utils";

// Automation / non-human accounts (excluded from the operator view by default).
export const isSystemUser = (name: string) => name.includes(":") || name === "import" || name === "";
export const isTestUser = (name: string) => /test/i.test(name);

export type OperatorStat = {
  user: string;
  actions: number;
  activeDays: number;
  lastActivity: string | null;
  reasons: { name: string; value: number }[];   // sorted desc
  types: { name: string; value: number }[];      // sorted desc
  distinctReasons: number;
  topReasonShare: number;       // 0..1 — concentration on the single most-used reason
  correctionShare: number;      // 0..1 — share of Correction / Stock Correction
  known: boolean;               // present & active in User_Management
  test: boolean;
  flags: string[];
};

function tally(rows: Transaction[], key: (t: Transaction) => string) {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r) || "—"; m.set(k, (m.get(k) || 0) + 1); }
  return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export function operatorStats(txns: Transaction[], users: User[], opts?: { includeSystem?: boolean }): OperatorStat[] {
  const roster = new Map(users.map((u) => [u.name.trim().toLowerCase(), u]));
  const byUser = new Map<string, Transaction[]>();
  for (const t of txns) {
    const u = (t.user || "").trim();
    if (!opts?.includeSystem && isSystemUser(u)) continue;
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u)!.push(t);
  }

  const out: OperatorStat[] = [];
  for (const [user, rows] of byUser) {
    const reasons = tally(rows, (t) => t.reason);
    const types = tally(rows, (t) => t.type);
    const days = new Set(rows.map((t) => dateKey(t.timestamp)).filter(Boolean));
    const last = rows.reduce<string | null>((acc, t) => {
      const ms = Date.parse(t.timestamp || "");
      return !isNaN(ms) && (!acc || ms > Date.parse(acc)) ? t.timestamp : acc;
    }, null);
    const rosterEntry = roster.get(user.toLowerCase());
    const known = !!rosterEntry && /true/i.test(String(rosterEntry.active));
    const test = isTestUser(user);
    const topReasonShare = reasons.length ? reasons[0].value / rows.length : 0;
    const correctionShare = rows.filter((t) => /correction/i.test(t.reason)).length / rows.length;

    const flags: string[] = [];
    if (!known && !test) flags.push("Not on roster");
    if (test) flags.push("Test account");
    if (rows.length >= 5 && reasons.filter((r) => r.name !== "—").length <= 1) flags.push("Only one reason used");
    if (rows.length >= 10 && correctionShare >= 0.4) flags.push("Heavy use of corrections");

    out.push({
      user, actions: rows.length, activeDays: days.size, lastActivity: last,
      reasons, types, distinctReasons: reasons.filter((r) => r.name !== "—").length,
      topReasonShare, correctionShare, known, test, flags,
    });
  }
  return out.sort((a, b) => b.actions - a.actions);
}

// Distinct human operators who have logged anything on a given day — "who's
// actually touching the digital system today".
export function activeOperatorsOn(txns: Transaction[], dayKey: string): string[] {
  const s = new Set<string>();
  for (const t of txns) {
    const u = (t.user || "").trim();
    if (isSystemUser(u)) continue;
    if (dateKey(t.timestamp) === dayKey) s.add(u);
  }
  return [...s].sort();
}

// Roster members who have logged nothing (possible non-adopters).
export function inactiveRosterUsers(txns: Transaction[], users: User[]): string[] {
  const active = new Set(txns.map((t) => (t.user || "").trim().toLowerCase()));
  return users
    .filter((u) => /true/i.test(String(u.active)) && !active.has(u.name.trim().toLowerCase()))
    .map((u) => u.name);
}
