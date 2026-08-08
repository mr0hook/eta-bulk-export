// Extension endpoints: /register, /session, /rin-request, /bug.
// CONTRACT IS STABLE — response shapes are consumed by shipped extension versions. Returns null
// when the path is not ours, so the entry router falls through.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { json, EMAIL_RE, cleanRin, randHex, isVersionBlocked } from '../lib/util.js';
import { getDev, putDev, getCfg, isVoided, rinClaim, listPrefix, deviceRate } from '../lib/kv.js';
import { verifyEmail, verifySigned } from '../lib/auth.js';
import { errlog } from '../lib/audit.js';

export async function extensionRoutes(request, env, url, path) {
    // ── register (unsigned) ──────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/register') {
      let b; try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      const email = String(b.email || '').trim().toLowerCase().slice(0, 254);   // RFC 5321 cap → 'email:'+email stays under the 512-byte KV key limit
      const rin = cleanRin(b.registrationNumber);
      const deviceId = String(b.deviceId || '').trim().slice(0, 80);
      const regFail = async (reason, msg, code) => { await errlog(env, request, 'register_fail', { reason }); return json({ ok: false, error: msg }, code); };   // no PII in the error log — reason tag only
      if (!b.name || !email || !b.consent) return regFail('missing_fields', 'name, email and consent are required', 400);
      if (!EMAIL_RE.test(email)) return regFail('invalid_email', 'invalid email', 400);
      if (!rin || rin === 'unknown') return regFail('no_rin', 'could not read your registration number — log into the ETA portal', 400);
      if (!deviceId) return regFail('no_device', 'missing device id', 400);
      // Per-IP rate limit — ATOMIC via the Locks DO; best-effort KV fallback when the DO isn't bound yet.
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (ip) {
        if (env.LOCKS) {
          const rl = await env.LOCKS.get(env.LOCKS.idFromName('rl:' + ip)).rateHit(40, 3600000);
          if (!rl.ok) return regFail('rate_limit', 'Too many registrations from this network — please try again later.', 429);
        } else {
          const rlKey = 'rl:' + ip + ':' + Math.floor(Date.now() / 3600000);
          const rlN = parseInt((await env.LEADS.get(rlKey)) || '0', 10) + 1;
          if (rlN > 40) return regFail('rate_limit', 'Too many registrations from this network — please try again later.', 429);
          await env.LEADS.put(rlKey, String(rlN), { expirationTtl: 3600 });
        }
      }
      const ev = await verifyEmail(email);
      if (ev.reject) return regFail('email_rejected', ev.reason, 400);
      if (await isVoided(env, rin)) return regFail('rin_voided', 'This registration number has been voided. Contact the administrator.', 403);

      const cfg = await getCfg(env);
      if (isVersionBlocked(cfg, String(b.version || '').slice(0, 24))) return regFail('version_blocked', 'Please update ETA Bulk Export to the latest version, then register.', 426);
      const prev = await getDev(env, deviceId);
      const now = new Date().toISOString();
      const dev = prev || { deviceId, clientKey: randHex(32), boundRins: [], features: [], quota: cfg.defaultQuota ?? 1, locked: false, killed: false, count: 0, firstAt: now };
      dev.regId = String(b.regId || dev.regId || '').slice(0, 120); dev.name = String(b.name).trim().slice(0, 120); dev.email = email;
      dev.phone = String(b.phone || '').trim().slice(0, 40); dev.company = String(b.company || '').trim().slice(0, 160);
      dev.taxpayerName = String(b.taxpayerName || '').trim().slice(0, 200);
      dev.version = String(b.version || '').slice(0, 24) || dev.version;
      dev.emailVerified = ev.verified;
      dev.country = (request.cf && request.cf.country) || dev.country || '';
      dev.lastRin = rin; dev.lastSeen = now; dev.count = (dev.count || 0) + 1;
      // Bind + ATOMICALLY claim the RIN. Claim ONLY when we actually bind (never squat a RIN we're over quota to
      // hold). A losing claim means another account owns it → 409, with no half-bound record left behind.
      if (!dev.boundRins.includes(rin)) {
        if (dev.boundRins.length < (dev.quota ?? 1)) {   // ?? so a deliberate quota 0 binds nothing
          const claim = await rinClaim(env, rin, deviceId);
          if (!claim.ok) return regFail('rin_claimed', 'This registration number is already registered to another account. If this is your RIN (e.g. you cleared browser storage or moved devices), ask the admin to move it to your account.', 409);
          dev.boundRins.push(rin);
        }
      } else {
        await rinClaim(env, rin, deviceId);   // returning device: re-affirm ownership (idempotent when already owner)
      }
      await putDev(env, dev);
      // email → device index (for per-user grouping)
      const idxKey = 'email:' + email; const idx = (await env.LEADS.get(idxKey, 'json')) || [];
      if (!idx.includes(deviceId)) { idx.push(deviceId); await env.LEADS.put(idxKey, JSON.stringify(idx)); }
      const allowed = dev.boundRins.includes(rin) && !dev.locked && !dev.killed && !cfg.globalKill;
      return json({ ok: true, clientKey: dev.clientKey, features: dev.features, boundRins: dev.boundRins, quota: dev.quota, allowed });
    }

    // ── session check-in (signed) — the enforcement source of truth ──────────
    if (request.method === 'POST' && path === '/session') {
      const body = await request.text();
      const dev = await verifySigned(env, request, body);
      if (!dev) {
        // Distinguish a DELETED/unknown device (client must re-register → gate reappears) from a transient
        // signature/skew/nonce failure on a device that still exists (client keeps its grace verdict).
        const known = await getDev(env, request.headers.get('x-device-id') || '');
        await errlog(env, request, 'sig_fail', { known: !!known });
        return json({ ok: false, error: known ? 'unauthorized' : 'not registered' }, 401);
      }
      let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
      const rin = cleanRin(b.rin);
      const version = String(b.version || '').slice(0, 24);
      const cfg = await getCfg(env);
      // Telemetry ONLY → a SEPARATE seen: key. /session must never rewrite the dev record, or a stale snapshot
      // would silently clobber admin-owned fields (killed / locked / superadmin / quota / boundRins) written
      // concurrently by /api/user (KV is last-writer-wins with no CAS). Admin read paths merge seen: for display.
      // Usage counters ride the same seen: put (counts only — disclosed in the privacy policy). MAX-merge:
      // a device whose localStorage was cleared restarts at 0 and must never regress the dashboard.
      const prevSeen = (await env.LEADS.get('seen:' + dev.deviceId, 'json')) || {};
      const st = (b.stats && typeof b.stats === 'object') ? b.stats : null;
      const capN = (v) => Math.max(0, Math.min(1e9, Number(v) || 0));
      await env.LEADS.put('seen:' + dev.deviceId, JSON.stringify({
        lastSeen: new Date().toISOString(), lastRin: rin || dev.lastRin || '', version: version || dev.version || '',
        exports: Math.max(capN(st && st.runs), prevSeen.exports || 0),
        docs: Math.max(capN(st && st.docs), prevSeen.docs || 0),
        pdfs: Math.max(capN(st && st.pdfs), prevSeen.pdfs || 0),
        lastExportAt: String((st && st.lastExportAt) || prevSeen.lastExportAt || '').slice(0, 40),
      }));
      const sa = !!dev.superadmin;                                     // superadmin → works on ANY account
      const globalKill = !!cfg.globalKill;                            // reversible service-wide emergency stop
      const killed = !!dev.killed || globalKill;                       // emergency stop still applies to everyone
      const locked = !!dev.locked && !sa;                             // superadmin bypasses its own lock
      let allowed = true, reason = '';
      if (killed) { allowed = false; reason = dev.killed ? 'killed' : 'global_stop'; }   // distinguish a per-device kill from a reversible global pause
      else if (locked) { allowed = false; reason = 'locked'; }
      else if (isVersionBlocked(cfg, version)) { allowed = false; reason = 'update_required'; }   // version kill switch — applies to everyone, superadmins included
      else if (!sa) {                                                  // superadmin skips void + allow-list entirely
        if (rin) {
          if (await isVoided(env, rin)) { allowed = false; reason = 'rin_voided'; }
          else if (!(dev.boundRins || []).includes(rin)) { allowed = false; reason = 'rin_not_allowed'; }
        } else {                                                       // no specific RIN supplied → require at least one bound, non-voided RIN
          let usable = false;
          for (const r of (dev.boundRins || [])) { if (!(await isVoided(env, r))) { usable = true; break; } }
          if (!usable) { allowed = false; reason = 'no_usable_rin'; }
        }
      }
      // Optional broadcast banner: the admin sets cfg.announcement { text, level, until? }; every allowed
      // extension surfaces it (a soft channel that isn't the kill-switch sledgehammer). Expired/empty → omit.
      let announcement = null;
      const ann = cfg.announcement;
      if (ann && ann.text && (!ann.until || Date.parse(ann.until) > Date.now())) {
        announcement = { text: String(ann.text).slice(0, 400), level: ann.level === 'warn' || ann.level === 'alert' ? ann.level : 'info', id: ann.id || '' };
      }
      return json({ ok: true, allowed, locked, killed, globalKill, reason, superadmin: sa, features: dev.features || [], boundRins: dev.boundRins || [], quota: dev.quota ?? 1, canRequestRin: true, announcement, message: dev.message || null });
    }

    // ── request another RIN (signed) ─────────────────────────────────────────
    if (request.method === 'POST' && path === '/rin-request') {
      const body = await request.text();
      const dev = await verifySigned(env, request, body);
      if (!dev) { await errlog(env, request, 'sig_fail', { tag: 'rinreq' }); return json({ ok: false, error: 'unauthorized' }, 401); }
      if (!(await deviceRate(env, 'rinreq', dev.deviceId, 20, 3600000))) { await errlog(env, request, 'rate_limit', { tag: 'rinreq' }); return json({ ok: false, error: 'Too many requests from this device — please try again later.' }, 429); }
      let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
      const requestedRin = cleanRin(b.requestedRin || dev.lastRin);
      if (!requestedRin) { await errlog(env, request, 'bad_request', { tag: 'rinreq' }); return json({ ok: false, error: 'no rin' }, 400); }
      if ((dev.boundRins || []).includes(requestedRin)) return json({ ok: true, already: true });
      // Dedupe: a pending request from this device for this RIN already exists → don't stack duplicates
      // (the in-tool button makes repeat clicks easy; the extra reads are cheap, writes are not).
      const dup = (await listPrefix(env, 'req:')).find((r) => r.status === 'pending' && r.deviceId === dev.deviceId && r.requestedRin === requestedRin);
      if (dup) return json({ ok: true, pending: true, id: dup.id });
      const id = randHex(8);
      await env.LEADS.put('req:' + id, JSON.stringify({ id, deviceId: dev.deviceId, email: dev.email, name: dev.name, requestedRin, note: String(b.note || '').slice(0, 300), status: 'pending', at: new Date().toISOString() }));
      return json({ ok: true, id });
    }

    // ── report a bug (signed) ────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/bug') {
      const body = await request.text();
      const dev = await verifySigned(env, request, body);
      if (!dev) { await errlog(env, request, 'sig_fail', { tag: 'bug' }); return json({ ok: false, error: 'unauthorized' }, 401); }
      if (!(await deviceRate(env, 'bug', dev.deviceId, 30, 3600000))) { await errlog(env, request, 'rate_limit', { tag: 'bug' }); return json({ ok: false, error: 'Too many reports from this device — please try again later.' }, 429); }
      let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
      const message = String(b.message || '').trim().slice(0, 2000);
      if (!message) { await errlog(env, request, 'bad_request', { tag: 'bug' }); return json({ ok: false, error: 'empty' }, 400); }
      // Optional client diagnostics (new clients attach recent run-log lines + a run summary; old clients
      // send message only). Sanitize + hard-cap everything — it rides the same single KV put as the bug.
      let diag;
      if (b.diag && typeof b.diag === 'object') {
        const log = Array.isArray(b.diag.log) ? b.diag.log.slice(-60).map((s) => String(s).slice(0, 300)) : [];
        while (log.length && JSON.stringify(log).length > 8192) log.shift();   // ≤8KB of log tail
        const p = b.diag.plan && typeof b.diag.plan === 'object' ? b.diag.plan : null;
        diag = {
          version: String(b.diag.version || '').slice(0, 24), last: String(b.diag.last || '').slice(0, 300), log,
          plan: p ? { source: String(p.source || '').slice(0, 16), year: String(p.year || '').slice(0, 12), from: String(p.from || '').slice(0, 10), to: String(p.to || '').slice(0, 10), chunks: p.chunks | 0, done: p.done | 0, failed: p.failed | 0, rows: p.rows | 0, pdf: !!p.pdf } : null,
        };
      }
      const id = randHex(8);
      const seen = await env.LEADS.get('seen:' + dev.deviceId, 'json');   // prefer the RIN active at report time (seen:), not the frozen registration RIN
      const rin = (seen && seen.lastRin) || dev.lastRin || '';
      await env.LEADS.put('bug:' + id, JSON.stringify({ id, deviceId: dev.deviceId, email: dev.email, name: dev.name, rin, message, ...(diag ? { diag } : {}), ua: request.headers.get('user-agent') || '', status: 'open', at: new Date().toISOString() }));
      return json({ ok: true, id });
    }

  return null;
}
