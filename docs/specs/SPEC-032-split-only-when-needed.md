# SPEC-032 — Split a chunk's details only when it genuinely outgrows one file

**Status:** BUILT · 2026-08-20 · ships as v0.11.1 (fix → patch) · corrects SPEC-029's file layout
**Driver:** user question — "why do you split detail rows if they don't exceed 1M rows in one Excel
file?" Correct challenge: SPEC-029 opened a NEW part file per 2,000-document batch, so restoring
10k chunks meant an ordinary chunk landed as five files even when its details were a few thousand
rows. Batching exists for MEMORY; it must not decide file layout.

## The three limits, kept straight

- **Excel's 1,048,576-row sheet limit** — applies to the DELIVERABLE. The merge output already
  rolls at `mergeout.ROW_CAP = 1,000,000`, so the files the user opens do use the full limit.
- **Chunk files are intermediate** — merge reads them back and produces those deliverables.
- **The real bound on a chunk file is the READ-BACK**: merge Phase 1 loads each one through
  ExcelJS (needed for fidelity, header union and dedup), which F-10 measured at ~9.5KB heap/row —
  72k rows peaks ~950MB and passes, 90k OOMs. Hence `PART_ROW_CAP = 60,000`, and hence a part
  cannot simply be raised to a million rows without first making merge read parts by streaming.

## Change

`createDetailSink` replaces per-batch part writing. Line rows are held in memory while the chunk
may still fit in one file (`CHUNK_LINES_INLINE_MAX = 30,000`, tens of MB of plain objects):

- Chunk finishes under the budget → `{ mode: 'inline' }`: ONE workbook with real line rows, byte
  for byte what a pre-batching run produced — whatever the document count or batch count.
- Chunk crosses it → the held rows flush to part 1 and the rest streams, rolling only at
  `PART_ROW_CAP`, never mid-invoice. The summary workbook then carries a header-only lines sheet.

A part's header is fixed when it opens and rows are written against THAT part's column list — a
later batch introducing a new dynamic column cannot shift earlier values one column right; merge
unions part headers by name.

## Effect on the driving case

A 10,000-document Sales chunk (~1 line each) now writes **one file** instead of five. A line-heavy
Purchases chunk still splits, but into the fewest 60k-row parts its data needs rather than one per
batch. Memory behaviour is unchanged: raw detail JSONs still never accumulate past one batch.

## Tests

- T-265 (rewritten) a 4,500-document chunk spanning three batches → zero part files, one workbook,
  4,500 line rows inline, serial continuous.
- T-270 the sink: stays inline across several batches under the budget (no file written at all);
  once over, rolls parts exactly at the cap without splitting an invoice, one invoice per part.
- T-259 / T-260 / T-261 unchanged — `writeDetailParts` and the merge grouping keep their contracts.
