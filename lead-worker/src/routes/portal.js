// SPEC-017 slice 1 — the admin portal API: Dashboard, Users, Clients, and the one-shot migration.
//
//   GET  /api/dashboard   what is happening right now: counters, live runs, alerts, recent events
//   GET  /api/users       searchable/filterable people (NOT devices) · GET /api/user?email= drills in
//   POST /api/user        { email, action, value }
//   GET  /api/clients     one row per TRN, with the person who manages it · GET /api/client?rin=
//   POST /api/client      { rin, action, value }
//   POST /api/migrate     rebuild users/clients/devices from the KV dev: records (idempotent)
//
// Slice 2 adds the Jobs section and slice 3 the plans that entitlement now reads:
//   GET  /api/jobs        every run, filterable by state/user/rin and by `stuck=1`
//   GET  /api/job?id=     one run with its chunk plan · POST /api/job { id, action:abandon|purge }
//   GET  /api/plans       the sellable plans · POST /api/plan (upsert) · POST /api/plan/delete
//
// These read D1 while the extension API still enforces from KV — that split is deliberate and lasts
// until slice 3. Two consequences are load-bearing:
//   · the state changes that KV can actually enforce (lock/kill/super/quota/features/void) are
//     MIRRORED back into KV here, because a portal button that changes nothing a device can see is
//     worse than no button;
//   · the ones KV has no concept of (plan, valid_until, note, tags) stay in D1 only.
//
// /api/users and /api/user are SHARED PATHS with the legacy KV dashboard in routes/admin.js. GET
// /api/users is redefined by the SPEC-017 contract and is served here. POST /api/user is
// discriminated by its body: `{ email, … }` is a portal action, `{ deviceId, … }` is a legacy
// per-device action and falls through to admin.js untouched.
import { json, cleanRin, randHex } from '../lib/util.js';
import { getDev, putDev, listPrefix, withSeen } from '../lib/kv.js';
import { audit } from '../lib/audit.js';
import {
  hasDb, ensureSchema, migrate, listUsers, getUser, listClients, getClient, listDevices,
  listJobs, listActiveJobs, dashboardStats, listExpiring, setUserField, deleteUser,
  setClientVoided, moveClient, listJobsPage, getJobRow, setJobState, purgeJobChunks,
  listPlans, getPlan, upsertPlan, deletePlan, countPlanUsers, resolveEntitlement,
  listFeatures, getFeature, upsertFeature, deleteFeature, countFeatureGrants, checkFeatureIds,
  featureId, CUSTOM_PLAN,
} from '../users.js';
import { getChunks, getEvents } from '../jobs.js';

const OURS = new Set([
  '/api/dashboard', '/api/users', '/api/user', '/api/clients', '/api/client', '/api/migrate',
  '/api/jobs', '/api/job', '/api/plans', '/api/plan', '/api/plan/delete',
  '/api/features', '/api/feature', '/api/feature/delete',
]);

const STALE_MS = 30 * 60000;      // a run that hasn't checkpointed in half an hour is stuck, not slow
const EXPIRY_DAYS = 14;           // "expiring soon" — long enough to renew, short enough to matter
const ERR_SPIKE = 20;             // extension failures in the last hour before it is worth a phone call

