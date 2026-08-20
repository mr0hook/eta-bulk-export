# Incident assessment — registration lockout mid-run, 2026-08-20 ~10:42 Cairo

**Severity:** High (tool unusable until an admin action) · **Data loss: NONE — verified on disk**
**Reported as:** "the tool sent me out of registration" and "the 429 WAF rate limit is a Cloudflare
problem… you made me lose one night data".

This document separates what is verified from what is still a hypothesis, because two unrelated
things happened in the same session and conflating them sends the fix in the wrong direction.

## 1. Data status — verified, not assumed

Inventory of `C:\Users\MRGho\Desktop\Amazon\Pr2\2023` taken after the lockout:

| Item | Value |
|---|---|
| Chunk workbooks | **37** |
| Detail part files | **24** |
| Total on disk | **291.6 MB** |
| Progress file | 38 planned · **37 done · 0 failed** · 254,048 rows |
| First / last write | 02:55:03 → 10:48:53 |

**Nothing was lost.** Chunk files are written to the folder as each chunk completes, and the merge
that turns them into the COMBINED deliverables is a purely local operation that never contacts the
backend. Only chunk 38 of 38 (4,753 documents) is unfinished.

Also on disk: `eta_failures.jsonl`, 3,488 entries — **3,484 FORBIDDEN, 4 NOT_FOUND**. Those are
documents ETA lists in search but refuses to serve on `/details` (~1.4% of the run). They are
spread thinly across chunks — no chunk crossed the SPEC-030 mass-403 threshold, which is why none
failed — so they read as genuine per-document permission denials, not an entity flip.

## 2. The 429s were ETA's, and they did not log anyone out

Measured directly during the run: every 429 and every timeout recorded by the live observer was on
`api-portal.invoicing.eta.gov.eg/api/v1/documents/{uuid}/details` — **ETA's own API host**. Our
backend is a different host entirely (`eta-bulk-leads.omsoliman95.workers.dev`).

More decisively, the mechanism rules it out: the extension only discards its stored credentials
when `/session` answers with the literal string `not registered` (registration.js). A 429 — from a
WAF, from Cloudflare, from anywhere — does not produce that answer and cannot trigger the wipe. And
the refusal shown on screen was **`device limit reached`**, which is a business rule in our own
worker (`/register`, `reason: device_limit`), not a rate limit.

*Caveat, stated honestly:* the page-level observer cannot see calls the extension makes to our own
backend, because those go out through the service worker. So this rules out 429s **as the cause of
the lockout** by mechanism, not by absence of evidence.

## 3. What actually happened

1. `/session` answered `not registered` for this device.
2. Per design, the client wiped `reg_creds` + `reg_verdict` so the gate would reappear rather than
   run on a stale grace verdict.
3. The gate auto-submitted a re-registration.
4. `/register` refused: **the account's device allowance was already fully held** — by a device id
   that this browser no longer had.

Step 1 has two candidate causes, and they are distinguishable:

- **(a) The device id was lost locally** and a fresh one minted, so the server legitimately did not
  know it. Supporting: the id present after the incident does not correspond to a registered
  device. Against: other `etaBulk_*` keys (including old runs') survived, so no wholesale wipe.
- **(b) The device record disappeared server-side** (admin trash, cleanup, or a storage issue), so
  a correct id was told it was unknown.

**Discriminating test (needs the admin token — only the owner can run it):** open `/admin`, find
the account, and list its devices with their ids and creation times. If the held device id is old
and this browser's id is new → (a). If the account holds no device at all, or one that vanished →
(b).

## 4. The real defect, fixed either way

Whichever of (a)/(b) applies, the design was fragile in two ways, both now closed (SPEC-033,
v0.11.2):

- **Identity lived only in the portal's own localStorage** — storage the portal owns and may clear
  at any re-authentication. It is now mirrored into `chrome.storage.local`, which belongs to the
  extension and no page action can touch, and localStorage is treated as a cache restored from it.
- **Losing credentials used to mint a NEW device id**, spending another slot off the allowance —
  the exact path into "device limit reached". The device id is now never regenerated while the
  mirror holds one, and the `not registered` path clears the *credentials* while deliberately
  keeping the id, so re-registration is always the "returning device" case the server never
  refuses.

Regression tests T-271..T-273 pin this, including a test that literally wipes the page storage and
asserts the same device id returns.

## 5. Recovery plan for this run

1. **Merge now.** It is local and needs no backend. This produces the COMBINED deliverables from
   all 37 completed chunks — ~250,000 of the 254,048 documents.
2. **Unblock the gate** in `/admin`: either raise this account's device allowance by one, or delete
   the stale device record. Then press *Register & unlock*.
3. **Finish the last chunk.** Server-side jobs are device-scoped, so a new device id cannot resume
   the old job. Use *Sync new since last run*, or a small date-range export covering chunk 38's
   window, then merge again — merge deduplicates by UUID, so overlap is harmless.
4. **The 3,484 forbidden documents:** *⟳ Load failed UUIDs* → Start will retry them. Expect most to
   remain forbidden; they appear to be documents this account genuinely cannot read.

## 6. Follow-ups worth doing

- Surface the lockout better: "device limit reached" inside a registration form gives no hint that
  an existing device holds the slot, or that the fix is an admin action. It should name the held
  devices and link the admin remedy.
- Consider whether a free-plan allowance of **one device** is right for an owner-operated tool where
  a browser can legitimately lose its identity; a small allowance with self-service device
  replacement would have made this a non-event.
- The `/session` `not registered` path should log the device id it was refused for, so (a) vs (b)
  is answerable from the run log alone next time.
