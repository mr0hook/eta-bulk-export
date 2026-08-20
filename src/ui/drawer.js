// Unified drawer UI (Shadow-DOM isolated, no remote code). Owns the orchestrator and subscribes to
// its hooks. Type, mark and palette follow the omarsoliman.dev design system; the faces are bundled
// bytes (fonts.js) registered via FontFace, not fetched, so nothing here loads remote code.
import { createOrchestrator } from '../core/orchestrator.js';
import { ALL_STATUSES } from '../api/sources.js';
import { idbGet, ensurePermission, writeBlob } from '../core/fs.js';
import { mergeFolder } from '../core/merge.js';
import { repairFolder } from '../core/repair.js';
import { removableColumns, XLSX_MIME } from '../export/xlsx.js';
import { session, register, gateEnabled, taxpayerId, requestRin, reportBug, LEAD_URL, EXT_VERSION, jobResumable, jobPlan, jobCheckpoint } from '../core/registration.js';
import { createRunLog } from '../core/runlog.js';
import { createEtaTracker } from '../core/eta.js';
import { FONT_BLOBS } from './fonts.js';
import { lsGet, lsSet } from '../core/ls.js';
import { readProgress, uuidMergeScope } from '../core/store.js';
import { parseList } from '../core/listinput.js';   // SPEC-022: the pasted UUID/RIN list
import { parseFailureUuids } from '../core/failures.js';   // SPEC-028: retry list from eta_failures.jsonl
import { readText } from '../core/fs.js';
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
// SPEC-018 — the Download flow's model. Pure (no DOM): the mapping, the defaults and the end-of-run
// sequence live in flow.js so they can be asserted without a shadow root (test/flow.test.mjs).
import {
  defaultRange, defaultAdvanced, normalizeAdvanced, loadAdvanced, saveAdvanced, advancedChanges,
  buildSel, sourceOfKind, kindOf, rejectionAllowed, resumeEntry, planFromJob, finishRun, runFinished, runClean,
  registerRefusal, chunkMap, runGuarded, restoreLog, persistLog, clearedLog, folderAction, abandonCheckpoint,
} from './flow.js';

