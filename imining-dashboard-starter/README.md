# iMining Dashboard Starter

A portable extraction of the Kansanshi MMU Operations dashboard — the **design system,
report/print engine, access gate, and hosting** — so you can stand up a new dashboard
with the same look, layout, and stack, then plug in different data (Google Sheets now,
AWS later) **without touching the UI**.

Stack: Next.js (app router, static export) · React · TypeScript · Tailwind · Recharts ·
lucide-react. Hosted as a static site on S3 + CloudFront.

---

## The one idea that makes porting easy
The UI only ever consumes a **typed data client** (`web/lib/api.ts`) that returns
well-shaped JSON. **The UI never knows where that JSON comes from.** So:

- Today: implement `api.ts` against **Google Sheets**.
- Later: re-implement *only the backend behind `api.ts`* against **AWS** — the entire
  UI, charts, reports, and hosting stay byte-for-byte the same.

Keep that boundary sacred (no data fetching or business logic inside components) and the
Sheets→AWS migration is a backend swap, not a rebuild.

---

## What's drop-in vs what you rewrite

**Drop-in (copy as-is — project-agnostic):**
- `web/components/charts.tsx` — chart + card library (BarH, BarV, StackedBar, Donut,
  AreaTrend, DataTable, ResponsibilityBar, HourHeatmap, ChartCard). **`PRINT_CHART_W`**
  near the top is the pinned report chart width (only relevant if you add PDF reports —
  see notes).
- `web/components/ui.tsx` — primitives (Card, CardBody, Stat, Badge).
- `web/lib/utils.ts` — `cn()` + `fmtTime()` (timestamps render in a fixed timezone;
  change `Africa/Lusaka` to your site's tz).
- `web/lib/print-context.ts` — print/report flag context.
- `web/app/globals.css` — brand tokens (navy/orange CSS variables) + report/print styles.
- `web/app/layout.tsx` — app shell.
- `web/lib/colors.ts` — **brand tokens + palette are generic; the activity/responsibility
  colour maps are Orica-specific** — replace those with your own categories.
- `hosting/` — S3 + CloudFront static hosting (generic; works for any static export).
- config: `package.json`, `next.config.mjs`, `tailwind.config.ts`, `tsconfig.json`,
  `postcss.config.mjs`.

**Rewrite per project (these are the Orica versions — use as a working reference):**
- `web/lib/api.ts` — the typed client + data shapes. **This is your data contract.**
  Replace the calls/types with your project's data. (Generic helpers in `web/lib/data.ts`
  like `uniqueSorted`, `groupSum`, `groupCount`, `pivot` are reusable; the domain
  filters are examples.)
- `web/app/page.tsx` — holds all the views + the `PrintReport` and `AccessGate`
  scaffolding. The **scaffolding is reusable** (keep `PrintReport`, `AccessGate`); the
  **views are Orica-specific** — rebuild them from the chart/ui primitives with your data.

---

## Stand up the new project (steps)
1. Copy `web/` into your new repo. `cd web && npm install && npm run dev`.
2. **Re-skin the brand** (optional — keep iMining or swap): edit the CSS variables in
   `app/globals.css` and the tokens in `lib/colors.ts`; drop your customer logo into
   `public/` and reference it where the views/report header use `/orica_logo.png`.
3. **Define your data contract** in `lib/api.ts`: the TypeScript shapes the UI consumes.
4. **Implement `api.ts` against Google Sheets** (see below).
5. **Rebuild the views** in `app/page.tsx` from the primitives — copy the patterns in the
   reference views (a `ChartCard` wrapping a `BarV`/`Donut`/etc., `Stat` tiles in a grid).
   Keep `PrintReport` + `AccessGate` as-is.
6. Deploy with `hosting/deploy.sh` (set the bucket/stack names inside first).

## Wiring Google Sheets (the data layer)
Goal: expose your sheet as **JSON in the shape `api.ts` expects**, so the AWS swap later
only changes the backend. Cleanest options, simplest first:
- **Google Apps Script Web App** (recommended for a static front-end): a few lines that
  read the sheet and `return ContentService.createTextOutput(JSON.stringify(rows))`.
  Deploy as a web app → you get a URL → point `api.ts` at it. Free, no keys in the client.
- **Published sheet → CSV/JSON**: quickest but least control over shape.
- **Sheets API v4 via a small serverless function**: if you need auth/shaping server-side.

Whatever you pick, have it return the **same JSON contract** your `api.ts` types declare.
When you migrate to AWS, you re-point `api.ts` at the AWS API returning that same shape —
nothing else changes.

## Notes / gotchas carried over
- **PDF reports** (optional): the report engine lives in `PrintReport` + the `.report-*`
  styles + the print branches in the chart components. It's driven by visiting
  `?print=1&tabs=…&kind=…`. If you add it, the render service (headless-Chrome → PDF) is
  in the Orica `Jotform-AWS-API/render` stack and points at any `SITE_BASE`. **Gotcha:**
  `PRINT_CHART_W` in `charts.tsx` is a fixed px chart width coupled to the render
  viewport — Recharts auto-measure is unreliable in the headless renderer. Measure a PDF
  and set it; don't rely on `ResponsiveContainer` for print.
- **Access gate:** `AccessGate` in `page.tsx` is a soft password gate; set
  `NEXT_PUBLIC_ACCESS_HASH` (SHA-256 of the password) in `.env.local` to enable it.
- **Timezone:** `fmtTime` pins display to one timezone (site time), never the viewer's.
- **Design rules** to keep: one brand colour on categorical bars (orange only on the
  actionable outlier), reserve red for genuine exceptions, status-aware tiles, sentence-case
  titles, collapse single-bar charts to a centred stat. (Full rationale was captured in the
  Orica repo's `docs/DESIGN_GUIDE.md`.)

---
_Extracted from the Orica/Kansanshi MMU dashboard. The included `app/page.tsx`,
`lib/api.ts`, and `lib/data.ts` are the live Orica implementation — kept as a reference
for how the pieces fit; replace them with your project's data + views._
