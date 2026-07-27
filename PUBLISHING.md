# Publishing to the Chrome Web Store — step-by-step

Target: **Unlisted** listing under **Omar Soliman (personal)** developer account.
Everything below is prepared; the steps marked **[you]** need your account/login and can't be automated.

---

## 0. Asset inventory (all ready in `cleanroom/`)
| CWS field | File | Notes |
|---|---|---|
| Package (upload) | `dist-package/eta-bulk-export-v0.3.0.zip` | 11 files, no dev/source. Rebuild with `npm run package`. |
| Store icon 128×128 | `icons/icon128.png` | inside the zip. Placeholder art — replace for a nicer listing. |
| Screenshot 1 (1280×800) | open `screenshot.html` → capture | Configure + Plan view |
| Screenshot 2 (1280×800) | open `screenshot.html#run` → capture | Run view with the live counter |
| Small promo tile 440×280 | open `promo.html` → capture | optional but recommended |
| Privacy policy URL | served by the Worker at `/privacy` (see step 1) | required |
| Description / summary | copy from **§3** below | |

To capture screenshots: open the HTML file in Chrome, set the window to ~1280×800 (or use DevTools device
toolbar at 1280×800), and screenshot. The pages auto-populate a realistic demo state.

---

## 1. Privacy policy URL  **[you]**
CWS requires a public URL. **It's already hosted by your Worker** at
`https://eta-bulk-leads.omsoliman95.workers.dev/privacy` (the `GET /privacy` route serves the policy, and the
extension's consent link points there). Just deploy the Worker (`npx wrangler deploy`) and use that URL.
`privacy.html` / `PRIVACY.md` in the repo mirror the same text if you prefer to host a copy elsewhere.

## 2. Chrome Web Store developer account  **[you]**
- Go to the **Chrome Web Store Developer Dashboard**, sign in with your Google account.
- Pay the **one-time US$5** registration fee (if not already registered).
- Verify your email/publisher contact.

## 3. Create the item & fill the listing  **[you]**
Dashboard → **Add new item** → upload `eta-bulk-export-v0.3.0.zip`. Then fill:

- **Name:** `ETA Bulk Export`
- **Summary (≤132):** `Bulk-export your own Egyptian Tax Authority e-invoices & e-receipts to Excel/JSON, past the portal's per-search limits.`
- **Category:** Productivity
- **Language:** English (add Arabic if you localize later)
- **Description:**
  ```
  A power tool for taxpayers and their accountants on the Egyptian Tax Authority (ETA) e-invoicing portal.
  It downloads your own e-invoices and e-receipts in bulk — paginating past the portal's per-search caps —
  and saves them as ready-to-use Excel workbooks (Arabic, RTL, with line items and tax breakdowns) in a
  folder you choose.

  • Invoices and receipts, any year, filtered by status/direction/date.
  • Year-first adaptive chunking so nothing is missed past the 10,000/search (invoices) and page (receipts) caps.
  • Live "invoices fetched" counter and progress.
  • Background-safe long runs and crash-safe resume — pick up exactly where you stopped.
  • One-click merge of a whole period into a single workbook; repair tool for damaged files.

  Your invoice/receipt content is processed on your device: read only from the ETA API you're already
  signed into, and written only to the folder you pick. Bulk export requires a free one-time registration;
  the contact details you enter and your tax registration number are stored by the developer to manage
  access (see the privacy policy).
  ```
- **Screenshots:** upload the two 1280×800 captures.
- **Small promo tile:** upload the 440×280 capture (optional).

## 4. Privacy practices tab  **[you]**
- **Single purpose:** `Export the signed-in user's own ETA invoice/receipt data to local spreadsheet files.`
- **Permission justifications:**
  - `host_permissions invoicing.eta.gov.eg` → *Content script mounts on the ETA portal (single purpose).*
  - `host_permissions api-portal.invoicing.eta.gov.eg` → *Reads the user's own invoice/receipt data from the ETA API using the token the portal already stored.*
  - `host_permissions eta-bulk-leads.omsoliman95.workers.dev` → *Free registration/licence backend: the extension registers once, then re-checks access (lock/kill/version/allowed-RIN). See the privacy policy for the data.*
  - *(If asked about the MAIN-world content script:)* *Required to read the portal-origin session token and call the ETA API under the page's own session; uses no chrome.* APIs.*
- **Data usage:** you **do** collect registration data — declare **Personally identifiable information**
  (Name, Email, Phone; plus the **tax registration number** and a **device id** as identifiers) and
  **Location** (the backend logs **IP / approximate location**). Purpose: app functionality (managed access) +
  contacting the user. Not sold; processed only by Cloudflare (hosting/KV) and Disify (email validation). The
  user's tax-document content is **not** collected (stays on-device → ETA API + chosen folder). Do not tick the
  "I don't collect user data" certification.
- **Privacy policy URL:** paste `https://eta-bulk-leads.omsoliman95.workers.dev/privacy` (from step 1).
- Certify the disclosures.

## 5. Distribution / visibility  **[you]**
- **Visibility: Unlisted** (installable by link, not shown in search/browse).
- Distribution: All regions (or restrict as you prefer).

## 6. Submit for review  **[you]**
- Submit. First reviews typically take a few hours to a few business days.
- If they ask for source (minified bundle), point them to the repo / provide a source zip; the build is
  reproducible via `npm ci && npm run build`.

---

## Before you submit — reminders
- **Placeholders already filled:** `LICENSE` author = Omar Soliman; privacy policy served by the Worker at `/privacy` and mirrored in `PRIVACY.md`/`privacy.html`; contact = omsoliman95@gmail.com. Set that support email in the CWS listing too.
- **Replace the placeholder icons** (`icons/gen-icons.mjs` generates simple ones) with final art for a nicer listing.
- **ETA Terms of Service:** automated bulk export past the UI caps may be restricted by ETA's own terms,
  independent of Chrome's policies. Even unlisted, you're distributing it. Get your own/independent legal read
  before sharing widely. (This is separate from — and unaffected by — the clean-room rebuild that resolved the
  copyright issue.)
