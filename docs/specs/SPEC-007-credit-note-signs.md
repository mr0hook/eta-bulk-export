# SPEC-007 — Credit-note figures export negative (F-07)

**Feature:** F-07 · **Requirement source:** user directive 2026-08-08 ("make sure all figures for
the credit notes are negative not positive", scope clarified as *"everything, no exceptions,
without percentage columns or fx rate"*, delivery *"always on, no UI"*).

A Credit Note reverses value. Exported positive, it double-counts against the originating invoice
in every downstream sum the user builds on the sheet. Every numeric figure a credit note carries
must therefore export negative, so a plain `SUM()` over a period nets correctly.

**Requirement (AC-07):** for a document whose `documentTypeNamePrimaryLang === 'Credit Note'`,
every monetary/quantity figure on BOTH the summary and line sheets is negative, with no user
action required. Debit notes and plain invoices are untouched.

## Sign rules

| Field group | Credit Note | Other docs |
|---|---|---|
| `totalSales`, `netAmount`, `totalAmount` | negative | unchanged |
| **all** tax totals — `T1..T20` **including `T4` withholding** | negative | unchanged |
| `itemsDiscount`, `discount`, `extraDiscount` (summary) | negative | unchanged |
| `quantity`, `salesTotal`, `netTotal`, `total` (line) | negative | unchanged |
| line `valueDifference`, `discount`, `itemsDiscount` | negative | unchanged |
| `currencyTotal`, `amountSold`, `totalForeign` (FX amounts) | negative | unchanged |
| tax **rate** columns (`T1%`, `T2%`, …) | **positive** — a rate is not a figure | unchanged |
| `currencyExchangeRate` | **positive** — a rate is not a figure | unchanged |
| `unitValue` / unit price | **positive** — see below | unchanged |

**Why unit price stays positive.** `quantity × unitValue = salesTotal`. The quantity already
carries the sign, so negating the unit price too would flip the product back positive and break
the line's own arithmetic (`-5 × -100 = +500`). A unit price is a per-unit rate, the same class as
the FX rate the user excluded. Called out explicitly because the directive said "no exceptions".

**Delivery.** `negativeCredit` is forced ON at the single call site
(`src/core/orchestrator.js:82`). No checkbox, no i18n strings. The flag survives as the seam the
render tests drive both ways; it is no longer reachable from the UI.

## Defect fixed in passing

`xlsx.js:193` and `:229` read `taxType === 'T4' ? (isCreditNote ? amount : (negativeCredit ? -amount
: amount))`. With `negativeCredit` OFF (today's hardcoded value) that path is dead. **Turning the
flag on would have negated T4 withholding on every plain invoice and debit note** — corrupting
documents the user never asked to touch. No fixture covered a plain invoice carrying T4, so the
suite was blind to it. The `T4` special case is deleted outright: T4 now follows the same `sgn()`
as every other tax, so a credit note's T4 goes negative and everything else's stays untouched.

**NOT in this spec:** receipts (no credit-note concept in ETA receipt `/details` — verified,
`buildReceipts` applies no signs at all); debit notes (they *add* value — positive is correct);
PO analytics (`src/reject/po.js:180` already treats credit as `-1`, so it stays consistent).

## Test cases (before implementation — `test/signs.test.mjs`, local fixtures; do NOT touch
`test/fixtures.mjs`, parity.test pins it)

| ID | Level | Given / When / Then | Expected |
|---|---|---|---|
| T-039 | unit | credit note w/ totals + T1 + T4 → renderInvoices, `negativeCredit:true` | summary `totalSales`/`netAmount`/`totalAmount` **and** `T1` **and** `T4` all negative |
| T-040 | unit | same corpus | summary `T1%` positive (rate untouched); `currencyExchangeRate` positive |
| T-041 | unit | credit note w/ `totalItemsDiscountAmount`/`totalDiscount`/`extraDiscountAmount` | all three negative on the summary row |
| T-042 | unit | credit-note line w/ `valueDifference`/`discount`/`itemsDiscount` | all three negative on the line row |
| T-043 | unit | credit-note line: qty 5, unitValue 100, salesTotal/netTotal/total | `quantity`/`salesTotal`/`netTotal`/`total` negative, `unitValue` **positive** |
| T-044 | unit | credit note in USD w/ `currencySegments` + line FX | `currencyTotal`/`amountSold`/`totalForeign` negative, `currencyExchangeRate`/`currencySold` untouched |
| T-045 | unit | **plain invoice** carrying T4, `negativeCredit:true` (the fixed defect) | every figure positive — T4 included |
| T-046 | unit | **debit note** carrying totals + T4, `negativeCredit:true` | every figure positive |
| T-047 | integration | `createOrchestrator` export options | `negativeCredit === true` at the render call site |

`test/parity.test.mjs:94` pins the OLD rule (`T4 (withholding) keeps raw amount for a credit
note`). It is updated to assert `-10` and its title corrected — a deliberate, user-directed
behavior change, not an accidental break.

## Implementation plan

Files: `src/export/xlsx.js` (drop `w`, 6 sign sites), `src/core/orchestrator.js` (1 flag),
`test/signs.test.mjs` (new), `test/parity.test.mjs` (1 assertion). No deps, no schema change.

Slices:
1. `test/signs.test.mjs` T-039..T-047 → run → watch T-041/042/045/046/047 fail.
2. `xlsx.js`: delete `w`; `193` → `sgn(t.amount)`; `205-207` → `sgn(...)`; `229` → `sgn(t.amount)`;
   `234-236` → `sgn(...)`. `orchestrator.js:82` → `negativeCredit: true`. Update parity T4 assert.
3. Full suite green → build → commit.

## Risks & rollback
Risk: a downstream consumer sums credit notes expecting positives — none exists in-repo
(`po.js` already subtracts). Risk: merged part files from an older version mix signs in one
folder — the merge is header-driven and does not re-sign, so a folder half-exported before this
change would mix conventions; noted for the user, not code-fixable. Rollback: revert the commit.

Size: well under a day.