const CSS = `
:host{ all:initial;
  /* Theme palette — omarsoliman.dev "clay & paper", dark set. The drawer stays dark on purpose: it is
     injected into the ETA portal's white SPA and has to read as a separate instrument, so the site's
     LIGHT paper palette is used only for the opt-in light theme below. data-theme flips the set.
     Values are the design system's, UNMODIFIED — by explicit decision, brand fidelity over the
     contrast nudges an earlier pass applied. Three pairs land below WCAG AA as a result; they are
     measured and pinned in test/theme.test.mjs rather than silently accepted. */
  --bg:#1a1712; --bg2:#131008; --bg3:#0d0b06; --bg-hd:#221e17; --bg-ft:#151209; --bg-hov:#2b261d;
  --line:#3b3527; --line2:#2b261d; --line3:#564e3a;
  --text:#f0eadb; --muted:#a39a84; --dim:#7a715c; --gate-sub:#d6b98a;
  --gold:#e08358; --gold2:#ec9a74; --gold-bd:#c2603b; --on-gold:#1a1712; --gold-chip:#3a2a20;
  --teal:#8fae97; --ok:#7cbe96; --ok-bd:#2c4a38; --ok-bg:#24342a; --err:#e08a7b; --err-bd:#4e312b; --err-bg:#3d241f;
  --info-bg:#27332b; --info-tx:#8fae97; --warn-bg:#3c321a; --warn-tx:#d9b05e;
  --focus:rgba(224,131,88,.15); --focus2:rgba(224,131,88,.18); --scrim:rgba(12,10,7,.35); --mscrim:rgba(12,10,7,.55);
  --shadow:0 18px 50px -12px rgba(0,0,0,.65); --glow:0 6px 16px -6px rgba(224,131,88,.5); --seg-shadow:0 8px 24px -8px rgba(0,0,0,.6);
  /* Type system. The families are bundled and registered from bytes at mount (see fonts.js and
     installFonts) — a url() @font-face would be subject to the portal's CSP. Each stack keeps its
     system fallback, so a blocked or failed load degrades silently to what shipped before. */
  --font-ui:'Bricolage Grotesque','Avenir Next','Segoe UI',system-ui,sans-serif;
  --font-mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
  --font-ar:'IBM Plex Sans Arabic','Bricolage Grotesque',system-ui,sans-serif;
  --r-lg:16px; --r:10px; --r-sm:6px;
  --dur-1:.12s; --dur-2:.2s; --dur-3:.35s; --ease-out:cubic-bezier(.22,1,.36,1);
  --scheme:dark }
:host([data-theme=light]){
  --bg:#faf6ee; --bg2:#fffdf7; --bg3:#f2ebdd; --bg-hd:#fffdf7; --bg-ft:#f2ebdd; --bg-hov:#e7dec9;
  --line:#e3dac6; --line2:#efe8d8; --line3:#c9bea3;
  --text:#231f18; --muted:#6b6453; --dim:#968d78; --gate-sub:#7c381f;
  --gold:#c2603b; --gold2:#dd8b62; --gold-bd:#a04a2a; --on-gold:#fffdf7; --gold-chip:#f4e2d6;
  --teal:#44685a; --ok:#2e7b4f; --ok-bd:#c4dcc9; --ok-bg:#ddebdb; --err:#b23f2e; --err-bd:#e8c9bf; --err-bg:#f4ddd4;
  --info-bg:#e2e9e0; --info-tx:#2f4f41; --warn-bg:#f3e6c2; --warn-tx:#95680f;
  --focus:rgba(160,74,42,.22); --focus2:rgba(160,74,42,.22); --scrim:rgba(35,31,24,.28); --mscrim:rgba(35,31,24,.45);
  --shadow:0 18px 40px -14px rgba(35,31,24,.22); --glow:0 6px 16px -6px rgba(160,74,42,.35); --seg-shadow:0 2px 8px rgba(35,31,24,.12);
  --scheme:light }
*{ box-sizing:border-box }
[hidden]{ display:none !important }   /* the hidden attribute must always win over any class display: rule (this bit .gate and #modal-root) */
.pill{ position:fixed; right:16px; bottom:16px; z-index:2147483647; font:600 13px var(--font-ui);
  display:inline-flex; align-items:center; gap:8px;
  padding:10px 14px; border-radius:var(--r); border:1px solid var(--gold-bd); color:var(--on-gold); cursor:pointer;
  background:linear-gradient(var(--gold2),var(--gold)); box-shadow:var(--glow) }
/* The brand star replaces the 📥 emoji: an emoji renders in the OS colour font, which ignores the
   palette entirely and looks different on every machine. The mark inherits currentColor. */
.pill svg{ width:15px; height:15px; flex:none }
.pill:hover{ filter:brightness(1.05) }
.scrim{ position:fixed; inset:0; z-index:2147483646; background:var(--scrim); opacity:0; pointer-events:none; transition:var(--dur-2) var(--ease-out) }
.scrim.on{ opacity:1; pointer-events:auto }
.drawer{ position:fixed; top:0; right:0; bottom:0; z-index:2147483647; width:404px; max-width:100vw;
  display:flex; flex-direction:column; background:var(--bg); color:var(--text); border-left:1px solid var(--line);
  box-shadow:var(--shadow); transform:translateX(100%); transition:transform var(--dur-3) var(--ease-out);
  font-family:var(--font-ui) }   /* direction comes from the dir attribute (ltr default, rtl in Arabic) */
.drawer.on{ transform:none }
/* Arabic gets its own face rather than letting Bricolage fall back to a system Arabic font: the two
   have different vertical metrics and the mixed result looks accidental. Scoped to the container so
   every descendant inherits, tokens included. */
.drawer[dir=rtl]{ --font-ui:var(--font-ar) }
.num{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; direction:ltr; unicode-bidi:isolate }   /* numbers/times stay LTR inside RTL text */
.hd{ padding:16px 16px 13px; border-bottom:1px solid var(--line2); background:linear-gradient(180deg,var(--bg-hd),var(--bg)) }
.hd-top{ display:flex; justify-content:space-between; align-items:center }
.brand{ display:flex; align-items:center; gap:10px }
/* The mark, matching assets/mark.svg: a flat clay tile with the cream star. Flat, not the gradient
   the old seal used — the brand mark has no gradient. radius is mark.svg's rx=15 at 64, scaled. */
.seal{ width:32px;height:32px;border-radius:7.5px;display:grid;place-items:center;color:var(--on-gold);background:var(--gold) }
.seal svg{ width:18px;height:18px }
.wm{ font:700 18px/1 var(--font-ui) }
/* Byline, sitting where the old translated tag line used to. Carries the brand accent rather than
   --dim, and the design system's display stack rather than the 9px mono the other micro-labels use
   — it is a signature, not a field label, so it does not follow their convention. (The webfont
   itself will not load under the portal's CSS policy; the stack degrades to var(--font-ui), which is
   what every other line in this drawer already renders in.)
   direction/unicode-bidi keep the Latin domain intact inside the Arabic RTL header. Not uppercased:
   a domain is a name, and this line is no longer a translated label — the text is fixed in both
   languages, so it carries no data-i18n. */
.tag{ font:600 11px/1 var(--font-ui);
  letter-spacing:.01em; color:var(--gold); margin-top:4px;
  direction:ltr; unicode-bidi:isolate; white-space:nowrap }
.x{ background:transparent;border:0;color:var(--muted);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:var(--r-sm) } .x:hover{ background:var(--bg-hov);color:var(--text) }
.chip{ display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font:600 11px/1 var(--font-mono);border:1px solid var(--line);color:var(--muted);background:var(--bg2) }
.chip .dot{ width:6px;height:6px;border-radius:50%;background:currentColor }
.chip.ok{ color:var(--ok);border-color:var(--ok-bd);background:var(--ok-bg) } .chip.err{ color:var(--err);border-color:var(--err-bd);background:var(--err-bg) }
.src{ margin-top:14px; display:flex; align-items:center; justify-content:space-between; gap:10px }
.seg{ display:inline-flex;padding:3px;gap:3px;background:var(--bg2);border:1px solid var(--line);border-radius:999px }
.seg button{ border:0;background:transparent;color:var(--muted);font:600 12px var(--font-ui);padding:6px 15px;border-radius:999px;cursor:pointer }
.seg button[aria-selected=true]{ background:var(--bg-hov);color:var(--text);box-shadow:var(--seg-shadow) }
.cap{ font:500 11px var(--font-mono);color:var(--muted);text-align:end } .cap b{ color:var(--gold) }
.body{ flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:13px }
.body::-webkit-scrollbar{ width:9px } .body::-webkit-scrollbar-thumb{ background:var(--line);border-radius:var(--r);border:2px solid var(--bg) }
.card{ background:var(--bg);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px }
.sh{ display:flex;align-items:baseline;gap:9px;margin-bottom:12px }
.sh .n{ font:600 12px var(--font-ui);color:var(--gold);width:20px;height:20px;border-radius:var(--r-sm);display:grid;place-items:center;background:var(--gold-chip) }
.sh h3{ margin:0;font:600 13px var(--font-ui) } .sh .hint{ margin-inline-start:auto;font:500 11px var(--font-mono);color:var(--dim) }
.row{ display:grid;grid-template-columns:1fr 1fr;gap:10px }
label.l{ display:block;font:600 10px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:5px }
select,.ctl{ width:100%;padding:9px 11px;border-radius:var(--r-sm);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 13px var(--font-ui);appearance:none }
input[type="date"].ctl{ appearance:auto;color-scheme:var(--scheme);direction:ltr;font:500 12px var(--font-mono) }
select:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--focus) }
.chips{ display:flex;flex-wrap:wrap;gap:7px }
.sc{ display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg2);color:var(--muted);font:600 11px var(--font-mono);cursor:pointer;user-select:none }
.sc input{ accent-color:var(--gold);margin:0 }
.togg{ display:inline-flex;align-items:center;gap:8px;cursor:pointer;font:600 12px var(--font-ui) } .togg input{ accent-color:var(--gold) }
.folder{ display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px dashed var(--line);border-radius:var(--r-sm);background:var(--bg2);margin-top:12px }
.folder svg{ width:16px;color:var(--teal) } .folder .p{ font:500 12px var(--font-mono);color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.btn{ font:600 13px var(--font-ui);display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 14px;border-radius:var(--r);cursor:pointer;border:1px solid var(--line);background:var(--bg-hov);color:var(--text) }
.btn:hover{ border-color:var(--line3) } .btn.primary{ background:linear-gradient(180deg,var(--gold2),var(--gold));color:var(--on-gold);border-color:var(--gold-bd) }
.btn.sm{ padding:8px 11px;font-size:12px } .btn[disabled]{ opacity:.4;cursor:not-allowed }
.stats{ display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:var(--r);overflow:hidden;margin-top:11px }
.stat{ background:var(--bg2);padding:11px 12px } .stat .k{ font:600 10px var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim) } .stat .v{ font:600 21px var(--font-mono);margin-top:2px }
.runbar{ display:flex;gap:8px } .runbar .btn{ flex:1 }
.tracker{ display:flex;gap:7px;margin:12px 0 9px } .tk{ flex:1;text-align:center;padding:8px 4px;border-radius:var(--r-sm);background:var(--bg2);border:1px solid var(--line2) }
.tk .v{ font:600 16px var(--font-mono) } .tk .k{ font:600 9px var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-top:2px }
.tk.ok .v{ color:var(--ok) } .tk.err .v{ color:var(--err) } .tk.left .v{ color:var(--teal) }
.track{ height:8px;border-radius:999px;background:var(--bg2);border:1px solid var(--line2);overflow:hidden } .track>i{ display:block;height:100%;width:0;background:linear-gradient(90deg,var(--teal),var(--gold));transition:width .3s }
.proc{ display:flex;align-items:baseline;justify-content:space-between;margin:9px 0 7px } .proc .pv{ font:600 19px var(--font-mono);color:var(--text) } .proc .pv #procN{ color:var(--gold) } .proc .pl{ font:600 10px var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim) }
.log{ margin-top:10px;padding:9px 11px;border-radius:var(--r-sm);background:var(--bg3);border:1px solid var(--line2);font:500 11px/1.55 var(--font-mono);color:var(--muted);max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;direction:ltr;text-align:left;unicode-bidi:plaintext }   /* technical console stays an LTR island; Arabic words inside lines render RTL via the bidi algorithm */
details.cols{ margin-top:13px } details.cols summary{ list-style:none;font:600 10px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim);cursor:pointer;user-select:none }
details.cols summary::-webkit-details-marker{ display:none }
details.cols summary::before{ content:'▸ '; color:var(--gold) } details.cols[open] summary::before{ content:'▾ ' }
details.cols .chips{ margin-top:9px }
.ckline{ display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;font:600 10px var(--font-mono);letter-spacing:.06em;color:var(--dim) } .ckline .cknow{ color:var(--muted) }
.ckbar{ height:6px;border-radius:999px;background:var(--bg2);border:1px solid var(--line2);overflow:hidden;margin-top:6px } .ckbar>i{ display:block;height:100%;width:0;background:linear-gradient(90deg,var(--gold),var(--teal));transition:width .25s }
/* The chunk map: one square per chunk, which is the thing the run card never had. Flex-wrap rather
   than a fixed grid so it mirrors under RTL for free and reflows at any chunk count. */
.ckgrid{ display:flex;flex-wrap:wrap;gap:3px;margin-top:8px }
.ckq{ width:9px;height:9px;border-radius:2px;background:var(--bg2);border:1px solid var(--line2);flex:0 0 auto }
.ckq.done{ background:var(--ok);border-color:var(--ok-bd) }
.ckq.part{ background:var(--ok);border-color:var(--ok-bd);opacity:.42 }   /* a range cell only some of whose chunks landed */
.ckq.run{ background:var(--gold);border-color:var(--gold-bd) }
.ckq.failed{ background:var(--err);border-color:var(--err-bd) }
.cklegend{ display:flex;flex-wrap:wrap;gap:10px;margin-top:7px;font:500 9px var(--font-mono);color:var(--dim) }
.cklegend span{ display:inline-flex;align-items:center;gap:4px }
.tools{ display:flex;gap:8px } .tools .btn{ flex:1 }
.ft{ border-top:1px solid var(--line2);padding:12px 15px;display:flex;align-items:center;gap:10px;background:linear-gradient(0deg,var(--bg-ft),var(--bg)) }
.ft .dot{ width:9px;height:9px;border-radius:50%;background:var(--dim);flex:0 0 auto } .ft.run .dot{ background:var(--gold) } .ft.ok .dot{ background:var(--ok) } .ft.err .dot{ background:var(--err) } .ft.wait .dot{ background:var(--teal) }
.ft .msg{ font:500 12px var(--font-ui);flex:1 }
.gate{ min-height:100%;display:flex;flex-direction:column;justify-content:center;gap:11px;padding:6px 4px }
.gate[hidden]{ display:none }   /* the class rule above sets display:flex, which otherwise overrides the [hidden] attribute — once registered, the gate must actually leave the layout so you land straight on the tool */
.gate .g-head{ font:800 19px var(--font-ui);color:var(--gold2);display:flex;align-items:center;gap:9px }
.gate .g-sub{ font:500 12.5px var(--font-ui);color:var(--gate-sub);margin:-3px 0 6px;line-height:1.45 }
.gate input.rg{ width:100%;padding:11px 13px;border-radius:var(--r);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 14px var(--font-ui) }
.gate input.rg:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--focus2) }
.gate .g-consent{ display:flex;align-items:flex-start;gap:9px;font:500 11.5px var(--font-ui);color:var(--muted);line-height:1.45;cursor:pointer;margin-top:4px } .gate .g-consent input{ margin-top:2px;accent-color:var(--gold) } .gate .g-consent a{ color:var(--gold) }
.gate button.rg-btn{ font:700 14px var(--font-ui);padding:12px 14px;border-radius:var(--r);border:1px solid var(--gold-bd);background:linear-gradient(var(--gold2),var(--gold));color:var(--on-gold);cursor:pointer;margin-top:4px }
.gate button.rg-btn:hover{ filter:brightness(1.05) } .gate button.rg-btn:disabled{ opacity:.55;cursor:progress }
.gate .g-msg{ font:600 11px var(--font-mono);color:var(--err);margin-top:2px }
.ann{ padding:9px 14px;font:600 12px var(--font-ui);border-bottom:1px solid var(--line2);line-height:1.4 }
.ann.info{ background:var(--info-bg);color:var(--info-tx) } .ann.warn{ background:var(--warn-bg);color:var(--warn-tx) } .ann.alert{ background:var(--err-bg);color:var(--err) }
.bmodal-scrim{ position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:var(--mscrim);padding:20px }
.bmodal{ width:100%;max-width:340px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px;box-shadow:var(--shadow) }
.bmodal-t{ font:700 14px var(--font-ui);margin-bottom:4px } .bmodal-s{ font:500 11px var(--font-ui);color:var(--muted);margin-bottom:10px }
.bmodal-ta{ width:100%;min-height:92px;resize:vertical;padding:9px 11px;border-radius:var(--r);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 13px var(--font-ui) }
.bmodal-ta:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--focus) }
.bmodal-f{ display:flex;gap:8px;justify-content:flex-end;margin-top:12px }
.rjlist{ max-height:300px;overflow:auto;margin-top:10px }
.rjrow{ display:flex;gap:9px;align-items:flex-start;padding:9px 2px;border-top:1px solid var(--line2) }
.rjrow input[type=checkbox]{ accent-color:var(--err);margin-top:3px;flex:0 0 auto }
.rjrow.off{ opacity:.55 }
.rjmain{ flex:1;min-width:0 }
.rjhead{ font:600 12px var(--font-ui);display:flex;gap:7px;flex-wrap:wrap;align-items:baseline }
.rjhead .amt{ margin-inline-start:auto;color:var(--gold) }
.rjmeta{ font:500 10px var(--font-mono);color:var(--dim);margin-top:2px }
.rjb{ display:inline-block;font:600 9px var(--font-mono);padding:2px 7px;border-radius:999px;border:1px solid var(--err-bd);color:var(--err);background:var(--err-bg);margin:4px 4px 0 0 }
.rjb.flag{ border-color:var(--line);color:var(--warn-tx);background:var(--warn-bg) }
.rjreason{ width:100%;margin-top:6px;padding:6px 9px;border-radius:var(--r-sm);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 11px var(--font-ui) }
.rjreason:focus{ outline:none;border-color:var(--gold);box-shadow:0 0 0 2px var(--focus) }
.rjres{ font:600 10px var(--font-mono);margin-top:3px } .rjres.ok{ color:var(--ok) } .rjres.err{ color:var(--err) }
.rjfoot{ display:flex;gap:8px;align-items:center;margin-top:11px }
.rjfoot .cnt{ font:600 11px var(--font-mono);color:var(--muted);white-space:nowrap }
.rjnum{ width:100%;padding:8px 10px;border-radius:var(--r-sm);background:var(--bg2);color:var(--text);border:1px solid var(--line);font:500 12px var(--font-mono) }
.rjnote{ margin-top:10px;padding:8px 11px;border-radius:var(--r-sm);font:600 11px var(--font-ui);background:var(--info-bg);color:var(--info-tx) }
.rjnote.warn{ background:var(--warn-bg);color:var(--warn-tx) }
/* ── SPEC-018 · the Download flow ──────────────────────────────────────────────────────────────
   One primary action, then a folder, then one question. Everything below is the chrome for those
   three steps; the old three-card form's controls live on inside <details class="adv">. */
.hero{ width:100%;font:700 15px var(--font-ui);padding:15px 14px }
.hint-line{ margin-top:9px;font:500 11.5px var(--font-ui);color:var(--muted);line-height:1.45 }
/* Resume entry: a whole row, not a link — an interrupted export is the most important thing on the
   screen for the person who has one, and invisible to everyone else. */
.resume{ display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;text-align:start;cursor:pointer;
  padding:11px 13px;border-radius:var(--r);border:1px solid var(--gold-bd);background:var(--gold-chip);color:var(--text) }
.resume:hover{ filter:brightness(1.08) } .resume[disabled]{ opacity:.45;cursor:not-allowed }
/* An interrupted run needs a way OUT as well as a way back in: without one, a force-closed run is
   offered on every mount for ever (the server only drops it at 'done' or 'abandoned'). */
.resumerow{ display:flex;gap:8px;align-items:stretch;margin-top:10px }
.rz-x{ flex:0 0 auto;padding:0 12px;font-size:13px }
.resume .rz-t{ font:600 13px var(--font-ui) } .resume .rz-s{ font:500 11px var(--font-mono);color:var(--muted) }
.seg.kinds{ display:flex;width:100% } .seg.kinds button{ flex:1;padding:8px 6px }
details.adv summary{ display:flex;align-items:baseline;gap:7px }
details.adv .advbody{ margin-top:11px;padding-top:11px;border-top:1px solid var(--line2) }
.offer{ margin-top:12px;padding:11px 13px;border-radius:var(--r);background:var(--warn-bg);color:var(--warn-tx);
  font:600 11.5px var(--font-ui);line-height:1.45;display:flex;flex-direction:column;gap:9px;align-items:flex-start }
.lockline{ margin-top:10px;font:500 11px var(--font-ui);color:var(--dim);line-height:1.4 }
/* Arabic has no letter case and its letterforms join: uppercasing is a no-op and letter-spacing
   breaks the joins into loose glyphs. Both are neutralised for every micro-label when RTL. */
.drawer[dir=rtl] label.l, .drawer[dir=rtl] .stat .k, .drawer[dir=rtl] .tk .k, .drawer[dir=rtl] .proc .pl,
.drawer[dir=rtl] .ckline, .drawer[dir=rtl] details.cols summary{ text-transform:none; letter-spacing:normal }
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

// Register the bundled faces from BYTES. FontFace(name, ArrayBuffer) performs no fetch, so the ETA
// portal's CSP — which has no font-src exemption for us and already blocks eval (see csp-shim.js) —
// has nothing to refuse. Faces land in document.fonts, which shadow roots resolve against.
// Best-effort by contract: any failure leaves the CSS stacks to fall back to system fonts, which is
// exactly what the drawer rendered before they were bundled. Never throws, never blocks mount.
let fontsInstalled = false;
function installFonts() {
  if (fontsInstalled) return;
  fontsInstalled = true;
  try {
    if (typeof FontFace !== 'function' || !document.fonts || !document.fonts.add) return;
    for (const f of FONT_BLOBS) {
      try {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const face = new FontFace(f.family, bytes.buffer, { weight: f.weight, style: 'normal', display: 'swap' });
        face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
      } catch {}
    }
  } catch {}
}

export function mountUI() {
  if (document.getElementById('eta-bulk-host')) return;
  const host = document.createElement('div');
  host.id = 'eta-bulk-host';
  const root = host.attachShadow({ mode: 'open' });
  const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
  installFonts();

  root.innerHTML += `
    <button class="pill" id="pill">${SEAL} ETA Bulk</button>
    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer" dir="ltr" role="dialog" aria-modal="true" aria-label="ETA Bulk Export">
      <header class="hd">
        <div class="hd-top">
          <div class="brand"><div class="seal">${SEAL}</div><div><div class="wm">ETA&nbsp;Bulk</div><div class="tag">by omarsoliman.dev</div></div></div>
          <div style="display:flex;align-items:center;gap:8px"><span class="chip" id="tok"><span class="dot"></span><span class="num">—</span></span><button class="x" id="langBtn" data-i18n-title="ui.langTitle" title="العربية / English" aria-label="Language" style="font-size:13px;font-weight:700">ع</button><button class="x" id="themeBtn" data-i18n-title="ui.themeTitle" title="Light / dark theme" aria-label="Toggle theme" style="font-size:15px">🌙</button><button class="x" id="close" aria-label="Close">×</button></div>
        </div>
        <!-- SPEC-018: the Receipts tab is gone — Sales/Purchases/Receipts is one question inside the
             export flow, not two places to reach the same job. What is left is Export vs Rejection,
             and Rejection is gated on the /session feature list. -->
        <div class="src" id="srcrow">
          <div class="seg" role="tablist" aria-label="Section" id="tabs">
            <button role="tab" aria-selected="true" data-tab="export" data-i18n="flow.export">Export</button>
            <button role="tab" aria-selected="false" data-tab="rejection" data-i18n="ui.rejection">Rejection</button>
          </div>
          <div class="cap" id="cap">Documents · cap <b>10,000</b>/search</div>
        </div>
        <div class="lockline" id="rejlock" hidden data-i18n="flow.rejLocked"></div>
      </header>
      <div class="ann" id="umsg" hidden></div>
      <div class="ann" id="ann" hidden></div>
      <div class="body">
        <div class="gate" id="gate" hidden>
          <div id="gate-form">
            <div class="g-head" data-i18n="gate.head">🔒 Register to unlock bulk export</div>
            <div class="g-sub" data-i18n="gate.sub">Free · one-time. Auto-detected tax registration no. — enter your contact details below.</div>
            <input class="rg" id="rg-rin-input" value="—" readonly aria-label="Tax registration number (auto-detected)" style="opacity:.7;cursor:not-allowed;font:700 14px var(--font-mono)">
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
        <!-- Step 1 · one primary action. Reaching "data is downloading" used to cost about a dozen
             decisions; every one of them now has a default that reproduces the configured run. -->
        <div id="step-home">
        <section class="card">
          <button class="btn primary hero" id="download" data-i18n="flow.download">⭳ Download</button>
          <!-- The ✕ is not decoration: it is the only path out of a resume offer for a run the user
               has given up on. Without it a force-closed run is offered on every mount for ever. -->
          <div class="resumerow" id="resumeRow" hidden>
            <button class="resume" id="resumeEntry"><span class="rz-t" id="rz-what"></span><span class="rz-s num" id="rz-sub"></span></button>
            <button class="btn sm rz-x" id="resumeDiscard" data-i18n-title="flow.discardTitle" aria-label="Discard" title="Discard this interrupted run">✕</button>
          </div>
          <div class="hint-line" id="dlhint" data-i18n="flow.downloadHint">Pick a folder, choose what to export, and go.</div>
          <!-- The folder also lives HERE, not only on step 2. A handle restored from IndexedDB comes
               back unpermitted, and the screen that reports "pick a folder" must be a screen you can
               pick one from. -->
          <div class="folder"><span>${FOLDER_ICO}</span><span class="p" id="folderHome">No output folder</span><button class="btn sm" id="pickHome" data-i18n="ui.pick">Pick</button></div>
        </section>
        <section class="card">
          <div class="sh"><h3 data-i18n="ui.tools">Tools</h3><span class="hint" data-i18n="ui.toolsHint">post-run</span></div>
          <!-- Merge stays a standalone action: a folder the user did not just export into still has
               to be mergeable. Repair is NOT here — it appears only when merge reports a file it
               could not read (see #repairOffer). -->
          <div class="tools"><button class="btn" id="merge" data-i18n="ui.merge">⧉ Merge folder</button><button class="btn" id="sync" data-i18n="ui.sync" data-i18n-title="ui.syncTitle" title="Re-exports from 3 days before the last run's end through today, into the same folder.">⟳ Sync new since last run</button></div>
          <!-- SPEC-034: resume straight from the folder's own progress file. The Resume entry above
               only appears when the SERVER still lists the job, and a job is device-scoped — so a
               device that lost its identity (2026-08-20) could not continue a run whose plan was
               sitting complete in the folder the whole time. -->
          <button class="btn sm" id="resumeFolder" style="width:100%;margin-top:8px" data-i18n="ui.resumeFolder" data-i18n-title="ui.resumeFolderTitle" title="Continues an interrupted run using the plan saved in the export folder — no server job needed.">⏵ Resume from folder</button>
          <button class="btn sm" id="bug" style="width:100%;margin-top:8px" data-i18n="ui.bug">🐞 Report a bug</button>
          <button class="btn sm" id="reqrin" style="width:100%;margin-top:8px" hidden data-i18n="ui.reqrin">＋ Request access for another account</button>
        </section>
        </div>
        <!-- Step 2 · one question. Sales/Purchases/Receipts replaces the source toggle AND the
             direction select; the range defaults to this calendar year; everything else is behind
             Advanced, collapsed, remembered, and defaulted to today's behaviour exactly. -->
        <div id="step-what" hidden>
        <section class="card">
          <div class="sh"><span class="n">1</span><h3 data-i18n="flow.whatTitle">What to export</h3></div>
          <div class="seg kinds" role="tablist" aria-label="What to export" id="kinds">
            <button role="tab" aria-selected="true" data-kind="sales" data-i18n="flow.sales">Sales</button>
            <button role="tab" aria-selected="false" data-kind="purchases" data-i18n="flow.purchases">Purchases</button>
            <button role="tab" aria-selected="false" data-kind="receipts" data-i18n="flow.receipts">Receipts</button>
          </div>
          <div class="row" style="margin-top:13px">
            <div><label class="l" data-i18n="ui.from">From</label><input type="date" class="ctl" id="from"></div>
            <div><label class="l" data-i18n="ui.to">To</label><input type="date" class="ctl" id="to"></div>
          </div>
          <details class="cols adv" id="adv">
            <summary><span data-i18n="flow.advanced">Advanced</span> <span id="advhint">· defaults</span></summary>
            <div class="advbody">
              <div class="hint-line" style="margin-top:0" data-i18n="flow.advNote">Untouched, these export exactly what a fully configured run would.</div>
              <div class="row" style="margin-top:11px">
                <div><label class="l" data-i18n="ui.filterBy">Filter by</label><select id="field"></select></div>
                <div><label class="l" data-i18n="ui.pdfHint">→ pdfs/ · slower</label><label class="togg" style="margin-top:4px"><input type="checkbox" id="pdf"> <span data-i18n="ui.pdfToggle">Official ETA PDF per document</span></label></div>
              </div>
              <div style="margin-top:12px"><label class="l" data-i18n="ui.status">Status</label><div class="chips" id="statuses">${ALL_STATUSES.map((s) => `<label class="sc"><input type="checkbox" id="st_${s}" checked>${s}</label>`).join('')}</div></div>
              <div style="margin-top:12px"><label class="l"><span data-i18n="ui.columns">Columns</span> <span id="colhint">· all</span></label><div class="chips" id="cols"></div></div>
            </div>
          </details>
          <!-- SPEC-022 · paste a list instead of picking dates: document UUIDs run an exact-list
               export (invoices only); registration numbers filter the range above. -->
          <details class="cols adv" id="lstbox">
            <summary><span data-i18n="flow.byList">By list (UUIDs / registration numbers)</span> <span id="lsthint"></span></summary>
            <div class="advbody">
              <div class="hint-line" style="margin-top:0" data-i18n="flow.listNote">Paste invoice UUIDs (exports exactly those invoices — the dates and tabs above are ignored) or counterparty registration numbers (exports only their documents from the range above). The list never leaves this device.</div>
              <textarea class="ctl" id="lst" rows="4" style="width:100%;margin-top:8px;resize:vertical;font-family:var(--font-mono, monospace);font-size:12px" spellcheck="false"></textarea>
              <label class="togg" id="lsteraRow" style="margin-top:8px" hidden><input type="checkbox" id="lstera" checked> <span data-i18n="flow.listEra">All years (2020 → today)</span></label>
              <!-- SPEC-028: fills the box above from eta_failures.jsonl — a paste typed by the
                   extension, so every list validation and the server's batching apply unchanged. -->
              <button class="btn sm" id="lstFails" style="margin-top:8px" data-i18n="flow.loadFails">⟳ Load failed UUIDs</button>
            </div>
          </details>
          <div class="folder"><span>${FOLDER_ICO}</span><span class="p" id="folder">No output folder</span><button class="btn sm" id="pick" data-i18n="ui.pick">Pick</button></div>
          <div class="runbar" style="margin-top:12px"><button class="btn sm" id="back" data-i18n="flow.back">‹ Back</button><button class="btn primary" id="start" data-i18n="flow.start">▶ Start</button></div>
        </section>
        </div>
        <!-- Step 3 · running. -->
        <div id="step-run" hidden>
        <section class="card">
          <div class="sh"><span class="n">2</span><h3 data-i18n="ui.run">Run</h3><span class="hint" id="runwhat"></span><button class="btn sm" id="logcopy" data-i18n="ui.logCopy" data-i18n-title="ui.logCopyTitle" title="Copy the full run log" style="margin-inline-start:auto;padding:4px 8px;font-size:11px">⧉ Log</button><button class="btn sm" id="logclear" data-i18n-title="ui.logClearTitle" title="Clear the run log" style="padding:4px 8px;font-size:11px">✕</button></div>
          <div class="stats"><div class="stat"><div class="k" data-i18n="ui.stChunks">Chunks</div><div class="v num" id="s-chunks">—</div></div><div class="stat"><div class="k" data-i18n="ui.stRows">Rows</div><div class="v num" id="s-rows">—</div></div><div class="stat"><div class="k" data-i18n="ui.stBiggest">Biggest</div><div class="v num" id="s-big">—</div></div><div class="stat"><div class="k" data-i18n="ui.stEta">Est. time</div><div class="v num" id="s-eta">—</div></div></div>
          <div class="tracker"><div class="tk ok"><div class="v num" id="t-done">0</div><div class="k" data-i18n="ui.tDone">Done</div></div><div class="tk err"><div class="v num" id="t-fail">0</div><div class="k" data-i18n="ui.tFail">Failed</div></div><div class="tk left"><div class="v num" id="t-left">0</div><div class="k" data-i18n="ui.tLeft">Left</div></div></div>
          <div class="proc"><span class="pv"><span id="procN" class="num">0</span> / <span id="procT" class="num">&mdash;</span></span><span class="pl" id="procLabel">invoices fetched</span></div>
          <div class="track"><i id="bar"></i></div>
          <div class="ckline"><span id="ckLabel">current chunk —</span><span class="cknow" id="ckCur"></span></div>
          <div class="ckbar"><i id="chunkbar"></i></div>
          <!-- One square per chunk. The bar above it is progress INSIDE the current chunk; this is
               which chunks are finished — painted from the plan, so a resumed run is right before
               the first fetch. -->
          <div class="ckgrid" id="ckgrid" role="img" data-i18n-label="ui.ckMap" aria-label="Chunk map"></div>
          <div class="cklegend" id="cklegend" hidden><span><i class="ckq done"></i><span data-i18n="ui.tDone">Done</span></span><span><i class="ckq run"></i><span data-i18n="ui.ckRun">Running</span></span><span><i class="ckq failed"></i><span data-i18n="ui.tFail">Failed</span></span><span><i class="ckq"></i><span data-i18n="ui.ckWait">Not started</span></span></div>
          <div class="log" id="log">Idle.</div>
          <div class="runbar" style="margin-top:11px"><button class="btn sm" id="pause" disabled data-i18n="ui.pause">Pause</button><button class="btn sm" id="resume" data-i18n="ui.resume">Resume</button><button class="btn sm" id="done" data-i18n="flow.doneBtn">✓ Done</button></div>
        </section>
        </div>
        <!-- Repair is not in the flow. repair.js fixes illegal XML characters in files written by
             OTHER tools; the only evidence such a file exists is merge saying it could not read one,
             so the offer is attached to that message and lives nowhere else. -->
        <div class="offer" id="repairOffer" hidden><span id="repairMsg"></span><button class="btn sm" id="repair" data-i18n="ui.repair">⛭ Repair files</button></div>
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
              <div><label class="l" data-i18n="rej.window">Window (days)</label><input type="number" class="rjnum" id="rj-window" min="1" max="365" value="14"><span id="rj-winsrc" style="display:block;font:600 9px var(--font-mono);color:var(--dim);margin-top:3px"></span></div>
            </div>
            <textarea class="rjreason" id="rj-tins" rows="2" data-i18n-ph="rej.tinsPh" placeholder="Tax registration numbers — one per line" style="margin-top:9px;direction:ltr;font-family:var(--font-mono)"></textarea>
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
  let tab = 'export';                // visible section: export | rejection (rejection is feature-gated)
  // SPEC-018 flow state. `kind` is what the user picked (sales|purchases|receipts) and `source` is
  // derived from it — the two are never set independently. `step` is which of the three screens is up.
  let kind = 'sales', step = 'home';
  let resumeJob = null;              // the one entry /job/resumable offered, or null
  let finishing = false;             // inside the post-run merge → checkpoint sequence
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
      const rs = restoreLog(raw);   // the parse lives in flow.js so the clear-it-again path is provable
      if (rs.keep) { rlog.restore(rs.entries); logRun = rs.run; }
      else localStorage.removeItem(RLOG_KEY);
    }
  } catch {}
  if (rlog.entries().length) rlog.push(t('ft.restored'), { level: 'info' });
  let saveT = 0;
  const saveLog = () => { saveT = 0; try { localStorage.setItem(RLOG_KEY, JSON.stringify(persistLog(logRun, rlog.toJSON()))); } catch {} };
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
        // DELIBERATELY NOT setBusy(false). A terminal line ends the run's NARRATIVE, not the run: the
        // orchestrator emits "⏸ Paused at i/n" and only THEN writes the progress file and sends its
        // best-effort checkpoint, staying `running` throughout — and start() answers a call made in
        // that window with a bare `return`, no status and no log line. Freeing the controls here is
        // what made Pause → re-run do nothing at all. The release point is the start() PROMISE; see
        // runGuarded() in flow.js, which every run entry point now goes through.
        if (meta.terminal) { lastChunk = null; renderChunkMap(); }   // nothing is running now, so no square may claim to be
        // SPEC-018: the fetch loop finishing is not the run finishing — the job is not done until the
        // output exists. Merge follows automatically; only then does the 'done' checkpoint go out.
        if (runFinished(meta)) autoFinish(meta);
        return;
      }
      const terminal = (m[0] === '\u2705' || m[0] === '\u23F8' || m[0] === '\u25A0' || /expired|Halted/.test(m));
      const cls = m.startsWith('✅') ? 'ok' : /expired|Halted|failed/.test(m) ? 'err' : m.startsWith('⏸') ? 'wait' : m.startsWith('▶') || m.startsWith('Prob') ? 'run' : '';
      setFt(cls, m.replace(/^[\u25B6\u2705\u25A0\u23F8]\s*/, ''));
      if (terminal) { logRun = 'done'; saveLogSoon(true); setBusy(false); }   // bare-string terminals = merge/repair — finished tools aren't resumable
    },
    onProgress: (done, failed, left) => {
      $('t-done').textContent = fmt(done); $('t-fail').textContent = fmt(failed); $('t-left').textContent = fmt(left);
      // plan.doneIds/failedIds were updated by the orchestrator (same object) just before this fires,
      // and this is also the ONLY hook a resume-skipped chunk emits — so the map repaints from it.
      renderChunkMap();
      updateEta();
    },
    onCount: (fetched, total) => {   // rows counter + bar only — the timer runs on work units, not rows
      $('procN').textContent = fmt(fetched); if (total) $('procT').textContent = fmt(total);
      $('bar').style.width = total ? Math.min(100, fetched / total * 100) + '%' : '0';
    },
    onPlan: renderPlan,
    onToken: (tk) => { const c = $('tok'); c.className = 'chip ' + (tk.ok ? 'ok' : 'err'); c.querySelector('.num').textContent = tk.label.replace(/^(Token|الجلسة):\s*/, ''); },
    onChunk: (ck) => {
      lastChunk = ck.phase === 'idle' ? null : ck;
      updateEta();
      renderChunkMap();   // ck.i is 1-based: this is what lights the amber square
      const { i, n, phase, cur, max } = ck;
      // 'pdf' had no entry here and no ui.* key, so a PDF-enabled run blanked its own chunk line and
      // zeroed its own bar for the LONGEST phase of every chunk.
      const label = { search: t('ui.phSearch'), details: t('ui.phDetails'), pdf: t('ui.phPdf'), write: t('ui.phWrite') }[phase];
      if (!max || !label) { $('ckLabel').textContent = t('ui.chunkNone'); $('ckCur').textContent = ''; $('chunkbar').style.width = '0'; return; }
      $('ckLabel').textContent = t('ui.chunkLine', { i: fmt(i), n: fmt(n), label });
      $('ckCur').textContent = `${fmt(cur)} / ${fmt(max)}`;
      $('chunkbar').style.width = Math.min(100, cur / max * 100) + '%';
    },
    // checked before every chunk: server-authoritative verdict for the live RIN (lock/kill/allowed-RIN)
    guard: async () => { if (!gateEnabled()) return true; const s = await session(); return s.registered && s.allowed; },
  });

  function setBusy(b) {
    // The run handler's own `finally { setBusy(false) }` fires while the automatic merge is still
    // going — the merge is kicked off from a status hook, not awaited by it. Releasing the controls
    // there would let a second run start on top of the merge. autoFinish releases them itself.
    if (!b && finishing) return;
    busy = b;
    // The post-run merge is part of the same run: it must not re-open the log lifecycle the
    // orchestrator's terminal line just closed, or a completed export would look resumable.
    if (b) { eta.reset(); lastChunk = null; if (!finishing) { logRun = 'active'; saveLogSoon(true); } }   // fresh rate baseline; mark mid-flight so a crash restores the log
    else if (logRun === 'active') { logRun = 'none'; saveLogSoon(true); }             // activity ended without a terminal status (plan built, resume loaded) → nothing to resume
    $('download').disabled = b || !licensed; $('sync').disabled = b || !licensed; $('start').disabled = b || !licensed;
    $('resumeEntry').disabled = b; $('resumeDiscard').disabled = b; $('back').disabled = b;
    $('pause').disabled = !b; $('resume').disabled = b; $('pick').disabled = b; $('pickHome').disabled = b; $('merge').disabled = b; $('repair').disabled = b;
    $('rj-scan').disabled = b || !licensed; rjFoot();
    $('po-pick').disabled = b; $('po-template').disabled = b; poFoot(); }

  // The chunk map. Painted from the PLAN, never from the event stream: orchestrator.start() skips an
  // already-done chunk with `continue` and emits no onChunk for it, so a map built from events alone
  // would show a resumed run's finished chunks as "not started" — the exact bug this replaces.
  function renderChunkMap() {
    const el = $('ckgrid'); if (!el) return;
    const p = currentPlan;
    const map = chunkMap(p, lastChunk ? lastChunk.i : null);
    $('cklegend').hidden = !map.total;
    if (!map.total) { el.textContent = ''; return; }
    el.textContent = '';
    for (const c of map.cells) {
      const i2 = document.createElement('i');
      i2.className = 'ckq' + (c.state === 'pending' ? '' : ' ' + c.state);
      i2.title = (c.n > 1 ? t('ui.ckRange', { from: c.from, to: c.to }) : t('ui.ckOne', { n: c.from }))
        + ' · ' + t({ done: 'ui.tDone', part: 'ui.tDone', run: 'ui.ckRun', failed: 'ui.tFail' }[c.state] || 'ui.ckWait');
      el.append(i2);
    }
  }

  // Plan → the run screen's numbers. Named (rather than inline in the hook) because a resume built
  // from /job/plan renders the same panel without going through onPlan.
  function renderPlan(p) {
    currentPlan = p;
    $('s-chunks').textContent = fmt(p.chunks.length); $('s-rows').textContent = fmt(p.totalRows);
    $('s-big').textContent = fmt(p.biggest); $('s-eta').textContent = fmtMin(estMinutes(p));
    const done = (p.doneIds || []).length; $('t-done').textContent = fmt(done); $('t-left').textContent = fmt(p.chunks.length - done);
    $('t-fail').textContent = fmt((p.failedIds || []).length);
    renderChunkMap();   // a resumed run paints its finished squares BEFORE the first fetch
    const doneRows = p.chunks.filter((c) => (p.doneIds || []).includes(c.id)).reduce((s, c) => s + Math.min(c.count, p.cap), 0);
    $('procN').textContent = fmt(doneRows); $('procT').textContent = fmt(p.totalRows);
    $('bar').style.width = p.totalRows ? (doneRows / p.totalRows * 100) + '%' : '0';
    $('start').disabled = busy || !licensed;
  }

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
    // Ungated (no bridge wired) is the standalone build: nothing to ask, so every feature is on.
    if (!gateEnabled()) { licensed = true; $('gate').hidden = true; showMain(true); renderAnnouncement(null); renderMessage(null); applyFeatures(null); if (!busy) { $('download').disabled = false; $('sync').disabled = false; $('start').disabled = false; $('rj-scan').disabled = false; poFoot(); } return; }   // ungated branch must mirror the gated one for the rejection controls too
    const s = await session();
    lastSession = s;
    renderAnnouncement(s.announcement);
    renderMessage(s.message);
    licensed = s.registered && s.allowed;
    $('gate').hidden = licensed;
    $('reqrin').hidden = !licensed;   // inside #main, so effectively: gated + registered + allowed
    showMain(licensed);   // full-screen registration page takes over the drawer while locked
    applyFeatures(s.features);   // SPEC-018: the drawer's first consumer of the verdict's feature list
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
    if (!busy) { $('download').disabled = !licensed; $('start').disabled = !licensed; $('rj-scan').disabled = !licensed; poFoot(); }
    refreshResume();   // an interrupted export is only offered to an account that could actually continue it
  }

  // ── SPEC-018 · features ──────────────────────────────────────────────────────────────────────
  // The rejection tab is gated on features.includes('auto-reject'). Absent → hidden, with one line
  // saying why, and a single remaining tab is no longer a tab bar.
  function applyFeatures(features) {
    const on = !gateEnabled() || rejectionAllowed(features);
    const btn = q('#tabs [data-tab=rejection]');
    if (btn) btn.hidden = !on;
    $('tabs').hidden = !on;
    $('rejlock').hidden = on || !licensed;   // while the gate screen is up there is nothing to explain yet
    if (!on && tab === 'rejection') selectTab('export');
  }

  // ── SPEC-018 · resume ────────────────────────────────────────────────────────────────────────
  // Fed by /job/resumable. The user should not have to remember that an export was interrupted, and
  // should never start a second run over the same range because the first one was invisible.
  function renderResume() {
    $('resumeRow').hidden = !resumeJob;
    if (!resumeJob) return;
    const span = resumeJob.from ? ` · ${resumeJob.from} → ${resumeJob.to}` : '';
    $('rz-what').textContent = t('flow.resume') + ' · ' + t('flow.' + resumeJob.kind) + span;
    $('rz-sub').textContent = t('flow.resumeSub', { done: fmt(resumeJob.done), n: fmt(resumeJob.total) });
  }
  async function refreshResume() {
    if (!gateEnabled() || !licensed) { resumeJob = null; renderResume(); return; }
    let res = null;
    try { res = await jobResumable(); } catch {}   // never blocks the drawer: no answer = no entry
    resumeJob = resumeEntry(res);
    renderResume();
  }

  // Re-render the source-dependent controls (Advanced's date field + column chips, the cap line, the
  // fetched-N label) and re-apply the Advanced values. `adv` defaults to what the form currently
  // holds, which is what makes a language toggle non-destructive.
  function applySourceUI(adv) {
    const src = orch.SOURCES[source];
    const a = normalizeAdvanced(kind, adv || readAdvanced());
    $('field').innerHTML = src.dateFields.map(([v]) => `<option value="${v}">${t('src.' + v)}</option>`).join('');
    $('field').value = a.field;
    const cols = $('cols');
    if (cols) cols.innerHTML = removableColumns(source).map((c) => `<label class="sc" title="${c.key}"><input type="checkbox" data-col="${c.key}"${a.excludeColumns.includes(c.key) ? '' : ' checked'}>${c.header}</label>`).join('');
    ALL_STATUSES.forEach((s) => { const b = $('st_' + s); if (b) b.checked = a.statuses.includes(s); });
    $('pdf').checked = a.downloadPdf;
    renderCap();   // cap line is tab-aware (Rejection shows its own scan cap), owned by renderCap
    const pl = $('procLabel'); if (pl) pl.textContent = t(source === 'receipts' ? 'ui.fetchedRec' : 'ui.fetchedInv');
    updateColHint();
  }
  const updateColHint = () => {
    const boxes = [...root.querySelectorAll('#cols input[data-col]')]; const off = boxes.filter((b) => !b.checked).length;
    const h = $('colhint'); if (h) h.textContent = off ? t('ui.colsKept', { kept: boxes.length - off, total: boxes.length }) : t('ui.colsAll');
    const n = advancedChanges(kind, readAdvanced());
    const ah = $('advhint'); if (ah) ah.textContent = n ? t('flow.advChanged', { n }) : t('flow.advDefaults');
  };
  // What Advanced currently says. Falls back to the kind's default for anything not rendered yet —
  // a missing control must never read as "excluded".
  const readAdvanced = () => normalizeAdvanced(kind, {
    field: $('field').value || defaultAdvanced(kind).field,
    statuses: ALL_STATUSES.filter((s) => { const b = $('st_' + s); return !b || b.checked; }),
    excludeColumns: [...root.querySelectorAll('#cols input[data-col]')].filter((b) => !b.checked).map((b) => b.dataset.col),
    downloadPdf: $('pdf').checked,
  });
  // Switching what you export switches which columns and date fields exist, so Advanced is
  // remembered per kind rather than globally.
  function setKind(next) {
    if (!['sales', 'purchases', 'receipts'].includes(next)) return;
    if (next !== kind) saveAdvanced(kind, readAdvanced());
    kind = next; source = sourceOfKind(kind);
    root.querySelectorAll('#kinds [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.kind === kind)));
    applySourceUI(loadAdvanced(kind));
    $('runwhat').textContent = t('flow.' + kind);
  }
  $('adv').addEventListener('change', () => { saveAdvanced(kind, readAdvanced()); updateColHint(); });
  root.querySelectorAll('#kinds [role=tab]').forEach((b) => b.onclick = () => { if (!busy) setKind(b.dataset.kind); });

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

  // Section machine. `tab` is export | rejection; the export section has its own three steps.
  function renderCap() {
    $('cap').innerHTML = tab === 'rejection' ? t('ui.capRejection') : t(source === 'receipts' ? 'ui.capReceipts' : 'ui.capDocs');
  }
  function selectTab(next) {
    tab = next;
    root.querySelectorAll('#tabs [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === next)));
    const rej = next === 'rejection';
    $('view-export').hidden = rej; $('view-rejection').hidden = !rej;
    renderCap();
  }
  root.querySelectorAll('#tabs [role=tab]').forEach((b) => b.onclick = () => {
    if (busy || tab === b.dataset.tab) return;   // don't switch tabs mid-run or onto the same tab
    selectTab(b.dataset.tab);
    setFt('', b.dataset.tab === 'rejection' ? t('ft.rejTab') : t('flow.downloadHint'));
  });
  // Download → folder → what to export → running. Steps are screens, not cards: only one is up.
  function setStep(next) {
    step = next;
    $('step-home').hidden = next !== 'home';
    $('step-what').hidden = next !== 'what';
    $('step-run').hidden = next !== 'run';
    if (next !== 'run') $('repairOffer').hidden = true;   // the offer belongs to the message that raised it
  }
  const offerRepair = (on) => { $('repairOffer').hidden = !on; if (on) $('repairMsg').textContent = t('flow.repairOffer'); };

  // actions
  const setFolderName = (n) => { $('folder').textContent = n; $('folderHome').textContent = n; };
  const pickFolderNow = async () => { try { setFolderName(await orch.pickFolder()); } catch {} };   // cancel is not an error
  $('pick').onclick = pickFolderNow;
  $('pickHome').onclick = pickFolderNow;

  // Every path that writes goes through here, and it exists because of one Chrome rule: a directory
  // handle rehydrated from IndexedDB after a reload comes back in 'prompt' state. orch.ensureDir()
  // goes straight to the owner-stamp check — dir.entries() — which throws NotAllowedError on such a
  // handle; the throw is swallowed into "Pick an output folder first.", and every entry point of the
  // flow then bails. That is the reload that "makes the tool stop working".
  //
  // So the permission is re-requested BEFORE anything reads the directory, and inside the click
  // gesture (requestPermission and showDirectoryPicker both need transient activation, which a
  // /session round-trip can outlive — hence licence checks now come after this, not before).
  async function ensureFolder(opts) {
    let act = folderAction({ hasHandle: !!orch.dir() });
    if (act === 'request') {
      let ok = false;
      try { ok = await ensurePermission(orch.dir()); } catch {}
      act = folderAction({ hasHandle: true, permitted: ok });
    }
    if (act === 'pick') { try { await orch.pickFolder(); } catch { return null; } }
    let d = null;
    try { d = await orch.ensureDir(opts); } catch {}
    if (d) setFolderName(d.name);
    return d;
  }
  // A run refused because the previous one has not finished winding down must say so. The silent
  // `return` this replaces is the visible half of the pause → re-run bug.
  const refuseRun = () => { setFt('wait', t('flow.runBusy')); logLine(t('flow.runBusy'), { level: 'wait' }); };
  // Step 1 → 2: the folder picker IS the second step. A folder remembered from last time is reused
  // (and is still changeable on the next screen) rather than re-prompted for.
  $('download').onclick = async () => {
    if (busy) { refuseRun(); return; }
    // Known-unlicensed is checked against the cached verdict first (so nothing is prompted for), then
    // the folder inside the gesture, and only then the fresh verdict — see ensureFolder.
    if (!licensed) { $('gate').hidden = false; $('rg-name').focus(); await refreshLicense(); if (!licensed) return; }
    const d = await ensureFolder();
    if (!d) { setFt('', t('orch.pickFolder')); return; }
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; $('rg-name').focus(); return; }
    const r = defaultRange(todayYmd());   // 1 Jan of the current year → today
    $('from').value = r.from; $('to').value = r.to;
    setKind(kind);                        // re-applies this kind's remembered Advanced
    setStep('what');
  };
  $('back').onclick = () => { if (!busy) setStep('home'); };
  $('done').onclick = () => { if (!busy) { setStep('home'); refreshResume(); } };
  // Step 2 → 3. Plan and start are one action now: "Build chunk plan" was a step the user had no
  // way to act on, and the plan is authorised by the server either way.
  $('start').onclick = async () => {
    const adv = readAdvanced();
    saveAdvanced(kind, adv);
    // SPEC-022: a pasted list changes what Start means. Refusals happen HERE, before any screen
    // change, so a bad paste never leaves the user staring at an empty run.
    const parsed = parseList($('lst') ? $('lst').value : '');
    if (parsed.error === 'mixed') { setFt('err', t('flow.listMixed')); return; }
    if (parsed.error === 'too_many') { setFt('err', t('flow.listTooMany')); return; }
    if (parsed.kind === 'rin' && source === 'receipts') { setFt('err', t('flow.listRinReceipts')); return; }
    const sel = buildSel(kind, { from: $('from').value, to: $('to').value }, adv);
    if (parsed.kind === 'rin') { sel.rinFilter = parsed.items; if ($('lstera').checked) sel.era = true; }
    // runGuarded owns `busy` for exactly as long as orch.start() runs — never releasing on a status
    // line — so the next Start can only land once the orchestrator has actually stopped.
    const r = await runGuarded({
      isBusy: () => busy, setBusy, onRefused: refuseRun,
      run: async () => {
        await refreshLicense(); if (!licensed) { $('gate').hidden = false; $('rg-name').focus(); return; }
        currentPlan = null; lastChunk = null;
        setStep('run'); renderChunkMap();
        const p = parsed.kind === 'uuid'
          ? await orch.planUuids({ uuids: parsed.items, downloadPdf: adv.downloadPdf, excludeColumns: [...adv.excludeColumns] })
          : await orch.plan(sel);
        if (p) await orch.start(p);
      },
    });
    if (r.error) { logLine(t('ft.planFailed', { msg: r.error?.message || r.error }), { level: 'err' }); setFt('err', t('ft.planFailedShort')); }
  };
  // Live classification under the By-list summary: what the paste is, how many, how many typos.
  $('lst').addEventListener('input', () => {
    const p = parseList($('lst').value);
    const bad = p.invalid.length ? t('flow.listBad', { m: p.invalid.length }) : '';
    $('lsteraRow').hidden = p.kind !== 'rin';
    $('lsthint').textContent =
      p.error === 'mixed' ? t('flow.listMixed')
      : p.error === 'too_many' ? t('flow.listTooMany')
      : p.kind === 'uuid' ? t('flow.listUuids', { n: p.items.length }) + bad
      : p.kind === 'rin' ? t('flow.listRins', { n: p.items.length }) + bad
      : bad;
  });
  // SPEC-028: one click from eta_failures.jsonl to a retry list. A LOADER, not an auto-runner —
  // the user reviews the filled box (and their Advanced choices) and presses the normal Start.
  $('lstFails').onclick = async () => {
    if (busy) { refuseRun(); return; }
    const d = await ensureFolder();
    if (!d) { setFt('', t('orch.pickFolder')); return; }
    let txt = '';
    try { txt = await readText(d, 'eta_failures.jsonl'); } catch {}   // absent file = nothing recorded
    const p = parseFailureUuids(txt);
    if (!p.uuids.length) { setFt('warn', t('flow.failsNone')); return; }
    $('lstbox').open = true;
    $('lst').value = p.uuids.join('\n');
    $('lst').dispatchEvent(new Event('input'));
    setFt('ok', t('flow.failsLoaded', { n: p.uuids.length }));
  };
  // The interrupted-run entry. The server holds the PLAN (its chunks are only purged at 'done'); the
  // folder holds the PROGRESS — and the column/PDF choices the server never stored — so the folder's
  // own plan wins whenever it describes the same run.
  $('resumeEntry').onclick = async () => {
    if (busy) { refuseRun(); return; }
    if (!resumeJob) return;
    const d = await ensureFolder();   // permission first, inside the gesture — see ensureFolder
    if (!d) { setFt('', t('orch.pickResume')); return; }
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; return; }
    const r = await runGuarded({
      isBusy: () => busy, setBusy, onRefused: refuseRun,
      run: async () => {
        lastChunk = null; setStep('run');
        let p = planFromJob(await jobPlan(resumeJob.id));
        if (!p) { logLine(t('flow.resumeGone'), { level: 'err' }); setFt('err', t('flow.resumeGone')); return; }
        let local = null; try { local = await orch.resume(); } catch {}
        if (local && local.key === p.key) p = { ...local, jobId: p.jobId };
        setKind(kindOf(p.source, p.dir));
        renderPlan(p);   // paints the chunk map's finished squares before a single fetch goes out
        await orch.start(p);
      },
    });
    if (r.error) { logLine(t('ft.resumeFailed', { msg: r.error?.message || r.error }), { level: 'err' }); setFt('err', t('ft.resumeFailed', { msg: r.error?.message || r.error })); }
  };
  // SPEC-034 — resume from the folder alone. Same run path as #resumeEntry, minus the server: the
  // progress file already holds the server-minted plan, the column/PDF choices and the done list,
  // and orch.resume() re-derives the done list from the chunk files actually on disk. Checkpoints
  // stay best-effort (mark() swallows a 404), so a job the server no longer associates with this
  // device does not stop the export from finishing.
  $('resumeFolder').onclick = async () => {
    if (busy) { refuseRun(); return; }
    const d = await ensureFolder();
    if (!d) { setFt('', t('orch.pickResume')); return; }
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; $('rg-name').focus(); return; }
    let p = null;
    try { p = await orch.resume(); } catch (e) { setFt('err', t('ft.resumeFailed', { msg: e?.message || e })); return; }
    if (!p) return;   // orch.resume() has already said why (no folder / no progress / wrong owner)
    const done = (p.doneIds || []).length, n = (p.chunks || []).length;
    if (!(await confirmModal(t('flow.resumeFolderTitle'), t('flow.resumeFolderBody', {
      kind: t('flow.' + kindOf(p.source, p.dir)), from: p.from || '', to: p.to || '', done: fmt(done), n: fmt(n), left: fmt(Math.max(0, n - done)),
    })))) return;
    const r = await runGuarded({
      isBusy: () => busy, setBusy, onRefused: refuseRun,
      run: async () => {
        lastChunk = null; setStep('run');
        setKind(kindOf(p.source, p.dir));
        renderPlan(p);   // paints the finished squares before a single fetch goes out
        await orch.start(p);
      },
    });
    if (r.error) { logLine(t('ft.resumeFailed', { msg: r.error?.message || r.error }), { level: 'err' }); setFt('err', t('ft.resumeFailed', { msg: r.error?.message || r.error })); }
  };
  // The way OUT of an interrupted run. Without it the offer is permanent: listResumable keeps a job
  // for as long as it is paused/halted/incomplete, and nothing in the extension ever left that set —
  // only the admin dashboard could. Clearing the persisted run log with it is the other half: its
  // "⏸ Paused at i/n" tail is what makes a reloaded drawer keep saying pause.
  $('resumeDiscard').onclick = async () => {
    if (busy || !resumeJob) return;
    if (!(await confirmModal(t('flow.discardConfirm'), t('flow.discardBody')))) return;
    const body = abandonCheckpoint(resumeJob);
    try {
      if (body) await jobCheckpoint(body);
      resumeJob = null; renderResume();
      rlog.clear(); logRun = clearedLog().run; saveLogSoon(true); renderLog();
      setFt('ok', t('flow.discarded')); refreshResume();
    } catch (e) { setFt('err', t('flow.discardFailed', { msg: e?.message || e })); }
  };
  $('sync').onclick = async () => {
    if (busy) { refuseRun(); return; }
    const d = await ensureFolder();
    if (!d) { setFt('', t('sync.pickFolder')); return; }
    await refreshLicense(); if (!licensed) { $('gate').hidden = false; return; }
    const r0 = await runGuarded({ isBusy: () => busy, setBusy, onRefused: refuseRun, run: async () => {
      const sel = deriveSyncSel(await readProgress(d), todayYmd());
      if (!sel) { setFt('', t('sync.noPrev')); return; }
      // The derived selection is run VERBATIM — it carries the previous run's own filters, which is
      // the point of a sync. The form is only updated so the user can see what is running; a stored
      // direction no tab maps to ('all') keeps its value in sel and is merely labelled here.
      selectTab('export');
      setKind(kindOf(sel.source, sel.dir));
      $('from').value = sel.from; $('to').value = sel.to;
      $('field').value = sel.field; $('pdf').checked = !!sel.downloadPdf;
      ALL_STATUSES.forEach((s) => { const c = $('st_' + s); if (c) c.checked = (sel.statuses || ALL_STATUSES).includes(s); });
      root.querySelectorAll('#cols input[data-col]').forEach((b) => { b.checked = !(sel.excludeColumns || []).includes(b.dataset.col); });
      updateColHint();
      setStep('run');
      logLine(t('sync.header', { from: sel.from, to: sel.to }), { level: 'run' });
      const p = await orch.plan(sel);
      if (p) await orch.start(p);
    } });
    if (r0.error) { logLine(t('sync.failed', { msg: r0.error?.message || r0.error }), { level: 'err' }); setFt('err', t('sync.failedShort')); }
  };
  $('rg-submit').onclick = async () => {
    const btn = $('rg-submit'), msg = $('rg-msg');
    btn.disabled = true; msg.style.color = 'var(--gate-sub)'; msg.textContent = t('gate.submitting');
    try {
      const res = await register({ name: $('rg-name').value, email: $('rg-email').value, phone: $('rg-phone').value, company: $('rg-company').value, consent: $('rg-consent').checked });
      if (res.ok) { msg.textContent = ''; await refreshLicense(); setFt('ok', t('ft.registered')); }
      else {
        // A device-limit refusal is not a failure the user can retry their way out of — it names
        // two counts and needs an admin. registerRefusal() phrases it; anything else keeps the
        // server's own error, which is already written for the person reading it.
        const refusal = registerRefusal(res);
        msg.style.color = 'var(--err)';
        msg.textContent = (refusal && refusal.text) || res.error || t('gate.regFailed');
      }
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
  // In-run Resume: load the folder's plan and continue immediately. There is no separate Start on
  // the run screen — "resume" that then waits for a second click is not resuming.
  $('resume').onclick = async () => {
    if (busy) { refuseRun(); return; }
    // Re-request the folder permission before orch.resume() reads it: after a reload the handle is
    // back in 'prompt' state and readProgress/scanDoneFromFolder are exactly what would throw.
    if (!(await ensureFolder())) { setFt('', t('orch.pickResume')); return; }
    const r = await runGuarded({ isBusy: () => busy, setBusy, onRefused: refuseRun, run: async () => {
      lastChunk = null;
      const p = await orch.resume();
      if (p) { renderPlan(p); await orch.start(p); }   // renderPlan, not a bare assign: the map must show what already landed
    } });
    if (r.error) logLine(t('ft.resumeFailed', { msg: r.error?.message || r.error }), { level: 'err' });
  };
  // One merge path, whether it is the automatic end of a run or the standalone button: both must
  // notice unreadable files and both must be able to raise the repair offer.
  async function runMergeInto(dir, onMsg, scope) {
    await mergeFolder(window.ExcelJS, dir, { onStatus: (m) => { onMsg(m); logLine(m); setFt('run', m); }, scope });
  }
  $('merge').onclick = async () => {
    if (busy) return;
    setBusy(true);
    offerRepair(false);
    try {
      const d = await ensureFolder({ allowUnverified: true });
      if (d) {
        const res = await finishRun({ merge: (onMsg) => runMergeInto(d, onMsg) });   // no checkpoint: this folder is not necessarily this run
        if (res.error) throw res.error;
        offerRepair(res.repair);
      }
    } catch (e) { logLine(t('ft.mergeFailed', { msg: e?.message || e }), { level: 'err' }); setFt('err', t('ft.mergeFailedShort')); }
    setBusy(false);
  };
  // Merge is the last phase of a run: the job is not done until the output exists. Only a clean
  // fetch checkpoints 'done' — that is what purges the plan server-side, and a partial run still
  // needs its plan.
  async function autoFinish(meta) {
    const p = currentPlan;
    if (!p || finishing) return;
    finishing = true;
    setBusy(true);
    offerRepair(false);
    try {
      const d = await ensureFolder({ allowUnverified: true });
      if (!d) { setFt('warn', t('orch.pickFolder')); return; }
      logLine(t('flow.merging'), { level: 'run' }); setFt('run', t('flow.merging'));
      const res = await finishRun({
        // SPEC-022: a uuid run merges ONLY its own files, under its own state — the folder-wide
        // sweep neither sees them nor is touched by them.
        merge: (onMsg) => runMergeInto(d, onMsg, p.mode === 'uuids' ? uuidMergeScope(p) : undefined),
        checkpoint: (runClean(meta) && p.jobId)
          ? () => jobCheckpoint({ jobId: p.jobId, state: 'done', done: (p.doneIds || []).length, failed: (p.failedIds || []).length })
          : null,
      });
      if (res.error) { logLine(t('ft.mergeFailed', { msg: res.error?.message || res.error }), { level: 'err' }); setFt('err', t('ft.mergeFailedShort')); }
      else { logLine(t('flow.runComplete'), { level: 'ok' }); setFt('ok', t('flow.runComplete')); }
      offerRepair(res.repair);
    } catch (e) { logLine(t('ft.mergeFailed', { msg: e?.message || e }), { level: 'err' }); setFt('err', t('ft.mergeFailedShort')); }
    finally { finishing = false; setBusy(false); refreshResume(); }
  }
  $('repair').onclick = async () => {
    if (busy) return;
    setBusy(true);
    try { const d = await ensureFolder(); if (d) { await repairFolder(d, { onStatus: (m) => { logLine(m); setFt('run', m); } }); offerRepair(false); } }
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
    const d = await ensureFolder();   // permission is re-requested inside the click gesture
    if (!d) { setFt('', t('orch.pickFolder')); return; }
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
    const d = await ensureFolder();
    if (!d) { setFt('', t('orch.pickFolder')); return; }
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
  // Clearing the log must also clear its LIFECYCLE. It used to drop the entries and the storage key
  // while leaving logRun at 'resumable', so the very next status line re-persisted run:'resumable'
  // and the "⏸ Paused at i/n" tail came back on the next reload — for ever. This ✕ is the visible,
  // devtools-free way out of a force-closed run that keeps saying pause.
  $('logclear').onclick = () => {
    const c = clearedLog();
    rlog.clear(); logRun = c.run; renderLog();
    try { localStorage.removeItem(RLOG_KEY); } catch {}
    setFt('', t('ft.logCleared'));
  };

  // Language: annotated nodes re-render via the data-i18n walker; dynamic areas (footer, chunk line)
  // pick up the new language on their next event. dir flips the drawer to RTL; .num/.log stay LTR islands.
  function applyLang() {
    const L = getLang();
    $('drawer').setAttribute('dir', L === 'ar' ? 'rtl' : 'ltr');
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nLabel)); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });   // catalog-owned markup only (consent text)
    { const pl = $('privacy-link'); if (pl) pl.href = String(LEAD_URL).replace(/\/$/, '') + '/privacy'; }    // consent innerHTML recreates the link — re-point it
    if (!orch.folderName()) setFolderName(t('ui.noFolder'));
    $('langBtn').textContent = L === 'ar' ? 'EN' : 'ع';
    applySourceUI();   // date-field option labels, cap line (renderCap), proc label, column chips (selection-preserving)
    $('runwhat').textContent = t('flow.' + kind);
    renderResume();    // the entry's label is assembled, not annotated
    renderChunkMap();  // the per-cell titles are assembled too
    if (!$('repairOffer').hidden) $('repairMsg').textContent = t('flow.repairOffer');
    rjRender(); poRender();   // rejection views bake t() at render — re-render so a language toggle isn't half-translated (row state lives on the items)
    renderLog();
  }
  $('langBtn').onclick = () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); applyLang(); refreshLicense(); };
  // Theme: default dark (the original look); light mirrors the admin dashboard. Pure CSS via data-theme.
  const applyTheme = (th) => { host.setAttribute('data-theme', th); $('themeBtn').textContent = th === 'light' ? '☀' : '🌙'; };
  applyTheme(lsGet('theme') === 'light' ? 'light' : 'dark');
  $('themeBtn').onclick = () => { const th = host.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; lsSet('theme', th); applyTheme(th); };
  // SPEC-018 initial state: Sales, this calendar year, Advanced as last left it, step 1.
  setKind(kind);
  { const r0 = defaultRange(todayYmd()); $('from').value = r0.from; $('to').value = r0.to; }
  setStep('home');
  selectTab('export');
  applyFeatures((lsGet('reg_verdict') || {}).features);   // last known verdict, so the tab doesn't flicker; refreshLicense re-runs it
  applyLang();   // initial render in the persisted language (also runs applySourceUI + renderLog + privacy href)
  setFt('', t('flow.downloadHint'));
  refreshLicense();   // registration gate — engages only once LEAD_URL is wired in registration.js
  orch.onToken?.(orch.tokenStatus());
  // NOTE: no local named `t` in mountUI scope — it would shadow the imported i18n t() (TDZ at mount).
  const tokChip = (tk) => { const c = $('tok'); c.className = 'chip ' + (tk.ok ? 'ok' : 'err'); c.querySelector('.num').textContent = tk.label.replace(/^(Token|الجلسة):\s*/, ''); };
  tokChip(orch.tokenStatus());
  setInterval(() => tokChip(orch.tokenStatus()), 30000);
  // The handle comes back in 'prompt' state; ensureFolder() re-requests it inside the next click.
  idbGet('dh_last').then((h) => { if (h) { orch.setFolder(h); setFolderName(h.name); } }).catch(() => {});

  // survive SPA re-render: re-append host if the app wipes it
  const obs = new MutationObserver(() => { if (!document.getElementById('eta-bulk-host')) document.documentElement.appendChild(host); });
  obs.observe(document.documentElement, { childList: true });

  return orch;
}
