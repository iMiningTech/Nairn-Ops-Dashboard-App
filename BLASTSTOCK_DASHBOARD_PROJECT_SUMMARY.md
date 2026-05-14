# BlastStock Dashboard — Project Workflow Summary

> **For Claude Code / new developers:** This document introduces the BlastStock Dashboard project. The dashboard is a **separate application** from the BlastStock scanner app — it reads from the same Google Sheets data layer but is its own codebase, hosted independently, and has its own purpose. This summary explains what the dashboard does, where its data comes from, and how to think about it.

---

## What is this project?

A **read-only reporting dashboard** that visualises inventory data produced by the BlastStock scanner app at Nairn Det Plant. The scanner app is what operators use day-to-day on Urovo handheld devices to log inventory movements. This dashboard is what management uses to see the resulting picture: stock levels, movement history, NDT destruction records, discrepancy flags, reconciliation status.

The dashboard does **not write to inventory data**. It only reads. All writes happen through the scanner app's flows.

---

## Where the data lives

The single source of truth is a Google Sheet:

**`Nairn Det Plant Inventory Labels`** — main spreadsheet with multiple tabs.

Key tabs the dashboard will read from:

| Tab | Contents | What it's used for |
|---|---|---|
| `Inventory_Master` | One row per inventory item (box, pool, or NDT batch) — current state, location, quantity, status | Stock-on-hand views, location maps |
| `Transaction_Log` | Append-only log of every change — who, what, when, why, correlation IDs | Movement history, audit reports, reconciliation |
| `NDT_Batch_Contents` | Line items inside each NDT batch — what was destroyed and when | Destruction reports, T1 range compliance |
| `Pool_Trigger_Locations` | List of locations where pool auto-sync fires | Filter logic for pool views |
| `Locations` | Active locations | Dropdown values, location-based grouping |
| `User_Management` | Users + auth levels | Activity by user reports |
| `Reasons` | Active transaction reasons | Categorical filters |
| `Assembly_Recipes` | NDT assembly BOM definitions | Reconstructing assembly groupings in reports |
| `NDT_Item_Types` | NDT line item types + units | Unit-aware aggregation (units vs metres) |

The data model is documented in detail in `BLASTSTOCK_CONTEXT.md`, `BLASTSTOCK_POOLS_DESIGN.md`, `BLASTSTOCK_NDT_BATCHES_DESIGN.md`, and `BLASTSTOCK_NDT_ASSEMBLIES_ADDENDUM.md`. Read those for full schema details.

---

## How the dashboard accesses the data

Three plausible paths, in order of recommendation:

### Option A (recommended): Apps Script Web App with read-only endpoints

Extend the existing Apps Script (`inventory_master_sync.gs`) with new read-only endpoints purpose-built for the dashboard:

- `?action=stockOnHand` — current stock summary, optionally filtered by location/type
- `?action=movementHistory&qr=XXX` — full transaction history for one item
- `?action=destructionReport&from=YYYY-MM-DD&to=YYYY-MM-DD` — all destroyed batches in date range, expanded to line items
- `?action=reconciliationSummary&room=ComponentRoom` — net in/out per pool, flagged discrepancies
- `?action=negativeFlags` — all pool rows where Current_Quantity < 0
- `?action=userActivity&user=XXX&from=...&to=...` — what a given user has done

The dashboard calls these endpoints via fetch. Same pattern as the scanner app — no new auth layer needed.

**Pros:** Reuses existing infrastructure, no separate database, always reads live data, no sync delay.

**Cons:** Apps Script has execution time limits (~6 min per call). For very large queries this might need pagination or pre-aggregation.

### Option B: Direct read via Google Sheets API

The dashboard backend (or frontend, with proper auth) reads sheet data directly using Google's Sheets API.

**Pros:** Maximum flexibility — read any cell at any time. Faster for large datasets than going through Apps Script.

**Cons:** Authentication is more involved (OAuth or service account), and the dashboard now depends on raw sheet structure rather than a stable API surface. If sheet layout changes, dashboard breaks.

### Option C: Materialised view in a real database

Replicate the sheet data to a proper database (DynamoDB, Postgres, etc) on a schedule, then build the dashboard on top of that database.

**Pros:** Best for complex queries, joins, large data volumes, BI tooling. Insulates the dashboard from sheet changes.

**Cons:** Adds operational complexity. Premature for current data volumes (~2,000 inventory items, dozens of transactions per day).

**Recommendation: start with Option A.** Migrate to C later if/when the data outgrows it.

---

## What the dashboard should display

These are the primary views the business needs. Prioritise based on what management actually asks for.

### 1. Stock-on-hand snapshot

The "what do we have right now" view. Should support:
- Filter by `Type` (RAW_MATERIAL / FINISHED_GOOD / POOL / NDT_BATCH)
- Filter by `Current_Location`
- Sort by quantity, last updated, description
- Visual highlight on negative pool quantities (red banner — these are discrepancy flags)
- Quick stats at the top: total items, total locations, count of flagged items

### 2. Pool dashboard

Specifically for pools — these are the high-volume in/out aggregates that operations cares most about.

- Current quantity per pool
- Net in/out today, this week, this month
- A "Discrepancies" tile showing all pools with negative quantities
- Drill-down: click a pool, see its full transaction history including paired box-side transactions

