"use client";

import { useContext } from "react";
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, Legend,
  CartesianGrid, PieChart, Pie, AreaChart, Area, LabelList, ReferenceLine,
} from "recharts";
import { Card, CardBody } from "@/components/ui";
import { MASTER_PALETTE, BRAND_NAVY, BRAND_ORANGE, RESPONSIBILITY_COLOURS } from "@/lib/colors";
import { PrintContext } from "@/lib/print-context";

// Re-exported so existing imports `from "@/components/charts"` keep working.
// True inside the report/print layout → charts use tighter margins.
export { PrintContext };

const AXIS = { fontSize: 12, fill: "rgb(100 116 130)" };
const GRID = "rgb(224 230 235)";
// Explicit chart width in the report (print). ResponsiveContainer's runtime
// auto-measure is unreliable in the headless PDF renderer (it grabs a partial
// width, leaving the chart small and left-of-centre), so we pin a deterministic
// px width and the chart fills its card every render. This value is MEASURED from
// the actual PDF: at the render service's 1240px viewport the report content is
// ~182mm wide ≈ 1074px, minus the card's 32px padding ≈ 1042px of chart space.
// NOTE: this is tied to the render viewport (1240px). If render/index.mjs's
// defaultViewport width changes, re-measure and update this number.
const PRINT_CHART_W = 1040;
const chartW = (print: boolean) => (print ? PRINT_CHART_W : "100%");

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardBody>
        <div className="mb-1 text-sm font-semibold text-fg">{title}</div>
        {subtitle && <div className="mb-3 text-xs text-muted">{subtitle}</div>}
        {children}
      </CardBody>
    </Card>
  );
}

