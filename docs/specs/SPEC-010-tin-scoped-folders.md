# SPEC-010 — TIN-scoped export folders (F-11)

**Feature:** F-11 · **Requirement source:** user directive 2026-08-08 — *"if i download the userdata
into a folder the folder should contain tin for that company so if we select different company on
the same folder it doesn't break"*, refined to: *"it should give warning that this already contain
data for another company and he should pick different folder"*.

## Diagnosis

The tool already knows which taxpayer is logged in — `taxpayerId()` (`registration.js:70`) reads
`USER_DATA.profile.TaxRin` and is used by the licensing gate. **Nothing in the file layer uses it.**

- `runKey(source, year, dir, field, from, to)` (`store.js:8`) — no TIN.
- `chunkFile(plan, chunk)` (`store.js:16`) — no TIN. The filter signature hashes date-field and
  statuses only.
- `progressName(plan)` derives from `plan.key`, i.e. from `runKey` — so no TIN either.
- `mergeFolder` globs `/^e(Invoices|Receipts)_.*\.xlsx$/i` (`merge.js:21`) — no owner filter.

So two companies running the same query into one folder produce **byte-identical filenames**. The
damage is not a clash; it is silent and it looks like success:

1. `scanDoneFromFolder` (`store.js:49`) decides which chunks are already downloaded **purely by
   filename presence**, and `resume()` folds that straight into `doneIds`
   (`orchestrator.js:286`).
2. Company B, resuming in Company A's folder, therefore finds A's files, concludes those chunks
   are done, and **never fetches them**.
3. B's export then contains **A's invoices**. `readProgress(dir)` with no plan compounds it: it
   picks the most-recently-updated `eta_progress*.json` in the folder (`store.js:39-48`), which
   may be the other company's — so Sync derives its date range from a stranger's run.
4. Merge blends both companies into one COMBINED set.

Nothing errors. The user gets a plausible workbook containing another company's tax data.

**Requirement (AC-10):** it must be impossible to write one company's export data into a folder
already holding another's, and the refusal must name the owning company rather than failing
obscurely.

## Design

### The stamp

A single small file claims the folder:

```json
{ "v": 1, "rin": "123456789", "company": "شركة ...", "claimedAt": "2026-08-08T14:00:00.000Z" }
```

`eta_folder.json` — same folder-authoritative convention as `eta_progress_*.json`. `company` is
advisory (from `taxpayerName()`, may be blank); **`rin` alone is authoritative.**

### The guard

One choke point: `ensureDir()` (`orchestrator.js:295`). Every path that writes — plan, start,
resume, sync, merge, repair — already funnels through it or through `dir()` after it. The guard
must live *there* and not in `pickFolder()`, because `drawer.js:943` restores the last folder from
IndexedDB via `setFolder()` on mount, which never touches `pickFolder()`. Verified once per folder
handle and cached, so a long run does not re-read the stamp on every write.

| Folder state | Behaviour |
|---|---|
| Stamp `rin` === logged-in TIN | Proceed |
| Stamp `rin` !== logged-in TIN | **Blocked.** Message names the owning company + TIN. |
| No stamp, no export files present | Claim silently — a fresh folder |
| No stamp, export files present | One-time confirmation, then claim |

A mismatch is a **hard block with no override**: the only way forward is a different folder. This
is deliberate — an override checkbox on a data-integrity guard is a checkbox that gets clicked.

### The legacy folder

Existing folders have no stamp, and this is exactly the case where contamination may *already*
have happened, so the tool must not guess. It asks once, through the existing in-drawer prompt:

> This folder already contains exported data, but no company stamp.
> Confirm it belongs to **{company} (TIN {rin})** — or pick a different folder.

Confirm → stamped, never asked again. Decline → treated as a mismatch, pick another folder.

**Rejected alternative:** inferring the owner from the `الرقم الضريبى للبائع` column of an existing
export. It works for a Sent folder but inverts for Received (the owner is the *receiver*), and
returns a confidently wrong answer on a folder that is already mixed. A question answered once
beats a guess that is silently wrong.

### What does NOT change

