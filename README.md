# ETA Bulk Export

Bulk-export **your own** Egyptian Tax Authority (ETA) e-invoices and e-receipts to Excel/JSON,
paginating past the portal's per-search caps (10,000/search for invoices, ~3,000 page-based for
receipts). Runs entirely on-device; sends your existing portal session token only to the ETA API;
writes files only to a folder you pick.

## Clean-room
Original work — **contains no code from the "Egypt ETA PDF Tool" (© Ahmed Abouelela)** and no
activation/subscription gate. The Excel export is reimplemented from scratch on MIT-licensed ExcelJS;
the tax/unit/currency code tables are the Tax Authority's public SDK data. See `NOTICE`.

## Layout
```
manifest.json          MV3, MAIN-world content script, both ETA hosts
vendor/exceljs.min.js  ExcelJS (MIT), unmodified
assets/codes/          ETA SDK code tables (public reference data), inlined at build
src/                   source modules (core / api / export / ui)
  main.js              entry (mounts the drawer)
build.mjs              esbuild bundle → dist/etaBulk.js (no remote code)
icons/                 own icons + generator
test/                  node parity tests + fixtures
```

## Develop
```
npm install            # esbuild (dev dep) only
npm run icons          # (re)generate placeholder icons
npm run build          # or: npm run build --dev   (unminified + sourcemap)
npm test               # node parity tests
```
Then load `cleanroom/` unpacked at `chrome://extensions` and open the portal.

## Status — feature-complete (M0–M6)
Scaffold · from-scratch export module (parity-tested) · orchestrator (own run loop, no base globals) ·
Shadow-DOM drawer · streaming merge + illegal-char repair · hardening (429 Retry-After backoff,
proactive token pre-expiry pause, dropped-detail reconciliation with a durable `eta_failures.jsonl`,
folder-authoritative resume, keep-alive) · per-chunk progress bar · removable-columns UI · official
signed-PDF download (`documents|receipts/{uuid}/pdf` → `pdfs/`) · CWS packaging + reviewer source zip.
48 automated tests (export parity, chunker coverage, API client, token, store, and end-to-end run-loop
robustness incl. PDF), TZ-pinned CI. Loads clean under the portal CSP. Remaining before public listing
(all **your** steps): host the privacy policy, capture is done (`screenshots/`), and get your own legal
read on ETA terms (see `STORE.md`).

### Official PDF
The **Official ETA PDF per document** toggle downloads each document's genuine signed PDF from the ETA
API (`GET {apiBase}/documents/{uuid}/pdf` and `…/receipts/{uuid}/pdf`, Bearer session token, same origin
as the JSON API) into a `pdfs/` subfolder. Supplementary to the xlsx; failures are logged to
`eta_failures.jsonl` and never fail the chunk. One PDF per document — narrow the date range for a
targeted set rather than pulling PDFs for a whole huge year.

Note: exports always use `combineAll: true` (one summary sheet + one line-items sheet). The base tool's
per-document-sheet mode (`combineAll: false`) is intentionally not used — bulk export of tens of thousands
of documents into one-sheet-each is not viable in a single workbook.

## Permissions (why)
- `host_permissions` for `invoicing.eta.gov.eg` + `api-portal.invoicing.eta.gov.eg` — the content
  script mounts on the portal and reads your invoice/receipt data from the ETA API using the token
  the portal already stored for you. Your invoice/receipt **content** never leaves your machine except
  those same ETA API calls.
- `host_permissions` for `eta-bulk-leads.omsoliman95.workers.dev` — the free registration/licence backend.
  Bulk export requires a one-time registration; the contact details you enter, your tax registration number
  and taxpayer name, a device id and the extension version are sent there (and your RIN + version on each
  licence check-in) so the operator can manage access. See `PRIVACY.md` / the hosted `/privacy` policy.
- File System Access (folder picker) needs no permission entry.
