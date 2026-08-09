// ETA Bulk Export — managed backend + admin site (SEPARATE from the license worker).
// Server-authoritative: the extension registers, then does HMAC-signed check-ins; this Worker decides
// lock / kill / features / allowed-RINs. You manage users, RIN requests and bug reports at /admin.
//
// Extension endpoints (CORS, contract is STABLE — do not change response shapes):
//   POST /register     { regId,name,email,phone,company,registrationNumber,taxpayerName,deviceId,consent }
//                      → creates dev record, binds the first RIN, returns { clientKey, features, boundRins, quota, allowed }
//   POST /session      signed → { allowed, locked, killed, reason, superadmin, features, boundRins, quota, canRequestRin }
//   POST /rin-request  signed { requestedRin, note } → queues a request for admin approval
//   POST /bug          signed { message } → files a bug report
//   POST /export/mapping signed { source, have?, rin, version } → the xlsx column mapping for that
//                      source (sheet names + [key,header,width] tuples), or { unchanged:true } when
//                      the client's hash already matches. SPEC-021 — column metadata only, never rows.
// Admin (token via `Authorization: Bearer <token>` header only — never the query string):
//   GET  /admin                    dashboard (Users · Requests · Bugs · Tools)
//   GET  /api/stats                summary counters for the dashboard cards
//   GET  /api/users|requests|bugs|voids
//   GET  /api/rin?rin=…            account check: who owns a RIN, its void state, and every account it is on
//   POST /api/user                 { deviceId, action, value }  action: lock|unlock|kill|revive|super|unsuper|setQuota|addRin|removeRin|setFeatures|delete
//   POST /api/request              { id, action:'approve'|'deny' }
//   POST /api/bug                  { id, action:'resolve'|'reopen'|'delete' }
//   POST /api/void                 { rin, action:'void'|'unvoid' }
//   POST /api/config               { globalKill?, defaultQuota?, minVersion?, killedVersions? }
// Admin portal v2 (SPEC-017, src/routes/portal.js — D1-backed, same bearer token):
//   GET  /api/dashboard            counters, live runs, alerts, recent events
//   GET  /api/users|user?email=    people (not devices) · POST /api/user { email, action, value }
//   GET  /api/clients|client?rin=  one row per TRN · POST /api/client { rin, action, value }
//   GET  /api/jobs|job?id=         export runs (filter state/user/rin/stuck) · POST /api/job { id, action }
//   GET  /api/plans                sellable plans · POST /api/plan (upsert) · POST /api/plan/delete
//   POST /api/migrate              rebuild users/clients/devices from the KV dev: records (idempotent)
//
// Entitlement (SPEC-017 slice 3) is decided in src/lib/verdict.js from the PERSON's D1 row: features
// come from their plan (a per-user override wins), an expired valid_until returns reason:'expired'
// from both /session and /plan/start, and quota is counted across every device on their email.
//
// Version kill switch: the extension sends its `version` in /register and /session; if it is below
// cfg.minVersion or listed in cfg.killedVersions, /session returns allowed:false, reason:'update_required'
// (applies to everyone, superadmins included).
//   GET  /export                   CSV of users
//
// Superadmin: a device flagged `superadmin` works on ANY account — it bypasses its own lock, the RIN
// void blacklist, and the RIN allow-list. Only the global kill switch (emergency stop) still applies.
//
// Bindings: KV "LEADS"; secret "ADMIN_TOKEN"; Durable Object "LOCKS" (class Locks) for atomic RIN ownership
// + rate limiting. LOCKS is OPTIONAL — every use falls back to (best-effort) KV when env.LOCKS is absent, so
// the Worker still deploys and runs before the DO migration is applied.
//
// A0: this file is the entry point and router only. The implementation lives in src/ —
//   src/locks.js        Durable Object
//   src/lib/util.js     pure helpers          src/lib/kv.js     KV access
//   src/lib/audit.js    audit + error trails  src/lib/auth.js   signatures, admin token, email
//   src/routes/*.js     the two route groups  src/assets/*.html dashboard + privacy pages

import { json, CORS, randHex } from './src/lib/util.js';
import { listPrefix, withSeen } from './src/lib/kv.js';
import { errlog } from './src/lib/audit.js';
import { makeAdminCheck } from './src/lib/auth.js';
import { extensionRoutes } from './src/routes/extension.js';
import { planRoutes } from './src/routes/plan.js';
import { exportRoutes } from './src/routes/exportmap.js';
import { portalRoutes } from './src/routes/portal.js';
import { adminRoutes } from './src/routes/admin.js';

export { Locks } from './src/locks.js';

export default {
  async fetch(request, env) {
    // Top-level catch: an unhandled throw would otherwise surface as an opaque Cloudflare 1101 with no
    // trace anywhere — record it (err: KV, admin Activity tab) and return a clean JSON 500 instead.
    try { return await handle(request, env); }
    catch (e) { await errlog(env, request, 'exception', { msg: String((e && e.message) || e).slice(0, 200) }); return json({ ok: false, error: 'server error' }, 500); }
  },
  // Daily analytics snapshot (cron, wrangler.toml [triggers]): one snap:<yyyy-mm-dd> KV record per day
  // feeding the dashboard Trend chart. Failures surface as err: records (kind cron_fail) in the Activity tab.
  async scheduled(event, env) {
    try {
      const users = await withSeen(env, await listPrefix(env, 'dev:'));
      const now = Date.now(), DAY = 86400000;
      let active7 = 0, active30 = 0, totalDocs = 0, totalExports = 0;
      for (const d of users) {
        const s = d.lastSeen ? Date.parse(d.lastSeen) : 0;
        if (s && now - s < 7 * DAY) active7++;
        if (s && now - s < 30 * DAY) active30++;
        totalDocs += d.docs || 0; totalExports += d.exports || 0;
      }
      const openBugs = (await listPrefix(env, 'bug:')).filter((g) => g.status === 'open').length;
      const pendingReqs = (await listPrefix(env, 'req:')).filter((r) => r.status === 'pending').length;
      const day = new Date(now).toISOString().slice(0, 10);
      await env.LEADS.put('snap:' + day, JSON.stringify({ day, users: users.length, active7, active30, totalDocs, totalExports, openBugs, pendingReqs }), { expirationTtl: 120 * 86400 });
    } catch (e) {
      try { await env.LEADS.put('err:' + (1e15 - Date.now()).toString().padStart(16, '0') + ':' + randHex(4), JSON.stringify({ at: new Date().toISOString(), kind: 'cron_fail', path: '(cron)', deviceId: '', country: '', detail: { msg: String((e && e.message) || e).slice(0, 200) } }), { expirationTtl: 30 * 86400 }); } catch {}
    }
  },
};

async function handle(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const admin = makeAdminCheck(request, env);

    const ext = await extensionRoutes(request, env, url, path);
    if (ext) return ext;
    const plan = await planRoutes(request, env, url, path);
    if (plan) return plan;
    // SPEC-021: the export column mapping. Signed + entitlement-checked like the planner.
    const emap = await exportRoutes(request, env, url, path);
    if (emap) return emap;
    // BEFORE adminRoutes on purpose: /api/users and /api/user are shared paths. portalRoutes serves
    // the SPEC-017 contract and returns null for a legacy `{ deviceId, … }` /api/user body, which
    // then falls through to the KV dashboard's handler with its request body still unread.
    const portal = await portalRoutes(request, env, url, path, admin);
    if (portal) return portal;
    const adm = await adminRoutes(request, env, url, path, admin);
    if (adm) return adm;

    return json({ ok: false, error: 'not found' }, 404);
}
