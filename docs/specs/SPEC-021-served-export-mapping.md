# SPEC-021 — Served export mapping (column definitions from the worker)

> Feature F-21 · Phase: BUILD · Depends on: SPEC-015 (worker split), SPEC-016 (signed extension calls)
> Goal: the xlsx sheet names and column definitions are served by the backend to authorised
> installations, with a bundled fallback that keeps every export correct offline.

## What moves

`src/export/xlsx.js` held two literal tables, `INV` and `RCP`: sheet names plus
`[key, header, width]` tuples. Pure data, compiled into the extension.

| Stays on the device | Now served by the worker |
|---|---|
| Every invoice/receipt ROW, every value in it | Sheet names |
| All dynamic columns (tax types, FX, discounts, references, customs) | Base column list: key, header, width, order |
| Rendering, writing, merging | The revision + hash that dates a mapping |

Crossing the wire, in both directions: a source name (`invoices` / `receipts`), a content hash, the
device's RIN and version — the same fields `/session` already carries. **No invoice content.** The
mapping is column metadata; it does not depend on and cannot reveal a single document.

## The endpoint

```
POST /export/mapping   signed (HMAC, same scheme as /plan/start)
  { source, have?, rin, version }
    → 200 { ok, source, revision, hash, mapping:{ key, summarySheet, lineSheet, summary[], lines[] } }
    → 200 { ok, source, revision, hash, unchanged:true }        when have === hash
    → 400 unknown source · 401 unsigned/unknown device · 403 not allowed · 429 rate limit
```

Entitlement is `computeVerdict()` — the identical gate `/plan/start` uses, deliberately not a second
copy of the rules (SPEC-016 states why). A locked, killed, expired or void-RIN device gets 403 and no
mapping. Rate limit 240/device/hour: one call per export run, so the ceiling only bites a loop.

Implementation: `lead-worker/src/mapping.js` (the data + `MAPPING_REVISION`),
`lead-worker/src/routes/exportmap.js` (the route), wired in `worker.js` after `planRoutes`.

## Versioning, and how a stale cache is detected

Two independent markers travel with every mapping:

- **`revision`** — a monotone integer, bumped in the same commit on both sides. Says which
  *generation*.
- **`hash`** — sha-256 of a canonically-ordered serialisation, first 128 bits. Says which exact
  *bytes*. The client sends the hash it holds as `have`; a match costs a small `unchanged:true`
  reply instead of the whole table, and re-stamps the cache's freshness.

The client cache is `{ revision, hash, at, mapping }` in localStorage per source. It is rejected —
and the bundled mapping used — when it is missing, unparseable, `revision < BUNDLED_REVISION` (this
build is newer than the cache), undated, dated in the future, older than `MAX_AGE_MS` (30 days), or
fails validation. `mappingStatus()` names which of those happened, and the run log says so.

## Which behaviour is authoritative

- The **bundled** mapping (`src/export/mapping.js`) is authoritative for **correctness**. It is a
  complete, working mapping, not a degraded subset. With no network, no account and no cache, the
  export is byte-for-byte what it always was. This is why a failed fetch is allowed to be quiet.
- The **served** mapping is authoritative for **currency**. Reachable + authorised + `revision >=`
  the build's → its headers, widths and order win.

The rule when they disagree is one-directional and enforced client-side by `validateMapping()`:
**rename, re-width, re-order and add freely; never remove.** A served mapping missing any bundled
key is rejected whole and not cached. Removing a column silently discards data the user already paid
(in time and portal quota) to fetch — that decision belongs in a build, not a KV edit.

Validation is all-or-nothing: there is no "use the good half". A partially-applied mapping is
precisely the silent corruption this design exists to prevent.

## Client flow

```
start(plan) → refreshMapping(source)      once per run, before the first sheet
                ├ ok + valid + current → cached; every chunk of the run uses it
                ├ unchanged            → cache re-stamped
                └ unreachable/refused  → last valid cache while in date, else bundled
                                          run log: orch.mapCached / orch.mapBundled (warn)
renderWorkbook() → mappingFor(source)     synchronous, un-memoised, never partial
```

`refreshMapping()` never throws. The plan, by contrast, hard-requires the server (SPEC-016) — the
asymmetry is deliberate: without a plan there is nothing to export, whereas without a fresh mapping
there is a correct export with last month's headers.

## What this does and does not achieve against a fork

**Does:** the endpoint is signed and entitlement-checked, so an unauthorised build gets 401/403.
From the day headers next change, only authorised installations follow; every fork drifts and stays
drifted, visibly, in the file the user opens.

**Does not:** the bundled mapping must stay complete for offline users, so a fork that ships today's
extension exports correctly today. Column headers are also visible in any exported file, so this is
not secrecy. The mapping raises the *maintenance* cost of a fork; the planner (SPEC-016) is what
raises its *capability* cost, because its answers are data-dependent and cannot be replayed.

## Tests

| ID | Test |
|---|---|
| T-195 | unsigned `/export/mapping` → 401 (not a public asset) |
| T-196 | unknown source → 400, never a default mapping |
| T-197 | a signed, entitled device gets sheets, columns, revision and a 128-bit hash; structural keys present |
| T-198 | each source has its own mapping and its own hash |
| T-199 | the hash is stable; `have` match → `unchanged` with no table; a stale `have` → full table |
| T-200 | at equal revisions the served and bundled mappings are byte-identical |
| T-201 | whatever the worker serves passes the client's own validator |
| T-202 | a locked device gets 403 and no mapping — the planner's gate, not a second one |
| client | `test/mapping.test.mjs` — bundled completeness; validation (rename/add allowed, drop refused, 12 malformed payloads); `chooseMapping` over all 8 rejection reasons; render honours a cached mapping and falls back on a corrupt/holed/expired one; `removableColumns` still hides index/details/uuid; `refreshMapping` caches, re-stamps, survives an unreachable server and a thrown transport, and refuses to cache a holed or backdated mapping |