export async function portalRoutes(request, env, url, path, admin) {
  if (!OURS.has(path)) return null;

  // Read the body from a CLONE: a legacy /api/user call must reach admin.js with its stream intact.
  let b = {};
  if (request.method === 'POST') { try { b = await request.clone().json(); } catch { b = {}; } }
  if (path === '/api/user' && request.method === 'POST' && !b.email) return null;   // legacy deviceId action

  if (!admin()) return json({ ok: false, error: 'unauthorized' }, 401);
  // No D1 (the default wrangler target binds none): say so plainly for the new endpoints, but hand
  // GET /api/users back to the KV dashboard rather than 503ing a page that worked yesterday.
  if (!hasDb(env)) return (path === '/api/users' && request.method === 'GET')
    ? null : json({ ok: false, error: 'portal unavailable — no D1 binding' }, 503);
  // Once per portal request, not per endpoint. Every read shape here now depends on a schema that
  // grows with the specs — users.device_quota and the features table arrived with SPEC-019 — and a
  // console that 500s on a page which worked yesterday, because nobody thought to press Migrate
  // first, is a worse trade than one idempotent DDL batch on an admin-only surface.
  await ensureSchema(env);

  // ── dashboard ───────────────────────────────────────────────────────────────────────────────────
  if (request.method === 'GET' && path === '/api/dashboard') {
    const now = Date.now();
    const since = new Date(now).toISOString().slice(0, 10);                       // midnight UTC today
    const horizon = new Date(now + EXPIRY_DAYS * 86400000).toISOString();
    const [st, active, expiring, recentJobs, auditRows, errRows, bugs, reqs] = await Promise.all([
      dashboardStats(env, { since, horizon }),
      listActiveJobs(env),
      listExpiring(env, horizon),
      listJobs(env, { limit: 10 }),
      newest(env, 'audit:', 20),
      newest(env, 'err:', 100),
      listPrefix(env, 'bug:'),
      listPrefix(env, 'req:'),
    ]);

    const stats = {
      users: st.users | 0, clients: st.clients | 0, devices: st.devices | 0,
      activeJobs: st.active_jobs | 0, jobsToday: st.jobs_today | 0, docsToday: st.docs_today | 0,
      openBugs: bugs.filter((g) => g.status === 'open').length,
      pendingRequests: reqs.filter((r) => r.status === 'pending').length,
      expiringSoon: st.expiring_soon | 0,
    };

    const alerts = [];
    for (const j of active) {
      // Only a run that claims to be MOVING can be stuck; 'planned' is a plan waiting for the user
      // to press Download, which is a normal resting state and not something to page anyone about.
      if (!['running', 'merging'].includes(j.state)) continue;
      const age = now - Date.parse(j.updated_at || '') || 0;
      if (age > STALE_MS) alerts.push({ level: 'alert', text: `Export ${j.id.slice(0, 8)} has not checkpointed in ${Math.round(age / 60000)} min (${j.user_email || 'unknown user'})`, ref: j.id });
    }
    for (const u of expiring) alerts.push({ level: 'warn', text: `${u.name || u.email} expires ${String(u.valid_until).slice(0, 10)}`, ref: u.email });
    const errHour = errRows.filter((e) => now - Date.parse(e.at || '') < 3600000).length;
    if (errHour > ERR_SPIKE) alerts.push({ level: 'alert', text: `${errHour} extension failures in the last hour`, ref: '' });

    const recent = [
      ...auditRows.map((a) => ({ at: a.at, kind: 'admin', text: `${a.action} · ${a.target || '—'}`, ref: a.target || '' })),
      ...recentJobs.map((j) => ({ at: j.created_at, kind: 'job', text: `${j.source || 'export'} ${j.state} · ${j.rin || '—'} (${j.user_email || 'unknown'})`, ref: j.id })),
    ].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 20);

    return json({
      ok: true, stats, alerts, recent,
      active: active.map((j) => ({
        jobId: j.id, user: j.user_email || '', rin: j.rin || '', source: j.source || '',
        state: j.state, done: j.done_count | 0, total: j.total_chunks | 0, updatedAt: j.updated_at || '',
      })),
    });
  }

  // ── users ───────────────────────────────────────────────────────────────────────────────────────
  if (request.method === 'GET' && path === '/api/users') {
    const { users, total } = await listUsers(env, {
      q: url.searchParams.get('q') || '', status: url.searchParams.get('status') || '',
      plan: url.searchParams.get('plan') || '', page: url.searchParams.get('page') || 1,
    });
    return json({ ok: true, users: users.map(shapeUser), total });
  }

  if (request.method === 'GET' && path === '/api/user') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const user = email ? await getUser(env, email) : null;
    if (!user) return json({ ok: false, error: 'no such user' }, 404);
    const [clients, devices, jobs, auditRows] = await Promise.all([
      listClients(env, { userEmail: email }),
      listDevices(env, email),
      listJobs(env, { userEmail: email }),
      newest(env, 'audit:', 300),
    ]);
    const ids = new Set(devices.map((d) => d.device_id));
    const bugs = (await listPrefix(env, 'bug:')).filter((g) => String(g.email || '').toLowerCase() === email || ids.has(g.deviceId));
    // What this account actually gets AND where each number came from. The portal has to be able to
    // print "25 clients (from pro)" against "12 clients (custom)": an admin who cannot tell an
    // inherited number from a negotiated one will eventually edit the plan to fix one account.
    const ent = await resolveEntitlement(env, email);
    return json({
      ok: true, user: shapeUser(user), entitlement: shapeEntitlement(ent, devices.length),
      clients: clients.clients.map(shapeClient), devices: devices.map(shapeDevice), jobs: jobs.map(shapeJob),
      bugs: bugs.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 50),
      // Audit keys carry no index, so filtering happens here: the trail records device ids (legacy
      // actions) as well as emails (portal actions), and both belong on one person's timeline.
      audit: auditRows.filter((a) => String(a.target || '').toLowerCase() === email || ids.has(a.target)).slice(0, 50),
    });
  }

  if (request.method === 'POST' && path === '/api/user') {
    const email = String(b.email || '').trim().toLowerCase();
    const user = await getUser(env, email);
    if (!user) return json({ ok: false, error: 'no such user' }, 404);
    let detail = { action: b.action };

    switch (b.action) {
      case 'lock': await setUserField(env, email, 'status', 'locked'); await mirrorKv(env, email, (d) => { d.locked = true; }); break;
      // Unlock/revive only undo their own state: unlocking a KILLED account must not quietly revive it.
      case 'unlock': if (user.status === 'locked') await setUserField(env, email, 'status', 'active'); await mirrorKv(env, email, (d) => { d.locked = false; }); break;
      case 'kill': await setUserField(env, email, 'status', 'killed'); await mirrorKv(env, email, (d) => { d.killed = true; }); break;
      case 'revive': if (user.status === 'killed') await setUserField(env, email, 'status', 'active'); await mirrorKv(env, email, (d) => { d.killed = false; }); break;
      case 'super': await setUserField(env, email, 'superadmin', 1); await mirrorKv(env, email, (d) => { d.superadmin = true; }); break;
      case 'unsuper': await setUserField(env, email, 'superadmin', 0); await mirrorKv(env, email, (d) => { d.superadmin = false; }); break;
      case 'setQuota': {
        const q = Math.max(0, b.value | 0);
        // The mirror writes the SAME number to every device, which is the pre-slice-3 truth: quota is
        // still enforced per device, so a two-device user can still hold 2q RINs. Slice 3 closes it;
        // until then the portal must not pretend otherwise.
        await setUserField(env, email, 'quota', q); await mirrorKv(env, email, (d) => { d.quota = q; });
        detail.value = q; break;
      }
      // SPEC-019: how many BROWSERS this person may register. NULL clears the override and hands
      // them back to their plan — the same reading setFeatures uses for an empty list, so clearing a
      // field never means "zero" by accident.
      case 'setDeviceQuota': {
        const v = numOrNull(b.value);
        await setUserField(env, email, 'device_quota', v);
        detail.value = v; break;
      }
      case 'setPlan': await setUserField(env, email, 'plan', String(b.value || 'free').slice(0, 40)); detail.value = b.value; break;
      case 'setValidUntil': await setUserField(env, email, 'valid_until', String(b.value || '').slice(0, 40)); detail.value = b.value; break;
      case 'setFeatures': {
        const f = toList(b.value);
        // Only ids that exist AND are active may be newly granted. Before the catalogue, a typo here
        // produced a feature nobody would ever hold and no error whatsoever. Note what this does NOT
        // do: it never inspects what the user already holds, so deactivating a feature cannot revoke
        // an existing grant — that is a support call, not a config change.
        const bad = await checkFeatureIds(env, f);
        if (bad.bad.length) return featureRefusal(bad);
        await setUserField(env, email, 'features', JSON.stringify(f)); await mirrorKv(env, email, (d) => { d.features = f; });
        detail.value = f; break;
      }
      // The one-way admin → device message. It is KV-only by nature: /session reads it from the dev:
      // record and it is the ONLY channel that reaches a blocked user to tell them why. Keyed by
      // person here, so it fans out to every device they own — a message meant for someone should
      // not depend on which browser they happen to open.
      case 'setMessage': {
        const v = b.value || {};
        const text = String(v.text || '').trim().slice(0, 400);
        if (!text) return json({ ok: false, error: 'empty message' }, 400);
        const level = (v.level === 'warn' || v.level === 'alert') ? v.level : 'info';
        const n = await mirrorKv(env, email, (d) => { d.message = { text, level, id: randHex(4), at: new Date().toISOString() }; });
        if (!n) return json({ ok: false, error: 'this user has no device to deliver a message to' }, 409);
        detail.value = text.slice(0, 60); break;
      }
      case 'clearMessage': await mirrorKv(env, email, (d) => { delete d.message; }); break;
      case 'setNote': await setUserField(env, email, 'note', String(b.value || '').slice(0, 2000)); detail.value = '(note)'; break;
      case 'setTags': await setUserField(env, email, 'tags', toList(b.value).slice(0, 20).join(',')); detail.value = b.value; break;
      case 'delete':
        // D1 only. The KV account survives on purpose: it is what the extension still enforces
        // against, and deleting it from a new surface would be an unreviewable second delete path.
        await deleteUser(env, email);
        await audit(env, 'user:delete', email, { name: user.name }, 'token');
        return json({ ok: true, deleted: true });
      default: return json({ ok: false, error: 'unknown action' }, 400);
    }
    await audit(env, 'user:' + b.action, email, detail, 'token');
    return json({ ok: true, user: shapeUser(await getUser(env, email)) });
  }

  // ── clients ─────────────────────────────────────────────────────────────────────────────────────
  if (request.method === 'GET' && path === '/api/clients') {
    const { clients, total } = await listClients(env, {
      q: url.searchParams.get('q') || '', page: url.searchParams.get('page') || 1,
    });
    return json({ ok: true, clients: clients.map(shapeClient), total });
  }

  if (request.method === 'GET' && path === '/api/client') {
    const rin = cleanRin(url.searchParams.get('rin'));
    const client = rin ? await getClient(env, rin) : null;
    if (!client) return json({ ok: false, error: 'no such client' }, 404);
    const user = client.user_email ? await getUser(env, client.user_email) : null;
    const jobs = await listJobs(env, { rin });
    return json({ ok: true, client: shapeClient(client), user: user ? shapeUser(user) : null, jobs: jobs.map(shapeJob) });
  }

  if (request.method === 'POST' && path === '/api/client') {
    const rin = cleanRin(b.rin);
    const client = rin ? await getClient(env, rin) : null;
    if (!client) return json({ ok: false, error: 'no such client' }, 404);
    let detail = { action: b.action };

    if (b.action === 'void' || b.action === 'unvoid') {
      const voided = b.action === 'void';
      await setClientVoided(env, rin, voided);
      // The KV void: blacklist is what /register and /session actually check — keep them in step or
      // the portal's void badge is decoration.
      try {
        if (voided) await env.LEADS.put('void:' + rin, new Date().toISOString());
        else await env.LEADS.delete('void:' + rin);
      } catch {}
    } else if (b.action === 'move') {
      const to = String(b.value || '').trim().toLowerCase();
      if (!to) return json({ ok: false, error: 'no target email' }, 400);
      if (!(await getUser(env, to))) return json({ ok: false, error: 'target user not found' }, 404);
      if (to === String(client.user_email || '')) return json({ ok: false, error: 'already owned by that user' }, 400);
      await moveClient(env, rin, to);
      // The rinowner: Durable Object is NOT touched. It arbitrates which DEVICE may claim a RIN and
      // is still what the extension obeys; moving the portal's record of who manages a taxpayer is a
      // different question, and conflating them here would silently re-point a live registration.
      detail = { action: 'move', from: client.user_email || '', to };
    } else {
      return json({ ok: false, error: 'unknown action' }, 400);
    }
    await audit(env, 'client:' + b.action, rin, detail, 'token');
    return json({ ok: true, client: shapeClient(await getClient(env, rin)) });
  }

  // ── jobs (slice 2) ──────────────────────────────────────────────────────────────────────────────
  if (request.method === 'GET' && path === '/api/jobs') {
    const { jobs, total } = await listJobsPage(env, {
      state: url.searchParams.get('state') || '', userEmail: url.searchParams.get('user') || '',
      rin: url.searchParams.get('rin') || '', stuck: url.searchParams.get('stuck') === '1',
      page: url.searchParams.get('page') || 1,
      // The 30-minute line is computed HERE and bound as a value, so "stuck" means the same thing on
      // the dashboard alerts and in this filter — two hard-coded intervals would drift.
      staleBefore: new Date(Date.now() - STALE_MS).toISOString(),
    });
    return json({ ok: true, jobs: jobs.map(shapeJob), total });
  }

  if (request.method === 'GET' && path === '/api/job') {
    const id = jobId(url.searchParams.get('id'));
    const job = id ? await getJobRow(env, id) : null;
    if (!job) return json({ ok: false, error: 'no such job' }, 404);
    // Empty for a finished run: chunks are dropped at 'done' (jobs.js checkpoint) and by `purge`
    // below. That is the retention rule, not a missing record — the job row still says what ran.
    const chunks = await getChunks(env, id);
    // State it rather than leave the UI to infer it. "The plan was purged" and "this job never had a
    // plan" produce the same empty array but mean opposite things to whoever is reading the screen —
    // one is retention working, the other is a run that failed before it planned anything.
    const purged = chunks.length === 0 && (job.total_chunks | 0) > 0;
    // SPEC-018 Part B: what the run DID, not only what it is — the status lines the extension
    // shipped while it ran, oldest first, so the detail page can tail them. Capped at 200 newest by
    // the writer and purged with the chunks at 'done', so a finished run answers with an empty
    // array for the same retention reason its plan is gone.
    const events = await getEvents(env, id);
    return json({
      ok: true, job: shapeJob(job), chunks: chunks.map(shapeChunk), purged,
      events: events.map((e) => ({ at: e.at || '', level: e.level || 'info', kind: e.kind || null, text: e.text || '' })),
    });
  }

  if (request.method === 'POST' && path === '/api/job') {
    const id = jobId(b.id);
    const job = id ? await getJobRow(env, id) : null;
    if (!job) return json({ ok: false, error: 'no such job' }, 404);

    if (b.action === 'abandon') {
      // 'abandoned' is also the state /job/resumable excludes, so this does both halves of the job:
      // the run stops counting as live on the dashboard AND the drawer stops offering the user a
      // resume that support has already written off.
      await setJobState(env, id, 'abandoned');
    } else if (b.action === 'purge') {
      // The chunk rows only — the jobs row survives, exactly as checkpoint() does on 'done'. What
      // was exported stays in the history; the range-by-range working detail about a taxpayer's
      // activity does not. The user-visible cost: an unfinished run purged this way can no longer be
      // resumed (/job/plan answers 410), which is why it is an explicit button and not a sweeper.
      await purgeJobChunks(env, id);
    } else {
      return json({ ok: false, error: 'unknown action' }, 400);
    }
    await audit(env, 'job:' + b.action, id, { action: b.action, user: job.user_email || '', rin: job.rin || '' }, 'token');
    return json({ ok: true, job: shapeJob(await getJobRow(env, id)) });
  }

  // ── plans (slice 3) ─────────────────────────────────────────────────────────────────────────────
  // The plans table and its three defaults are what entitlement resolves against, and an environment
  // where ensureSchema had never run would otherwise show an empty Plans tab that silently means
  // "nobody has any features" — hence the schema call at the top of this router.
  if (request.method === 'GET' && path === '/api/plans') {
    return json({ ok: true, plans: (await listPlans(env)).map(shapePlan) });
  }

  if (request.method === 'POST' && path === '/api/plan') {
    const id = String(b.id || '').trim().toLowerCase().slice(0, 40);
    if (!id) return json({ ok: false, error: 'plan id required' }, 400);
    // 'custom' already means "this account's numbers are written on the account". A plan with the
    // same id would give one word two meanings and make an account's allowance depend on which
    // meaning the resolver reached first.
    if (id === CUSTOM_PLAN) return json({ ok: false, error: "'custom' is a reserved account type, not a plan — set an account's plan to custom to give it negotiated numbers" }, 400);
    const features = toList(b.features).slice(0, 40);
    const bad = await checkFeatureIds(env, features);
    if (bad.bad.length) return featureRefusal(bad);
    await upsertPlan(env, {
      id, name: b.name || id, quota: b.quota, deviceQuota: numOrNull(b.deviceQuota), features, price: b.price,
      active: b.active === undefined ? true : !!b.active,       // omitted means active: a new plan nobody can be put on is not a plan
    });
    await audit(env, 'plan:upsert', id, { quota: b.quota | 0, deviceQuota: b.deviceQuota, features }, 'token');
    return json({ ok: true, plan: shapePlan(await getPlan(env, id)) });
  }

  if (request.method === 'POST' && path === '/api/plan/delete') {
    const id = String(b.id || '').trim().toLowerCase().slice(0, 40);
    if (!id) return json({ ok: false, error: 'plan id required' }, 400);
    const n = await countPlanUsers(env, id);
    // Refused, never cascaded. Deleting a plan out from under its users would resolve their features
    // and their plan quota to nothing on the next check-in — a silent downgrade nobody asked for and
    // nobody would see until a user reported a missing tab. Name the count so the admin can judge
    // the size of the move they are being asked to make first.
    if (n) return json({ ok: false, error: n + ' user' + (n === 1 ? ' is' : 's are') + " still on plan '" + id + "' — move them to another plan first", users: n }, 409);
    await deletePlan(env, id);
    await audit(env, 'plan:delete', id, {}, 'token');
    return json({ ok: true, deleted: true });
  }

  // ── feature catalogue (SPEC-019) ────────────────────────────────────────────────────────────────
  // Features stop being a vocabulary hard-coded in the portal UI and become rows an admin owns.
  // What a row CANNOT do is gate anything by itself: `auto-reject` opens the Rejection tab because
  // src/ui/flow.js asks for that id by name. A brand-new feature is a sellable label until somebody
  // wires the one line that checks it, and the portal says so where features are created.
  if (request.method === 'GET' && path === '/api/features') {
    return json({ ok: true, features: (await listFeatures(env)).map(shapeFeature) });
  }

  if (request.method === 'POST' && path === '/api/feature') {
    const id = featureId(b.id);
    if (!id) return json({ ok: false, error: 'feature id required (lowercase slug)' }, 400);
    const existing = await getFeature(env, id);
    await upsertFeature(env, {
      id, name: b.name || id, description: b.description,
      active: b.active === undefined ? true : !!b.active,       // omitted means active, as for plans
    });
    await audit(env, 'feature:upsert', id, { created: !existing, active: b.active !== false }, 'token');
    return json({ ok: true, feature: shapeFeature(await getFeature(env, id)), created: !existing });
  }

  if (request.method === 'POST' && path === '/api/feature/delete') {
    const id = featureId(b.id);
    if (!id) return json({ ok: false, error: 'feature id required' }, 400);
    const n = await countFeatureGrants(env, id);
    // Refused, never cascaded — the same rule as deleting a plan, for a sharper reason: a grant
    // stores the id as a string, so deleting the row would leave live grants pointing at nothing.
    // Both counts are named because they need different fixes: a plan is one edit, N users are N.
    // Deactivating instead is the safe move, and it is what the message should push an admin toward.
    if (n.plans || n.users) {
      return json({
        ok: false, plans: n.plans, users: n.users,
        error: `'${id}' is still granted by ${n.plans} plan${n.plans === 1 ? '' : 's'} and ${n.users} user${n.users === 1 ? '' : 's'} — remove those grants first, or deactivate it instead to stop new ones without taking it away from anybody`,
      }, 409);
    }
    await deleteFeature(env, id);
    await audit(env, 'feature:delete', id, {}, 'token');
    return json({ ok: true, deleted: true });
  }

  // ── migration ───────────────────────────────────────────────────────────────────────────────────
  if (request.method === 'POST' && path === '/api/migrate') {
    const devices = await withSeen(env, await listPrefix(env, 'dev:'));
    const report = await migrate(env, devices);
    await audit(env, 'migrate', '', { users: report.users, clients: report.clients, devices: report.devices, conflicts: report.conflicts.length }, 'token');
    return json({ ok: true, ...report });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
// audit:/err: keys embed a DESCENDING timestamp, so the first n keys of a prefix scan are the n
// newest records — no sorting and no full scan of a 180-day trail.
async function newest(env, prefix, n) {
  const names = []; let cursor;
  do {
    const l = await env.LEADS.list({ prefix, cursor });
    for (const k of l.keys) names.push(k.name);
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor && names.length < n * 2);
  const slice = names.slice(0, n), out = [];
  for (let i = 0; i < slice.length; i += 100) {
    const part = slice.slice(i, i + 100);
    const map = await env.LEADS.get(part, 'json');
    for (const key of part) { const v = map.get(key); if (v) out.push(v); }
  }
  return out;
}

/**
 * Apply a state change to every KV device of this user. Best-effort: the D1 write is the portal's
 * record and has already happened, and a KV hiccup must not turn a successful action into a 500.
 */
async function mirrorKv(env, email, apply) {
  try {
    const ids = (await env.LEADS.get('email:' + email, 'json')) || [];
    for (const id of ids) {
      const dev = await getDev(env, id);
      if (!dev) continue;
      apply(dev);
      await putDev(env, dev);
    }
    return ids.length;
  } catch { return 0; }
}

const toList = (v) => (Array.isArray(v) ? v.map(String) : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);
const parseJson = (v, fallback) => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : fallback; } catch { return fallback; } };

