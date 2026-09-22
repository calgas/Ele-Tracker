# ELE Tracker

A production-tracking app for the **Winding → Final QA** capacitor batch card — the 9-stage physical card used on the shop floor, digitized. Every batch is tracked under one `MasterBatchNo` as it moves through each stage, from element winding to final QA sign-off.

This is a sibling app to CALGAS CAPACITORS' **Stock Management** app, not a replacement for the broader Manufacturing Tracker (order-to-dispatch) project — ELE Tracker's scope is specifically the physical Winding-to-FQA batch card.

**Current version:** 1.2.0
**Repo:** `calgas/Ele-Tracker` · **Hosted:** https://calgas.github.io/Ele-Tracker/

---

## What changed in 1.2.0

Moved to the `calgas` account, plus correctness and reliability work found while doing so.

### Stage writes are serialized

Each stage reads the batch's `CurrentStage`, checks it, appends its row, then advances the stage. Only serial generation used to hold a lock, so two devices submitting the same stage together could both pass the check before either advanced it — and both entries got written.

Every write now runs under one script lock taken at the request boundary. Reads stay concurrent. Anything whose action name isn't `ping`, `whoami` or `get…` is treated as a write, so a future write action is locked by default rather than depending on someone remembering to list it. A write that can't get the lock within 20s answers "try again in a moment".

### Duplicate MasterBatchNo was possible

Apps Script buffers sheet writes, and nothing called `SpreadsheetApp.flush()`. The serial lock could therefore release before its counter update was committed, letting the next request read the old counter and issue a `MasterBatchNo` that already existed — on the one value every stage keys off. The lock now flushes before it releases. Rare, but it was the worst possible column for it.

### Requests can no longer hang forever

`fetch` has no timeout of its own, so on weak Wi-Fi a Save could spin indefinitely, and the natural response — reload and enter it again — duplicates the entry if the first one had in fact arrived. Requests now give up after 30s. A write that times out says *"This may already be saved — check the entries list before submitting it again"*; a read just asks you to check the connection. The 30s is deliberately above the backend's 20s lock wait, so a busy server always answers first.

When Apps Script answers with an HTML error page instead of JSON (quota, a broken deployment), operators now see a readable message with the HTTP status instead of `Unexpected token <`.

### Faster login and session checks

- The session check locates the one matching row with a `TextFinder` instead of reading Stock Management's whole `Sessions` sheet, so its cost stays flat however many sessions accumulate.
- Stock Management's spreadsheet is opened once per request rather than every time it's needed.
- The Dropdowns tab is read in a single call at login. It was several sheet calls per list, across thirty-odd lists.

### Offline copies no longer wipe each other

Both apps are served from `calgas.github.io`, and Cache Storage is shared across an origin, not per app. Each service worker was deleting every cache that wasn't its own — so every Stock Management update deleted ELE's offline copy, and vice versa. Each worker now only cleans up caches with its own prefix (`ele-tracker-shell-` here, `calgas-shell-` in Stock Management). This needed fixing in **both** apps; Stock Management 3.6.4 carries its half.

### Icons

The manifest used JPEGs, which Android can't build an adaptive icon from. It now uses Stock Management's PNG icons, including a dedicated maskable one, served from `https://calgas.github.io/Stock-Management/logo/`.

---

## Architecture

- **Database:** Google Sheets
- **Backend:** Google Apps Script, single file (`Code.gs`), bound to the ELE spreadsheet and deployed as a Web App
- **Frontend:** single-file `index.html`, hosted on GitHub Pages, installable as a PWA
- **Auth:** none of its own — see below

```
Browser (index.html)
   │  POST { action, token, ...params }
   ▼
Apps Script Web App (Code.gs)
   │  reads/writes
   ▼
Google Sheet (this app's own spreadsheet)
   │  session lookup, Users, FG_Master
   ▼
Stock Management's Sheet
```

### How sign-in is shared

Both apps live under `calgas.github.io`, so they share browser storage. Stock Management saves the session as `stock_session`; ELE reads the same key. **Signing into Stock Management signs you into ELE**, and signing out of either signs you out of both.

