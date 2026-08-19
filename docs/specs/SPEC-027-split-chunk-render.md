# SPEC-027 — Split chunk render: streamed detail parts beside a small summary workbook

**Status:** BUILT · 2026-08-19 · ships as v0.8.0 (feature → minor bump)
**Driver:** user-identified (2026-08-19, live Purchases run): a chunk's SUMMARY row count says
nothing about its DETAILS row count — 10k invoices can mean 1–2M line rows. Today the whole chunk
(both sheets) is built as one ExcelJS workbook: ~KBs of object model per row means a line-heavy
chunk OOMs the tab at creation ("Invalid array length" / Aw-Snap), and the SAME workbook would
later OOM merge's Phase-1 read, which loads each chunk file through ExcelJS. SPEC-026's 2,000-doc
Purchases cap is the seatbelt; this is the fix that makes chunk size independent of line count.

## Shape

Per chunk, decided by the built line-row count:

- **≤ 30,000 line rows** (every Sales chunk observed, most others): EXACTLY today's output — one
  workbook, summary + lines sheets, same name, same styling. Byte-for-byte no change.
- **> 30,000 line rows:** the chunk becomes
  - `<chunkname>_det_p01.xlsx`, `_det_p02.xlsx`, … — single-sheet detail part files, ≤ 60,000
    line rows each (the envelope F-10 proved safe for ExcelJS to read back), written with the
    SPEC-014 streaming writer (constant ~22MB heap at any size). An invoice's lines NEVER straddle
    two parts — same rule merge's rotator enforces — so any consumer can join lines to their
    summary inside one file set member. Values pass through sanitize.clean() (the streaming
    writer's own XML escaping covers control chars; clean() adds the noncharacter/lone-surrogate
    scrub so parts match the ExcelJS path's hygiene).
  - `<chunkname>.xlsx` — the ExcelJS summary workbook, styling intact, whose lines sheet is
    HEADER-ONLY (keeps the "عرض" hyperlink target and merge's sheet-name detection working).

**Write order is load-bearing:** stale `_det_p*` of the same chunk are deleted first (a retried
chunk may produce fewer parts; a survivor would poison merge), then parts, then the summary LAST —
the summary keeps its exact current name, so `scanDoneFromFolder`'s "file present = chunk done"
resume contract and the empty-chunk incident guard are untouched, and a crash mid-chunk can never
look complete.

Styling on detail parts (borders/fills) is dropped — parts are plumbing that merge consumes; the
summary workbook and the COMBINED outputs keep their look.

## Merge (Phase 1) learns the grouping

- `_det_p\d+\.xlsx` files are recognized as parts and claimed by their parent chunk file
  (name minus the suffix). The main loop iterates parents only; after the parent's own sheets,
  each part's single sheet is appended through the same lines logic (header union per part).
- A part whose parent is absent from the folder is an incomplete chunk write — skipped with the
  existing per-file warn (its data has no summary to join; the retry rewrites everything).
- Incremental mode: a NEW part whose parent is not also being read is ambiguity → the existing
  DRIFT path (full rebuild). A retried chunk rewrites parts + summary together, so the normal
  incremental case reads them together.
- Transient memory while merging a split chunk: one ≤60k-row part's ExcelJS model at a time plus
  the chunk's accumulated plain-object line rows — bounded by SPEC-026's chunk caps. (Per-part
  JSONL emission is the recorded future optimization if a cap rise ever needs it.)

## Not changing

- repair.js (per-file, shape-agnostic), resume/scanDone (summary name unchanged), the COMBINED
  output writers, PDF phase, and the uuid-scoped merge (its prefix regex matches parts naturally).
- Raw detail JSONs are still held for the whole chunk during fetch — that term is bounded by
  SPEC-026's caps; mapping rows on arrival and dropping raw JSON is the next lever if needed.

## Tests

- T-258 (xlsx) buildRows/renderWorkbook refactor pin: renderWorkbook output for a small corpus is
  unchanged, and buildRows returns the identical rows/cols renderWorkbook uses.
- T-259 (chunk write) a line-heavy chunk writes parts ≤ cap with no invoice straddling parts,
  parts land BEFORE the summary, stale parts of a retried chunk are removed, and the summary's
  lines sheet is header-only.
- T-260 (merge) a folder mixing a legacy 2-sheet chunk and a split chunk (summary + 2 parts)
  merges to the same COMBINED dataset as the all-legacy equivalent — lines joined across parts.
- T-261 (merge) an orphan part is skipped with a warn in full mode; a new orphan part in
  incremental mode triggers the full-rebuild path.
