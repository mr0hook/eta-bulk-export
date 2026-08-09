// Admin surface: the dashboard and privacy pages, /api/*, /export, /backup.
// admin is the zero-arg check built by makeAdminCheck — passed in so the bodies are untouched.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { json, CORS, cleanRin, randHex } from '../lib/util.js';
import { devKey, getDev, putDev, listPrefix, withSeen, listKeys, getCfg, isVoided, rinOwnerGet, rinClaim, rinRelease, personHeld } from '../lib/kv.js';
import { audit, actorOf } from '../lib/audit.js';
import { resolveEntitlement } from '../users.js';
import DASH from '../assets/dash.html';
import PRIVACY_HTML from '../assets/privacy.html';

export async function adminRoutes(request, env, url, path, admin) {
    // ── admin dashboard ──────────────────────────────────────────────────────
    if (request.method === 'GET' && (path === '/admin' || path === '/')) return new Response(DASH, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' } });
    // ── public privacy policy (the extension's consent link points here) ──────
    if (request.method === 'GET' && path === '/privacy') return new Response(PRIVACY_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });

    // ── admin API ────────────────────────────────────────────────────────────
    if (path.startsWith('/api/')) {
      if (!admin()) return json({ ok: false, error: 'unauthorized' }, 401);
      // SPEC-017 slice 4 — the same identity the portal records, on the legacy KV actions too. These
      // paths are still live (the KV dashboard's per-DEVICE buttons have no portal equivalent), so
      // an actor recorded on one console and not the other would leave a trail that looks complete
      // and names nobody for half of what happened.
      const actor = actorOf(request);

      if (request.method === 'GET' && path === '/api/stats') {
        const users = await listPrefix(env, 'dev:');
        const reqs = await listPrefix(env, 'req:');
        const bugs = await listPrefix(env, 'bug:');
        const voided = (await listKeys(env, 'void:')).length;
        const stats = {
          users: users.length,
          active: users.filter((d) => !d.locked && !d.killed).length,
          locked: users.filter((d) => d.locked && !d.killed).length,
          killed: users.filter((d) => d.killed).length,
          superadmins: users.filter((d) => d.superadmin).length,
          boundRins: users.reduce((n, d) => n + ((d.boundRins || []).length), 0),
          pendingRequests: reqs.filter((r) => r.status === 'pending').length,
          openBugs: bugs.filter((g) => g.status === 'open').length,
          voided,
        };
        return json({ ok: true, stats, cfg: await getCfg(env) });
      }
      if (request.method === 'GET' && path === '/api/users') return json({ ok: true, users: (await withSeen(env, await listPrefix(env, 'dev:'))).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''))), cfg: await getCfg(env) });
      if (request.method === 'GET' && path === '/api/requests') return json({ ok: true, requests: (await listPrefix(env, 'req:')).sort((a, b) => String(b.at).localeCompare(String(a.at))) });
      if (request.method === 'GET' && path === '/api/bugs') return json({ ok: true, bugs: (await listPrefix(env, 'bug:')).sort((a, b) => String(b.at).localeCompare(String(a.at))) });
      if (request.method === 'GET' && path === '/api/voids') return json({ ok: true, voids: await listKeys(env, 'void:') });
      if (request.method === 'GET' && path === '/api/rin') {   // account check: look up who owns a RIN + its state
        const rin = cleanRin(url.searchParams.get('rin'));
        if (!rin) return json({ ok: false, error: 'no rin' }, 400);
        const ownerId = await rinOwnerGet(env, rin);
        const owner = ownerId ? await getDev(env, ownerId) : null;
        const bound = (await listPrefix(env, 'dev:')).filter((d) => (d.boundRins || []).includes(rin)).map((d) => ({ deviceId: (d.deviceId || '').slice(0, 8), name: d.name, email: d.email, superadmin: !!d.superadmin, locked: !!d.locked, killed: !!d.killed }));
        return json({ ok: true, rin, voided: await isVoided(env, rin), owner: owner ? { deviceId: (owner.deviceId || '').slice(0, 8), name: owner.name, email: owner.email, company: owner.company } : null, bound });
      }
      // GET /api/audit moved to routes/portal.js in SPEC-017 slice 4 — paged, filterable by actor /
      // target / action, and answered BEFORE the D1 gate so it works with or without a binding. It
      // still returns the trail under `audit` as well as `entries`, so the page below keeps working.
      if (request.method === 'GET' && path === '/api/errors') {   // extension-facing failure log (newest first; keys sort descending; 30-day TTL)
        const names = []; let cursor;
        do { const l = await env.LEADS.list({ prefix: 'err:', cursor }); for (const k of l.keys) names.push(k.name); cursor = l.list_complete ? null : l.cursor; } while (cursor && names.length < 500);
        const slice = names.slice(0, 300); const out = [];
        for (let i = 0; i < slice.length; i += 100) { const map = await env.LEADS.get(slice.slice(i, i + 100), 'json'); for (const n of slice.slice(i, i + 100)) { const v = map.get(n); if (v) out.push(v); } }
        return json({ ok: true, errors: out });
      }
      if (request.method === 'GET' && path === '/api/insights') {   // aggregates for the Insights tab charts (computed from existing KV)
        const users = await withSeen(env, await listPrefix(env, 'dev:'));
        const now = Date.now(), DAY = 86400000;
        const byDay = {}, versions = {}, countries = {}, domains = {};
        let checkedIn = 0, active7 = 0, active30 = 0, cold = 0, never = 0, corporate = 0, freemail = 0;
        let totalDocs = 0, totalExports = 0, totalPdfs = 0;
        const FREE = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'live.com', 'aol.com', 'yandex.com', 'proton.me', 'protonmail.com']);
        for (const d of users) {
          const day = String(d.firstAt || '').slice(0, 10); if (day) byDay[day] = (byDay[day] || 0) + 1;
          const v = d.version || '—'; versions[v] = (versions[v] || 0) + 1;
          const c = d.country || '—'; countries[c] = (countries[c] || 0) + 1;
          const dom = String(d.email || '').split('@')[1] || ''; if (dom) { domains[dom] = (domains[dom] || 0) + 1; if (FREE.has(dom.toLowerCase())) freemail++; else corporate++; }
          const seen = d.lastSeen ? Date.parse(d.lastSeen) : 0;
          if (!seen) { never++; } else { checkedIn++; const age = now - seen; if (age < 7 * DAY) active7++; else if (age < 30 * DAY) active30++; else cold++; }
          totalDocs += d.docs || 0; totalExports += d.exports || 0; totalPdfs += d.pdfs || 0;
        }
        const topDocs = users.filter((d) => d.docs > 0).sort((a, b) => (b.docs || 0) - (a.docs || 0)).slice(0, 5).map((d) => ({ k: d.name || d.email || (d.deviceId || '').slice(0, 8), n: d.docs || 0 }));
        const toArr = (o) => Object.entries(o).map(([k, n]) => ({ k, n }));
        const regByDay = Object.keys(byDay).sort().map((k) => ({ date: k, count: byDay[k] }));
        return json({ ok: true, insights: {
          total: users.length, checkedIn, activity: { active7, active30, cold, never },
          regByDay, versions: toArr(versions).sort((a, b) => b.n - a.n), countries: toArr(countries).sort((a, b) => b.n - a.n).slice(0, 12),
          domains: toArr(domains).sort((a, b) => b.n - a.n).slice(0, 12), leadQuality: { corporate, freemail },
          value: { totalDocs, totalExports, totalPdfs, topDocs },
        } });
      }
      if (request.method === 'GET' && path === '/api/snaps') {   // daily snapshots for the Trend chart (ascending by day)
        const snaps = (await listPrefix(env, 'snap:')).sort((a, b) => String(a.day).localeCompare(String(b.day))).slice(-60);
        return json({ ok: true, snaps });
      }
      if (request.method === 'GET' && path === '/api/health') {   // self-check: which mode is production actually in?
        let kvOk = false; try { const probe = 'health:probe'; await env.LEADS.put(probe, '1', { expirationTtl: 60 }); kvOk = (await env.LEADS.get(probe)) === '1'; } catch {}
        const cfg = await getCfg(env);
        return json({ ok: true, health: {
          locksBound: !!env.LOCKS, adminTokenSet: !!env.ADMIN_TOKEN, kvOk,
          globalKill: !!cfg.globalKill, minVersion: cfg.minVersion || '', killedVersions: (cfg.killedVersions || []).length,
          announcementActive: !!(cfg.announcement && cfg.announcement.text && (!cfg.announcement.until || Date.parse(cfg.announcement.until) > Date.now())),
        } });
      }

      let b = {}; try { b = await request.json(); } catch {}
      if (request.method === 'POST' && path === '/api/void') {
        const rin = cleanRin(b.rin); if (!rin) return json({ ok: false, error: 'no rin' }, 400);
        const wasVoided = !!(await env.LEADS.get('void:' + rin));
        if (b.action === 'unvoid') await env.LEADS.delete('void:' + rin); else await env.LEADS.put('void:' + rin, new Date().toISOString());
        await audit(env, b.action === 'unvoid' ? 'unvoid' : 'void', rin, { before: wasVoided ? 'voided' : 'active', after: b.action === 'unvoid' ? 'active' : 'voided' }, actor);
        return json({ ok: true, rin, voided: b.action !== 'unvoid' });
      }
      if (request.method === 'POST' && path === '/api/config') {
        const cfg = await getCfg(env);
        // The global kill switch and the version floor decide whether every install in the field
        // keeps working. "It was turned on at 14:02" is half an answer without what it was before.
        const wasCfg = { globalKill: !!cfg.globalKill, minVersion: cfg.minVersion || '', killedVersions: cfg.killedVersions || [], announcement: cfg.announcement ? String(cfg.announcement.text || '').slice(0, 60) : '' };
        if (typeof b.globalKill === 'boolean') cfg.globalKill = b.globalKill;
        if (Number.isFinite(b.defaultQuota)) cfg.defaultQuota = Math.max(0, b.defaultQuota | 0);
        if (typeof b.minVersion === 'string') cfg.minVersion = b.minVersion.trim().slice(0, 24);
        if (Array.isArray(b.killedVersions)) cfg.killedVersions = b.killedVersions.map((s) => String(s).trim().slice(0, 24)).filter(Boolean).slice(0, 50);
        // Broadcast announcement banner: { text, level:'info'|'warn'|'alert', until? } — empty text clears it.
        if (b.announcement !== undefined) {
          const a = b.announcement;
          if (!a || !String(a.text || '').trim()) cfg.announcement = null;
          else cfg.announcement = { text: String(a.text).slice(0, 400), level: (a.level === 'warn' || a.level === 'alert') ? a.level : 'info', until: a.until ? String(a.until).slice(0, 40) : '', id: randHex(4) };
        }
        await env.LEADS.put('cfg', JSON.stringify(cfg));
        const nowCfg = { globalKill: !!cfg.globalKill, minVersion: cfg.minVersion || '', killedVersions: cfg.killedVersions || [], announcement: cfg.announcement ? cfg.announcement.text.slice(0, 60) : '' };
        await audit(env, 'config', '', { ...nowCfg, before: wasCfg, after: nowCfg }, actor);
        return json({ ok: true, cfg });
      }
      if (request.method === 'POST' && path === '/api/user') {
        const dev = await getDev(env, String(b.deviceId || '')); if (!dev) return json({ ok: false, error: 'no such device' }, 404);
        // Snapshot the fields these buttons move, BEFORE the switch mutates dev in place. Same field
        // map as the portal's, on the device shape: this console is where a per-device lock, quota or
        // RIN binding still happens, so the trail has to be able to diff those too.
        const DEV_FIELD = { lock: 'locked', unlock: 'locked', kill: 'killed', revive: 'killed', super: 'superadmin', unsuper: 'superadmin', setQuota: 'quota', setFeatures: 'features', setTags: 'tags', addRin: 'boundRins', removeRin: 'boundRins' };
        const devField = DEV_FIELD[b.action];
        const snap = (o) => (devField ? (Array.isArray(o[devField]) ? o[devField].slice() : (typeof o[devField] === 'boolean' ? !!o[devField] : (o[devField] == null ? null : o[devField]))) : undefined);
        const wasDev = snap(dev);
        switch (b.action) {
          case 'lock': dev.locked = true; break;
          case 'unlock': dev.locked = false; break;
          case 'kill': dev.killed = true; break;
          case 'revive': dev.killed = false; break;
          case 'super': dev.superadmin = true; break;         // works on ANY account
          case 'unsuper': dev.superadmin = false; break;
          case 'setQuota': dev.quota = Math.max(0, (b.value | 0)); break;
          // FIX: honor the claim result. Previously a failed rinClaim was ignored, so an admin could bind a RIN
          // in dev.boundRins while the Locks DO still recorded another owner → stale ownership + a user who
          // passes the allow-list but whose RIN a second account can later re-claim. Now a lost claim → 409.
          case 'addRin': {
            const r = cleanRin(b.value);
            if (r && !dev.boundRins.includes(r)) {
              const claim = await rinClaim(env, r, dev.deviceId);
              if (!claim.ok) return json({ ok: false, error: 'RIN ' + r + ' is already owned by another account (' + String(claim.owner || '').slice(0, 8) + '). Use "Move RIN" to transfer it.' }, 409);
              dev.boundRins.push(r); if (dev.boundRins.length > dev.quota) dev.quota = dev.boundRins.length;
            }
            break;
          }
          case 'removeRin': { const r = cleanRin(b.value); dev.boundRins = dev.boundRins.filter((x) => x !== r); await rinRelease(env, r, dev.deviceId); break; }
          // Atomic-ish transfer: release from source, then claim onto target. One safe click for the most common
          // support request (the /register 409 tells users "ask the admin to move it"). Fails closed on a lost claim.
          case 'moveRin': {
            const r = cleanRin(b.value); const toId = String(b.toDeviceId || '').trim();
            if (!r) return json({ ok: false, error: 'no rin' }, 400);
            if (!dev.boundRins.includes(r)) return json({ ok: false, error: 'this user does not hold ' + r }, 400);
            const target = await getDev(env, toId); if (!target) return json({ ok: false, error: 'target account not found' }, 404);
            if (target.deviceId === dev.deviceId) return json({ ok: false, error: 'source and target are the same account' }, 400);
            // Release the source's OWNERSHIP first (so the target can claim — claimRin is first-writer-wins), but
            // do NOT strip the source's boundRins yet. Only commit both sides AFTER the target claim succeeds, so a
            // transient claim failure can't orphan the RIN and lock the source user out — it stays in boundRins.
            await rinRelease(env, r, dev.deviceId);
            let claim;
            try { claim = await rinClaim(env, r, target.deviceId); }
            catch (e) { await rinClaim(env, r, dev.deviceId).catch(() => {}); return json({ ok: false, error: 'transfer failed (' + String((e && e.message) || e) + ') — the RIN stays with the source account.' }, 500); }
            if (!claim.ok) { await rinClaim(env, r, dev.deviceId).catch(() => {}); return json({ ok: false, error: 'another account claimed ' + r + ' first (' + String(claim.owner || '').slice(0, 8) + ') — the RIN stays with the source account.' }, 409); }
            dev.boundRins = dev.boundRins.filter((x) => x !== r); await putDev(env, dev);
            if (!target.boundRins.includes(r)) { target.boundRins.push(r); if (target.boundRins.length > target.quota) target.quota = target.boundRins.length; }
            await putDev(env, target);
            await audit(env, 'moveRin', dev.deviceId, { rin: r, from: (dev.deviceId || '').slice(0, 8), to: toId.slice(0, 8), before: (dev.deviceId || '').slice(0, 8), after: toId.slice(0, 8) }, actor);
            return json({ ok: true, moved: true });
          }
          // one-way admin → device message, delivered on the next /session check-in (even to blocked
          // devices — it's the only channel to tell a blocked user why). Dismissal is client-side by id.
          case 'setMessage': {
            const v = b.value || {};
            const text = String(v.text || '').trim().slice(0, 400);
            if (!text) return json({ ok: false, error: 'empty message' }, 400);
            dev.message = { text, level: (v.level === 'warn' || v.level === 'alert') ? v.level : 'info', id: randHex(4), at: new Date().toISOString() };
            break;
          }
          case 'clearMessage': delete dev.message; break;
          case 'setFeatures': dev.features = Array.isArray(b.value) ? b.value.map(String) : String(b.value || '').split(',').map((s) => s.trim()).filter(Boolean); break;
          case 'setNote': dev.note = String(b.value || '').slice(0, 2000); break;   // free-text admin note (who/why)
          case 'setTags': dev.tags = (Array.isArray(b.value) ? b.value.map(String) : String(b.value || '').split(',')).map((s) => s.trim()).filter(Boolean).slice(0, 20); break;
          case 'delete': {
            // Snapshot EVERYTHING into trash:<deviceId> (30-day TTL) BEFORE deleting — /api/trash can
            // restore the account, its telemetry, and its requests/bugs; RINs are re-claimed on restore.
            const myReqs = (await listPrefix(env, 'req:')).filter((r) => r.deviceId === dev.deviceId);
            const myBugs = (await listPrefix(env, 'bug:')).filter((g) => g.deviceId === dev.deviceId);
            const seenRec = await env.LEADS.get('seen:' + dev.deviceId, 'json');
            try { await env.LEADS.put('trash:' + dev.deviceId, JSON.stringify({ dev, seen: seenRec, reqs: myReqs, bugs: myBugs, at: new Date().toISOString() }), { expirationTtl: 30 * 86400 }); } catch {}
            for (const r of (dev.boundRins || [])) await rinRelease(env, r, dev.deviceId);
            await env.LEADS.delete(devKey(dev.deviceId));
            await env.LEADS.delete('seen:' + dev.deviceId);
            if (dev.email) {   // drop this device from the email→devices index (delete the index if now empty)
              const ik = 'email:' + dev.email; const nidx = ((await env.LEADS.get(ik, 'json')) || []).filter((x) => x !== dev.deviceId);
              if (nidx.length) await env.LEADS.put(ik, JSON.stringify(nidx)); else await env.LEADS.delete(ik);
            }
            // remove this device's RIN requests + bug reports so nothing lingers as "pending" after the account is gone
            for (const r of myReqs) await env.LEADS.delete('req:' + r.id);
            for (const g of myBugs) await env.LEADS.delete('bug:' + g.id);
            await audit(env, 'delete', dev.deviceId, { name: dev.name, email: dev.email, rins: dev.boundRins || [], before: { locked: !!dev.locked, killed: !!dev.killed, quota: dev.quota | 0, rins: (dev.boundRins || []).length }, after: null }, actor);
            return json({ ok: true, deleted: true });
          }
          default: return json({ ok: false, error: 'unknown action' }, 400);
        }
        await putDev(env, dev);
        await audit(env, b.action, dev.deviceId, {
          name: dev.name, value: (b.action === 'setNote' ? '(note)' : b.action === 'setMessage' ? String((b.value || {}).text || '').slice(0, 60) : b.value),
          ...(devField ? { field: devField, before: wasDev, after: snap(dev) } : {}),
        }, actor);
        return json({ ok: true, dev });
      }
      if (request.method === 'POST' && path === '/api/request') {
        // AUDIT GAP CLOSED (SPEC-017 slice 4): this delete wrote nothing. "Clearing clutter" and
        // "making an approval disappear" are the same keystroke, and only one of them was visible.
        if (b.action === 'delete') {
          const gone = await env.LEADS.get('req:' + String(b.id || ''), 'json');
          await env.LEADS.delete('req:' + String(b.id || ''));
          await audit(env, 'request_delete', (gone && gone.deviceId) || String(b.id || ''), { rin: (gone && gone.requestedRin) || '', before: (gone && gone.status) || '(unknown)', after: '(deleted)' }, actor);
          return json({ ok: true });
        }
        const r = await env.LEADS.get('req:' + String(b.id || ''), 'json'); if (!r) return json({ ok: false, error: 'no request' }, 404);
        const wasStatus = r.status || 'pending';
        if (b.action === 'approve') {
          const dev = await getDev(env, r.deviceId);
          if (dev && !dev.boundRins.includes(r.requestedRin)) {
            // SPEC-017 slice 3: the cap is the PERSON's, counted across every device on their email.
            // This used to raise dev.quota to fit whatever was approved, which meant the cap said
            // nothing the moment anyone asked — approving was the supported way around it. Refusing
            // makes the decision visible: an admin who wants to grant more raises the quota or the
            // plan first, and that shows up in the audit trail as the entitlement change it is.
            const held = await personHeld(env, dev.email, dev);
            let cap = dev.quota ?? 1;
            try { const ent = await resolveEntitlement(env, dev.email); if (ent) cap = Math.max(cap, ent.quotaEff); } catch {}
            if (held.rins.size >= cap) return json({ ok: false, error: 'cannot approve — ' + (dev.email || 'this user') + ' already holds ' + held.rins.size + ' of ' + cap + ' clients across ' + held.devices + ' device(s). Raise their quota or plan first.' }, 409);
            const claim = await rinClaim(env, r.requestedRin, dev.deviceId);
            if (!claim.ok) return json({ ok: false, error: 'cannot approve — ' + r.requestedRin + ' is owned by another account (' + String(claim.owner || '').slice(0, 8) + ').' }, 409);
            dev.boundRins.push(r.requestedRin); await putDev(env, dev);
          }
          r.status = 'approved';
        } else r.status = 'denied';
        r.resolvedAt = new Date().toISOString(); await env.LEADS.put('req:' + r.id, JSON.stringify(r));
        await audit(env, 'request_' + (b.action || ''), r.deviceId, { rin: r.requestedRin, before: wasStatus, after: r.status }, actor);
        return json({ ok: true });
      }
      if (request.method === 'GET' && path === '/api/trash') {   // deleted accounts recoverable for 30 days
        const trash = (await listPrefix(env, 'trash:')).map((t) => ({ deviceId: (t.dev || {}).deviceId || '', name: (t.dev || {}).name || '', email: (t.dev || {}).email || '', rins: (t.dev || {}).boundRins || [], at: t.at }));
        return json({ ok: true, trash: trash.sort((a, b) => String(b.at).localeCompare(String(a.at))) });
      }
      if (request.method === 'POST' && path === '/api/trash') {
        const id = String(b.deviceId || '');
        if (b.action === 'purge') { await env.LEADS.delete('trash:' + id); await audit(env, 'trash_purge', id, { before: '(in trash)', after: '(purged)' }, actor); return json({ ok: true }); }
        if (b.action === 'restore') {
          const t = await env.LEADS.get('trash:' + id, 'json');
          if (!t || !t.dev) return json({ ok: false, error: 'not in trash (expired or purged)' }, 404);
          if (await getDev(env, id)) return json({ ok: false, error: 'device re-registered since deletion — restore would clobber the live account' }, 409);
          // Re-claim RINs; another account may have legitimately claimed one since deletion — those are
          // dropped (first-writer-wins, restore must not steal) and reported back as lostRins.
          const kept = [], lostRins = [];
          for (const r of (t.dev.boundRins || [])) { const c = await rinClaim(env, r, id); if (c.ok) kept.push(r); else lostRins.push(r); }
          t.dev.boundRins = kept;
          await putDev(env, t.dev);
          if (t.seen) await env.LEADS.put('seen:' + id, JSON.stringify(t.seen));
          if (t.dev.email) { const ik = 'email:' + t.dev.email; const idx = (await env.LEADS.get(ik, 'json')) || []; if (!idx.includes(id)) { idx.push(id); await env.LEADS.put(ik, JSON.stringify(idx)); } }
          for (const r of (t.reqs || [])) await env.LEADS.put('req:' + r.id, JSON.stringify(r));
          for (const g of (t.bugs || [])) await env.LEADS.put('bug:' + g.id, JSON.stringify(g));
          await env.LEADS.delete('trash:' + id);
          await audit(env, 'trash_restore', id, { name: t.dev.name, lostRins, before: '(in trash)', after: '(restored)' }, actor);
          return json({ ok: true, restored: true, lostRins });
        }
        return json({ ok: false, error: 'unknown action' }, 400);
      }
      // AUDIT GAP CLOSED (SPEC-017 slice 4): POST /api/bug lived here and wrote NOTHING — resolving
      // and, worse, deleting a user's report left no record that anyone had touched it. It now lives
      // in routes/portal.js, which owns the path, audits all four actions (resolve · reopen · delete
      // · note) and answers with or without a D1 binding, so nothing depends on this being reachable.
      return json({ ok: false, error: 'not found' }, 404);
    }

    if (request.method === 'GET' && path === '/export') {
      if (!admin()) return json({ ok: false, error: 'unauthorized' }, 401);
      const type = (url.searchParams.get('type') || 'users').toLowerCase();
      // Neutralize spreadsheet formula injection: a cell beginning with = + - @ TAB or CR is prefixed with a
      // single quote so Excel/Sheets treat attacker-supplied name/company/etc. as text, not a formula.
      const toCsv = (rows) => rows.map((r) => r.map((c) => { let s = String(c ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
      let cols, rows, fname;
      if (type === 'requests') {
        cols = ['at', 'resolvedAt', 'status', 'name', 'email', 'requestedRin', 'note', 'deviceId'];
        rows = [cols, ...(await listPrefix(env, 'req:')).sort((a, b) => String(b.at).localeCompare(String(a.at))).map((r) => cols.map((c) => r[c]))];
        fname = 'eta-bulk-requests.csv';
      } else if (type === 'bugs') {
        cols = ['at', 'status', 'name', 'email', 'rin', 'message', 'ua', 'deviceId'];
        rows = [cols, ...(await listPrefix(env, 'bug:')).sort((a, b) => String(b.at).localeCompare(String(a.at))).map((g) => cols.map((c) => g[c]))];
        fname = 'eta-bulk-bugs.csv';
      } else {
        cols = ['name', 'email', 'emailVerified', 'phone', 'company', 'taxpayerName', 'boundRins', 'quota', 'locked', 'killed', 'superadmin', 'version', 'features', 'country', 'firstAt', 'lastSeen', 'count', 'tags', 'note'];
        rows = [cols, ...(await withSeen(env, await listPrefix(env, 'dev:'))).map((d) => cols.map((c) => Array.isArray(d[c]) ? d[c].join('|') : d[c]))];
        fname = 'eta-bulk-users.csv';
      }
      return new Response('﻿' + toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="' + fname + '"', 'cache-control': 'no-store', ...CORS } });
    }

    // Full JSON backup — the only export that captures clientKey/deviceId/requests/bugs/voids/cfg/audit, i.e.
    // the ONLY one you can actually restore the namespace from after an accidental wipe or bad bulk op.
    if (request.method === 'GET' && path === '/backup') {
      if (!admin()) return json({ ok: false, error: 'unauthorized' }, 401);
      const dump = { at: new Date().toISOString(), users: await listPrefix(env, 'dev:'), seen: {}, requests: await listPrefix(env, 'req:'), bugs: await listPrefix(env, 'bug:'), voids: await listKeys(env, 'void:'), cfg: await getCfg(env) };
      { let cursor; do { const l = await env.LEADS.list({ prefix: 'seen:', cursor }); const names = l.keys.map((k) => k.name); for (let i = 0; i < names.length; i += 100) { const m = await env.LEADS.get(names.slice(i, i + 100), 'json'); for (const [k, v] of m) if (v) dump.seen[k.slice(5)] = v; } cursor = l.list_complete ? null : l.cursor; } while (cursor); }
      return new Response(JSON.stringify(dump, null, 1), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="eta-bulk-backup.json"', 'cache-control': 'no-store', ...CORS } });
    }

  return null;
}
