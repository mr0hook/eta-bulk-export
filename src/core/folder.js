// SPEC-010 — folder ownership stamp. An export folder belongs to exactly ONE taxpayer.
//
// Why this exists: chunk filenames carry no owner, and resume() decides which chunks are already
// downloaded purely by filename presence (store.js:49 → orchestrator.js:286). Two companies in one
// folder therefore produce identical filenames, the second inherits the first's files, skips
// fetching them, and ships an export full of the other company's invoices — with no error. This
// module makes that impossible by refusing the folder up front, which is cheaper and far safer
// than putting the TIN in every filename (that would make every pre-existing file stop matching
// and silently re-download whole folders).
//
// Read-only by design: verify() NEVER writes. Claiming is always an explicit, separate decision.
import { readText, writeText, listFiles } from './fs.js';

export const STAMP = 'eta_folder.json';
const V = 1;
// Any export this tool has ever written. Presence means "someone already used this folder", which
// is the signal that we must ask rather than assume.
const DATA_RE = /^e(Invoices|Receipts)_.*\.xlsx$/i;

const known = (rin) => { const s = String(rin ?? '').trim(); return s && s !== 'unknown' ? s : null; };

// Tolerates anything: missing, empty, not JSON, wrong shape, future version. A damaged stamp must
// degrade to "unknown owner" (→ we ask) and never to "no owner" (→ we'd silently claim it).
export async function readStamp(dir) {
  try {
    const raw = await readText(dir, STAMP);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || j.v !== V) return null;
    const rin = known(j.rin);
    return rin ? { v: V, rin, company: String(j.company || ''), claimedAt: String(j.claimedAt || '') } : null;
  } catch { return null; }
}

// Returns the stamp written, or null when the taxpayer is unknown (never claim on a guess).
export async function claim(dir, rin, company = '', now = () => new Date()) {
  const id = known(rin);
  if (!id) return null;
  const stamp = { v: V, rin: id, company: String(company || ''), claimedAt: now().toISOString() };
  await writeText(dir, STAMP, JSON.stringify(stamp, null, 1));
  return stamp;
}

// state:
//   'ok'           — stamped for this taxpayer, proceed
//   'blocked'      — stamped for someone else; owner/company name them in the message
//   'fresh'        — unstamped and empty; caller may claim it silently
//   'needsConfirm' — unstamped but already holds exports; caller must ask before claiming
//   'unverified'   — nobody is logged in, so ownership cannot be checked either way
export async function verify(dir, rin) {
  const id = known(rin);
  const stamp = await readStamp(dir);
  if (!id) return { state: 'unverified', owner: stamp?.rin || null, company: stamp?.company || '' };
  if (stamp) {
    return stamp.rin === id
      ? { state: 'ok', owner: stamp.rin, company: stamp.company }
      : { state: 'blocked', owner: stamp.rin, company: stamp.company };
  }
  const used = (await listFiles(dir, DATA_RE)).length > 0;
  return { state: used ? 'needsConfirm' : 'fresh', owner: null, company: '' };
}
