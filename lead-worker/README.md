# ETA Bulk Export — lead backend + management dashboard

A Cloudflare Worker that (a) registers extension installs and enforces access **server-side** (lock / kill /
features / allowed-RINs / void / superadmin) via HMAC-signed check-ins, and (b) serves a password-protected
**dashboard** to manage users, RIN requests and bug reports. **Separate** from your license worker.

## Endpoints
Extension (CORS; `/session`, `/rin-request`, `/bug` are HMAC-signed):
| Method | Path | Purpose |
|---|---|---|
| POST | `/register` | first-time registration → binds the RIN, returns the device key |
| POST | `/session` | signed check-in → authoritative `{ allowed, reason, … }` verdict |
| POST | `/rin-request` | signed → queue "request another RIN" for admin approval |
| POST | `/bug` | signed → file a bug report |

Admin — **`Authorization: Bearer <ADMIN_TOKEN>` header only** (never `?token=`):
| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` (or `/`) | management dashboard (enter token in-page) |
| GET | `/api/stats` | summary counters for the dashboard cards |
| GET | `/api/users` · `/api/requests` · `/api/bugs` · `/api/voids` | JSON lists |
| GET | `/api/rin?rin=…` | account check: owner + every account a RIN is on + void state |
| POST | `/api/user` | `{ deviceId, action, value }` — lock/kill/super/setQuota/addRin/removeRin/setFeatures/delete |
| POST | `/api/request` · `/api/bug` · `/api/void` · `/api/config` | approve/deny · resolve/reopen/delete · void/unvoid · settings |
| GET | `/export` | CSV of users (UTF-8 BOM, Excel + Arabic safe) |

A device de-dupes on **deviceId**; a RIN can be a free user's primary only once (`rinowner:`), and voided RINs
(`void:`) are blocked for everyone. Superadmin devices bypass lock / void / allow-list on any account.

## Deploy — KV is already created, so this is 2 commands
The KV namespace `ETA_BULK_LEADS` already exists in your account and its id is wired into `wrangler.toml`.
```bash
cd lead-worker
npm install                 # gets wrangler locally
npx wrangler login          # once, opens your browser

npx wrangler secret put ADMIN_TOKEN   # type a long random string (your dashboard password)
npx wrangler deploy                   # prints your Worker URL
```
`deploy` prints the URL, e.g. `https://eta-bulk-leads.<your-subdomain>.workers.dev`.

## Wire it to the extension (fixes the "Network error")
Open `cleanroom/src/core/registration.js`, set `LEAD_URL` to that Worker URL (no trailing slash), rebuild:
```bash
cd ..
npm run build && npm run package
```
Reload the extension — registration now POSTs to your Worker and unlocks on success.

## Manage / read your leads
Open **`https://eta-bulk-leads.<your-subdomain>.workers.dev/admin`**, enter your admin token. Three tabs:
- **Users** — per user: Lock/Unlock, Kill/Revive, **Super** (works on ANY non-voided account), RIN quota,
  add/remove allowed RIN, features, delete. Plus **Void RIN** (blacklist a RIN), **Check account** (who owns a
  RIN / is it voided), a global kill switch, default quota, and CSV export.
- **RIN requests** — approve/deny users' "request another RIN" (approve adds it to their allowed list).
- **Bug reports** — resolve / delete reports filed from the tool's "🐞 Report a bug".

### Access rules enforced server-side
- A RIN can be a **free user's primary** only once — a second self-registration of it is refused (an admin can
  still *add* it to a multi-RIN account).
- **Voided** RINs can't register or run (blocked for everyone).
- **Superadmin** accounts bypass the per-RIN lock and work on any non-voided account.
- Emails are validated at registration (disposable / dead-domain rejected; `emailVerified` recorded).

## Notes
- **Durable Object `Locks`** gives *atomic* single-owner RIN claims and per-IP rate limiting (Cloudflare KV has
  no compare-and-set). It's created automatically by the `[[migrations]]` in `wrangler.toml` on your first
  `npx wrangler deploy` — **no extra step, and free on the Workers Free plan.** The code falls back to
  best-effort KV if the binding is ever missing, so the Worker still runs without it. On the first claim/read
  after deploy, each RIN's DO adopts any ownership recorded during the earlier KV-only phase (no double-claims).
- CORS is open (`*`) so the MAIN-world content script can POST directly. Tighten to
  `https://invoicing.eta.gov.eg` in `CORS['Access-Control-Allow-Origin']` if you prefer.
- **Abuse control:** `/register` is public; it caps field lengths and the per-IP rate limit (40/h) is now atomic
  via the `Locks` DO. For a public launch you can additionally add a Cloudflare **Rate Limiting** rule on `POST /register`
  (dashboard → Security → WAF) — the KV counter is best-effort only.
- **CSV safety:** the export neutralizes spreadsheet formula injection (cells starting with `= + - @` are
  quoted as text), so a malicious registration name can't execute a formula when you open the file.
- KV scales to tens of thousands of leads; the dashboard lists them all and filters client-side.
- **Privacy:** you are the data controller for these contacts. The extension shows a consent notice and
  links your privacy policy before submitting — keep that policy hosted and accurate.
