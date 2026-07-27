# Privacy Policy — ETA Bulk Export

_Last updated: 11 July 2026. Data controller: Omar Soliman._

> The canonical, always-current version of this policy is served by the backend at
> `https://eta-bulk-leads.omsoliman95.workers.dev/privacy` (the same URL the extension's registration
> consent links to). This file mirrors it.

ETA Bulk Export bulk-exports **your own** Egyptian Tax Authority (ETA) e-invoices and e-receipts to
Excel/JSON. There are **two independent data flows** — read both.

## 1. Your invoice & receipt data — stays on your device (not sent to us)
When you use the tool on `https://invoicing.eta.gov.eg`, it:
- reads the OIDC access token the ETA portal already stored in your browser (`localStorage.USER_DATA`),
- uses it to call the ETA API (`https://api-portal.invoicing.eta.gov.eg`) to download **your own**
  e-invoices / e-receipts (the same data the portal shows you), and
- writes the resulting Excel/JSON files to a folder **you** pick.

This invoice/receipt content is attached only to requests to `api-portal.invoicing.eta.gov.eg` (enforced by
an origin check in code) and written only to your chosen local folder. **It is never transmitted to the
developer, to the backend described below, or to any third party.**

## 2. Registration & account data — sent to the backend
Bulk export requires a free, one-time registration. Registration and the ongoing licence checks send the
following to the developer's backend at `https://eta-bulk-leads.omsoliman95.workers.dev` (hosted on
Cloudflare):

| When | Data | Why |
|------|------|-----|
| On registration | Name, email, phone, company (typed by you); your **tax registration number (RIN)** and **taxpayer legal name** (read automatically from the ETA portal); a random device identifier; the extension version. | Create your account, bind it to your RIN, and let the operator contact you about the tool. |
| Automatically by the server | Your **IP address** and derived **country** (via Cloudflare); the result of an email-deliverability check (via a third-party service, Disify). | Abuse prevention (rate limiting) and rejecting invalid/disposable emails. |
| On each licence check-in | Your **RIN** and extension version are re-sent periodically. | Enforce access controls: lock, disable, require a newer version, or block a voided RIN. |
| If you submit a bug report | The **message you type** and your browser's **user-agent**. | Diagnose and fix the issue. |

## How your data is used
Registration data is used to provide managed access, enforce the access controls above, and contact you
about the tool. It is **not sold**. It is processed only by the operator and the named service providers
(Cloudflare for hosting/storage; Disify for email validation).

## What is stored on your device
- `localStorage` — export run state (which chunks are done) so you can resume; your registration
  credentials (device id + a per-device key + the last licence verdict).
- `IndexedDB` — a handle to the output folder you granted, so it can be reused.
- The exported files — in the folder you chose.

## Retention
Account records are kept until you request deletion or the operator removes the account. Administrative
action logs auto-expire after 180 days; anti-abuse counters expire within hours.

## Permissions and why
- **Host access to `invoicing.eta.gov.eg` and `api-portal.invoicing.eta.gov.eg`** — to run on the portal
  and read your invoice/receipt data from the ETA API.
- **Host access to `eta-bulk-leads.omsoliman95.workers.dev`** — the registration/licence backend described
  in section 2.
- The output-folder picker uses the File System Access API (explicit selection each time; no separate
  permission entry).

## Your choices & rights
Registration is required only for bulk export. You can stop using the extension and request access to,
correction of, or deletion of your data at any time by emailing the developer at omsoliman95@gmail.com.
Uninstalling stops all further data collection.

## Contact
Omar Soliman (data controller) — omsoliman95@gmail.com