Filenames, `runKey`, `chunkFile`, and progress-file names are **untouched**. Because the folder is
now single-company by construction, putting the TIN in filenames would buy nothing — and it would
cost a migration in which every pre-existing file stops matching `chunkFile()`, making
`scanDoneFromFolder` report zero chunks done and **silently re-downloading entire folders**. Files
are never renamed either; renaming thousands of handles through the FSA API risks real data loss
for no benefit.

### Unknown TIN

`taxpayerId()` returns `'unknown'` only when `USER_DATA` is missing or unparseable — which also
means there is no bearer token, so a run cannot start regardless. `verify()` returns a third
verdict, `unverified`, and the two callers treat it differently by design:

- **`start()` / `resume()` / `sync` treat `unverified` as blocked** — no run writes files into a
  folder whose ownership could not be checked.
- **`mergeFolder` treats it as proceed-with-warning** on an *already-stamped* folder — merge reads
  files the user already has and writes only derived output, and it must stay usable while logged
  out. It logs that the owner could not be verified.

An unknown TIN never claims an unstamped folder in either case.

**NOT in this spec:** run-log persistence (next feature); incremental merge; per-TIN subfolders;
migrating or renaming existing files; anything touching the licensing RIN gate, which is a
separate concern that happens to read the same value.

## Test cases (before implementation — `test/folder.test.mjs`; fake dir, no browser)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-076 | unit | empty folder, TIN `A` → `claim()` | `eta_folder.json` written with `rin: 'A'`, `v: 1` |
| T-077 | unit | folder stamped `A`, logged in as `A` | `verify()` → ok; no write (stamp not rewritten) |
| T-078 | unit | folder stamped `A`, logged in as `B` | `verify()` → blocked; reason names `A` + its company |
| T-079 | unit | no stamp, folder contains `eInvoices_*.xlsx` | `verify()` → `needsConfirm`, does **not** auto-claim |
| T-080 | unit | needsConfirm → user confirms | stamp written for current TIN; second call → ok |
| T-081 | unit | needsConfirm → user declines | blocked; **no** stamp written |
| T-082 | unit | stamp file is corrupt / not JSON / `v` unknown | treated as no stamp — never throws, never auto-claims over data |
| T-083 | unit | TIN is `'unknown'`, folder stamped `A` | `verify()` → `unverified` (not `ok`, not `blocked`); no stamp written |
| T-083b | unit | TIN is `'unknown'`, folder unstamped with data | `verify()` → `unverified`; still **no** auto-claim |
| T-084 | integration | `orchestrator.js` source | `ensureDir` calls the guard; `setFolder` restore path cannot bypass it |
| T-085 | integration | guard blocks | **nothing** was written to the folder — asserted on the fake dir's file map |

T-085 is the load-bearing one: the block must happen *before* any write, not after.

## Implementation plan

Files: `src/core/folder.js` (new — `readStamp` / `claim` / `verify`, all deps injected),
`src/core/orchestrator.js` (guard in `ensureDir`, refuse unknown TIN in `start`), `src/ui/drawer.js`
(wire the existing in-drawer confirm; surface the block message), `src/core/i18n.js` (~6 keys ×
EN/AR), `test/folder.test.mjs` (new). No deps, no manifest change, no permission change.

Slices:
1. `test/folder.test.mjs` T-076..T-083 → run → watch fail.
2. `folder.js` (pure, injected clock + `taxpayerId`).
3. `orchestrator.js` guard + T-084/T-085.
4. `drawer.js` confirm wiring + i18n. Full suite + build → commit.

## Risks & rollback

Risk: a user who legitimately shares one folder across two companies is now blocked — accepted,
that is the requested behaviour and the data says it was never safe. Risk: the one-time
confirmation is answered wrongly on an already-mixed legacy folder, stamping it for the wrong
company — the prompt names the company explicitly to make that hard, and deleting
`eta_folder.json` re-triggers it. Risk: a user deletes the stamp and reuses the folder for another
company — re-prompted, because export files are present. **Not fixed by this spec:** folders
already contaminated by the bug; this prevents new contamination and cannot detect past
contamination (see the rejected auto-detect above). Rollback: revert the commit — the stamp file
is inert and ignored by every other code path.

Size: well under a day.
