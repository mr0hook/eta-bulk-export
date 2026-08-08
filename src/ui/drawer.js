// Unified drawer UI (Shadow-DOM isolated, no remote code → system fonts). Owns the orchestrator
// and subscribes to its hooks. "Control console" aesthetic from the design concept.
import { createOrchestrator } from '../core/orchestrator.js';
import { ALL_STATUSES } from '../api/sources.js';
import { idbGet, ensurePermission, writeBlob } from '../core/fs.js';
import { mergeFolder } from '../core/merge.js';
import { repairFolder } from '../core/repair.js';
import { removableColumns, XLSX_MIME } from '../export/xlsx.js';
import { session, register, gateEnabled, taxpayerId, requestRin, reportBug, LEAD_URL, EXT_VERSION } from '../core/registration.js';
import { createRunLog } from '../core/runlog.js';
import { createEtaTracker } from '../core/eta.js';
import { lsGet, lsSet } from '../core/ls.js';
import { readProgress } from '../core/store.js';
import { deriveSyncSel } from '../core/sync.js';
import { todayYmd } from '../core/time.js';
import { t, getLang, setLang } from '../core/i18n.js';
import { defaultCfg, normalizeCfg } from '../reject/rules.js';
import { scanReceived } from '../reject/scan.js';
import { submitRejections, liveRejectAvailable, auditRuns, auditText } from '../reject/submit.js';
import { loadWindows, makeResolver } from '../reject/window.js';
import { fetchReceivedDetails } from '../reject/received.js';
import { parsePoWorkbook, projectInvoice, analyzePo } from '../reject/po.js';
import { renderPoAnalytics, renderPoTemplate, poAnalyticsName } from '../reject/po_xlsx.js';

const CSS = `
:host{ all:initial;
  /* Theme palette — omarsoliman.dev "clay & paper", dark set. The drawer stays dark on purpose: it is
     injected into the ETA portal's white SPA and has to read as a separate instrument, so the site's
     LIGHT paper palette is used only for the opt-in light theme below. data-theme flips the set.
     Two values deviate from the source system, both for contrast — see test/theme.test.mjs:
       --dim  the site's ink-4 (#7A715C) scores 3.70 on this background; AA needs 4.5 at 10-11px.
       light --gold  the site's clay-5 (#C2603B) under cream text scores 4.10; clay-6 scores 5.89. */
  --bg:#1a1712; --bg2:#131008; --bg3:#0d0b06; --bg-hd:#221e17; --bg-ft:#151209; --bg-hov:#2b261d;
  --line:#3b3527; --line2:#2b261d; --line3:#564e3a;
  --text:#f0eadb; --muted:#a39a84; --dim:#8e8571; --gate-sub:#d6b98a;
  --gold:#e08358; --gold2:#ec9a74; --gold-bd:#c2603b; --on-gold:#1a1712; --gold-chip:#3a2a20;
  --teal:#8fae97; --ok:#7cbe96; --ok-bd:#2c4a38; --ok-bg:#24342a; --err:#e08a7b; --err-bd:#4e312b; --err-bg:#3d241f;
  --info-bg:#27332b; --info-tx:#8fae97; --warn-bg:#3c321a; --warn-tx:#d9b05e;
  --focus:rgba(224,131,88,.15); --focus2:rgba(224,131,88,.18); --scrim:rgba(12,10,7,.35); --mscrim:rgba(12,10,7,.55);
  --shadow:0 18px 50px -12px rgba(0,0,0,.65); --glow:0 6px 16px -6px rgba(224,131,88,.5); --seg-shadow:0 8px 24px -8px rgba(0,0,0,.6);
  --r-lg:16px; --r:10px; --r-sm:6px;
  --dur-1:.12s; --dur-2:.2s; --dur-3:.35s; --ease-out:cubic-bezier(.22,1,.36,1);
  --scheme:dark }
:host([data-theme=light]){
  --bg:#faf6ee; --bg2:#fffdf7; --bg3:#f2ebdd; --bg-hd:#fffdf7; --bg-ft:#f2ebdd; --bg-hov:#e7dec9;
  --line:#e3dac6; --line2:#efe8d8; --line3:#c9bea3;
  --text:#231f18; --muted:#6b6453; --dim:#776e5b; --gate-sub:#7c381f;
  --gold:#7c381f; --gold2:#a04a2a; --gold-bd:#6a2f1a; --on-gold:#fffdf7; --gold-chip:#f4e2d6;
  /* The three status foregrounds are the design system's green-6 / red-6 / amber-6 darkened by a
     few percent. On their own soft backgrounds the source values land at 4.18 / 4.43 / 3.96 — just
     under AA, and these render 11px chip text. Nudged to 4.52 each; see test/theme.test.mjs. */
  --teal:#44685a; --ok:#2c754b; --ok-bd:#c4dcc9; --ok-bg:#ddebdb; --err:#b03e2e; --err-bd:#e8c9bf; --err-bg:#f4ddd4;
  --info-bg:#e2e9e0; --info-tx:#2f4f41; --warn-bg:#f3e6c2; --warn-tx:#89600e;
  --focus:rgba(160,74,42,.22); --focus2:rgba(160,74,42,.22); --scrim:rgba(35,31,24,.28); --mscrim:rgba(35,31,24,.45);
  --shadow:0 18px 40px -14px rgba(35,31,24,.22); --glow:0 6px 16px -6px rgba(160,74,42,.35); --seg-shadow:0 2px 8px rgba(35,31,24,.12);
  --scheme:light }
*{ box-sizing:border-box }
[hidden]{ display:none !important }   /* the hidden attribute must always win over any class display: rule (this bit .gate and #modal-root) */
.pill{ position:fixed; right:16px; bottom:16px; z-index:2147483647; font:600 13px system-ui,sans-serif;
  padding:10px 14px; border-radius:var(--r); border:1px solid var(--gold-bd); color:var(--on-gold); cursor:pointer;
  background:linear-gradient(var(--gold2),var(--gold)); box-shadow:var(--glow) }
.pill:hover{ filter:brightness(1.05) }
.scrim{ position:fixed; inset:0; z-index:2147483646; background:var(--scrim); opacity:0; pointer-events:none; transition:var(--dur-2) var(--ease-out) }
.scrim.on{ opacity:1; pointer-events:auto }
.drawer{ position:fixed; top:0; right:0; bottom:0; z-index:2147483647; width:404px; max-width:100vw;
  display:flex; flex-direction:column; background:var(--bg); color:var(--text); border-left:1px solid var(--line);
  box-shadow:var(--shadow); transform:translateX(100%); transition:transform var(--dur-3) var(--ease-out);
  font-family:system-ui,-apple-system,Segoe UI,sans-serif }   /* direction comes from the dir attribute (ltr default, rtl in Arabic) */
.drawer.on{ transform:none }
.num{ font-family:ui-monospace,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; direction:ltr; unicode-bidi:isolate }   /* numbers/times stay LTR inside RTL text */
.hd{ padding:16px 16px 13px; border-bottom:1px solid var(--line2); background:linear-gradient(180deg,var(--bg-hd),var(--bg)) }
.hd-top{ display:flex; justify-content:space-between; align-items:center }
.brand{ display:flex; align-items:center; gap:10px }
.seal{ width:32px;height:32px;border-radius:var(--r);display:grid;place-items:center;color:var(--on-gold);background:linear-gradient(160deg,var(--gold2),var(--gold)) }
.seal svg{ width:17px;height:17px }
.wm{ font:700 18px/1 system-ui }
/* Byline. direction/unicode-bidi keep the Latin domain intact inside the Arabic RTL header, and
   margin-inline-start flips with it. Deliberately NOT uppercase + tracked like the site's micro-labels:
   letter-spacing breaks Arabic cursive joining, and this line sits in a bilingual header. */
.by{ font:600 9px/1 ui-monospace; letter-spacing:.04em; color:var(--gold); margin-inline-start:7px;
  vertical-align:2px; direction:ltr; unicode-bidi:isolate; white-space:nowrap } .tag{ font:600 9px/1 ui-monospace; letter-spacing:.16em; text-transform:uppercase; color:var(--dim); margin-top:3px }
.x{ background:transparent;border:0;color:var(--muted);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:var(--r-sm) } .x:hover{ background:var(--bg-hov);color:var(--text) }
.chip{ display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font:600 11px/1 ui-monospace;border:1px solid var(--line);color:var(--muted);background:var(--bg2) }
.chip .dot{ width:6px;height:6px;border-radius:50%;background:currentColor }
.chip.ok{ color:var(--ok);border-color:var(--ok-bd);background:var(--ok-bg) } .chip.err{ color:var(--err);border-color:var(--err-bd);background:var(--err-bg) }
.src{ margin-top:14px; display:flex; align-items:center; justify-content:space-between; gap:10px }
.seg{ display:inline-flex;padding:3px;gap:3px;background:var(--bg2);border:1px solid var(--line);border-radius:999px }
.seg button{ border:0;background:transparent;color:var(--muted);font:600 12px system-ui;padding:6px 15px;border-radius:999px;cursor:pointer }
.seg button[aria-selected=true]{ background:var(--bg-hov);color:var(--text);box-shadow:var(--seg-shadow) }
.cap{ font:500 11px ui-monospace;color:var(--muted);text-align:end } .cap b{ color:var(--gold) }
.body{ flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:13px }
.body::-webkit-scrollbar{ width:9px } .body::-webkit-scrollbar-thumb{ background:var(--line);border-radius:var(--r);border:2px solid var(--bg) }
.card{ background:var(--bg);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px }
.sh{ display:flex;align-items:baseline;gap:9px;margin-bottom:12px }
.sh .n{ font:600 12px system-ui;color:var(--gold);width:20px;height:20px;border-radius:var(--r-sm);display:grid;place-items:center;background:var(--gold-chip) }
.sh h3{ margin:0;font:600 13px system-ui } .sh .hint{ margin-inline-start:auto;font:500 11px ui-monospace;color:var(--dim) }
.row{ display:grid;grid-template-columns:1fr 1fr;gap:10px }
label.l{ display:block;font:600 10px ui-monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:5px }
select,.ctl{ width:100%;padding:9px 11px;border-radius:var(--r-sm);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 13px system-ui;appearance:none }
input[type="date"].ctl{ appearance:auto;color-scheme:var(--scheme);direction:ltr;font:500 12px ui-monospace,monospace }
select:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--focus) }
.chips{ display:flex;flex-wrap:wrap;gap:7px }
.sc{ display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg2);color:var(--muted);font:600 11px ui-monospace;cursor:pointer;user-select:none }
.sc input{ accent-color:var(--gold);margin:0 }
.togg{ display:inline-flex;align-items:center;gap:8px;cursor:pointer;font:600 12px system-ui } .togg input{ accent-color:var(--gold) }
.folder{ display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px dashed var(--line);border-radius:var(--r-sm);background:var(--bg2);margin-top:12px }
.folder svg{ width:16px;color:var(--teal) } .folder .p{ font:500 12px ui-monospace;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.btn{ font:600 13px system-ui;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 14px;border-radius:var(--r);cursor:pointer;border:1px solid var(--line);background:var(--bg-hov);color:var(--text) }
.btn:hover{ border-color:var(--line3) } .btn.primary{ background:linear-gradient(180deg,var(--gold2),var(--gold));color:var(--on-gold);border-color:var(--gold-bd) }
.btn.sm{ padding:8px 11px;font-size:12px } .btn[disabled]{ opacity:.4;cursor:not-allowed }
.stats{ display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:var(--r);overflow:hidden;margin-top:11px }
.stat{ background:var(--bg2);padding:11px 12px } .stat .k{ font:600 10px ui-monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dim) } .stat .v{ font:600 21px ui-monospace;margin-top:2px }
.runbar{ display:flex;gap:8px } .runbar .btn{ flex:1 }
.tracker{ display:flex;gap:7px;margin:12px 0 9px } .tk{ flex:1;text-align:center;padding:8px 4px;border-radius:var(--r-sm);background:var(--bg2);border:1px solid var(--line2) }
.tk .v{ font:600 16px ui-monospace } .tk .k{ font:600 9px ui-monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-top:2px }
.tk.ok .v{ color:var(--ok) } .tk.err .v{ color:var(--err) } .tk.left .v{ color:var(--teal) }
.track{ height:8px;border-radius:999px;background:var(--bg2);border:1px solid var(--line2);overflow:hidden } .track>i{ display:block;height:100%;width:0;background:linear-gradient(90deg,var(--teal),var(--gold));transition:width .3s }
.proc{ display:flex;align-items:baseline;justify-content:space-between;margin:9px 0 7px } .proc .pv{ font:600 19px ui-monospace;color:var(--text) } .proc .pv #procN{ color:var(--gold) } .proc .pl{ font:600 10px ui-monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dim) }
.log{ margin-top:10px;padding:9px 11px;border-radius:var(--r-sm);background:var(--bg3);border:1px solid var(--line2);font:500 11px/1.55 ui-monospace;color:var(--muted);max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;direction:ltr;text-align:left;unicode-bidi:plaintext }   /* technical console stays an LTR island; Arabic words inside lines render RTL via the bidi algorithm */
details.cols{ margin-top:13px } details.cols summary{ list-style:none;font:600 10px ui-monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);cursor:pointer;user-select:none }
details.cols summary::-webkit-details-marker{ display:none }
details.cols summary::before{ content:'▸ '; color:var(--gold) } details.cols[open] summary::before{ content:'▾ ' }
details.cols .chips{ margin-top:9px }
.ckline{ display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;font:600 10px ui-monospace;letter-spacing:.06em;color:var(--dim) } .ckline .cknow{ color:var(--muted) }
.ckbar{ height:6px;border-radius:999px;background:var(--bg2);border:1px solid var(--line2);overflow:hidden;margin-top:6px } .ckbar>i{ display:block;height:100%;width:0;background:linear-gradient(90deg,var(--gold),var(--teal));transition:width .25s }
.tools{ display:flex;gap:8px } .tools .btn{ flex:1 }
.ft{ border-top:1px solid var(--line2);padding:12px 15px;display:flex;align-items:center;gap:10px;background:linear-gradient(0deg,var(--bg-ft),var(--bg)) }
.ft .dot{ width:9px;height:9px;border-radius:50%;background:var(--dim);flex:0 0 auto } .ft.run .dot{ background:var(--gold) } .ft.ok .dot{ background:var(--ok) } .ft.err .dot{ background:var(--err) } .ft.wait .dot{ background:var(--teal) }
.ft .msg{ font:500 12px system-ui;flex:1 }
.gate{ min-height:100%;display:flex;flex-direction:column;justify-content:center;gap:11px;padding:6px 4px }
.gate[hidden]{ display:none }   /* the class rule above sets display:flex, which otherwise overrides the [hidden] attribute — once registered, the gate must actually leave the layout so you land straight on the tool */
.gate .g-head{ font:800 19px system-ui;color:var(--gold2);display:flex;align-items:center;gap:9px }
.gate .g-sub{ font:500 12.5px system-ui;color:var(--gate-sub);margin:-3px 0 6px;line-height:1.45 }
.gate input.rg{ width:100%;padding:11px 13px;border-radius:var(--r);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 14px system-ui }
.gate input.rg:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--focus2) }
.gate .g-consent{ display:flex;align-items:flex-start;gap:9px;font:500 11.5px system-ui;color:var(--muted);line-height:1.45;cursor:pointer;margin-top:4px } .gate .g-consent input{ margin-top:2px;accent-color:var(--gold) } .gate .g-consent a{ color:var(--gold) }
.gate button.rg-btn{ font:700 14px system-ui;padding:12px 14px;border-radius:var(--r);border:1px solid var(--gold-bd);background:linear-gradient(var(--gold2),var(--gold));color:var(--on-gold);cursor:pointer;margin-top:4px }
.gate button.rg-btn:hover{ filter:brightness(1.05) } .gate button.rg-btn:disabled{ opacity:.55;cursor:progress }
.gate .g-msg{ font:600 11px ui-monospace;color:var(--err);margin-top:2px }
.ann{ padding:9px 14px;font:600 12px system-ui;border-bottom:1px solid var(--line2);line-height:1.4 }
.ann.info{ background:var(--info-bg);color:var(--info-tx) } .ann.warn{ background:var(--warn-bg);color:var(--warn-tx) } .ann.alert{ background:var(--err-bg);color:var(--err) }
.bmodal-scrim{ position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:var(--mscrim);padding:20px }
.bmodal{ width:100%;max-width:340px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px;box-shadow:var(--shadow) }
.bmodal-t{ font:700 14px system-ui;margin-bottom:4px } .bmodal-s{ font:500 11px system-ui;color:var(--muted);margin-bottom:10px }
.bmodal-ta{ width:100%;min-height:92px;resize:vertical;padding:9px 11px;border-radius:var(--r);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 13px system-ui }
.bmodal-ta:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--focus) }
.bmodal-f{ display:flex;gap:8px;justify-content:flex-end;margin-top:12px }
.rjlist{ max-height:300px;overflow:auto;margin-top:10px }
.rjrow{ display:flex;gap:9px;align-items:flex-start;padding:9px 2px;border-top:1px solid var(--line2) }
.rjrow input[type=checkbox]{ accent-color:var(--err);margin-top:3px;flex:0 0 auto }
.rjrow.off{ opacity:.55 }
.rjmain{ flex:1;min-width:0 }
.rjhead{ font:600 12px system-ui;display:flex;gap:7px;flex-wrap:wrap;align-items:baseline }
.rjhead .amt{ margin-inline-start:auto;color:var(--gold) }
.rjmeta{ font:500 10px ui-monospace;color:var(--dim);margin-top:2px }
.rjb{ display:inline-block;font:600 9px ui-monospace;padding:2px 7px;border-radius:999px;border:1px solid var(--err-bd);color:var(--err);background:var(--err-bg);margin:4px 4px 0 0 }
.rjb.flag{ border-color:var(--line);color:var(--warn-tx);background:var(--warn-bg) }
.rjreason{ width:100%;margin-top:6px;padding:6px 9px;border-radius:var(--r-sm);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 11px system-ui }
.rjreason:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 2px var(--focus) }
.rjres{ font:600 10px ui-monospace;margin-top:3px } .rjres.ok{ color:var(--ok) } .rjres.err{ color:var(--err) }
.rjfoot{ display:flex;gap:8px;align-items:center;margin-top:11px }
.rjfoot .cnt{ font:600 11px ui-monospace;color:var(--muted);white-space:nowrap }
.rjnum{ width:100%;padding:8px 10px;border-radius:var(--r-sm);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 12px ui-monospace }
.rjnote{ margin-top:10px;padding:8px 11px;border-radius:var(--r-sm);font:600 11px system-ui;background:var(--info-bg);color:var(--info-tx) }
.rjnote.warn{ background:var(--warn-bg);color:var(--warn-tx) }
`;