On the server, every ELE request is checked directly against Stock Management's `Sessions` sheet. This is deliberately uncached: Stock Management caches sessions in its own script cache and evicts on sign-out, but ELE's cache is a separate one that a sign-out there can't reach. Reading the sheet means a sign-out takes effect in ELE immediately.

---

## The 9 stages

| # | Stage | Sheet tab |
|---|-------|-----------|
| 1 | Winding | `Winding` |
| 2 | Spray & Core Cleaning | `PaperMaskingSpray` |
| 3 | Heat Stabilization | `HeatStabilization` |
| 4 | Short Clearing (+ testing rounds) | `ShortClearing`, `ShortClearing_Testing` |
| 5 | Welding / Lead Soldering | `Welding` |
| 6 | Pouring & Curing | `PouringCuring` |
| 7 | Electrical Testing & Packing | `PouringElectricalPacking` |
| 8 | BDV & Final Testing | `BDVFinalTesting` |
| 9 | Final QA | `FinalQA_Results` |

Supporting tabs: `BatchMaster` (one row per batch, holds `CurrentStage` and `Status`), `FilmLoadReadings`, `Dropdowns`, and `Code_Sequences` (the FY serial counters).

Every stage after Winding requires the batch to currently be sitting at the stage immediately before it — the app enforces the card's fixed order. Final QA submission also flips the batch's `Status` to `Complete`.

### Permissions

Admins can log every stage. Everyone else can log only the stage matching their **Department** in Stock Management's `Users` sheet. These nine names must exist in Stock Management's `Departments` tab **exactly as written** — a missing or differently-spelled one leaves that department's staff unable to log anything:

`Winding` · `Spray & Core Cleaning` · `Heat Stabilization` · `Short Clearing` · `Welding & Soldering` · `Pouring & Curing` · `Electrical Testing & Packing` · `BDV & Final Testing` · `Final QA`

---

## Setup

### 1. Spreadsheet + Apps Script

**Moving an existing sheet:** *File → Make a copy* into the account that will own the app. The bound Apps Script project comes with the copy. Triggers and deployments do not.

**Fresh install:** create a new Google Sheet, open *Extensions → Apps Script*, delete the boilerplate, paste in `Code.gs`, and run `ADMIN_setupSheet()` once from the editor. It creates every tab with headers, and is safe to re-run — it only creates tabs that don't exist yet.

Then, either way:

1. In `Code.gs`, confirm `STOCK_SHEET_ID` is Stock Management's spreadsheet ID.
2. **Deploy → New deployment → Web app.** Execute as *Me*, access *Anyone* (the app handles its own auth on top of this). Copy the `/exec` URL.
3. Check Stock Management's `Departments` tab has all nine stage names above.
4. Fill in the **Dropdowns** tab (see below).

**Updating the backend later:** use *Deploy → Manage deployments → Edit (pencil) → Version: New version*. That keeps the same `/exec` URL. Creating a *new* deployment instead issues a new URL, which `index.html` would then need.

### 2. Frontend

1. In `index.html`, set `ELE_API_URL` to the `/exec` URL, and confirm `STOCK_API_URL` points at Stock Management's deployment.
2. Host `index.html`, `manifest.json` and `sw.js` together on GitHub Pages off this repo's `main` branch.
3. Confirm `https://calgas.github.io/Stock-Management/logo/icon-192.png` loads — the icons are served from there.

### 3. Moving users from an old deployment

The old installed app keeps working against the old backend and old sheets, so anyone still using it writes to the old data and nobody notices the split. Once the new app is confirmed working, in the old account use *Manage deployments → Archive* on the old ELE deployment **and** the old Stock Management one. Old installs then fail loudly instead. Have operators uninstall the old app and install from the new URL.

### Dropdowns tab — columns to populate

Each column header names a list; put one value per row underneath.

**Machines:** `Machines_Winding`, `Machines_Spray`, `Machines_HeatStab`, `Machines_ShortClearing`, `Machines_Welding`, `Machines_PouringCuring`, `Machines_ElectricalPacking`, `Machines_BDV`

**Operators — one list per stage** (each stage has its own people, not a shared list):
`Operators_Winding`, `Operators_Spray`, `Operators_HeatStab`, `Operators_ShortClearing`, `Operators_Welding`, `Operators_PouringCuring`, `Operators_ElectricalPacking`, `Operators_BDV`, `Operators_FinalQA`

