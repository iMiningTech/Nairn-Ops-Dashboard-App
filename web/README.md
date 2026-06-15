# Nairn Det Plant — Inventory Operations Dashboard

A read-only reporting dashboard over the **Nairn Det Plant Inventory Labels**
Google Sheet (the BlastStock scanner app's data layer). Same stack/look as the
iMining Kansanshi dashboard: **Next.js (static export) · React · TypeScript ·
Tailwind · Recharts · lucide-react**, hosted as a static site on **S3 +
CloudFront**. It only ever **reads** — all writes happen through the scanner app.

## The one idea
The UI only ever calls a typed data client — [`lib/api.ts`](lib/api.ts) — that
returns well-shaped JSON. **The UI never knows where that JSON comes from.**
Today that's Google Sheets; later it's AWS, and the migration is a *backend swap,
not a rebuild* — re-point `NEXT_PUBLIC_API_BASE` at an AWS API returning the same
shapes and nothing in the UI changes.

## Data modes
Set in `.env.local` (copy from `.env.local.example`):

| `NEXT_PUBLIC_DATA_MODE` | What it does | Backend needed |
|---|---|---|
| _(blank)_ / `gviz` | Reads the published Sheet tabs as CSV directly in the browser. Great for `npm run dev` — live data, nothing deployed. No pool-flow aggregation. | None |
| `appsscript` | Calls the Apps Script Web App (`NEXT_PUBLIC_API_BASE` = its `/exec` URL), which returns JSON already in the contract shape. **Use this for the deployed site.** | [`../apps-script/nairn_dashboard_api.gs`](../apps-script/nairn_dashboard_api.gs) |

## Run locally
```bash
cp .env.local.example .env.local   # optional; blank works (gviz against live sheet)
npm install
npm run dev                         # http://localhost:3000
```

## Views (Milestones 1–2)
- **Stock on Hand** — filter by type / status / location, search, KPI tiles,
  qty-by-type donut, qty-by-location bars, table with negative-qty highlighting,
  CSV export.
- **Pool Dashboard** — discrepancy banner, current pool quantities (red = negative
  discrepancy), net in/out (Apps Script mode), kitchen-TV layout. Add `?tv=1` to
  the URL for the 3-metre kitchen-TV view (Pool, no chrome, larger fonts,
  auto-refresh every 60s).

Future milestones (Movement history, Destruction records, Reconciliation, User
activity) plug in as new views + new `api.ts` actions — see the project summary
in the repo root.

## Deploy (S3 + CloudFront)
1. Deploy the Apps Script (see its header) and set in `.env.local`:
   `NEXT_PUBLIC_DATA_MODE=appsscript` and `NEXT_PUBLIC_API_BASE=<exec URL>`.
2. Set `NEXT_PUBLIC_SITE_TZ` (confirm the plant's timezone) and, to gate access,
   `NEXT_PUBLIC_ACCESS_HASH` (`echo -n 'pw' | shasum -a 256 | cut -d" " -f1`).
3. `AWS_PROFILE=imining-dev ../hosting/deploy.sh` — builds, ensures the stack,
   syncs `out/` to S3, invalidates CloudFront, prints the URL.

> The access gate is a soft, client-side password (stops casual link sharing).
> It is **not** a hard security boundary — for that, gate the data API itself
> (set `API_TOKEN` in the Apps Script + `NEXT_PUBLIC_API_TOKEN` here).
