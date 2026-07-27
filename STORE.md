# Chrome Web Store — listing & submission notes

## Listing
- **Name:** ETA Bulk Export
- **Category:** Productivity
- **Summary (≤132 chars):** Bulk-export your own Egyptian Tax Authority e-invoices & e-receipts to Excel/JSON, past the portal's per-search limits.
- **Description:**
  > A power tool for taxpayers and their accountants on the Egyptian Tax Authority (ETA) e-invoicing
  > portal. It downloads **your own** e-invoices and e-receipts in bulk — paginating past the portal's
  > per-search caps — and saves them as ready-to-use Excel workbooks (Arabic, RTL, with line items and
  > tax breakdowns) in a folder you choose. Your invoice/receipt content is processed on your device and
  > written only to the folder you pick. Features: year-first adaptive chunking, background-safe long runs,
  > crash-safe resume, and one-click merge of a full period into a single workbook.
  >
  > It accesses **only your own data, under your own portal session** — no username/password automation,
  > no bypass of any authentication or security control, and no scraping of other users' data. Bulk export
  > requires a free one-time registration; the contact details you enter and your tax registration number
  > are stored by the developer to manage access — see the privacy policy.

## Single purpose
Export the signed-in user's own ETA invoice/receipt data to local spreadsheet files. Every feature
(planning, downloading, merging, repairing) serves that one purpose.

## Permissions — reviewer justifications
| Manifest entry | Why it's needed |
|---|---|
| `host_permissions: https://invoicing.eta.gov.eg/*` | The content script mounts on the ETA portal (single purpose). |
| `host_permissions: https://api-portal.invoicing.eta.gov.eg/*` | Reads the user's own invoice/receipt data from the ETA API using the token the portal already stored. |
| `host_permissions: https://eta-bulk-leads.omsoliman95.workers.dev/*` | The free registration/licence backend: the extension registers once, then periodically re-checks access (lock/kill/version/allowed-RIN). Data involved is disclosed in the privacy policy. |
| content script `world: MAIN` | Needed to read the portal-origin OIDC token and call the ETA API under the page's own session — the tool cannot function otherwise. |
| File System Access (no manifest permission) | Writes exports to a folder the user explicitly picks. |
No `storage`, `downloads`, `tabs`, or broad-host permissions are requested. (The backend calls go through the background service worker, which is pinned to the exact backend origin above.)

## Policy compliance
- **Remote code:** none. Everything (app code + ExcelJS + JSZip + the ETA public code tables) is bundled
  into `dist/etaBulk.js` / `vendor/` at build time. No `eval`, no CDN, no remotely-hosted scripts.
- **User data:** the registration/account data (see the Privacy policy) is sent to the developer's
  Cloudflare backend; your invoice/receipt content is NOT — it stays on-device (ETA API + your chosen
  folder). Not sold; not transferred beyond the named processors (Cloudflare hosting/KV, Disify email check).
- **Minified code:** `dist/etaBulk.js` is esbuild-minified; the full unminified source is in `src/` and the
  bundle is reproducible via `npm ci && npm run build`. Provide the repo link / a source zip to reviewers.

## Privacy-practices tab answers  ⚠️ updated — the registration gate DOES collect data
- Collects: **YES — personally identifiable information**. The one-time registration collects **name, email,
  phone, company**, your **tax registration number (RIN)** and taxpayer legal name (read from the portal),
  and a **random device identifier**; the extension **version** is sent for the update check. The backend
  also records your **IP address and derived country**. In the Privacy tab declare **Personally identifiable
  information** (Name, Email, Phone, and the tax registration number / device id as identifiers) and
  **Location** (the server logs IP / approximate location). Purpose: **App functionality** (managed access) +
  contacting the user about the tool.
- It does **not** collect: the user's tax-document content (invoices/receipts stay on-device → ETA API +
  chosen folder), health, financial-account, authentication-credential, or web-history data.
- **Not sold**, and **not transferred** beyond the named processors (Cloudflare hosting/KV; Disify email
  validation). Not used for creditworthiness/lending.
- Because you collect data, do **not** tick the "I do not collect user data" certification — complete the
  data-collection disclosures instead and certify they are accurate.
- The privacy policy is served by the Worker at `https://eta-bulk-leads.omsoliman95.workers.dev/privacy`
  (and mirrored in `PRIVACY.md` / `privacy.html`). Link that URL in the listing's Privacy tab.

## Likely review pitfalls & mitigations
- *"Why host access to a government API?"* → the reviewer notes above + the description make clear the user
  only accesses **their own** data with their own session; no third-party data, no server.
- *`world:MAIN` content script* → justify (token + same-origin API call); it uses zero `chrome.*` APIs.
- *Minified bundle* → point to `src/` + reproducible build.

## Pre-submission checklist
- [x] Privacy policy served by the Worker at `/privacy` and mirrored in `PRIVACY.md` / `privacy.html`; contact = omsoliman95@gmail.com. **[you]** Set that support/contact email in the CWS listing and paste the `/privacy` URL into the Privacy tab.
- [x] Icons generated (`npm run icons` → amber "export" mark, 16/48/128). Swap for bespoke art later if you like.
- [x] `LICENSE` author = Omar Soliman.
- [x] `minimum_chrome_version: 111` set in `manifest.json` (MAIN-world content scripts require it).
- [x] Screenshots ready in `screenshots/`: two 1280×800 (`1-configure-plan.png`, `2-run-counter.png`) + a 440×280 promo tile, captured from `screenshot.html`, `screenshot.html#run`, and `promo.html`.
- [ ] **[you]** `npm ci && npm run build && npm run package` → upload `dist-package/eta-bulk-export-v<ver>.zip`.
- [ ] **[you]** (only if a reviewer asks about the minified bundle) `npm run package:source` → send `dist-package/eta-bulk-export-source-v<ver>.zip` (reproduces `dist` via `npm ci && npm run build`).
- [ ] **[you]** Complete the Privacy-practices tab per above; attach the reviewer notes; link the source repo.

## ⚠️ Before publishing publicly (non-Chrome legal item)
Bulk programmatic export beyond the portal's UI caps may be restricted by the **ETA terms of use**,
independent of Chrome's policies. Get your own / independent legal-compliance sign-off on automated
bulk export before listing this publicly. (This is separate from — and unaffected by — the clean-room
rebuild, which resolves the copyright concern.)
