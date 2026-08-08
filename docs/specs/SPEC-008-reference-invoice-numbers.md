# SPEC-008 — Original invoice NUMBER on credit/debit notes (F-08)

**Feature:** F-08 · **Builds on:** SPEC-001 (reference UUIDs, shipped) · **Requirement source:**
user directive 2026-08-08 — "make sure credit note and debit note original invoice reference has
been added", answered scope: *"Yes — add an invoice-number column"* (resolve from the exported
corpus for free, fall back to an API lookup when the original is outside the export).

SPEC-001 already puts the referenced document's **UUID** (`الرقم المرجعي`) on both sheets. A UUID
is a 64-char hash — useless for a human reconciling a credit note against the invoice it reverses,
and useless for a `VLOOKUP` against the invoice-number column. This spec adds the original's
**invoice number** (`internalID`) beside it.

**Requirement (AC-08):** every credit/debit note that carries `references` shows, on BOTH sheets,
the internal invoice number of each referenced original — resolved without extra API traffic when
that original is already in the export, and by a bounded `/details` lookup when it is not. A
reference that cannot be resolved leaves a blank cell and never fails the chunk.

## Behaviour

| Case | Result |
|---|---|
| Original is in the same export corpus | number filled, **zero** API calls |
| Original is outside the corpus (older period, other direction) | one `/details` lookup, number filled |
| Same original referenced by N notes / across chunks | resolved **once** — run-level cache |
| Lookup fails (404, network, non-Valid) | blank cell, cached as unresolvable, chunk still succeeds |
| Note references several originals | numbers joined `', '`, same order/filter as the UUID column |
| Only some of several resolve | the resolved ones are joined; unresolved are skipped |
| No document in the export has references | neither column exists (unchanged from SPEC-001) |
| `AUTH` / `STOPPED` during a lookup | propagates — the run's existing token-renewal and pause paths must still own those |

**Column.** Key `referenceNumber`, header `رقم الفاتورة الأصلية`, width 22, placed immediately
**before** `referenceUUID` on both sheets — the human-readable number leads, the hash follows.
Sparse, like every v62 field: the column exists only when some document carries references.

**Purity.** `renderWorkbook` stays synchronous and pure. Resolution happens in the orchestrator
before the render call; the renderer receives a ready `options.refNumbers` Map (uuid → internalID)
and only reads it. Passing no Map degrades to SPEC-001 behaviour (UUID column only).

**NOT in this spec:** receipts (ETA receipt `/details` has no references concept); resolving a
reference to anything other than `internalID`; the Columns UI (sparse dynamic columns are not
offered there, same as `referenceUUID`); back-filling already-exported files.

## Test cases (before implementation — `test/refnums.test.mjs`; merge case extends
`test/merge.test.mjs`)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-049 | unit | corpus holds both the note and its original → `resolveReferenceNumbers` | number resolved, `fetchDetails` called **0** times |
| T-050 | unit | original absent from corpus | exactly **1** `fetchDetails` call; map holds uuid → its `internalID` |
| T-051 | unit | lookup throws (404/network) | resolves to unresolvable, no throw, subsequent calls do not retry it |
| T-052 | unit | same uuid referenced by 3 notes across 2 calls sharing a cache | exactly **1** `fetchDetails` call total |
| T-053 | unit | lookup throws `AUTH` (and separately `STOPPED`) | propagates to the caller — never swallowed |
| T-054 | unit | render w/ refNumbers → summary + line cols | `referenceNumber` sits immediately before `referenceUUID` on both sheets |
| T-055 | unit | note references `['A','B']`, both resolved | both sheets show `'A-1, A-2'` |
| T-056 | unit | note references `['A','B']`, only `A` resolved | both sheets show `'A-1'` (unresolved skipped, no empty separators) |
| T-057 | unit | render with **no** refNumbers Map (SPEC-001 fallback) | `referenceUUID` column present as before; no `referenceNumber` column |
| T-058 | unit | corpus where no doc has references | neither column on either sheet |
| T-059 | integration (merge) | old part file lacking `رقم الفاتورة الأصلية` + new part with it | merged sheet carries the header; old rows blank there (mirrors T-006) |

## Implementation plan

Files: `src/core/refs.js` (new, pure + injectable deps), `src/export/xlsx.js` (2 col defs +
2 row assignments), `src/core/orchestrator.js` (run-level cache + one resolve call before render),
`test/refnums.test.mjs` (new), `test/merge.test.mjs` (extend with T-059). No deps, no schema change.

Slices:
1. `test/refnums.test.mjs` T-049..T-058 → run → watch fail.
2. `src/core/refs.js`: `localNumbers(records)`, `resolveReferenceNumbers(records, deps, cache)`.
3. `xlsx.js`: insert `referenceNumber` before `referenceUUID` on both sheets; set
   `row.referenceNumber` / `lr.referenceNumber` from `options.refNumbers`.
4. `orchestrator.js`: run-level `refNumbers` Map on `opts`; resolve after the details pass, before
   `renderWorkbook`; invoices only. Full suite + build → commit.

## Risks & rollback
Risk: a large export of notes whose originals are all outside the range adds one lookup per
distinct original — bounded by `mapLimit` at the same concurrency as the details pass and cached
run-wide, so the worst case is one extra `/details` per distinct original, once. Risk: `AUTH`
raised mid-resolution must not be swallowed or the run would silently lose its renewal path —
pinned by T-053. Rollback: revert the commit; the UUID column (SPEC-001) is untouched.

Size: well under a day.