// '' / null / undefined mean "not set" — NOT zero. An allowance field cleared in a form must hand the
// account back to its plan, not silently cap it at nothing.
const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Math.max(0, Math.min(1e6, Math.trunc(Number(v) || 0))));

/**
 * One refusal for both grant paths (a plan's features and a user's). It names the offending ids —
 * the whole point of a catalogue is that it can say no, and a "no" that does not say which id was
 * wrong just moves the guessing to the admin.
 */
const featureRefusal = (bad) => json({
  ok: false, unknown: bad.unknown, inactive: bad.inactive,
  error: 'cannot grant ' + bad.bad.map((f) => `'${f}'`).join(', ') + ' — '
    + [
      bad.unknown.length ? `not in the feature catalogue (${bad.unknown.join(', ')})` : '',
      bad.inactive.length ? `inactive, so it can no longer be newly granted (${bad.inactive.join(', ')})` : '',
    ].filter(Boolean).join('; '),
}, 400);

const shapeUser = (u) => u && ({
  email: u.email, name: u.name || '', company: u.company || '', plan: u.plan || 'free',
  // deviceQuota is null when the account inherits its plan's allowance — the portal must be able to
  // render an empty box rather than a number the admin never typed.
  quota: u.quota | 0, deviceQuota: u.device_quota == null ? null : u.device_quota | 0,
  clientCount: u.client_count | 0, deviceCount: u.device_count | 0,
  jobCount: u.job_count | 0, docs: u.docs | 0, status: u.status || 'active',
  validUntil: u.valid_until || '', lastSeen: u.last_seen || '',
  tags: String(u.tags || '').split(',').filter(Boolean),
  // Additive to the contract's user shape — the drill-in page needs them and a list row can ignore them.
  note: u.note || '', features: parseJson(u.features, []), superadmin: !!u.superadmin,
  country: u.country || '', createdAt: u.created_at || '',
});