// Brand mark: the omarsoliman.dev star (two squares, one rotated 45°) — assets/mark.svg from the
// design system, redrawn in currentColor so .seal's cream-on-clay treatment carries it.
const SEAL = '<svg viewBox="0 0 24 24" fill="currentColor"><g transform="translate(12 12)"><rect x="-6.2" y="-6.2" width="12.4" height="12.4"/><rect x="-6.2" y="-6.2" width="12.4" height="12.4" transform="rotate(45)"/></g></svg>';
const FOLDER_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

// Rough pre-run guess only — replaced by the live measured rows/sec rate once the run starts.
// Details fetch ~40-way concurrent (≈0.1 s/row); official PDFs (8-way, big payloads) dominate when on.
function estMinutes(plan) {
  const perRow = plan.downloadPdf ? 0.35 : 0.1;
  const secs = plan.chunks.reduce((s, c) => s + Math.min(c.count, plan.cap) * perRow + 15, 0);
  return Math.max(1, Math.round(secs / 60));
}
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

export function mountUI() {
  if (document.getElementById('eta-bulk-host')) return;
  const host = document.createElement('div');
  host.id = 'eta-bulk-host';
  const root = host.attachShadow({ mode: 'open' });
  const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);

  const YEARS = ['2020', '2021', '2022', '2023', '2024', '2025', '2026'];
  root.innerHTML += `
    <button class="pill" id="pill">📥 ETA Bulk</button>
    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer" dir="ltr" role="dialog" aria-modal="true" aria-label="ETA Bulk Export">
      <header class="hd">
        <div class="hd-top">
          <div class="brand"><div class="seal">${SEAL}</div><div><div class="wm">ETA&nbsp;Bulk<span class="by">by omarsoliman.dev</span></div><div class="tag" data-i18n="ui.tag">export console</div></div></div>
          <div style="display:flex;align-items:center;gap:8px"><span class="chip" id="tok"><span class="dot"></span><span class="num">—</span></span><button class="x" id="langBtn" data-i18n-title="ui.langTitle" title="العربية / English" aria-label="Language" style="font-size:13px;font-weight:700">ع</button><button class="x" id="themeBtn" data-i18n-title="ui.themeTitle" title="Light / dark theme" aria-label="Toggle theme" style="font-size:15px">🌙</button><button class="x" id="close" aria-label="Close">×</button></div>
        </div>
        <div class="src" id="srcrow">
          <div class="seg" role="tablist" aria-label="Source">
            <button role="tab" aria-selected="true" data-tab="invoices" data-i18n="ui.invoices">Invoices</button>
            <button role="tab" aria-selected="false" data-tab="receipts" data-i18n="ui.receipts">Receipts</button>
            <button role="tab" aria-selected="false" data-tab="rejection" data-i18n="ui.rejection">Rejection</button>
          </div>
          <div class="cap" id="cap">Documents · cap <b>10,000</b>/search</div>
        </div>
      </header>
      <div class="ann" id="umsg" hidden></div>
      <div class="ann" id="ann" hidden></div>
      <div class="body">
        <div class="gate" id="gate" hidden>
          <div id="gate-form">
            <div class="g-head" data-i18n="gate.head">🔒 Register to unlock bulk export</div>
            <div class="g-sub" data-i18n="gate.sub">Free · one-time. Auto-detected tax registration no. — enter your contact details below.</div>
            <input class="rg" id="rg-rin-input" value="—" readonly aria-label="Tax registration number (auto-detected)" style="opacity:.7;cursor:not-allowed;font:700 14px ui-monospace">
            <input class="rg" id="rg-name" data-i18n-ph="gate.phName" placeholder="Full name" autocomplete="off">
            <input class="rg" id="rg-email" type="email" data-i18n-ph="gate.phEmail" placeholder="Email" autocomplete="off">
            <input class="rg" id="rg-phone" data-i18n-ph="gate.phPhone" placeholder="Phone" autocomplete="off">
            <input class="rg" id="rg-company" data-i18n-ph="gate.phCompany" placeholder="Company" autocomplete="off">
            <label class="g-consent"><input type="checkbox" id="rg-consent"><span data-i18n-html="gate.consent">I agree my registration details — including my tax registration number — are stored by <b>Omar Soliman</b> to provide and manage access to this tool and to contact me about it. <a id="privacy-link" href="#" target="_blank" rel="noopener">Privacy policy</a></span></label>
            <button class="rg-btn" id="rg-submit" data-i18n="gate.submit">Register &amp; unlock</button>
            <div class="g-msg" id="rg-msg"></div>
          </div>
          <div id="gate-blocked" hidden>
            <div class="g-head" id="blk-head">🔒 Locked</div>
            <div class="g-sub" id="blk-msg"></div>
            <button class="rg-btn" id="blk-req" hidden style="margin-top:9px" data-i18n="gate.reqBtn">Request access for this account</button>
            <div class="g-msg" id="blk-reqmsg" style="color:var(--gate-sub)"></div>
          </div>
        </div>
        <div id="main">
        <div id="view-export">
        <section class="card">
          <div class="sh"><span class="n">1</span><h3 data-i18n="ui.configure">Configure</h3></div>
          <div class="row">
            <div><label class="l" data-i18n="ui.from">From</label><input type="date" class="ctl" id="from" value="2025-01-01"></div>
            <div><label class="l" data-i18n="ui.to">To</label><input type="date" class="ctl" id="to" value="2025-12-31"></div>
          </div>
          <div class="row" style="margin-top:11px">
            <div><label class="l" data-i18n="ui.direction">Direction</label><select id="dir"></select></div>
            <div><label class="l" data-i18n="ui.filterBy">Filter by</label><select id="field"></select></div>
          </div>
          <div class="row" style="margin-top:11px">
            <div><label class="l" data-i18n="ui.quickYear">Quick year</label><select id="year"><option value="" data-i18n="ui.rangeAbove">range above</option>${YEARS.map((y) => `<option value="${y}">${y}</option>`).join('')}</select></div>
            <div><label class="l" data-i18n="ui.lineItems">Line items</label><label class="togg" style="margin-top:4px"><input type="checkbox" id="details" checked> <span data-i18n="ui.details">Details</span></label></div>
          </div>
          <label class="togg" style="margin-top:12px"><input type="checkbox" id="pdf"> <span data-i18n="ui.pdfToggle">Official ETA PDF per document</span> <span style="color:var(--dim);font:600 10px ui-monospace;margin-inline-start:3px" data-i18n="ui.pdfHint">→ pdfs/ · slower</span></label>
          <div style="margin-top:12px"><label class="l" data-i18n="ui.status">Status</label><div class="chips" id="statuses">${ALL_STATUSES.map((s) => `<label class="sc"><input type="checkbox" id="st_${s}" checked>${s}</label>`).join('')}</div></div>
          <details class="cols"><summary><span data-i18n="ui.columns">Columns</span> <span id="colhint">· all</span></summary><div class="chips" id="cols"></div></details>
          <div class="folder"><span>${FOLDER_ICO}</span><span class="p" id="folder">No output folder</span><button class="btn sm" id="pick" data-i18n="ui.pick">Pick</button></div>
        </section>
        <section class="card">
          <div class="sh"><span class="n">2</span><h3 data-i18n="ui.plan">Plan</h3><span class="hint" data-i18n="ui.planHint">year-first adaptive</span></div>
          <button class="btn" id="build" style="width:100%" data-i18n="ui.build">⟐ Build chunk plan</button>
          <button class="btn" id="sync" style="width:100%;margin-top:8px" data-i18n="ui.sync" data-i18n-title="ui.syncTitle" title="Re-exports from 3 days before the last run's end through today, into the same folder. Run Merge afterwards — duplicates are removed automatically.">⟳ Sync new since last run</button>
          <div class="stats"><div class="stat"><div class="k" data-i18n="ui.stChunks">Chunks</div><div class="v num" id="s-chunks">—</div></div><div class="stat"><div class="k" data-i18n="ui.stRows">Rows</div><div class="v num" id="s-rows">—</div></div><div class="stat"><div class="k" data-i18n="ui.stBiggest">Biggest</div><div class="v num" id="s-big">—</div></div><div class="stat"><div class="k" data-i18n="ui.stEta">Est. time</div><div class="v num" id="s-eta">—</div></div></div>
        </section>
        <section class="card">
          <div class="sh"><span class="n">3</span><h3 data-i18n="ui.run">Run</h3><span class="hint" data-i18n="ui.runHint">background-safe</span><button class="btn sm" id="logcopy" data-i18n="ui.logCopy" data-i18n-title="ui.logCopyTitle" title="Copy the full run log" style="margin-inline-start:8px;padding:4px 8px;font-size:11px">⧉ Log</button><button class="btn sm" id="logclear" data-i18n-title="ui.logClearTitle" title="Clear the run log" style="padding:4px 8px;font-size:11px">✕</button></div>
          <div class="runbar"><button class="btn primary" id="start" disabled data-i18n="ui.start">▶ Approve &amp; Start</button><button class="btn sm" id="pause" disabled data-i18n="ui.pause">Pause</button><button class="btn sm" id="resume" data-i18n="ui.resume">Resume</button></div>
          <div class="tracker"><div class="tk ok"><div class="v num" id="t-done">0</div><div class="k" data-i18n="ui.tDone">Done</div></div><div class="tk err"><div class="v num" id="t-fail">0</div><div class="k" data-i18n="ui.tFail">Failed</div></div><div class="tk left"><div class="v num" id="t-left">0</div><div class="k" data-i18n="ui.tLeft">Left</div></div></div>
          <div class="proc"><span class="pv"><span id="procN" class="num">0</span> / <span id="procT" class="num">&mdash;</span></span><span class="pl" id="procLabel">invoices fetched</span></div>
          <div class="track"><i id="bar"></i></div>
          <div class="ckline"><span id="ckLabel">current chunk —</span><span class="cknow" id="ckCur"></span></div>
          <div class="ckbar"><i id="chunkbar"></i></div>
          <div class="log" id="log">Idle.</div>
        </section>
        <section class="card">
          <div class="sh"><span class="n">4</span><h3 data-i18n="ui.tools">Tools</h3><span class="hint" data-i18n="ui.toolsHint">post-run</span></div>
          <div class="tools"><button class="btn" id="merge" data-i18n="ui.merge">⧉ Merge folder</button><button class="btn" id="repair" data-i18n="ui.repair">⛭ Repair files</button></div>
          <button class="btn sm" id="bug" style="width:100%;margin-top:8px" data-i18n="ui.bug">🐞 Report a bug</button>
          <button class="btn sm" id="reqrin" style="width:100%;margin-top:8px" hidden data-i18n="ui.reqrin">＋ Request access for another account</button>
        </section>
        </div>
        <div id="view-rejection" hidden>
        <section class="card">
          <div class="sh"><span class="n">1</span><h3 data-i18n="rej.title">Auto-Reject</h3><span class="hint" data-i18n="rej.hint">received · Valid only</span></div>
          <div class="row">
            <div><label class="l" data-i18n="ui.from">From</label><input type="date" class="ctl" id="rj-from"></div>
            <div><label class="l" data-i18n="ui.to">To</label><input type="date" class="ctl" id="rj-to"></div>
          </div>
          <details class="cols" style="margin-top:11px"><summary><span data-i18n="rej.criteria">Criteria</span> <span id="rj-crithint"></span></summary>
            <div class="row" style="margin-top:9px">
              <div><label class="l" data-i18n="rej.supplierList">Supplier list</label><select id="rj-mode">
                <option value="off" data-i18n="rej.modeOff">Off</option>
                <option value="block" data-i18n="rej.modeBlock">Blocklist → reject</option>
                <option value="allow" data-i18n="rej.modeAllow">Trusted-only → flag others</option>
              </select></div>
              <div><label class="l" data-i18n="rej.window">Window (days)</label><input type="number" class="rjnum" id="rj-window" min="1" max="365" value="14"><span id="rj-winsrc" style="display:block;font:600 9px ui-monospace;color:var(--dim);margin-top:3px"></span></div>
            </div>
            <textarea class="rjreason" id="rj-tins" rows="2" data-i18n-ph="rej.tinsPh" placeholder="Tax registration numbers — one per line" style="margin-top:9px;direction:ltr;font-family:ui-monospace,monospace"></textarea>
            <div class="row" style="margin-top:9px">
              <div><label class="l"><input type="checkbox" id="rj-amt" style="accent-color:var(--gold);vertical-align:-2px"> <span data-i18n="rej.maxAmount">Reject above</span></label><input type="number" class="rjnum" id="rj-max" min="0" placeholder="—"></div>
              <div><label class="l" data-i18n="rej.minAmount">Reject below</label><input type="number" class="rjnum" id="rj-min" min="0" placeholder="—"></div>
            </div>
            <div class="row" style="margin-top:9px">
              <div><label class="l"><input type="checkbox" id="rj-vat" style="accent-color:var(--gold);vertical-align:-2px"> <span data-i18n="rej.vat">VAT mismatch beyond</span></label><input type="number" class="rjnum" id="rj-tol" min="0.1" max="50" step="0.1" value="2"></div>
              <div><label class="l" data-i18n="rej.dup">Duplicate invoices</label><label class="togg" style="margin-top:7px"><input type="checkbox" id="rj-dup" checked> <span data-i18n="rej.dup">Duplicates</span></label></div>
            </div>
            <div style="margin-top:9px"><label class="l"><input type="checkbox" id="rj-typ" style="accent-color:var(--gold);vertical-align:-2px"> <span data-i18n="rej.types">Accepted types</span></label>
              <div class="chips"><label class="sc"><input type="checkbox" id="rj-t-invoice" checked><span data-i18n="rej.tInvoice">Invoice</span></label><label class="sc"><input type="checkbox" id="rj-t-credit" checked><span data-i18n="rej.tCredit">Credit note</span></label><label class="sc"><input type="checkbox" id="rj-t-debit" checked><span data-i18n="rej.tDebit">Debit note</span></label></div>
            </div>
          </details>
          <button class="btn" id="rj-scan" style="width:100%;margin-top:12px" data-i18n="rej.scan">⌕ Scan received documents</button>
          <div class="rjnote" id="rj-note" hidden></div>
          <div class="rjlist" id="rj-list" hidden></div>
          <div class="rjfoot" id="rj-foot" hidden>
            <span class="cnt num" id="rj-count"></span>
            <button class="btn primary" id="rj-go" style="flex:1" disabled></button>
            <button class="btn sm" id="rj-auditbtn" data-i18n="rej.audit">⧉ Audit</button>
          </div>
        </section>
        <section class="card">
          <div class="sh"><span class="n">2</span><h3 data-i18n="po.title">PO Reconciliation</h3><span class="hint" data-i18n="po.hint">upload · analyze</span></div>
          <input type="file" id="po-file" accept=".xlsx" style="display:none">
          <div class="tools"><button class="btn" id="po-pick" data-i18n="po.pick">⇪ Upload PO sheet</button><button class="btn sm" id="po-template" data-i18n="po.template">⤓ Template</button></div>
          <div class="rjmeta" id="po-status" style="margin-top:7px"></div>
          <div class="row" style="margin-top:11px">
            <div><label class="l" data-i18n="po.from">From</label><input type="date" class="ctl" id="po-from"></div>
            <div><label class="l" data-i18n="po.to">To</label><input type="date" class="ctl" id="po-to"></div>
          </div>
          <button class="btn primary" id="po-analyze" style="width:100%;margin-top:12px" disabled data-i18n="po.analyze">▦ Analyze period</button>
          <div class="rjnote" id="po-note" hidden></div>
          <div class="stats" id="po-sum" hidden><div class="stat"><div class="k" data-i18n="po.stInvoices">Invoices</div><div class="v num" id="po-s-inv">—</div></div><div class="stat"><div class="k" data-i18n="po.stMatched">Matched</div><div class="v num" id="po-s-match">—</div></div><div class="stat"><div class="k" data-i18n="po.stWarnings">Warnings</div><div class="v num" id="po-s-warn">—</div></div><div class="stat"><div class="k" data-i18n="po.stExceeded">POs exceeded</div><div class="v num" id="po-s-exc">—</div></div></div>
        </section>
        </div>
        </div>
      </div>
      <footer class="ft" id="ft"><span class="dot"></span><span class="msg" id="ftmsg">Pick a source and build a plan.</span></footer>
    </aside>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
  const q = (sel) => root.querySelector(sel);
  let currentPlan = null, source = 'invoices', busy = false, licensed = true;   // licensed=true default → standalone (no bridge) is ungated
  let rjItems = [], rjCtrl = null;   // auto-reject review items + abort controller for a scan/submit/analyze in flight
  let tab = 'invoices';              // visible view: invoices | receipts | rejection (source stays export-only)
  let poState = { pos: [], warnings: [], fileName: '', analysis: null };   // uploaded PO sheet + last analysis
  let lastSession = null;        // last /session verdict (drives the request-RIN prefill)
  // Live time-left: measured in WORK units (invoices fully processed, PDFs doubling), not discovered
  // rows — the paged /search phase is fast and must not make the timer plummet (see core/eta.js).
  const eta = createEtaTracker();
  let lastChunk = null;          // most recent onChunk payload = live progress inside the current chunk
  const updateEta = () => { if (!busy || !currentPlan) return; const m = eta.update(currentPlan, lastChunk); if (m != null) $('s-eta').textContent = '~' + fmtMin(m); };

  const setFt = (cls, msg) => { const f = $('ft'); f.className = 'ft' + (cls ? ' ' + cls : ''); $('ftmsg').textContent = msg; };

  // Run log: timestamped ring buffer, persisted to localStorage. Lifecycle rule: a reload restores the
  // log ONLY when there is an interrupted job worth resuming — a run that was mid-flight when the page
  // died ('active') or one that ended paused/halted/incomplete ('resumable'). Everything else — clean
  // completion, merge/repair sessions, idle browsing, and any pre-lifecycle legacy payload — starts
  // fresh. Saves are debounced; state transitions flush immediately (must not be lost).
  const RLOG_KEY = 'etaBulk_runlog';
  const rlog = createRunLog({});
  let logRun = 'none';   // 'none' | 'active' (busy right now) | 'resumable' (paused/halted/incomplete/crashed) | 'done'
  try {
    const raw = localStorage.getItem(RLOG_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      const wrapped = j && typeof j === 'object' && !Array.isArray(j);
      const run = wrapped ? (j.run || (j.closed === false ? 'resumable' : 'done')) : 'done';   // v1 {closed} maps over; legacy arrays drop
      if (run === 'active' || run === 'resumable') { rlog.restore(j.entries); logRun = 'resumable'; }   // a crashed 'active' run is now a resumable one
      else localStorage.removeItem(RLOG_KEY);
    }
  } catch {}
  if (rlog.entries().length) rlog.push(t('ft.restored'), { level: 'info' });
  let saveT = 0;
  const saveLog = () => { saveT = 0; try { localStorage.setItem(RLOG_KEY, JSON.stringify({ v: 2, run: logRun, entries: rlog.toJSON() })); } catch {} };
  const saveLogSoon = (now) => { if (now) { clearTimeout(saveT); saveLog(); } else if (!saveT) saveT = setTimeout(saveLog, 1000); };
  const renderLog = () => {
    const el = $('log');
    const pin = el.scrollHeight - el.scrollTop - el.clientHeight < 8;   // keep manual scrollback; auto-follow only at the bottom
    el.textContent = rlog.text() || t('ui.idle');
    if (pin) el.scrollTop = el.scrollHeight;
  };
  const logLine = (m, meta) => { rlog.push(m, meta); renderLog(); saveLogSoon(meta && meta.terminal); };

  const orch = createOrchestrator({
    // SPEC-010: a folder holding exports but no owner stamp is the one case the tool must not guess
    // about — it is exactly where a pre-fix run may already have mixed two companies. Ask once.
    confirmFolder: ({ rin, company }) => confirmModal(t('folder.confirmTitle'), t('folder.confirmBody', { company: company || t('folder.unnamed'), rin })),
    onStatus: (m, meta) => {
      const clean = !!(meta && meta.kind === 'done' && meta.level === 'ok');   // completed with zero failed chunks
      if (meta && meta.terminal) logRun = clean ? 'done' : 'resumable';   // set BEFORE logLine so its terminal flush persists the state
      logLine(m, meta);
      // Prefer the structured meta from the orchestrator; fall back to the legacy emoji/regex sniff for
      // sources that still emit bare strings (merge/repair callbacks, drawer-local lines).
      if (meta) {
        const cls = { ok: 'ok', err: 'err', wait: 'wait', run: 'run' }[meta.level] || '';
        setFt(cls, m.replace(/^[▶✅■⏸]\s*/, ''));
        if (clean) $('s-eta').textContent = '0m';
        if (meta.terminal) setBusy(false);
        return;
      }
      const terminal = (m[0] === '\u2705' || m[0] === '\u23F8' || m[0] === '\u25A0' || /expired|Halted/.test(m));
      const cls = m.startsWith('✅') ? 'ok' : /expired|Halted|failed/.test(m) ? 'err' : m.startsWith('⏸') ? 'wait' : m.startsWith('▶') || m.startsWith('Prob') ? 'run' : '';
      setFt(cls, m.replace(/^[\u25B6\u2705\u25A0\u23F8]\s*/, ''));
      if (terminal) { logRun = 'done'; saveLogSoon(true); setBusy(false); }   // bare-string terminals = merge/repair — finished tools aren't resumable
    },
    onProgress: (done, failed, left) => {
      $('t-done').textContent = fmt(done); $('t-fail').textContent = fmt(failed); $('t-left').textContent = fmt(left);
      updateEta();   // plan.doneIds was updated by the orchestrator (same object) just before this fires
    },
    onCount: (fetched, total) => {   // rows counter + bar only — the timer runs on work units, not rows
      $('procN').textContent = fmt(fetched); if (total) $('procT').textContent = fmt(total);
      $('bar').style.width = total ? Math.min(100, fetched / total * 100) + '%' : '0';
    },
    onPlan: (p) => {
      currentPlan = p;
      $('s-chunks').textContent = fmt(p.chunks.length); $('s-rows').textContent = fmt(p.totalRows);
      $('s-big').textContent = fmt(p.biggest); $('s-eta').textContent = fmtMin(estMinutes(p));
      const done = (p.doneIds || []).length; $('t-done').textContent = fmt(done); $('t-left').textContent = fmt(p.chunks.length - done);
      const doneRows = p.chunks.filter((c) => (p.doneIds || []).includes(c.id)).reduce((s, c) => s + Math.min(c.count, p.cap), 0);
      $('procN').textContent = fmt(doneRows); $('procT').textContent = fmt(p.totalRows);
      $('bar').style.width = p.totalRows ? (doneRows / p.totalRows * 100) + '%' : '0';
      $('start').disabled = !licensed;
    },
    onToken: (tk) => { const c = $('tok'); c.className = 'chip ' + (tk.ok ? 'ok' : 'err'); c.querySelector('.num').textContent = tk.label.replace(/^(Token|الجلسة):\s*/, ''); },
    onChunk: (ck) => {
      lastChunk = ck.phase === 'idle' ? null : ck;
      updateEta();
      const { i, n, phase, cur, max } = ck;
      const label = { search: t('ui.phSearch'), details: t('ui.phDetails'), write: t('ui.phWrite') }[phase];
      if (!max || !label) { $('ckLabel').textContent = t('ui.chunkNone'); $('ckCur').textContent = ''; $('chunkbar').style.width = '0'; return; }
      $('ckLabel').textContent = t('ui.chunkLine', { i: fmt(i), n: fmt(n), label });
      $('ckCur').textContent = `${fmt(cur)} / ${fmt(max)}`;
      $('chunkbar').style.width = Math.min(100, cur / max * 100) + '%';
    },
    // checked before every chunk: server-authoritative verdict for the live RIN (lock/kill/allowed-RIN)
    guard: async () => { if (!gateEnabled()) return true; const s = await session(); return s.registered && s.allowed; },
  });

  function setBusy(b) { busy = b;
    if (b) { eta.reset(); lastChunk = null; logRun = 'active'; saveLogSoon(true); }   // fresh rate baseline; mark mid-flight so a crash restores the log
    else if (logRun === 'active') { logRun = 'none'; saveLogSoon(true); }             // activity ended without a terminal status (plan built, resume loaded) → nothing to resume
    $('build').disabled = b || !licensed; $('sync').disabled = b || !licensed; $('start').disabled = b || !currentPlan || !licensed; $('pause').disabled = !b; $('resume').disabled = b; $('pick').disabled = b; $('merge').disabled = b; $('repair').disabled = b;
    $('rj-scan').disabled = b || !licensed; rjFoot();
    $('po-pick').disabled = b; $('po-template').disabled = b; poFoot(); }

  // Registration gate — engages only once LEAD_URL is wired (gateEnabled). Locks to one taxpayer per device:
  // registered → ungated; a different client-taxpayer must register again (a new lead for that entity).
  const showMain = (v) => { $('main').hidden = !v; $('srcrow').style.display = v ? '' : 'none'; };
  // Owner broadcast banner pushed via /session — a soft channel that isn't the kill-switch sledgehammer.
  const renderAnnouncement = (a) => { const el = $('ann'); if (!el) return; if (a && a.text) { el.hidden = false; el.className = 'ann ' + (a.level === 'warn' || a.level === 'alert' ? a.level : 'info'); el.textContent = a.text; } else el.hidden = true; };
  // Personal admin→user message (stacked above the broadcast banner). Dismissible; dismissed ids kept locally.
  const renderMessage = (m) => {
    const el = $('umsg'); if (!el) return;
    const seen = lsGet('msgseen') || [];
    if (!m || !m.text || (m.id && seen.includes(m.id))) { el.hidden = true; return; }
    el.hidden = false; el.className = 'ann ' + (m.level === 'warn' || m.level === 'alert' ? m.level : 'info');
    el.textContent = '';
    el.append(Object.assign(document.createElement('span'), { textContent: '✉ ' + m.text }));
    const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Dismiss' });
    x.style.cssText = 'float:inline-end;font-size:14px;padding:0 6px;margin-inline-start:8px';
    x.onclick = () => { lsSet('msgseen', [...seen, m.id].slice(-20)); el.hidden = true; };
    el.append(x);
  };
  async function refreshLicense() {
    if (!gateEnabled()) { licensed = true; $('gate').hidden = true; showMain(true); renderAnnouncement(null); renderMessage(null); if (!busy) { $('build').disabled = false; $('sync').disabled = false; $('start').disabled = !currentPlan; $('rj-scan').disabled = false; poFoot(); } return; }   // ungated branch must mirror the gated one for the rejection controls too
    const s = await session();
    lastSession = s;
    renderAnnouncement(s.announcement);
    renderMessage(s.message);
    licensed = s.registered && s.allowed;
    $('gate').hidden = licensed;
    $('reqrin').hidden = !licensed;   // inside #main, so effectively: gated + registered + allowed
    showMain(licensed);   // full-screen registration page takes over the drawer while locked
    if (!licensed) {
      const showForm = !s.registered;
      $('gate-form').hidden = !showForm;
      $('gate-blocked').hidden = showForm;
      if (showForm) {
        const rin = taxpayerId();   // auto-detect ONLY the TIN; the user types their own contact details
        $('rg-rin-input').value = (rin && rin !== 'unknown') ? rin : t('gate.noRinDetected');
      } else {
        const paused = s.reason === 'global_stop';                                   // reversible service-wide pause
        const needsUpdate = s.reason === 'update_required';                          // version kill switch
        const rinIssue = s.reason === 'rin_not_allowed' || s.reason === 'no_usable_rin';
        const voided = s.reason === 'rin_voided';
        $('blk-head').textContent = t(needsUpdate ? 'gate.hUpdate' : paused ? 'gate.hPaused' : s.killed ? 'gate.hKilled' : s.locked ? 'gate.hLocked' : voided ? 'gate.hVoided' : rinIssue ? 'gate.hRin' : 'gate.hDefault');
        $('blk-msg').textContent = t(needsUpdate ? 'gate.mUpdate' : paused ? 'gate.mPaused' : s.killed ? 'gate.mKilled' : s.locked ? 'gate.mLocked' : voided ? 'gate.mVoided' : rinIssue ? 'gate.mRin' : 'gate.mDefault', { rin: s.rin });
        $('blk-req').hidden = !rinIssue;   // "request access" only applies to an unallowed (not voided/locked/paused/outdated) account
        $('blk-reqmsg').textContent = '';
      }
    }
    if (!busy) { $('build').disabled = !licensed; $('start').disabled = !currentPlan || !licensed; $('rj-scan').disabled = !licensed; poFoot(); }
  }

  function applySourceUI() {
    const src = orch.SOURCES[source];
    // preserve current selections across re-renders (language toggle re-runs this) — restore when still valid
    const keepDir = $('dir').value, keepField = $('field').value;
    const keepOff = new Set([...root.querySelectorAll('#cols input[data-col]')].filter((b) => !b.checked).map((b) => b.dataset.col));
    $('dir').innerHTML = src.dirs.map(([v], i) => `<option value="${v}"${i === 0 ? ' selected' : ''}>${t('src.' + v)}</option>`).join('');
    $('field').innerHTML = src.dateFields.map(([v], i) => `<option value="${v}"${i === 0 ? ' selected' : ''}>${t('src.' + v)}</option>`).join('');
    if (keepDir && src.dirs.some(([v]) => v === keepDir)) $('dir').value = keepDir;
    if (keepField && src.dateFields.some(([v]) => v === keepField)) $('field').value = keepField;
    renderCap();   // cap line is tab-aware (Rejection shows its own scan cap), owned by renderCap
    const pl = $('procLabel'); if (pl) pl.textContent = t(source === 'receipts' ? 'ui.fetchedRec' : 'ui.fetchedInv');
    const cols = $('cols');
    if (cols) { cols.innerHTML = removableColumns(source).map((c) => `<label class="sc" title="${c.key}"><input type="checkbox" data-col="${c.key}"${keepOff.has(c.key) ? '' : ' checked'}>${c.header}</label>`).join(''); updateColHint(); }
  }
  const updateColHint = () => {
    const boxes = [...root.querySelectorAll('#cols input[data-col]')]; const off = boxes.filter((b) => !b.checked).length;
    const h = $('colhint'); if (h) h.textContent = off ? t('ui.colsKept', { kept: boxes.length - off, total: boxes.length }) : t('ui.colsAll');
  };
  const gather = () => {
    const from = $('from').value, to = $('to').value;
    const fY = (from || '').slice(0, 4), tY = (to || '').slice(0, 4);
    const year = (fY && tY) ? (fY === tY ? fY : fY + '-' + tY) : (from || to || '2025').slice(0, 4);
    const excludeColumns = [...root.querySelectorAll('#cols input[data-col]')].filter((b) => !b.checked).map((b) => b.dataset.col);
    return { source, year, dir: $('dir').value, field: $('field').value, from, to, statuses: ALL_STATUSES.filter((s) => $('st_' + s).checked), downloadDetails: $('details').checked, downloadPdf: $('pdf').checked, excludeColumns };
  };
  $('year').onchange = () => { const y = $('year').value; if (!y) return; $('from').value = y === '2020' ? '2020-11-15' : y + '-01-01'; $('to').value = y + '-12-31'; };
  $('cols').addEventListener('change', updateColHint);

  // open/close — return focus to the pill on close (a11y: focus must not be left on a now-hidden control)
  const openDrawer = (o) => { $('drawer').classList.toggle('on', o); $('scrim').classList.toggle('on', o); if (o) { $('close').focus(); refreshLicense(); } else { $('pill').focus(); } };
  $('pill').onclick = () => openDrawer(true);
  $('close').onclick = () => openDrawer(false);
  $('scrim').onclick = () => openDrawer(false);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape in a focused field dismisses the FIELD, not the whole drawer (was nuking half-filled registration).
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches('input, select, textarea')) { tgt.blur(); return; }
    openDrawer(false);
  });
  // Focus trap (aria-modal): keep Tab within the drawer so keyboard/AT users can't tab into the obscured page.
  // Scope to the #drawer subtree — NOT the whole shadow root, whose first focusable is #pill (outside the
  // dialog); trapping to that would let focus escape the modal.
  $('drawer').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...$('drawer').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], active = root.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });

  // Tab machine. `tab` is the visible view (invoices | receipts | rejection); `source` stays the
  // EXPORT source only — 'rejection' is a view, never a SOURCES key (applySourceUI would throw),
  // and visiting it must not invalidate a built export plan. setSource keeps the plan-invalidation
  // rule for real source switches; selectTab owns aria + view visibility + the cap line.
  function setSource(src) {
    if (source === src) return;
    source = src; applySourceUI();
    currentPlan = null; $('start').disabled = true;
    for (const id of ['s-chunks', 's-rows', 's-big', 's-eta']) $(id).textContent = '—';
  }
  function renderCap() {
    $('cap').innerHTML = tab === 'rejection' ? t('ui.capRejection') : t(source === 'receipts' ? 'ui.capReceipts' : 'ui.capDocs');
  }
  function selectTab(next) {
    tab = next;
    root.querySelectorAll('.seg [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === next)));
    const rej = next === 'rejection';
    $('view-export').hidden = rej; $('view-rejection').hidden = !rej;
    if (!rej) setSource(next);   // export tabs keep source === tab; rejection leaves source (and the plan) alone
    renderCap();
  }
  root.querySelectorAll('.seg [role=tab]').forEach((b) => b.onclick = () => {
    if (busy || tab === b.dataset.tab) return;   // don't switch tabs mid-run or onto the same tab
    selectTab(b.dataset.tab);
    setFt('', b.dataset.tab === 'rejection' ? t('ft.rejTab') : t('ft.sourceChanged', { src: t(source === 'receipts' ? 'ui.receipts' : 'ui.invoices') }));
  });

  // actions
  $('pick').onclick = async () => { try { const n = await orch.pickFolder(); $('folder').textContent = n; } catch {} };
  $('build').onclick = async () => { setBusy(true); currentPlan = null; $('start').disabled = true; try { await orch.plan(gather()); } catch (e) { logLine(t('ft.planFailed', { msg: e?.message || e }), { level: 'err' }); setFt('err', t('ft.planFailedShort')); } setBusy(false); };
  $('start').onclick = async () => { if (!currentPlan) return; await refreshLicense(); if (!licensed) { $('gate').hidden = false; $('rg-name').focus(); return; } setBusy(true); try { await orch.start(currentPlan); } finally { setBusy(false); } };
  $('sync').onclick = async () => {
    if (busy) return;
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; return; }
    let d = null; try { d = await orch.ensureDir(); } catch {}   // folder-pick cancel is not an error
    if (!d) { setFt('', t('sync.pickFolder')); return; }
    setBusy(true);
    try {
      const sel = deriveSyncSel(await readProgress(d), todayYmd());
      if (!sel) { setFt('', t('sync.noPrev')); return; }
      // reflect the derived selection into the form so the user sees exactly what will run
      selectTab(sel.source);   // also pulls the user back to the export view if they were on Rejection
      $('from').value = sel.from; $('to').value = sel.to; $('year').value = '';
      $('dir').value = sel.dir; $('field').value = sel.field; $('pdf').checked = !!sel.downloadPdf;
      ALL_STATUSES.forEach((s) => { const c = $('st_' + s); if (c) c.checked = (sel.statuses || ALL_STATUSES).includes(s); });
      root.querySelectorAll('#cols input[data-col]').forEach((b) => { b.checked = !(sel.excludeColumns || []).includes(b.dataset.col); });
      updateColHint();
      logLine(t('sync.header', { from: sel.from, to: sel.to }), { level: 'run' });
      const p = await orch.plan(sel);
      if (p) await orch.start(p);
    } catch (e) { logLine(t('sync.failed', { msg: e?.message || e }), { level: 'err' }); setFt('err', t('sync.failedShort')); }
    finally { setBusy(false); }
  };
  $('rg-submit').onclick = async () => {
    const btn = $('rg-submit'), msg = $('rg-msg');
    btn.disabled = true; msg.style.color = 'var(--gate-sub)'; msg.textContent = t('gate.submitting');
    try {
      const res = await register({ name: $('rg-name').value, email: $('rg-email').value, phone: $('rg-phone').value, company: $('rg-company').value, consent: $('rg-consent').checked });
      if (res.ok) { msg.textContent = ''; await refreshLicense(); setFt('ok', t('ft.registered')); }
      else { msg.style.color = 'var(--err)'; msg.textContent = res.error || t('gate.regFailed'); }
    } catch (e) {
      msg.style.color = 'var(--err)'; msg.textContent = t('gate.regError', { msg: e && e.message ? e.message : e });   // never leave the button stuck on "Submitting…"
    } finally {
      btn.disabled = false;
    }
  };
  $('blk-req').onclick = async () => {
    const b = $('blk-req'); b.disabled = true; $('blk-reqmsg').textContent = t('gate.reqSending');
    const r = await requestRin('', '');
    b.disabled = false;
    $('blk-reqmsg').textContent = r.ok ? (r.already ? t('gate.reqAlready') : r.pending ? t('msg.rinPending') : t('gate.reqSent')) : t('msg.rinFail', { err: r.error || 'error' });
  };
  $('pause').onclick = () => { rjCtrl?.abort(); orch.pause(); setFt('wait', t('ft.pausingShort')); logLine(t('ft.pausing'), { level: 'wait' }); };   // Pause also aborts an auto-reject scan/submit in flight
  $('resume').onclick = async () => { setBusy(true); try { const p = await orch.resume(); if (p) { currentPlan = p; $('start').disabled = false; } } catch (e) { logLine(t('ft.resumeFailed', { msg: e?.message || e }), { level: 'err' }); } finally { setBusy(false); } };
  $('merge').onclick = async () => {
    setBusy(true);
    try { const d = await orch.ensureDir({ allowUnverified: true }); if (d) { $('folder').textContent = d.name; await mergeFolder(window.ExcelJS, d, { onStatus: (m) => { logLine(m); setFt('run', m); } }); } }
    catch (e) { logLine(t('ft.mergeFailed', { msg: e?.message || e }), { level: 'err' }); setFt('err', t('ft.mergeFailedShort')); }
    setBusy(false);
  };
  $('repair').onclick = async () => {
    setBusy(true);
    try { const d = await orch.ensureDir(); if (d) { $('folder').textContent = d.name; await repairFolder(d, { onStatus: (m) => { logLine(m); setFt('run', m); } }); } }
    catch (e) { logLine(t('ft.repairFailed', { msg: e?.message || e }), { level: 'err' }); setFt('err', t('ft.repairFailedShort')); }
    setBusy(false);
  };
  // In-drawer (shadow-DOM) prompt — NOT window.prompt, which in the page's MAIN world is the portal's own
  // dialog and can be silently suppressed by Chrome's "prevent additional dialogs", losing the report with no feedback.
  function promptModal(title, sub, placeholder, opts) {   // opts { input:true, value } → single-line input instead of textarea
    return new Promise((resolve) => {
      const scrim = document.createElement('div'); scrim.className = 'bmodal-scrim';
      const card = document.createElement('div'); card.className = 'bmodal'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', title);
      const ttl = document.createElement('div'); ttl.className = 'bmodal-t'; ttl.textContent = title;
      const s = document.createElement('div'); s.className = 'bmodal-s'; s.textContent = sub;
      const ta = document.createElement(opts && opts.input ? 'input' : 'textarea'); ta.className = 'bmodal-ta'; ta.placeholder = placeholder;
      if (opts && opts.input) { ta.style.minHeight = 'auto'; ta.value = opts.value || ''; }
      const f = document.createElement('div'); f.className = 'bmodal-f';
      const cancel = document.createElement('button'); cancel.className = 'btn sm'; cancel.textContent = t('modal.cancel');
      const send = document.createElement('button'); send.className = 'btn primary sm'; send.textContent = t('modal.send');
      f.append(cancel, send); card.append(ttl, s, ta, f); scrim.append(card); root.appendChild(scrim);
      setTimeout(() => ta.focus(), 20);
      const done = (v) => { scrim.remove(); resolve(v); };
      send.onclick = () => done(ta.value); cancel.onclick = () => done(null);
      if (opts && opts.input) ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(ta.value); } });
      scrim.addEventListener('click', (e) => { if (e.target === scrim) done(null); });
      scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    });
  }
  // Yes/no confirm in the same in-drawer modal style (window.confirm has the same suppression problem).
  function confirmModal(title, sub) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div'); scrim.className = 'bmodal-scrim';
      const card = document.createElement('div'); card.className = 'bmodal'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', title);
      const ttl = document.createElement('div'); ttl.className = 'bmodal-t'; ttl.textContent = title;
      const s = document.createElement('div'); s.className = 'bmodal-s'; s.textContent = sub;
      const f = document.createElement('div'); f.className = 'bmodal-f';
      const cancel = document.createElement('button'); cancel.className = 'btn sm'; cancel.textContent = t('modal.cancel');
      const okb = document.createElement('button'); okb.className = 'btn primary sm'; okb.textContent = t('modal.confirm');
      f.append(cancel, okb); card.append(ttl, s, f); scrim.append(card); root.appendChild(scrim);
      setTimeout(() => cancel.focus(), 20);   // safe default focus: Enter on the freshly-opened modal must not confirm a rejection
      const done = (v) => { scrim.remove(); resolve(v); };
      okb.onclick = () => done(true); cancel.onclick = () => done(false);
      scrim.addEventListener('click', (e) => { if (e.target === scrim) done(false); });
      scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    });
  }
  $('bug').onclick = async () => {
    const m = await promptModal(t('modal.bugTitle'), t('modal.bugSub'), t('modal.bugPh'));
    if (m == null) return;                                   // cancelled
    if (!m.trim()) { setFt('err', t('msg.bugEmpty')); return; }
    const diag = {   // status lines + counts only — never invoice/receipt content (matches the modal disclosure + privacy policy)
      log: rlog.lines().slice(-50),
      plan: currentPlan ? { source: currentPlan.source, year: currentPlan.year, from: currentPlan.from, to: currentPlan.to, chunks: currentPlan.chunks.length, done: (currentPlan.doneIds || []).length, failed: (currentPlan.failedIds || []).length, rows: currentPlan.totalRows, pdf: !!currentPlan.downloadPdf } : null,
      last: $('ftmsg').textContent,
    };
    const r = await reportBug(m.trim(), diag);
    setFt(r.ok ? 'ok' : 'err', r.ok ? t('msg.bugSent') : t('msg.bugFail', { err: r.error === 'not registered' ? t('msg.registerFirst') : (r.error || 'error') }));
  };
  $('reqrin').onclick = async () => {
    const cur = taxpayerId();
    const bound = (lastSession && lastSession.boundRins) || [];
    const prefill = (cur !== 'unknown' && !bound.includes(cur)) ? cur : '';   // sensible default: the currently logged-in, not-yet-allowed RIN
    const rin = await promptModal(t('modal.rinTitle'), t('modal.rinSub'), t('modal.rinPh'), { input: true, value: prefill });
    if (rin == null || !rin.trim()) return;
    const r = await requestRin(rin.trim(), 'in-tool request');
    setFt(r.ok ? 'ok' : 'err', r.ok
      ? (r.already ? t('msg.rinAlready') : r.pending ? t('msg.rinPending') : t('msg.rinSent'))
      : t('msg.rinFail', { err: r.error || 'error' }));
  };
  // ── Auto-Reject panel ──────────────────────────────────────────────────────
  // Scan → review → confirm. All document data rendered via textContent (untrusted portal data —
  // the drawer's earlier XSS audit finding class must not come back via this list).
  const RJCFG_KEY = 'arCfg';
  function rjCritHint(c) {
    const n = (c.issuer.mode !== 'off' ? 1 : 0) + (c.amount.on ? 1 : 0) + (c.vat.on ? 1 : 0) + (c.dup.on ? 1 : 0) + (c.types.on ? 1 : 0);
    $('rj-crithint').textContent = '· ' + n;
  }
  function rjLoadCfg() {
    const c = normalizeCfg(lsGet(RJCFG_KEY));
    $('rj-mode').value = c.issuer.mode; $('rj-tins').value = c.issuer.list.join('\n');
    $('rj-amt').checked = c.amount.on; $('rj-max').value = c.amount.max ?? ''; $('rj-min').value = c.amount.min ?? '';
    $('rj-vat').checked = c.vat.on; $('rj-tol').value = c.vat.tolPct; $('rj-dup').checked = c.dup.on;
    $('rj-typ').checked = c.types.on; $('rj-t-invoice').checked = c.types.invoice; $('rj-t-credit').checked = c.types.credit; $('rj-t-debit').checked = c.types.debit;
    $('rj-window').value = c.windowDays;
    rjCritHint(c);
  }
  function rjCollectCfg(persist) {
    const numv = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
    const c = normalizeCfg({
      issuer: { mode: $('rj-mode').value, list: $('rj-tins').value.split(/[\s,;]+/).filter(Boolean) },
      amount: { on: $('rj-amt').checked, max: numv('rj-max'), min: numv('rj-min') },
      vat: { on: $('rj-vat').checked, tolPct: numv('rj-tol') ?? 2 },
      dup: { on: $('rj-dup').checked },
      types: { on: $('rj-typ').checked, invoice: $('rj-t-invoice').checked, credit: $('rj-t-credit').checked, debit: $('rj-t-debit').checked },
      windowDays: numv('rj-window') ?? 14,
    });
    if (persist) lsSet(RJCFG_KEY, c);
    rjCritHint(c);
    return c;
  }
  function rjFoot() {
    const go = $('rj-go'); if (!go) return;
    const n = rjItems.filter((i) => i.sel).length;
    $('rj-count').textContent = t('rej.selCount', { n: fmt(n) });
    go.textContent = t(liveRejectAvailable() ? 'rej.goLive' : 'rej.goDry');
    go.disabled = busy || !n;
  }
  function rjRender() {
    const list = $('rj-list'); list.textContent = '';
    list.hidden = !rjItems.length; $('rj-foot').hidden = !rjItems.length;
    const L = getLang();
    rjItems.forEach((it, idx) => {
      const row = document.createElement('div'); row.className = 'rjrow' + (!it.eligible || !it.doc ? ' off' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = it.sel; cb.disabled = !it.eligible || !it.doc;
      cb.onchange = () => { it.sel = cb.checked; rjFoot(); };
      const main = document.createElement('div'); main.className = 'rjmain';
      const head = document.createElement('div'); head.className = 'rjhead';
      const name = document.createElement('span'); name.textContent = it.doc?.issuerName || it.uuid;
      const iid = document.createElement('span'); iid.className = 'num'; iid.style.color = 'var(--dim)'; iid.textContent = it.doc?.internalID || '';
      const amt = document.createElement('span'); amt.className = 'amt num'; amt.textContent = it.doc?.totalAmount != null ? fmt(it.doc.totalAmount) : '';
      head.append(name, iid, amt);
      const meta = document.createElement('div'); meta.className = 'rjmeta num';
      meta.textContent = [it.uuid, it.doc?.received ? String(it.doc.received).slice(0, 10) : '', it.ageDays != null ? Math.floor(it.ageDays) + 'd' : '',
        !it.eligible || !it.doc ? t(it.doc ? 'rej.expired' : 'rej.ineligible') : ''].filter(Boolean).join(' · ');
      const rules = document.createElement('div');
      for (const f of it.firings) { const b = document.createElement('span'); b.className = 'rjb' + (f.sev === 'flag' ? ' flag' : ''); b.textContent = f.id; b.title = L === 'ar' ? f.ar : f.en; rules.append(b); }
      main.append(head, meta, rules);
      if (it.eligible && it.doc) {
        const rs = document.createElement('input'); rs.className = 'rjreason'; rs.placeholder = t('rej.reasonPh');
        rs.value = it.reason ?? (it.firings.length ? (L === 'ar' ? it.firings[0].ar : it.firings[0].en) : '');
        it.reason = rs.value;
        rs.oninput = () => { it.reason = rs.value; };
        main.append(rs);
      }
      const res = document.createElement('div'); res.className = 'rjres'; res.dataset.rjres = String(idx); main.append(res);
      row.append(cb, main); list.append(row);
    });
    rjFoot();
  }
  $('rj-scan').onclick = async () => {
    if (busy) return;
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; return; }
    const cfg = rjCollectCfg(true);
    setBusy(true);
    rjItems = []; rjRender(); $('rj-note').hidden = true;
    const ctrl = new AbortController(); rjCtrl = ctrl;
    try {
      const win = await loadWindows({ signal: ctrl.signal });   // per-type window when the portal exposes it; honest fallback otherwise
      renderWinBadge(win, cfg);
      const res = await scanReceived({ from: $('rj-from').value, to: $('rj-to').value, cfg, resolveWindow: makeResolver(win, cfg), hooks: {
        onStatus: () => setFt('run', t('rej.phRows')),
        onProgress: (cur, max) => setFt('run', t('rej.phDetails', { cur: fmt(cur), max: fmt(max) })),
        onRate: (w) => setFt('wait', t('orch.rateWait', { s: Math.round(w / 1000) })),
        signal: ctrl.signal,
      } });
      rjItems = res.items.map((it) => ({ ...it, sel: it.verdict === 'reject' && it.eligible && !!it.doc, reason: undefined }));
      rjRender();
      const nRej = rjItems.filter((i) => i.sel).length;
      const note = $('rj-note'); note.hidden = false;
      note.className = rjItems.length ? 'rjnote warn' : 'rjnote';
      note.textContent = rjItems.length
        ? t('rej.found', { n: fmt(rjItems.length), rej: fmt(nRej), flag: fmt(rjItems.length - nRej) })
        : t('rej.none', { passed: fmt(res.passed), scanned: fmt(res.scanned) });
      logLine(note.textContent, { level: rjItems.length ? 'warn' : 'ok' });
      setFt(rjItems.length ? 'wait' : 'ok', note.textContent);
    } catch (e) {
      const msg = e.code === 'TOO_MANY' ? t('rej.tooMany', { n: fmt(e.count), cap: fmt(e.cap) })
        : e.code === 'BAD_RANGE' ? t('rej.badRange')
        : e.code === 'STOPPED' ? t('ft.pausingShort')
        : t('rej.scanFailed', { msg: e.code || e.message || e });
      const note = $('rj-note'); note.hidden = false; note.className = 'rjnote warn'; note.textContent = msg;
      logLine(msg, { level: 'err' }); setFt('err', msg);
    } finally { rjCtrl = null; setBusy(false); }
  };
  $('rj-go').onclick = async () => {
    if (busy) return;
    const sel = rjItems.map((it, idx) => ({ it, idx })).filter((x) => x.it.sel && x.it.eligible && x.it.doc);
    if (!sel.length) return;
    const dry = !liveRejectAvailable();
    if (!(await confirmModal(t('rej.confirmTitle', { n: fmt(sel.length) }), t(dry ? 'rej.confirmDrySub' : 'rej.confirmLiveSub')))) return;
    setBusy(true);
    const ctrl = new AbortController(); rjCtrl = ctrl;
    try {
      const items = sel.map(({ it }) => ({ uuid: it.uuid, reason: (it.reason || '').trim() || (it.firings[0] ? it.firings[0].ar : 'مرفوضة'), doc: it.doc, rules: it.firings.map((f) => f.id) }));
      const { dryRun, results } = await submitRejections(items, { dryRun: dry, signal: ctrl.signal, onItem: (i, r) => {
        const el = q(`[data-rjres="${sel[i].idx}"]`); if (!el) return;
        el.className = 'rjres ' + (r.ok ? 'ok' : 'err');
        el.textContent = r.ok ? t(r.dry ? 'rej.rowDry' : 'rej.rowOk') : t('rej.rowFail', { err: r.error });
      } });
      const okN = results.filter((r) => r.ok).length, failN = results.filter((r) => !r.ok).length;
      const msg = dryRun ? t('rej.doneDry', { n: fmt(okN) })
        : t('rej.doneLive', { icon: failN ? '⚠️' : '✅', ok: fmt(okN), n: fmt(items.length), failTail: failN ? t('rej.failTail', { fail: fmt(failN) }) : '' });
      logLine(msg, { level: failN ? 'err' : 'ok' });
      setFt(failN ? 'err' : 'ok', msg);
    } catch (e) { const m = t('rej.submitFailed', { msg: e.code || e.message || e }); logLine(m, { level: 'err' }); setFt('err', m); }
    finally { rjCtrl = null; setBusy(false); }
  };
  $('rj-auditbtn').onclick = async () => {
    if (!auditRuns().length) { setFt('', t('rej.auditEmpty')); return; }
    try { await navigator.clipboard.writeText(auditText()); setFt('ok', t('rej.auditCopied')); }
    catch { setFt('err', t('ft.logCopyBlocked')); }
  };
  ['rj-mode', 'rj-tins', 'rj-amt', 'rj-max', 'rj-min', 'rj-vat', 'rj-tol', 'rj-dup', 'rj-typ', 'rj-t-invoice', 'rj-t-credit', 'rj-t-debit', 'rj-window']
    .forEach((id) => $(id).addEventListener('change', () => rjCollectCfg(true)));
  rjLoadCfg();
  $('rj-to').value = todayYmd();
  $('rj-from').value = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);   // default: the receiver-rejection window

  // ── PO Reconciliation card ─────────────────────────────────────────────────
  // Upload → parse (engine) → Analyze: fetch received+details for the period, match against the
  // sheet, write the PO_Analytics workbook, surface stats. Out-of-period/over-consumption are
  // warnings only — this card never feeds the reject flow.
  function renderWinBadge(win, cfg) {
    const el = $('rj-winsrc'); if (!el) return;
    el.textContent = win && win.source === 'api' ? t('rej.winApi') : t('rej.winCfg', { days: cfg.windowDays });
  }
  function poFoot() { const b = $('po-analyze'); if (b) b.disabled = busy || !licensed || !poState.pos.length; }
  function poRender() {
    const st = $('po-status'); if (!st) return;
    st.textContent = poState.pos.length ? t('po.loaded', { n: fmt(poState.pos.length), warn: fmt(poState.warnings.length) }) + (poState.fileName ? ' · ' + poState.fileName : '') : '';
    const a = poState.analysis;
    $('po-sum').hidden = !a;
    if (a) { $('po-s-inv').textContent = fmt(a.totals.invoices); $('po-s-match').textContent = fmt(a.totals.matched); $('po-s-warn').textContent = fmt(a.totals.warnings); $('po-s-exc').textContent = fmt(a.totals.exceededPos); }
    poFoot();
  }
  const poNote = (cls, msg) => { const n = $('po-note'); n.hidden = false; n.className = cls ? 'rjnote warn' : 'rjnote'; n.textContent = msg; };
  $('po-pick').onclick = () => $('po-file').click();
  $('po-file').onchange = async () => {
    const f = $('po-file').files?.[0];
    $('po-file').value = '';   // reset so re-selecting the same (edited) file refires onchange
    if (!f) return;
    if (!window.ExcelJS) { setFt('err', t('orch.noExcel')); return; }
    try {
      const wb = new window.ExcelJS.Workbook();
      await wb.xlsx.load(await f.arrayBuffer());   // same read path merge.js uses
      const { pos, rowWarnings } = parsePoWorkbook(wb);
      poState = { pos, warnings: rowWarnings, fileName: f.name, analysis: null };
      poRender();
      if (!pos.length) poNote(true, t('po.noPos'));
      else poNote(rowWarnings.length > 0, t('po.loaded', { n: fmt(pos.length), warn: fmt(rowWarnings.length) }));
    } catch (e) {
      const msg = e.code === 'PO_HEADERS' ? t('po.badHeaders', { missing: (e.missing || []).join(', ') }) : t('po.parseFailed', { msg: e?.message || e });
      poNote(true, msg); setFt('err', msg);
    }
  };
  $('po-template').onclick = async () => {
    if (busy) return;
    if (!window.ExcelJS) { setFt('err', t('orch.noExcel')); return; }
    let d = null; try { d = await orch.ensureDir(); } catch {}
    if (!d) { setFt('', t('orch.pickFolder')); return; }
    if (!(await ensurePermission(d))) { setFt('err', t('orch.permLost')); return; }   // permission inside the click gesture
    try {
      const buf = await renderPoTemplate(window.ExcelJS).workbook.xlsx.writeBuffer();
      await writeBlob(d, 'PO_Template.xlsx', new Blob([buf], { type: XLSX_MIME }));
      setFt('ok', t('po.templateSaved'));
    } catch (e) { setFt('err', t('po.failed', { msg: e?.message || e })); }
  };
  $('po-analyze').onclick = async () => {
    if (busy || !poState.pos.length) return;
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; return; }
    if (!window.ExcelJS) { setFt('err', t('orch.noExcel')); return; }
    // folder + permission FIRST, inside the gesture — after minutes of fetching the re-request would fail
    let d = null; try { d = await orch.ensureDir(); } catch {}
    if (!d) { setFt('', t('orch.pickFolder')); return; }
    if (!(await ensurePermission(d))) { setFt('err', t('orch.permLost')); return; }
    setBusy(true);
    const ctrl = new AbortController(); rjCtrl = ctrl;   // shared controller: Pause aborts analyze too
    try {
      const cfg = rjCollectCfg(false);
      const win = await loadWindows({ signal: ctrl.signal });
      renderWinBadge(win, cfg);
      setFt('run', t('po.phFetch'));
      const { results } = await fetchReceivedDetails({ from: $('po-from').value, to: $('po-to').value, hooks: {
        onStatus: () => setFt('run', t('po.phFetch')),
        onProgress: (cur, max) => setFt('run', t('po.phVerify', { cur: fmt(cur), max: fmt(max) })),
        onRate: (w) => setFt('wait', t('orch.rateWait', { s: Math.round(w / 1000) })),
        signal: ctrl.signal,
      } });
      const invoices = results.filter((r) => r.o && (!r.o.status || r.o.status === 'Valid')).map((r) => projectInvoice(r.o));
      const fetchFailed = results.filter((r) => !r.o).length;   // fail-closed: unverifiable docs are counted and reported, never dropped silently
      const analysis = analyzePo(poState.pos, invoices, { resolveWindow: makeResolver(win, cfg), windowDays: cfg.windowDays, fetchFailed });
      poState.analysis = analysis;
      const name = poAnalyticsName(new Date());
      const meta = { from: $('po-from').value, to: $('po-to').value, generatedAt: new Date().toISOString(), version: EXT_VERSION, windowSource: win.source, windowDays: cfg.windowDays };
      const buf = await renderPoAnalytics(window.ExcelJS, analysis, meta).workbook.xlsx.writeBuffer();
      await writeBlob(d, name, new Blob([buf], { type: XLSX_MIME }));
      poRender();
      let msg = t('po.done', { name, inv: fmt(analysis.totals.invoices), matched: fmt(analysis.totals.matched), warn: fmt(analysis.totals.warnings) });
      if (fetchFailed) msg += ' ' + t('po.fetchFail', { n: fmt(fetchFailed) });
      poNote(analysis.totals.warnings > 0 || fetchFailed > 0, msg);
      logLine(msg, { level: analysis.totals.warnings || fetchFailed ? 'warn' : 'ok' });
      setFt(analysis.totals.warnings || fetchFailed ? 'wait' : 'ok', msg);
    } catch (e) {
      const msg = e.code === 'TOO_MANY' ? t('rej.tooMany', { n: fmt(e.count), cap: fmt(e.cap) })
        : e.code === 'BAD_RANGE' ? t('rej.badRange')
        : e.code === 'STOPPED' ? t('ft.pausingShort')
        : t('po.failed', { msg: e.code || e.message || e });
      poNote(true, msg); logLine(msg, { level: 'err' }); setFt('err', msg);
    } finally { rjCtrl = null; setBusy(false); }
  };
  $('po-to').value = todayYmd();
  $('po-from').value = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);   // default: last 30 days (2,000-doc scan cap guides narrower ranges)

  $('logcopy').onclick = async () => {
    const header = `ETA Bulk v${EXT_VERSION} · ${tab === 'rejection' ? 'rejection' : source} · ${new Date().toISOString()}\n`;
    try { await navigator.clipboard.writeText(header + rlog.text()); setFt('ok', t('ft.logCopied')); }
    catch { setFt('err', t('ft.logCopyBlocked')); }   // portal permissions-policy edge case
  };
  $('logclear').onclick = () => { rlog.clear(); renderLog(); try { localStorage.removeItem(RLOG_KEY); } catch {} setFt('', t('ft.logCleared')); };

  // Language: annotated nodes re-render via the data-i18n walker; dynamic areas (footer, chunk line)
  // pick up the new language on their next event. dir flips the drawer to RTL; .num/.log stay LTR islands.
  function applyLang() {
    const L = getLang();
    $('drawer').setAttribute('dir', L === 'ar' ? 'rtl' : 'ltr');
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });   // catalog-owned markup only (consent text)
    { const pl = $('privacy-link'); if (pl) pl.href = String(LEAD_URL).replace(/\/$/, '') + '/privacy'; }    // consent innerHTML recreates the link — re-point it
    if (!orch.folderName()) $('folder').textContent = t('ui.noFolder');
    $('langBtn').textContent = L === 'ar' ? 'EN' : 'ع';
    applySourceUI();   // dir/field option labels, cap line (renderCap), proc label, column chips (selection-preserving)
    rjRender(); poRender();   // rejection views bake t() at render — re-render so a language toggle isn't half-translated (row state lives on the items)
    renderLog();
  }
  $('langBtn').onclick = () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); applyLang(); refreshLicense(); };
  // Theme: default dark (the original look); light mirrors the admin dashboard. Pure CSS via data-theme.
  const applyTheme = (th) => { host.setAttribute('data-theme', th); $('themeBtn').textContent = th === 'light' ? '☀' : '🌙'; };
  applyTheme(lsGet('theme') === 'light' ? 'light' : 'dark');
  $('themeBtn').onclick = () => { const th = host.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; lsSet('theme', th); applyTheme(th); };
  applyLang();   // initial render in the persisted language (also runs applySourceUI + renderLog + privacy href)
  setFt('', t('ft.initial'));
  refreshLicense();   // registration gate — engages only once LEAD_URL is wired in registration.js
  orch.onToken?.(orch.tokenStatus());
  // NOTE: no local named `t` in mountUI scope — it would shadow the imported i18n t() (TDZ at mount).
  const tokChip = (tk) => { const c = $('tok'); c.className = 'chip ' + (tk.ok ? 'ok' : 'err'); c.querySelector('.num').textContent = tk.label.replace(/^(Token|الجلسة):\s*/, ''); };
  tokChip(orch.tokenStatus());
  setInterval(() => tokChip(orch.tokenStatus()), 30000);
  idbGet('dh_last').then((h) => { if (h) { orch.setFolder(h); $('folder').textContent = h.name; } }).catch(() => {});

  // survive SPA re-render: re-append host if the app wipes it
  const obs = new MutationObserver(() => { if (!document.getElementById('eta-bulk-host')) document.documentElement.appendChild(host); });
  obs.observe(document.documentElement, { childList: true });

  return orch;
}