**Everything else:** `Shifts`, `FilmType`, `FreeMargin`, `Resistivity`, `CanSize`, `AssemblyDeltaWireType`, `MetalTopConnection`, `ProcessTimeOptions` (e.g. 12/10/8/6 Hrs), `CoolingTimeOptions` (e.g. 4/3/2 Hrs), `FilmUsedFor`, `FilmSupplier`, `FilmTypeShortCode`, `CustomerNames`

> `ADMIN_setupSheet()` only creates missing tabs; it never adds columns to a tab you already have. On an existing sheet, add new columns by hand. A legacy `Staff` column may still exist on older sheets — nothing reads it.

### If upgrading an existing ShortClearing tab

Add four columns for the card's separate "Retesting (If Required)" block: `RetestClearingVoltageDC`, `RetestClearingVoltageAC`, `RetestReactorBalancingMFD`, `RetestOperatorName`.

---

## Features

- **Full batch lifecycle** — create a batch at Winding (auto-generates `MasterBatchNo` as `{Machine}_{MFD}_{DD/MM/YYYY}_{FY serial}`, with the serial resetting every 1 April), log each stage in order through to Final QA.
- **Dashboard** — every batch, live stage/status, search by FG code / master batch no / date.
- **Batch report** — click any batch row for a one-screen summary of everything logged across all 9 stages.
- **Export, everywhere** — every stage table and the Dashboard has an Export button. Downloads a styled `.xlsx` via `xlsx-js-style`, falling back to plain `.csv` automatically if that library can't load.
- **Export picker** — every Export opens an Excel-filter-style checkbox list (search + select-all, default: everything selected) so you can export a subset.
- **Full batch report export** — one click from the batch report downloads a multi-sheet workbook, one tab per stage, for a single batch.
- **Copy last shift** — pre-fills a Winding shift entry from the previous one.
- **Final QA grid** — five sample columns (S1–S5) against the card's test rows.
- **Mobile-first navigation** — one stage visible at a time, with a fixed bottom tab bar on mobile and a top bar on desktop. Last-viewed stage is remembered.
- **Bottom-sheet forms on mobile**, skeleton loading states, a connection/sync indicator, and an install-to-home-screen prompt.
- **Dark / light theme**, persisted, defaults to system preference.
- **Animated splash screen** with staged loading progress on boot and sign-in.

---

## File structure

```
Code.gs        Apps Script backend — single file, sectioned:
                 CONFIG → UTILS → AUTH → WRITE LOCK → CODEGEN →
                 STAGE HELPERS → PHASE 1–5 (stage handlers) →
                 API ROUTING → SETUP
index.html     Frontend — single file, PWA
manifest.json  PWA manifest (icons served from Stock Management's Pages site)
sw.js          Service worker — app-shell caching; backend calls always network-only
```

### Deploying a frontend update

Bump the `app-version` meta tag in `index.html` and `CACHE_VERSION` in `sw.js` together, or installed clients keep serving the old shell. Currently `1.2.0` / `ele-tracker-shell-v4`.

---

## Known limitations / open items

- **Not yet built:** an offline submission queue (a stage entry needs a live connection to save), a stale-batch flag on the Dashboard, pull-to-refresh, and haptic feedback.
- **QR/barcode batch scanning** — considered and explicitly descoped, not planned.
- **Same icon as Stock Management.** With both apps installed on one phone, the home-screen icons are identical and only the label (`StockApp` / `ELETracker`) tells them apart.
- **Export styling needs `xlsx-js-style` from jsDelivr** (pinned at 1.2.0). If it can't be reached, exports fall back to unstyled CSV rather than failing. ELE only ever writes workbooks and never parses uploaded files, so the SheetJS file-reading vulnerability (CVE-2023-30533) that affected Stock Management's bulk import does not apply here.
- **Pouring & Curing is required before Electrical Testing & Packing** in the stage order as coded, even though Pouring & Curing applies to Kvar/Aircon/Oil capacitors specifically. Worth confirming against the card for other product types.
- **No automated tests in the repo.** Changes are verified by syntax checks and by logic tests run against mocked Apps Script and browser APIs during development.