const shapeClient = (c) => c && ({
  rin: c.rin, company: c.company || '', userEmail: c.user_email || '', userName: c.user_name || '',
  voided: !!c.voided, jobCount: c.job_count | 0, docs: c.docs | 0,
  lastExportAt: c.last_export_at || '', createdAt: c.created_at || '',
});

const shapeDevice = (d) => ({
  deviceId: d.device_id, version: d.version || '', country: d.country || '',
  lastSeen: d.last_seen || '', lastRin: d.last_rin || '',
  exports: d.exports | 0, docs: d.docs | 0, pdfs: d.pdfs | 0, createdAt: d.created_at || '',
});

const jobId = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

const shapeJob = (j) => j && ({
  jobId: j.id, user: j.user_email || '', rin: j.rin || '', source: j.source || '',
  dateField: j.date_field || '', dir: j.dir || '', from: j.from_iso || '', to: j.to_iso || '',
  state: j.state, done: j.done_count | 0, failed: j.failed_count | 0, total: j.total_chunks | 0,
  rows: j.total_rows | 0, probes: j.probes | 0, version: j.version || '',
  createdAt: j.created_at || '', updatedAt: j.updated_at || '',
});

const shapeChunk = (c) => ({
  idx: c.idx | 0, chunkId: c.chunk_id || '', from: c.from_iso || '', to: c.to_iso || '',
  subF: c.sub_f || '', subT: c.sub_t || '', label: c.label || '', count: c.count | 0,
  warn: c.warn || '', state: c.state || 'pending',
});

