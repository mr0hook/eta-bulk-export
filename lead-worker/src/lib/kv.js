// KV access — device records, prefix scans, RIN ownership, per-device rate limiting.
// Every function takes env explicitly; nothing here closes over a request.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { randHex } from './util.js';

const devKey = (id) => 'dev:' + id;
const getDev = (env, id) => env.LEADS.get(devKey(id), 'json');
const putDev = (env, d) => env.LEADS.put(devKey(d.deviceId), JSON.stringify(d));

async function listPrefix(env, prefix) {
  const names = []; let cursor;
  do { const l = await env.LEADS.list({ prefix, cursor }); for (const k of l.keys) names.push(k.name); cursor = l.list_complete ? null : l.cursor; } while (cursor);
  const out = [];
  for (let i = 0; i < names.length; i += 100) {                          // bulk get: 1 subrequest per 100 keys (was N+1)
    const map = await env.LEADS.get(names.slice(i, i + 100), 'json');
    for (const v of map.values()) if (v) out.push(v);
  }
  return out;
}
// Merge the volatile seen: telemetry (lastSeen/lastRin/version, written by /session) over dev records for admin display.
async function withSeen(env, users) {
  const seen = {}; let cursor;
  do {
    const l = await env.LEADS.list({ prefix: 'seen:', cursor }); const names = l.keys.map((k) => k.name);
    for (let i = 0; i < names.length; i += 100) { const map = await env.LEADS.get(names.slice(i, i + 100), 'json'); for (const [k, v] of map) if (v) seen[k.slice(5)] = v; }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  for (const d of users) { const s = seen[d.deviceId]; if (s) { d.lastSeen = s.lastSeen || d.lastSeen; d.lastRin = s.lastRin || d.lastRin; d.version = s.version || d.version; d.exports = s.exports || 0; d.docs = s.docs || 0; d.pdfs = s.pdfs || 0; d.lastExportAt = s.lastExportAt || ''; } }
  return users;
}
async function listKeys(env, prefix) {
  const out = []; let cursor;
  do { const l = await env.LEADS.list({ prefix, cursor }); for (const k of l.keys) out.push(k.name.slice(prefix.length)); cursor = l.list_complete ? null : l.cursor; } while (cursor);
  return out;
}
async function getCfg(env) { return (await env.LEADS.get('cfg', 'json')) || { globalKill: false, defaultQuota: 1 }; }
const isVoided = async (env, rin) => !!(await env.LEADS.get('void:' + rin));       // blacklisted RIN

// RIN ownership — atomic via the Locks Durable Object when bound, else best-effort KV (read-back) fallback.
const rinOwnerGet = (env, rin) => env.LOCKS ? env.LOCKS.get(env.LOCKS.idFromName('rin:' + rin)).getOwner(rin) : env.LEADS.get('rinowner:' + rin);
async function rinClaim(env, rin, deviceId) {   // → { ok, owner }
  if (env.LOCKS) return env.LOCKS.get(env.LOCKS.idFromName('rin:' + rin)).claimRin(deviceId, rin);
  const owner = await env.LEADS.get('rinowner:' + rin);
  if (owner && owner !== deviceId) return { ok: false, owner };
  await env.LEADS.put('rinowner:' + rin, deviceId);
  const confirmed = await env.LEADS.get('rinowner:' + rin);   // narrows (not closes) the KV race
  if (confirmed && confirmed !== deviceId) return { ok: false, owner: confirmed };
  return { ok: true, owner: deviceId };
}
async function rinRelease(env, rin, deviceId) {
  if (env.LOCKS) { await env.LOCKS.get(env.LOCKS.idFromName('rin:' + rin)).releaseRin(deviceId, rin); return; }
  if ((await env.LEADS.get('rinowner:' + rin)) === deviceId) await env.LEADS.delete('rinowner:' + rin);
}
/**
 * Every RIN this PERSON holds, across every browser they have registered — SPEC-017 slice 3.
 *
 * The licensing hole this closes: `dev.boundRins.length < dev.quota` counts one browser, so the same
 * accountant on a laptop and an office PC held two quotas against one licence. Counted from KV (the
 * `email:` index → each `dev:` record) rather than from the D1 clients table because KV is what
 * /register actually enforces from, exists on every install migrated or not, and can never be behind
 * the very record being written in this request.
 *
 * `self` is passed in — not re-read — because the device may be mid-registration and not yet in the
 * index. A device whose record has vanished contributes nothing rather than throwing; under-counting
 * one browser is a smaller failure than refusing a legitimate registration outright.
 *
 * @returns { rins: Set<string>, devices: number }
 */
async function personHeld(env, email, self) {
  const rins = new Set((self && self.boundRins) || []);
  let devices = self ? 1 : 0;
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { rins, devices };
  const ids = (await env.LEADS.get('email:' + e, 'json')) || [];
  for (const id of ids) {
    if (self && id === self.deviceId) continue;
    const d = await getDev(env, id);
    if (!d) continue;
    devices++;
    for (const r of (d.boundRins || [])) rins.add(r);
  }
  return { rins, devices };
}

// Per-device fixed-window limiter for the SIGNED endpoints (/bug, /rin-request). Atomic via the Locks DO
// (self-cleaning alarm) when bound; best-effort KV bucket otherwise. Without this, one registered device could
// loop a signed endpoint and write unbounded permanent KV records — exhausting write quota and bloating the
// admin listPrefix scans. Returns true if the call is within budget.
async function deviceRate(env, tag, deviceId, limit, windowMs) {
  if (env.LOCKS) { try { const rl = await env.LOCKS.get(env.LOCKS.idFromName('rl:' + tag + ':' + deviceId)).rateHit(limit, windowMs); return rl.ok; } catch { return true; } }
  const key = 'rl:' + tag + ':' + deviceId + ':' + Math.floor(Date.now() / windowMs);
  const n = parseInt((await env.LEADS.get(key)) || '0', 10) + 1;
  if (n > limit) return false;
  await env.LEADS.put(key, String(n), { expirationTtl: Math.ceil(windowMs / 1000) + 60 });
  return true;
}

export { devKey, getDev, putDev, listPrefix, withSeen, listKeys, getCfg, isVoided, rinOwnerGet, rinClaim, rinRelease, deviceRate, personHeld };
