// Small shadcn-style primitives (Tailwind + tokens). Hand-rolled so there's no
// CLI step; extend freely. This is the component vocabulary the team reuses.
import { type ReactNode, useContext } from "react";
import { cn } from "@/lib/utils";
import { PrintContext } from "@/lib/print-context";

export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-surface shadow-sm", className)} onClick={onClick}>
      {children}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

export function Stat({ label, value, sub, status, onClick }: { label: string; value: ReactNode; sub?: string; status?: "ok" | "warn" | "bad"; onClick?: () => void }) {
  const print = useContext(PrintContext);
  const accent = status === "bad" ? "border-t-4 border-t-danger"
    : status === "warn" ? "border-t-4 border-t-warn"
    : status === "ok" ? "border-t-4 border-t-ok" : "";
  const valueColor = status === "bad" ? "text-danger" : status === "warn" ? "text-warn" : "";
  // In the report, click-hints are meaningless and the columns are tighter, so
  // strip the hint text, drop the click affordance, and shrink the value a touch.
  const cleanSub = print && sub ? sub.replace(/\s*·?\s*click to (filter|investigate|drill down)/i, "").trim() : sub;
  const clickable = onClick && !print;
  return (
    <Card className={cn(accent, clickable && "cursor-pointer transition hover:border-accent hover:shadow-md")} onClick={clickable ? onClick : undefined}>
      <CardBody className={cn("overflow-hidden text-center", print && "p-2")}>
        <div className={cn("text-muted", print ? "text-[11px] leading-tight" : "text-sm")}>{label}</div>
        <div className={cn("font-semibold tracking-tight break-words", print ? "mt-0.5 text-lg leading-tight" : "mt-1 text-3xl", valueColor)}>{value}</div>
        {cleanSub && <div className={cn("text-muted", print ? "mt-0.5 text-[10px] leading-tight" : "mt-1 text-xs")}>{cleanSub}</div>}
      </CardBody>
    </Card>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "ok" | "muted" | "warn" | "danger"; children: ReactNode }) {
  const tones: Record<string, string> = {
    ok: "bg-ok/10 text-ok",
    warn: "bg-warn/10 text-warn",
    danger: "bg-danger/10 text-danger",
    muted: "bg-muted/10 text-muted",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}
