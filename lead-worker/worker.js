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
    const adm = await adminRoutes(request, env, url, path, admin);
    if (adm) return adm;

    return json({ ok: false, error: 'not found' }, 404);
}