This is the screen that goes on the kitchen TV. Make it readable at 3 metres.

### 3. Movement history (audit view)

- Searchable transaction log
- Filter by date range, user, reason, item type, location
- Each row shows full context: timestamp, what changed, who, why, correlation ID
- Correlation IDs are clickable — click to see all paired transactions

### 4. Destruction records

- All NDT batches and their statuses (Active / To Be Destroyed / Destroyed)
- For Destroyed batches: destruction date, destroyer, full contents list
- Group assembly line items by `Assembly_Group_Id`
- Filter by date range for compliance reporting (T1 range submissions)
- Exportable to CSV/PDF for paperwork

### 5. Reconciliation view (the holy grail)

Each room is self-balancing. This view shows the balance for each room:

```
Component Room (this week):
  Total IN  (boxes from magazines):           1,540 units across 12 boxes
  Total OUT (trays to production):            1,200 units
  Total OUT (defects to NDT):                    35 units
  Net change:                                  +305 units
  Pool current vs calculated:                  matches ✓
```

When the calculated vs actual doesn't match, the view flags it loudly. This is what surfaces "someone didn't scan properly" in a way an operator can actually act on.

### 6. User activity report

- Transactions per user per day
- Most active users, most recent activity
- Useful for spotting training issues ("X user only ever uses 'Stock Correction' reason — they don't understand the reasons list")

---

## Technical recommendations

### Frontend stack

The scanner app is React + Vite. If you want consistency, keep the dashboard on the same stack. Other reasonable choices: Next.js (more out-of-the-box for SSR/auth), or even just a static HTML page with charts if simplicity matters more than polish.

Charting library: Recharts (already familiar in React ecosystem), Chart.js, or Plotly. For a kitchen-TV display, big numbers and simple bars trump fancy interactivity.

### Backend

If using Option A, the backend IS the Apps Script. No separate backend needed.

If using Option B or C, decide based on hosting preference. Netlify Functions / Vercel Functions / AWS Lambda all work fine for a read-only API.

### Hosting

Netlify drag-and-drop works for the scanner app and would work here too. If you want a permanent URL with a path you control, use the same Netlify account.

For AWS hosting later, S3 + CloudFront is simpler than Amplify for static dashboards.

### Auth

For a kitchen TV display: probably no auth needed — it's read-only and lives on a screen in a private facility.

For mobile/desktop access to detailed views: at minimum reuse the existing PIN auth flow (`?action=login` against `User_Management`). Cleaner long-term: proper SSO via Cognito or similar.

### Refresh strategy

- For kitchen TV display: auto-refresh every 60 seconds, no user interaction
- For interactive views: explicit refresh button + auto-refresh on page focus
- Don't poll aggressively — Apps Script has rate limits and the data doesn't change that fast

---

## What this project is NOT

To keep scope tight, the dashboard explicitly does **not**:

- Write any data back to the sheet (use the scanner app for that)
- Replace the scanner app for any operational workflow
- Need to support the Urovo handheld — assume a normal browser on desktop, tablet, or kitchen TV
- Handle BarTender integration, label printing, or any data ingest — that's all upstream

---

## Suggested initial milestones

**Milestone 1: Stock-on-hand view**
- Reads `Inventory_Master` via a new Apps Script endpoint
- Filterable table by Type and Location
- Top-line stats: total items, flagged items, last update timestamp
- Deploys to a public URL (Netlify drag-drop)

**Milestone 2: Pool dashboard with discrepancy flags**
- Dedicated pool view with current quantities
- Red banner for any negative pool
- Drill-down to transaction history
- Suitable for kitchen TV display (large fonts, auto-refresh)

**Milestone 3: Destruction records view**
- All NDT batches grouped by status
- Date-range filter
- Expandable batch contents with assembly groupings
- Export to CSV

**Milestone 4: Reconciliation view**
- Per-room in/out calculations
- Compare calculated vs actual pool quantities
- Flag mismatches

**Milestone 5: Movement history / audit**
- Full transaction log search
- Correlation ID navigation
- User activity report

Don't try to build all five at once. Milestone 1 alone delivers most of the value.

---

## How to start

1. Read the BlastStock project context files in this order:
   - `BLASTSTOCK_CONTEXT.md` (project overview)
   - `BLASTSTOCK_POOLS_DESIGN.md` (pool concept)
   - `BLASTSTOCK_NDT_BATCHES_DESIGN.md` (NDT batch concept)
   - `BLASTSTOCK_NDT_ASSEMBLIES_ADDENDUM.md` (assembly decomposition)
   - `inventory_master_sync.gs` (the existing Apps Script — for endpoint conventions)
2. Decide data access strategy (recommended: Option A, Apps Script endpoints)
3. Spike Milestone 1 first — stock-on-hand view as a static read
4. Iterate from there based on what management actually asks for next

---

## Open questions for Justin

To be answered before deciding architecture in depth:

- Where will the dashboard live? Kitchen TV only, or also accessible via phone/laptop?
- Will the dashboard need its own auth, or is it OK as an open URL (read-only data, internal network)?
- Are there specific reports the team is already producing manually that the dashboard should replace?
- Any timing constraints (end of month, audit deadline) that should prioritise certain views?

---

*This is a living document. Update freely as the project takes shape.*