// Horizontal bar, one row per category. Default `accent` mode: one brand navy
// with the single largest (actionable) bar in orange + inline values — colour
// only carries meaning where it must. Pass a colorMap to keep encoded colour
// (e.g. RAG compliance), which overrides accent.
export function BarH({ data, colorMap, height = 360, xLabel, yLabel, accent = true, onSelect }:
  { data: { name: string; value: number }[]; colorMap?: Record<string, string>; height?: number; xLabel?: string; yLabel?: string; accent?: boolean; onSelect?: (name: string) => void }) {
  if (!data.length) return <Empty />;
  const handleClick = onSelect ? ((entry: { name?: string }) => { if (entry?.name) onSelect(entry.name); }) : undefined;
  // A single category is a stat, not a chart — a full-width lone bar reads oddly.
  // Centre it in the widget area so it looks intentional.
  if (data.length === 1) {
    return (
      <div style={{ height }} className="flex flex-col items-center justify-center gap-1 text-center">
        <span className="text-sm text-muted">{data[0].name}</span>
        <span className="text-4xl font-semibold tracking-tight text-fg">{data[0].value}</span>
        {xLabel && <span className="text-xs text-muted">{xLabel.toLowerCase()}</span>}
      </div>
    );
  }
  const print = useContext(PrintContext);
  const useAccent = accent && !colorMap;
  const maxV = Math.max(...data.map((d) => d.value));
  const fillOf = (d: { name: string; value: number }, i: number) =>
    colorMap ? (colorMap[d.name] || MASTER_PALETTE[i % MASTER_PALETTE.length])
    : useAccent ? (d.value === maxV ? BRAND_ORANGE : BRAND_NAVY)
    : MASTER_PALETTE[i % MASTER_PALETTE.length];
  return (
    <div style={{ width: chartW(print), minWidth: 0, height }} className={onSelect ? "cursor-pointer" : undefined}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: print ? (yLabel ? 8 : 2) : (yLabel ? 24 : 16), right: useAccent ? 34 : 16, bottom: xLabel ? 18 : 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={AXIS} label={xLabel ? { value: xLabel, position: "insideBottom", offset: -8, ...AXIS } : undefined} />
          <YAxis type="category" dataKey="name" width={print ? 104 : 150} tick={AXIS}
                 label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", style: { textAnchor: "middle" }, ...AXIS } : undefined} />
          <Tooltip />
          <Bar dataKey="value" radius={[0, 5, 5, 0]} onClick={handleClick as never}>
            {data.map((d, i) => <Cell key={i} fill={fillOf(d, i)} />)}
            {useAccent && <LabelList dataKey="value" position="right" fontSize={11} fill="rgb(31 41 55)" />}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Vertical bar, one column per category (e.g. by date), with axis labels.
// `barLabels` maps name → a short status word drawn vertically inside the bar.
// `target` reframes as performance-vs-target: a dashed line + green only when a
// bar beats target (neutral navy otherwise) — so normal days don't read as alarms.
// Otherwise `accent` mode highlights the single largest bar in orange.
export function BarV({ data, colorMap, height = 360, xLabel, yLabel, barLabels, accent = true, target, targetLabel, onSelect }:
  { data: { name: string; value: number }[]; colorMap?: Record<string, string>; height?: number; xLabel?: string; yLabel?: string; barLabels?: Record<string, string>; accent?: boolean; target?: number; targetLabel?: string; onSelect?: (name: string) => void }) {
  if (!data.length) return <Empty />;
  // A single column (e.g. one date selected) is a stat, not a chart — centre it.
  // Labelled variants (daily shift-quality) keep their bar; target charts show
  // the target alongside the value.
  if (data.length === 1 && !barLabels) {
    return (
      <div style={{ height }} className="flex flex-col items-center justify-center gap-1 text-center">
        <span className="text-sm text-muted">{data[0].name}</span>
        <span className="text-4xl font-semibold tracking-tight text-fg">{data[0].value}</span>
        {yLabel && <span className="text-xs text-muted">{yLabel.toLowerCase()}{target != null ? ` · target ${target}` : ""}</span>}
      </div>
    );
  }
  const print = useContext(PrintContext);
  const useAccent = accent && !colorMap && target == null;
  const handleClick = onSelect ? ((entry: { name?: string }) => { if (entry?.name) onSelect(entry.name); }) : undefined;
  const maxV = Math.max(...data.map((d) => d.value));
  const fillOf = (d: { name: string; value: number }, i: number) =>
    target != null ? (d.value >= target ? "#59A14F" : BRAND_NAVY)
    : colorMap ? (colorMap[d.name] || MASTER_PALETTE[i % MASTER_PALETTE.length])
    : useAccent ? (d.value === maxV ? BRAND_ORANGE : BRAND_NAVY)
    : MASTER_PALETTE[i % MASTER_PALETTE.length];
  const showValues = useAccent || target != null;
  const renderText = (p: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: string | number }) => {
    const x = Number(p.x) || 0, y = Number(p.y) || 0, width = Number(p.width) || 0, h = Number(p.height) || 0;
    const txt = barLabels?.[String(p.value)];
    if (!txt || width <= 0 || h < 28) return null;
    const cx = x + width / 2, cy = y + h / 2;
    return (
      <text x={cx} y={cy} transform={`rotate(-90 ${cx} ${cy})`} textAnchor="middle"
            dominantBaseline="central" fontSize={11} fontWeight={600} fill="#fff">{txt}</text>
    );
  };
  return (
    <div style={{ width: chartW(print), minWidth: 0, height }} className={onSelect ? "cursor-pointer" : undefined}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: print ? (yLabel ? 10 : 4) : (yLabel ? 24 : 16), right: target != null ? 92 : 16, top: showValues ? 16 : 0, bottom: xLabel ? 18 : 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis type="category" dataKey="name" tick={AXIS}
                 label={xLabel ? { value: xLabel, position: "insideBottom", offset: -8, ...AXIS } : undefined} />
          <YAxis type="number" allowDecimals={false} tick={AXIS}
                 label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", style: { textAnchor: "middle" }, ...AXIS } : undefined} />
          <Tooltip />
          {target != null && (
            <ReferenceLine y={target} stroke={BRAND_ORANGE} strokeDasharray="5 4"
              label={{ value: targetLabel || `target ${target}`, position: "right", fontSize: 11, fill: BRAND_ORANGE }} />
          )}
          <Bar dataKey="value" radius={[5, 5, 0, 0]} onClick={handleClick as never}>
            {data.map((d, i) => <Cell key={i} fill={fillOf(d, i)} />)}
            {barLabels && <LabelList dataKey="name" content={renderText as never} />}
            {showValues && !barLabels && <LabelList dataKey="value" position="top" fontSize={11} fill="rgb(31 41 55)" />}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Stacked/grouped vertical bar. rows: [{ x, [series]: number }]. series with colours.
// `onSelect` makes a column clickable → returns its x-axis category.
export function StackedBar({ rows, xKey, series, colorMap, height = 420, stacked = true, xLabel, yLabel, onSelect }:
  { rows: Record<string, unknown>[]; xKey: string; series: string[]; colorMap: Record<string, string>; height?: number; stacked?: boolean; xLabel?: string; yLabel?: string; onSelect?: (x: string) => void }) {
  if (!rows.length) return <Empty />;
  const print = useContext(PrintContext);
  // Chart-level click → activeLabel is the x-axis category of the clicked column
  // (reliable for stacked bars; a per-segment Bar onClick returns segment data).
  const handleClick = onSelect ? ((state: { activeLabel?: string | number }) => {
    if (state?.activeLabel != null) onSelect(String(state.activeLabel));
  }) : undefined;
  return (
    <div style={{ width: chartW(print), minWidth: 0, height }} className={onSelect ? "cursor-pointer" : undefined}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ left: print ? (yLabel ? 8 : 4) : (yLabel ? 16 : 8), right: print ? 36 : 12, bottom: xLabel ? 44 : 0 }} onClick={handleClick as never}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis dataKey={xKey} tick={AXIS}
                 label={xLabel ? { value: xLabel, position: "insideBottom", offset: -2, ...AXIS } : undefined} />
          <YAxis tick={AXIS}
                 label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", style: { textAnchor: "middle" }, ...AXIS } : undefined} />
          <Tooltip />
          <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
          {series.map((s, i) => (
            <Bar key={s} dataKey={s} stackId={stacked ? "a" : undefined}
                 fill={colorMap[s] || MASTER_PALETTE[i % MASTER_PALETTE.length]} radius={stacked ? 0 : [4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const RAD = Math.PI / 180;
const LABEL_MIN = 0.07; // only slices ≥7% get a leader line + label; rest via hover/legend

// Custom label: draws the leader line AND the text together, so small slices
// render nothing at all (no dangling lines). Bigger slices get "Name %".
function donutLabel(p: {
  cx?: number; cy?: number; midAngle?: number; outerRadius?: number; percent?: number; name?: string;
}) {
  const { cx = 0, cy = 0, midAngle = 0, outerRadius = 0, percent = 0, name = "" } = p;
  if (percent < LABEL_MIN) return null;
  const cos = Math.cos(-midAngle * RAD), sin = Math.sin(-midAngle * RAD);
  const sx = cx + outerRadius * cos, sy = cy + outerRadius * sin;          // slice edge
  const mx = cx + (outerRadius + 16) * cos, my = cy + (outerRadius + 16) * sin; // elbow
  const right = cos >= 0;
  const ex = mx + (right ? 16 : -16), ey = my;
  return (
    <g>
      <path d={`M${sx},${sy}L${mx},${my}L${ex},${ey}`} stroke="rgb(160 170 180)" strokeWidth={1} fill="none" />
      <circle cx={sx} cy={sy} r={2} fill="rgb(160 170 180)" />
      <text x={ex + (right ? 4 : -4)} y={ey} textAnchor={right ? "start" : "end"} dominantBaseline="central"
            fontSize={11} fill="rgb(31 41 55)">
        {`${name} ${Math.round(percent * 100)}%`}
      </text>
    </g>
  );
}

// In print, draw the % INSIDE each slice (centroid) — clip-safe, so the pie gets
// real labels on the page. Slices under 5% stay clean (read via the legend).
function donutInsideLabel(p: { cx?: number; cy?: number; midAngle?: number; innerRadius?: number; outerRadius?: number; percent?: number }) {
  const { cx = 0, cy = 0, midAngle = 0, innerRadius = 0, outerRadius = 0, percent = 0 } = p;
  if (percent < 0.05) return null;
  const r = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + r * Math.cos(-midAngle * RAD), y = cy + r * Math.sin(-midAngle * RAD);
  return (
    <text x={x} y={y} fill="#fff" fontSize={10} fontWeight={700} textAnchor="middle" dominantBaseline="central">
      {Math.round(percent * 100)}%
    </text>
  );
}

// Wrapping legend: items flow across multiple centered lines and never run off the
// right edge (the default inline legend clips when there are many segments).
function DonutLegend(props: { payload?: { value?: string; color?: string }[] }) {
  const items = props.payload || [];
  return (
    <ul style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "2px 12px", margin: 0, padding: "2px 8px", listStyle: "none", fontSize: 11, lineHeight: 1.4 }}>
      {items.map((e, i) => (
        <li key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", color: "rgb(31 41 55)" }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: e.color, display: "inline-block", flexShrink: 0 }} />
          {e.value}
        </li>
      ))}
    </ul>
  );
}

export function Donut({ data, colorMap, height = 380 }:
  { data: { name: string; value: number }[]; colorMap?: Record<string, string>; height?: number }) {
  const print = useContext(PrintContext);
  if (!data.length) return <Empty />;
  const colorOf = (name: string, i: number) => colorMap?.[name] || MASTER_PALETTE[i % MASTER_PALETTE.length];
  // Print: shorter container + larger pie removes the big vertical dead space.
  const h = print ? 250 : height;
  return (
    <div style={{ width: chartW(print), height: h, margin: "0 auto" }}>
      <ResponsiveContainer>
        <PieChart margin={{ top: 4, right: 10, bottom: 4, left: 10 }}>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="38%" outerRadius={print ? "72%" : "60%"}
               paddingAngle={1} labelLine={false} label={print ? donutInsideLabel : donutLabel} isAnimationActive={!print}>
            {data.map((d, i) => <Cell key={i} fill={colorOf(d.name, i)} />)}
          </Pie>
          <Tooltip formatter={(v, n) => [v as number, n as string]} />
          <Legend content={DonutLegend as never} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AreaTrend({ rows, xKey, series, colorMap, height = 320 }:
  { rows: Record<string, unknown>[]; xKey: string; series: string[]; colorMap: Record<string, string>; height?: number }) {
  const print = useContext(PrintContext);
  if (!rows.length) return <Empty />;
  return (
    <div style={{ width: chartW(print), minWidth: 0, height }}>
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ left: 8, right: print ? 36 : 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis dataKey={xKey} tick={AXIS} />
          <YAxis tick={AXIS} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Area key={s} type="monotone" dataKey={s} stackId="a"
                  stroke={colorMap[s] || MASTER_PALETTE[i % MASTER_PALETTE.length]}
                  fill={colorMap[s] || MASTER_PALETTE[i % MASTER_PALETTE.length]} fillOpacity={0.7} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DataTable({ columns, rows, csvName }:
  { columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; csvName?: string }) {
  const print = useContext(PrintContext);
  // Right-align purely numeric columns (counts, durations, %) — dates/times/text
  // stay left. Detected from the data so callers don't have to annotate.
  const numericCols = new Set(
    columns.filter((c) => {
      let hasNum = false;
      for (const r of rows) {
        const v = r[c.key];
        if (v == null || v === "" || v === "—") continue;
        if (typeof v === "number") { hasNum = true; continue; }
        const s = String(v).replace(/[,%\s]/g, "");
        if (s !== "" && !isNaN(Number(s))) hasNum = true; else return false;
      }
      return hasNum;
    }).map((c) => c.key)
  );
  const cls = (key: string) => `${print ? "px-2 py-1 whitespace-nowrap" : "px-3 py-2"} ${numericCols.has(key) ? "text-right tabular-nums" : ""}`;
  function downloadCsv() {
    const header = columns.map((c) => `"${c.label}"`).join(",");
    const body = rows.map((r) => columns.map((c) => `"${String(r[c.key] ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = csvName || "export.csv"; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div>
      <div className={print ? "rounded-xl border border-border" : "max-h-80 overflow-auto rounded-xl border border-border"}>
        <table className={`w-full ${print ? "text-[11px]" : "text-sm"}`}>
          <thead className="sticky top-0 bg-bg text-left text-xs uppercase tracking-wide text-muted">
            <tr>{columns.map((c) => <th key={c.key} className={`${cls(c.key)} font-medium`}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-muted">No records.</td></tr>
            ) : rows.map((r, i) => (
              <tr key={i} className="border-t border-border hover:bg-bg/60">
                {columns.map((c) => <td key={c.key} className={cls(c.key)}>{String(r[c.key] ?? "—")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {csvName && rows.length > 0 && !print && (
        <button onClick={downloadCsv} className="mt-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs hover:bg-bg">
          ⬇ Download CSV
        </button>
      )}
    </div>
  );
}

// Single full-width stacked bar: every logged hour bucketed by responsibility.
// One bar, one argument — the "Waiting on mine" band is the client exhibit.
export function ResponsibilityBar({ segments }:
  { segments: { name: string; hours: number; pct: number }[] }) {
  if (!segments.length) return <Empty />;
  return (
    <div>
      <div className="flex h-12 w-full overflow-hidden rounded-lg border border-border">
        {segments.map((s) => (
          <div key={s.name} title={`${s.name}: ${s.hours.toFixed(1)}h (${s.pct}%)`}
               className="flex items-center justify-center text-xs font-semibold text-white"
               style={{ width: `${s.pct}%`, background: RESPONSIBILITY_COLOURS[s.name] || "#BAB0AC" }}>
            {s.pct >= 7 ? `${s.pct}%` : ""}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RESPONSIBILITY_COLOURS[s.name] || "#BAB0AC" }} />
            {s.name} <span className="text-muted">{s.pct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function rgba(hex: string, a: number) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Hour-of-day × category heatmap. Each row coloured by its category colour,
// cell opacity scaled to its value vs the grid max. Shows the site's rhythm.
export function HourHeatmap({ rows, colors, unit = "h" }:
  { rows: { label: string; values: number[] }[]; colors: Record<string, string>; unit?: string }) {
  if (!rows.length) return <Empty />;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[660px]">
        <div className="flex">
          <div className="w-32 shrink-0" />
          {hours.map((h) => <div key={h} className="flex-1 text-center text-[9px] text-muted">{h % 3 === 0 ? h : ""}</div>)}
        </div>
        {rows.map((r) => {
          const rmax = Math.max(1, ...r.values);  // per-row intensity: each row shows its own pattern
          return (
            <div key={r.label} className="mt-0.5 flex items-center">
              <div className="w-32 shrink-0 truncate pr-2 text-right text-xs text-muted">{r.label}</div>
              {r.values.map((v, h) => (
                <div key={h} className="flex-1 px-[1px]">
                  <div title={`${r.label} · ${String(h).padStart(2, "0")}:00 · ${v % 1 ? v.toFixed(1) : v}${unit}`}
                    className="h-6 rounded-sm"
                    style={{ background: v > 0 ? rgba(colors[r.label] || "#4E79A7", 0.18 + 0.82 * (v / rmax)) : "rgb(241 245 249)" }} />
                </div>
              ))}
            </div>
          );
        })}
        <div className="mt-1 flex"><div className="w-32 shrink-0" /><div className="flex-1 text-[9px] text-muted">hour of day →</div></div>
      </div>
    </div>
  );
}

function Empty() {
  return <div className="py-12 text-center text-sm text-muted">No data for the current filters.</div>;
}
