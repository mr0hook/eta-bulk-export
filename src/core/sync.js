// Incremental "sync" export: derive a plan selection that picks up where the folder's last run
// ended — same source/filters/folder, date range = (last run's end − a small overlap) → today.
// The overlap re-fetches a few days so late-arriving documents near the boundary aren't missed;
// the duplicates it creates collapse in mergeFolder's cross-file UUID dedup.
import { addDaysYmd } from './time.js';

export const SYNC_OVERLAP_DAYS = 3;

// progress = store.readProgress() shape (persists source/dir/field/from/to/statuses/excludeColumns/downloadPdf).
// today = ymd string. Returns a plan(sel)-compatible selection, or null when the progress is unusable.
export function deriveSyncSel(progress, today) {
  if (!progress || !progress.from || !progress.to || !progress.source || !progress.field) return null;
  let from = addDaysYmd(progress.to, -SYNC_OVERLAP_DAYS);
  if (from < progress.from) from = progress.from;      // never reach before the original run's start
  let to = String(today);
  if (to < from) to = from;                            // progress.to in the future / clock skew → 1-day range
  const fY = from.slice(0, 4), tY = to.slice(0, 4);
  return {
    source: progress.source,
    year: fY === tY ? fY : fY + '-' + tY,              // same label rule as the drawer's gather()
    dir: progress.dir, field: progress.field, from, to,
    statuses: progress.statuses, excludeColumns: progress.excludeColumns || [],
    // SPEC-022b: a filtered run syncs FILTERED. Dropping the RIN list here would silently widen
    // the export to the whole range — the exact subset/superset aliasing planSig exists to prevent.
    rinFilter: progress.rinFilter || [],
    downloadPdf: !!progress.downloadPdf, downloadDetails: true,
  };
}