const shapePlan = (p) => p && ({
  id: p.id, name: p.name || p.id, quota: p.quota | 0,
  // NULL resolves to the one-device floor everywhere it is read, so report the resolved number
  // rather than a blank the admin would have to interpret.
  deviceQuota: p.device_quota == null ? 1 : p.device_quota | 0,
  features: parseJson(p.features, []), price: p.price || '', active: !!p.active,
});

const shapeFeature = (f) => f && ({
  id: f.id, name: f.name || f.id, description: f.description || '',
  active: !!f.active, createdAt: f.created_at || '',
});

/**
 * The account's resolved allowance next to WHERE each number came from ('plan' | 'custom' |
 * 'override'), plus how many devices it is actually using — an account already over its cap is
 * grandfathered, not broken, and the portal needs enough to say that rather than raise an alarm.
 */
const shapeEntitlement = (e, deviceCount) => e && ({
  plan: e.plan, custom: !!e.custom,
  clients: e.quotaEff | 0, devices: e.deviceQuotaEff | 0, features: e.features,
  planClients: e.planQuota | 0, planDevices: e.planDeviceQuota | 0,
  devicesUsed: deviceCount | 0, overDevices: (deviceCount | 0) > (e.deviceQuotaEff | 0),
  // Keyed like the values above (clients/devices/features), not like the columns underneath —
  // a consumer should never have to know that the client allowance is called `quota` in SQL.
  source: { clients: e.source.quota, devices: e.source.devices, features: e.source.features },
});
