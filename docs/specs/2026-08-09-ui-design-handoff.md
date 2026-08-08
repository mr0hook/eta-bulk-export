# UI Design Handoff — omarsoliman.dev → ETA Bulk Export drawer

**Date:** 2026-08-09
**Status:** Design direction. No source files modified.
**Scope:** `src/ui/drawer.js` (primary), `lead-worker/src/assets/dash.html` (secondary, §7)

---

## 0. Provenance — what was actually read

| Source | How | Result |
|---|---|---|
| `https://omarsoliman.dev` | `curl -L` | **HTTP 200, no redirect.** 47,193 bytes. Next.js/Turbopack SSR output. |
| `https://omarsoliman.dev/_next/static/chunks/1b1f8po2tewol.css` | `curl` | **HTTP 200.** 37,246 bytes, the complete compiled stylesheet including the full `:root` token block. |
| `src/ui/drawer.js` | Read, all 954 lines | `CSS` template (L25–152) + all HTML template strings. |
| `lead-worker/src/assets/dash.html` | Grep | Token blocks at L5–6, theme bootstrap at L3. |
| `manifest.json`, `csp-shim.js` | Read | Constrains the font decision — see §6.1. |

Every hex, rem, px, and cubic-bezier in §2 is quoted verbatim from the compiled stylesheet. Anything I derived is tagged **INFERRED**. Contrast ratios in §5 were computed (WCAG 2.1 relative luminance), not estimated.

---

## 1. The design language

**Warm editorial-technical.** A paper-and-ink publication palette — cream grounds, ink browns, a terracotta ("clay") accent — driven by a three-font system that assigns each typeface a *job*: a grotesque for interface and headings, a serif for reading, a mono for metadata. Not brutalist (it has soft shadows and 16–24px radii), not corporate-neutral (nothing is grey — even the "greys" are warm browns, `#6b6453`, `#968d78`). Structure comes from hairline warm borders and generous vertical rhythm rather than from boxes and fills. Motion is fast and understated: 120–350ms on a single decelerating curve, with a proper `prefers-reduced-motion` escape hatch.

The signature move is the **uppercase mono micro-label** (`.os-meta`, `.os-tag`, `.os-badge`, `.os-callout__label`): 12px IBM Plex Mono, weight 500, uppercase, `letter-spacing: .09em`, muted ink. It appears on tags, badges, callout labels, and blockquote citations. It is the thing that makes the site look like itself.

**The good news:** the drawer already speaks a dialect of this. It runs a numbered-card "control console" layout with uppercase mono micro-labels (`label.l`, `.stat .k`, `.tk .k`, `.tag`) at 9–10px, hairline borders, a warm gold accent, and a `data-theme` toggle. This is a **re-tuning, not a re-skin**. The tone is already right; the palette is cool-grey where the site is warm, the type is system-default where the site is deliberate, and the scales are ad-hoc where the site is systematic.

---

## 2. Tokens

### 2.1 Colour — primitives (verbatim from the site)

Light is `:root`; dark is `[data-theme=dark]`. The site seeds the attribute from `localStorage` then falls back to `prefers-color-scheme`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper-0` | `#faf6ee` | `#1a1712` | Ground |
| `--paper-1` | `#fffdf7` | `#221e17` | Card / raised |
| `--paper-2` | `#f2ebdd` | `#2b261d` | Subtle fill |
| `--paper-3` | `#e7dec9` | `#353023` | Inset fill |
| `--line-1` | `#e3dac6` | `#3b3527` | Hairline |
| `--line-2` | `#c9bea3` | `#564e3a` | Strong border |
| `--ink-1` | `#231f18` | `#f0eadb` | Headings |
| `--ink-2` | `#3a342a` | `#d6cebc` | Body |
| `--ink-3` | `#6b6453` | `#a39a84` | Muted |
| `--ink-4` | `#968d78` | `#7a715c` | Faint |
| `--clay-5` / accent | `#c2603b` | `#e08358` | Primary accent |
| `--clay-6` / accent-strong | `#a04a2a` | `#ec9a74` | Hover / link |
| `--clay-7` | `#7c381f` | — | Link hover (light) |
| `--accent-soft` | `#f4e2d6` | `#3a2a20` | Accent wash |
| `--accent-contrast` | `#fffdf7` | `#1a1712` | Text on accent |
| `--secondary` (moss) | `#44685a` | `#8fae97` | Second accent |
| `--tertiary` (teal) | `#4a9ca6` | `#7dd6df` | Third accent |
| `--highlight` (gold) | `#f6e7bc` | `#4a3c16` | Selection / mark |
| `--highlight-text` | `#4f3d0e` | `#ebcd7e` | On highlight |
| `--status-success` | `#2e7b4f` | `#7cbe96` | + soft `#ddebdb` / `#24342a` |
| `--status-warning` | `#95680f` | `#d9b05e` | + soft `#f3e6c2` / `#3c321a` |
| `--status-danger` | `#b23f2e` | `#e08a7b` | + soft `#f4ddd4` / `#3d241f` |

Also present: `--clay-3 #efc3ac`, `--clay-4 #dd8b62`, `--moss-4 #7e9c84`, `--moss-6 #2f4f41`, `--gold-5 #c0922f`, `--teal-4 #7abdc4`, `--teal-6 #2e7a84`.

### 2.2 Colour — drawer bindings

The drawer's existing token names stay (minimal diff, and they carry meaning the site's don't). Only their values change. **Elevation direction inverts between themes** — see the `--bg2`/`--well` rows; the site's dark ramp goes *lighter* for elevation, while the drawer's current dark ramp goes *darker* for insets. Both are needed.

| Drawer token | Today (dark) | → Light | → Dark | Note |
|---|---|---|---|---|
| `--bg` | `#151a21` | `#fffdf7` | `#221e17` | Drawer body = card level, not page level |
| `--bg2` | `#0f141a` | `#f2ebdd` | `#2b261d` | Controls/inputs. **Recedes in light, rises in dark** |
| `--bg3` → rename `--well` | `#0a0d11` | `#e7dec9` | `#1a1712` | Log pane. Asymmetric: `paper-3` light, `paper-0` dark **INFERRED** |
| `--bg-hd` | `#1a212b` | `#fffdf7` | `#2b261d` | Header gradient top |
| `--bg-ft` | `#10151c` | `#f2ebdd` | `#1a1712` | Footer gradient |
| `--bg-hov` | `#1b222c` | `#f2ebdd` | `#353023` | Hover / selected seg |
| `--line` | `#28303c` | `#e3dac6` | `#3b3527` | `--line-1` |
| `--line2` | `#1f2630` | `#e3dac6` | `#3b3527` | Collapse to one hairline **INFERRED** |
| `--line3` | `#3a4452` | `#c9bea3` | `#564e3a` | `--line-2` |
| `--text` | `#e9e3d6` | `#231f18` | `#f0eadb` | `--ink-1` |
| `--muted` | `#99a3b1` | `#6b6453` | `#a39a84` | `--ink-3` |
| `--dim` | `#687181` | `#6b6453` | `#a39a84` | **Merge into `--muted` — see §5.1** |
| `--gold` → `--accent` | `#e3a552` | `#c2603b` | `#e08358` | Brand/interactive becomes clay |
| `--gold2` → `--accent-strong` | `#f0b765` | `#a04a2a` | `#ec9a74` | Hover |
| `--on-gold` → `--on-accent` | `#1a1206` | `#fffdf7` | `#1a1712` | See §5.2 before shipping light |
| `--gold-chip` → `--accent-soft` | `#3a2c14` | `#f4e2d6` | `#3a2a20` | Section-number chip |
| `--teal` → `--tertiary` | `#62b6b2` | `#2e7a84` | `#7dd6df` | **`teal-6` not `teal-5` in light — §5.1** |
| `--run` (new) | — | `#95680f` | `#d9b05e` | In-flight. **Gold stops being the brand — §2.3** |
| `--ok` | `#57c08a` | `#2e7b4f` | `#7cbe96` | `--status-success` |
| `--ok-bg` / `--ok-bd` | | `#ddebdb` / mix 30% | `#24342a` / mix 30% | |
| `--err` | `#e5786b` | `#b23f2e` | `#e08a7b` | `--status-danger` |
| `--err-bg` / `--err-bd` | | `#f4ddd4` / mix 30% | `#3d241f` / mix 30% | |
| `--warn-tx` / `--warn-bg` | | `#95680f` / `#f3e6c2` | `#d9b05e` / `#3c321a` | `--status-warning` |
| `--info-tx` / `--info-bg` | | `#2e7a84` / `#ddeef0` | `#7dd6df` / `#1e3539` | `--tertiary` family |
| `--scrim` | `rgba(6,8,11,.35)` | `rgba(35,31,24,.28)` | `rgba(10,8,6,.55)` | Warm the scrim **INFERRED** |

### 2.3 The one substantive colour decision: split brand from in-flight

Today `--gold` is doing five jobs: brand seal, primary button, section-number chip, progress-bar terminus, *and* the `run` footer dot. When a run is in flight, the "running" signal is the same hue as every idle button on screen.

**Adopt clay as the interactive/brand accent and give gold a single job: in-flight.** Progress bars, the `run` footer dot, the ETA chip, and the "N found" scan note become gold; buttons, the seal, section numbers, focus rings, and the active tab become clay. The status ladder then reads cleanly with no hue collisions:

`wait` teal → `run` gold → `ok` green → `warn` amber → `err` red, with clay reserved for *"you can act on this."*

This is the change that most repays the effort. It is also the change most likely to be argued about, because gold is currently the tool's whole visual identity and `dash.html` is built on it. §7 addresses that.

### 2.4 Type

```
--font-display : "Bricolage Grotesque"   /* UI, headings, buttons, inputs, labels */
--font-serif   : "Source Serif 4"        /* body prose */
--font-mono    : "IBM Plex Mono"         /* metadata, numbers, uppercase micro-labels */
```

Scale, verbatim:

| Token | Value | px |
|---|---|---|
| `--text-2xs` | `.75rem` | 12 |
| `--text-xs` | `.8125rem` | 13 |
| `--text-sm` | `.9375rem` | 15 |
| `--text-base` | `1.0625rem` | 17 |
| `--text-lg` | `1.25rem` | 20 |
| `--text-xl` | `1.5rem` | 24 |
| `--text-2xl` | `1.875rem` | 30 |
| `--text-3xl`…`5xl` | `2.375` / `3` / `3.75rem` | 38 / 48 / 60 |

Leading `--leading-tight:1.1` · `--leading-snug:1.3` · `--leading-body:1.65`.
Tracking `--tracking-tight:-.022em` · `--tracking-snug:-.01em` · `--tracking-wide:.09em`.
Weights 400 / 500 / 600 / 700 / 800.

**The scale bottoms out above where the drawer lives.** `--text-2xs` is 12px; the drawer's micro-labels are 9px and 10px, and its body copy is 11–13px. `--text-base` (17px) appears nowhere in a 404px panel. Two tokens must be added — **INFERRED**, they are not on the site:

```
--text-4xs: .625rem;   /* 10px — .stat .k, .tk .k, label.l, .proc .pl */
--text-3xs: .6875rem;  /* 11px — .log, .rjmeta, .chip, .rjb */
```

Drawer type bindings:

| Surface | Font | Size | Weight | Tracking |
|---|---|---|---|---|
| `.wm` wordmark | display | `--text-lg` 20 | 700 | `--tracking-tight` |
| `.sh h3` card title | display | `--text-xs` 13 | 600 | `--tracking-snug` |
| `.btn`, `.seg button` | display | `--text-xs` 13 | 600 | `--tracking-snug` |
| `select`, `.ctl`, `.rg`, `.rjreason` | display | `--text-xs` 13 | 500 | normal |
| `.g-sub`, `.bmodal-s`, `.ft .msg` | display | `--text-2xs` 12 | 500 | normal |
| `.tag`, `label.l`, `.stat .k`, `.tk .k`, `.proc .pl` | mono | `--text-4xs` 10 | 500 | `--tracking-wide` † |
| `.chip`, `.rjb`, `.rjmeta`, `.cap` | mono | `--text-3xs` 11 | 500–600 | `--tracking-wide` † |
| `.log` | mono | `--text-3xs` 11 / 1.55 | 500 | normal |
| `.stat .v`, `.proc .pv` | mono | 21 / 19 | 600 | `tabular-nums` |
| `.tk .v` | mono | `--text-xl` 24 ‡ | 600 | `tabular-nums` |

† Uppercase + `--tracking-wide` **must be disabled in Arabic** — see §6.2.
‡ Bumped from 16px. The live Done/Failed/Left counters are the thing users watch during a 40-minute run; they deserve to be the largest type in the drawer.

**Serif appears nowhere.** There is no prose surface in the drawer. `--font-serif` is dropped from this target entirely — that alone strips one of the site's three defining voices. See §4.1.

### 2.5 Spacing

Site: `--space-1..12` = `4 8 12 16 20 24 32 40 48 64 80 112`.

The drawer lives entirely in `--space-1..6` (4–24px). `--space-7..12` (32–112) never occur in a 404px column and are dropped. `--measure:66ch` and `--container:1080px` are irrelevant.

The drawer's current spacing is off-grid: **5, 7, 9, 11, 13, 14** px. Snapping:

| Current | → | Where |
|---|---|---|
| 5, 6 | `--space-1` 4 | label margins, chip gaps |
| 7, 8, 9 | `--space-2` 8 | control gaps, chip padding |
| 10, 11, 12, 13 | `--space-3` 12 | row gaps, body gap, card `.sh` margin |
| 14, 15, 16 | `--space-4` 16 | card padding, body padding, header padding |
| 20 | `--space-5` 20 | modal scrim padding |
| 24 | `--space-6` 24 | gate vertical rhythm |

**Cost to flag:** body padding 14→16 and card padding 14→16 removes 8px of horizontal content width from a fixed 404px panel, and the `.row` two-column grid is already tight (each column ≈176px today). Either accept slightly tighter columns, or widen the drawer to 420px. Recommend **420px** — it buys back the padding and the two-column date row stops feeling cramped. This is a product decision, not a CSS one.

### 2.6 Radius

Site: `--radius-sm:6px` · `--radius-md:10px` · `--radius-lg:16px` · `--radius-xl:24px` · `--radius-pill:999px`.

Drawer today: 3, 5, 6, 7, 9, 10, 11, 13, 14, 16, 50%, 999px.

| Drawer surface | Today | → |
|---|---|---|
| `.rjb` badges, `.rjreason`, `mark` | 6 | `--radius-sm` 6 |
| `select`, `.ctl`, `.folder`, `.log`, `.rjnum`, `.tk`, `.stat` | 7–10 | `--radius-md` 10 |
| `.btn`, `.pill`, `.seal`, `.rg`, `.rg-btn`, `.bmodal-ta` | 9–10 | `--radius-md` 10 |
| `.card`, `.bmodal` | 13 | `--radius-lg` 16 |
| `.chip`, `.sc`, `.seg`, `.track`, `.ckbar` | 999 | `--radius-pill` |
| `.ft .dot`, `.chip .dot` | 50% | keep 50% |

`--radius-xl` 24 has no use here. **Note:** the site puts `--radius-pill` on *buttons* (`.os-btn { border-radius: var(--radius-pill) }`). Do not follow that — see §4.3.

### 2.7 Elevation

```
--shadow-card  : 0 1px 2px #3a2c160d, 0 4px 14px #3a2c160f;   /* warm-tinted */
--shadow-pop   : 0 2px 4px #3a2c1612, 0 12px 32px #3a2c161f;
--shadow-inset : inset 0 1px 2px #3a2c1612;
/* [data-theme=dark] */
--shadow-card  : 0 1px 2px #00000040, 0 4px 14px #0000004d;
--shadow-pop   : 0 2px 4px #0000004d, 0 12px 32px #00000073;
--shadow-inset : inset 0 1px 2px #00000059;
```

Adopt `--shadow-card` on `.card`, `--shadow-pop` on `.bmodal` and `.pill`, `--shadow-inset` on `.log` and `.track`.

**Do not adopt either for the drawer's own edge.** `.drawer` currently uses `0 18px 50px -12px rgba(0,0,0,.65)`, and it needs that weight: the drawer floats over an arbitrary third-party page whose background is unknown and possibly white. `--shadow-pop` is a card shadow and will not separate the panel. Keep the existing `--shadow`, retinted warm:

```
--shadow: 0 18px 50px -12px rgba(26,23,18,.55);   /* light  INFERRED */
--shadow: 0 18px 50px -12px rgba(0,0,0,.7);       /* dark   INFERRED */
```

### 2.8 Focus

```
--focus-ring: 0 0 0 2px var(--bg-page), 0 0 0 4px var(--clay-5);
```

A two-stop offset ring — strictly better than the drawer's current `0 0 0 3px rgba(227,165,82,.15)`, which at 15% alpha is nearly invisible. **Adopt, with one correction:** the inner 2px halo is `var(--bg-page)`, which assumes the element sits on the page ground. Inside the drawer, controls sit on `--bg2`. Rebind per-surface:

```
--focus-ring: 0 0 0 2px var(--bg2), 0 0 0 4px var(--accent);
```

Apply on `:focus-visible`, not `:focus` — the site is right about this and the drawer currently uses bare `:focus`, which fires the ring on mouse clicks too.

### 2.9 Motion

```
--dur-1: .12s;  --dur-2: .2s;  --dur-3: .35s;
--ease-out: cubic-bezier(.22, 1, .36, 1);

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto }
  *, :before, :after { transition-duration: .01ms !important; animation-duration: .01ms !important }
}
```

Near-identical to what the drawer already does (`.28s cubic-bezier(.2,.8,.2,1)` slide, `.2s` scrim, `.3s` bar, `.25s` chunk bar). Rebind:

| Surface | Today | → |
|---|---|---|
| `.drawer` transform | `.28s cubic-bezier(.2,.8,.2,1)` | `--dur-3` + `--ease-out` |
| `.scrim` opacity | `.2s` | `--dur-2` + `--ease-out` |
| `.track > i`, `.ckbar > i` width | `.3s` / `.25s` | `--dur-3` + `--ease-out` |
| `.btn`, `.chip`, `.sc` hover | none | `--dur-2` on bg/border/colour |
| Focus ring | none | `--dur-1` on `box-shadow` |

Two site behaviours to **adopt**: `.os-btn:active { transform: translateY(1px) }` and `.os-toggle:active { transform: scale(.94) }` — cheap, and the drawer's buttons currently have no press feedback at all.

One to **reject**: `.os-card--link:hover { transform: translateY(-2px) }`. The drawer's `.card`s are static containers, not links, and lifting them inside a 404px column over a third-party page reads as jitter.

**The drawer has no `prefers-reduced-motion` block today.** Add the site's verbatim, scoped to the shadow root. This is an accessibility gap that exists now and the site hands you the fix.

---

## 3. Per-surface direction

### 3.1 Launcher pill (`.pill`)
Clay gradient replaces gold: `linear-gradient(var(--accent-strong), var(--accent))`, `--on-accent` text, `--radius-md` 10 (not pill — a pill-shaped pill is a lozenge and reads as a chat widget). `--shadow-pop`. Keep `z-index: 2147483647` and `position: fixed`. Add `:active { transform: translateY(1px) }`.

### 3.2 Header (`.hd`)
Gradient `--bg-hd` → `--bg` stays; both warm now. The `.seal` keeps its 32px rounded-square with the shield glyph, filled clay. `.wm` goes display/700/20px/`--tracking-tight`. `.tag` ("EXPORT CONSOLE") is the site's `.os-meta` exactly — mono/10px/500/uppercase/`--tracking-wide`/`--muted`. The token `.chip` becomes `.os-badge`-shaped: mono, `--text-3xs`, `--radius-pill`, with `ok`/`err` mapping to `--status-success-soft` / `--status-danger-soft`.

Icon buttons (`.x` — lang, theme, close) adopt `.os-iconbtn`: 32×32, `--radius-pill`, `--muted` → `--text` on hover with `--bg-hov` fill, `--focus-ring` on `:focus-visible`.

### 3.3 Source tabs (`.seg`) + cap line
The pill-shaped segmented control is already right. Selected tab: `--bg-hov` fill + `--seg-shadow`; change selected text to `--accent-strong` and selected fill to `--accent-soft` — this is the site's `.os-nav__link--active` treatment and it makes the active tab unambiguous, which matters because Rejection is a destructive-adjacent view. `.cap` stays mono `--text-3xs` `--muted` with `<b>` in `--accent`.

### 3.4 Announcement banners (`.ann`, `#umsg`)
Map directly onto `.os-callout`: `--radius-md`, 1px border at `color-mix(in oklab, <status> 30%, transparent)`, soft-tint background, and a mono uppercase label. Today they are bare tinted bars with no label; giving them an `.os-callout__label` ("NOTICE" / "WARNING" / "ACTION REQUIRED") is a real legibility win in a panel where a lot of text competes. The dismiss `×` stays `float: inline-end`.

### 3.5 Gate / registration (`.gate`)
This is the only surface that is *editorial* rather than *operational* — a full-bleed takeover with one job. It is where the site's language survives most intact and should be leaned into hardest:

- `.g-head` → display, `--text-xl` 24, weight 700, `--tracking-tight`, `--text` (not accent — a lock heading in accent colour reads as a link).
- `.g-sub` → `--text-2xs` 12 at `--leading-body` 1.65, `--muted`. This is the one place the site's generous leading belongs.
- `input.rg` → `.os-input`: `--radius-md`, `--bg2`, 1px `--line3`, 40px height, `:hover` border `--ink-4`, `:focus` border `--accent` + `0 0 0 3px var(--accent-soft)`.
- The read-only auto-detected TIN field keeps mono + `direction: ltr`.
- `.rg-btn` → primary button, full width, 48px (`--text-base` sizing), clay fill.
- `.g-consent` → `--text-3xs` 11 at 1.45, `--muted`, with the privacy link in `--link` and the site's `text-underline-offset: 3px` + 45%-alpha underline. Keep the checkbox `accent-color: var(--accent)`.
- `#gate-blocked` uses the same shell with `--status-danger` on `.g-head` for killed/locked/voided, `--status-warning` for paused/update-required.

### 3.6 Configure card (`.card` + `.sh`)
`.card`: `--bg`, 1px `--line`, `--radius-lg` 16, `--space-4` padding, `--shadow-card`.

`.sh` numbered chip (`.n`): keep the 20×20 rounded square, `--accent-soft` fill, `--accent` numeral, `--radius-sm`. The site has no equivalent — this is the drawer's own idiom and it is good; keep it.

`label.l` micro-labels: mono/10/500/uppercase/`--tracking-wide`/`--muted` (**not** `--dim` — §5.1). `select`/`.ctl` adopt `.os-input`. Date inputs keep `appearance: auto` and `color-scheme: var(--scheme)` — do not remove that, it is what makes the native picker chrome match the theme.

Status chips (`.sc`) and column chips: `.os-tag` shape — mono `--text-3xs`, `--radius-pill`, `--bg2` fill, `--line` border. Checked state should use the `.os-tag--clay` recipe: `color-mix(in oklab, var(--accent) 16%, var(--bg))` fill, `color-mix(in oklab, var(--accent) 42%, transparent)` border. Today checked/unchecked differ only by a native checkbox glyph; this makes the selected set scannable at a glance.

`details.cols` disclosure: summary is `.os-meta`. **Replace the `▸`/`▾` text markers with an inline SVG chevron that rotates via `transform`** — the text glyphs point the wrong way in RTL (§6.2) and cannot be flipped.

`.folder`: keep the dashed border (it correctly signals "empty until you pick"), `--radius-md`, folder icon in `--tertiary`.

### 3.7 Plan card + `.stats`
`.stats` 2×2 hairline grid stays — it is essentially the site's card grid at panel scale. `.stat .k` is `.os-meta`; `.stat .v` is mono/600/21px/`tabular-nums`. When the ETA value is a live estimate during a run, colour it `--run` (gold) so it visibly belongs to the in-flight family.

Build and Sync are `.os-btn--secondary` (transparent, `--line3` border) — they are setup actions, not the commitment. Only Start is primary.

### 3.8 Run card — the most important surface
This is what a user stares at for 40 minutes. Give it the strongest hierarchy in the drawer.

- **`.tracker`** (Done / Failed / Left): values to `--text-xl` 24, mono, 600, `tabular-nums`. Colour `--ok` / `--err` / `--tertiary`. Keys are `.os-meta`. These become the visual peak of the card.
- **`.proc`** counter: `.pv` mono/600/19; `#procN` in `--run` gold while busy, `--ok` on clean completion. `.pl` is `.os-meta`.
- **`.track > i`**: today `linear-gradient(90deg, var(--teal), var(--gold))`. Change to a solid `--run` gold fill with `--shadow-inset` on the track. A two-hue gradient on an 8px bar reads as decoration and, in RTL, a directional gradient has to be flipped — a solid fill sidesteps the whole problem (§6.2).
- **`.ckbar`** chunk sub-progress: 6px, solid `--tertiary`, so the two bars are distinguishable at a glance (outer = whole run, inner = current chunk).
- **`.log`**: `--well` background, `--shadow-inset`, `--radius-md`, mono `--text-3xs`/1.55, `--muted`. Keep `direction: ltr; text-align: left; unicode-bidi: plaintext` **exactly as-is** — it is correct and load-bearing (§6.2). Consider colouring the timestamp prefix `--ink-4`/`--dim` so the message text separates; that is the one place the faintest ink is legitimate, because timestamps are scannable structure rather than content.
- **`.btn.primary`** (Approve & Start): clay fill, `--on-accent`. Read §5.2 before shipping this in light mode.

### 3.9 Tools card
Merge / Repair / Report a bug / Request access are all `.os-btn--secondary`. None of them is primary; the card currently has four visually equal buttons and that is correct — do not promote any.

### 3.10 Footer status bar (`.ft`)
The five states map onto the status family: `''` → `--ink-4`, `run` → `--run` gold, `ok` → `--status-success`, `err` → `--status-danger`, `wait` → `--tertiary`. `.msg` is display/`--text-2xs` 12/500.

Add a subtle pulse on the `run` dot (`animation: pulse 1.6s var(--ease-out) infinite`) — with the `prefers-reduced-motion` block from §2.9 already suppressing it. The footer is the only persistent liveness signal when the drawer is scrolled away from the Run card.

### 3.11 Rejection tab
The highest-stakes surface in the product: it submits irreversible rejections against real invoices. It should feel *heavier* than the export views.

- `.rjrow`: hairline `--line` top border, `--space-2` vertical padding. `.off` rows stay at `opacity: .55`.
- Row checkbox keeps `accent-color: var(--err)` — deliberate and correct; these checkboxes arm a destructive action.
- `.rjhead` name display/600/12; `.internalID` mono `--ink-4`; `.amt` mono, `--accent`, `margin-inline-start: auto`.
- `.rjmeta` mono `--text-4xs` 10, `--muted`.
- `.rjb` rule badges → `.os-badge--danger`: `--radius-sm` 6 (not pill — badges and tags should differ), `--status-danger-soft` fill, `--status-danger` text, mono/uppercase/`--tracking-wide`. `.rjb.flag` → `.os-badge--warning`.
- `.rjreason` → `.os-input` at `--text-3xs` 11.
- `.rjres` results: `--status-success` / `--status-danger`, mono `--text-4xs`.
- `.rjnote` → `.os-callout`, with `--callout--deadline`(danger) styling when items were found and neutral when none were.
- `.rjfoot` primary button: **this one should not be clay.** A live-submit button that rejects N invoices should be `--status-danger` filled, so it is visually distinct from every other primary in the drawer. The dry-run variant stays clay. **INFERRED** — the site has no destructive-button pattern.

### 3.12 PO Reconciliation card
Reuses `.stats` (4-up), `.os-callout` for `#po-note`, secondary buttons for upload/template, clay primary for Analyze. `#po-status` is mono `--text-4xs` `--muted`. Nothing bespoke needed.

### 3.13 Modals (`.bmodal`)
`--radius-lg` 16, `--shadow-pop`, `--bg`, 1px `--line`. `.bmodal-t` display/700/14. `.bmodal-s` `--text-3xs`/`--muted`. `.bmodal-ta` is `.os-input` textarea (`min-height: 96px`, `resize: vertical`, `padding: --space-3 --space-4`). Scrim `--mscrim`, warm-tinted. Keep the existing focus defaults — cancel-focused on confirm modals is a deliberate safety choice.

---

## 4. What will NOT survive contact

A marketing site optimises for one reader, one column, unlimited vertical space, and a first impression. This drawer is 404px wide, injected into someone else's page, dense with live operational state, bilingual, and looked at for forty minutes at a stretch. Four parts of the site's language do not transfer, and pretending otherwise would produce a worse tool.

### 4.1 The serif — dropped entirely
`Source Serif 4` carries the site's body voice at 17px/1.65 across a 66ch measure. There is no prose in the drawer. The longest strings are the gate sub-heading and consent text, at 11–12px in a 372px column. A serif at that size in that space is measurably harder to read and looks like a mistake. **`--font-serif` is not part of this target.** That removes one of the site's three defining voices, and the identity has to be carried by colour, the mono micro-labels, and shape instead.

### 4.2 Vertical rhythm — compressed by ~3×
`--space-7..12` (32–112px) and `.os-prose > * + * { margin-top: var(--space-5) }` are the site's breathing. The drawer's Run card alone stacks a button row, a three-cell tracker, a counter, two progress bars, a chunk label, and a log pane. At site rhythm, that card alone would be roughly 900px tall and the drawer would become a scroll-hunt during exactly the moments it needs to be glanceable. The drawer stays at `--space-1..4`. The site's airiness is deliberately not inherited.

### 4.3 Pill-shaped buttons — rejected
`.os-btn { border-radius: var(--radius-pill); height: 40px; padding: 0 20px }`. In the drawer, `.runbar` puts three buttons on one row inside 372px, and `.tools` puts two. Pill radius on a 110px-wide button wastes ~14px of horizontal space to curvature, and a row of adjacent pills reads as a tag cloud rather than a control bar. Buttons take `--radius-md` 10. The pill radius is kept only where it is semantically a pill: `.chip`, `.sc`, `.seg`, `.os-tag`, and the progress tracks.

### 4.4 The `.os-card--link` hover lift — rejected
Covered in §2.9. Cards here are containers, not navigation.

### 4.5 The typefaces themselves — likely blocked, see §6.1
This is the big one, and it is an engineering constraint rather than a taste call.

---

## 5. Contrast and accessibility

All ratios below computed against the actual token values. AA small-text threshold is 4.5:1; the drawer's labels are 10–13px, so **everything in it is small text** — the 3:1 large-text allowance essentially never applies here.

### 5.1 Site tokens that fail at drawer scale

| Pair | Ratio | Verdict |
|---|---|---|
| `--ink-4 #968d78` on `--paper-0 #faf6ee` (light) | **3.05** | Fails AA |
| `--ink-4 #968d78` on `--paper-3 #e7dec9` (light, inset) | **2.46** | Fails badly |
| `--ink-4 #7a715c` on `--paper-1 #221e17` (dark) | **3.43** | Fails AA |
| `--tertiary` = `teal-5 #4a9ca6` on `--paper-0` (light) | **2.95** | Fails badly |
| `--clay-5 #c2603b` on `--paper-0` (light) | **3.87** | Fails AA as text |

**Actions:**
1. **`--ink-4` is not a text colour in this UI.** On the site it labels tags at 12px against generous whitespace; here it would carry 10px uppercase micro-labels. Merge `--dim` into `--muted` (`--ink-3`: **5.45** light / **6.39** dark — both pass) and reserve `--ink-4` for non-text only: disabled glyphs, hairline dividers, log timestamps. Note this fixes a **pre-existing bug**: today's `--dim #687181` on `--bg #151a21` is **3.55**, and today's light-theme `--dim #8090a5` on `#f2f5f9` is **2.98** — the drawer currently ships failing micro-labels in both themes.
2. **Bind `--tertiary` to `teal-6 #2e7a84` in light** (**4.60**, passes) and `#7dd6df` in dark (**10.68**). Never `teal-5` for text.
3. **Bind text-clay to `clay-6 #a04a2a`** (**5.55**, passes) rather than `clay-5`. Keep `clay-5` for fills and borders only.

### 5.2 The primary button in light mode — must be fixed before ship

The site's own primary button is `--accent-contrast #fffdf7` on `--clay-5 #c2603b` = **4.10:1**. It fails AA for the drawer's 13px button labels. It only passes on the site because `.os-btn` runs at 15px/600, where 4.10 is still short of 4.5 but visually forgiving on a marketing page. On a button labelled **"▶ Approve & Start"** that commits a multi-thousand-row export, it is not acceptable.

Three options, measured:

| Option | Ratio | Note |
|---|---|---|
| Cream on `clay-6 #a04a2a` | **5.89** | Passes. Darker, slightly heavier. **Recommended.** |
| Cream on `clay-7 #7c381f` | **8.45** | Passes comfortably. Reads brown rather than terracotta. |
| `ink-1 #231f18` on `clay-4 #dd8b62` | **6.20** | Passes. Dark-on-warm — this is the drawer's *existing* pattern (`--on-gold #1a1206` on gold) |

Note the third row: **the drawer's current button treatment is more accessible than the site's.** Today's `--on-gold #1a1206` on the gold gradient is a very high-contrast dark-on-warm fill. Adopting the site's cream-on-clay would be an accessibility regression. Recommendation: use **cream on `clay-6`** for the primary fill (keeps the site's read, passes AA), and keep dark-on-warm for the gold `--run` indicators.

Dark mode is fine throughout: `--accent #e08358` on `#1a1712` is **6.43**, `--accent-strong` is **8.03**, all statuses are 6.8–8.8.

### 5.3 Other items

- **`:focus` → `:focus-visible`.** The drawer fires its ring on mouse click today. The site's `--focus-ring` (§2.8) is also far more visible than the current 15%-alpha glow.
- **`prefers-reduced-motion` is absent from the drawer.** Add the site's block (§2.9). The progress-bar width transitions and the proposed footer pulse both need it.
- **`color-scheme: var(--scheme)` must be preserved** on the host and on `input[type=date]`. Without it the native date picker renders in OS light chrome inside a dark drawer.
- **Do not rely on `text-wrap: balance` or `pretty`.** `manifest.json` sets `minimum_chrome_version: 111`; `balance` shipped in 114 and `pretty` in 117. They degrade silently, which is fine, but no layout should depend on them. `color-mix()` shipped in exactly 111 — usable, but it is the floor, so the `color-mix()` recipes in §3.6 should have static fallbacks.

---

## 6. Environment constraints

### 6.1 Webfonts are probably blocked — resolve this first

`drawer.js` opens with: *"Shadow-DOM isolated, no remote code → system fonts."* That comment is load-bearing. Three separate walls stand between this drawer and Bricolage Grotesque:

1. **MV3 forbids remote code.** Google Fonts URLs are out. Fonts must be bundled as `.woff2` in the extension. There are none in the repo today (`find . -name "*.woff*"` → empty).
2. **`manifest.json` declares no `web_accessible_resources`.** Bundled fonts would need `chrome-extension://` URLs exposed to the page, which requires adding that key.
3. **The content script runs in `world: MAIN` on `invoicing.eta.gov.eg`, so the *portal's* CSP applies — and Shadow DOM does not escape it.** `@font-face` in a shadow root is still subject to the host document's `font-src`. We already know the portal ships a strict CSP: `csp-shim.js` exists specifically because the portal blocks `unsafe-eval`. If its `font-src` does not permit `chrome-extension:`, the fonts silently fail and the drawer falls back to `system-ui` — but only in production, on the one page it matters.

**Recommendation:** treat the typefaces as *aspirational* and the identity as colour + shape + rhythm. Ship the retune on `system-ui` / `ui-monospace` first. Separately, spike whether a bundled `chrome-extension://`-hosted `@font-face` actually loads on the live portal. If it does, **IBM Plex Mono is the one worth adding** — it is the site's most recognisable voice, it is the drawer's dominant typeface already (every label, chip, number, and log line is mono), and it has genuine tabular figures, which matters for live counters that must not jitter. Bricolage Grotesque is the *least* worth the fight: at 12–13px in a 404px panel its personality is invisible and its wider default widths cost horizontal room.

### 6.2 RTL — the drawer runs in Arabic

`applyLang()` sets `dir="rtl"` on `.drawer`. The site is `lang="en"`, LTR-only, and **nothing in its CSS is direction-aware.** Verified physical properties in the compiled stylesheet:

```css
.os-prose ul, .os-prose ol { padding-left: 1.4em }
.os-prose blockquote      { border-left: 3px solid var(--accent); padding: 0 0 0 var(--space-6) }
.os-skip                  { left: var(--space-4) }
```

**Every borrowed rule must be rewritten to logical properties** — `padding-inline-start`, `border-inline-start`, `inset-inline-start`, `margin-inline-start`. The drawer already does this correctly today (`margin-inline-start: auto`, `text-align: end`, `float: inline-end`); do not regress it by pasting site CSS.

Four RTL issues specific to this handoff:

1. **Uppercase + `--tracking-wide` breaks Arabic.** This is the site's signature move and it is actively harmful in Arabic: the script has no letter case, so `text-transform: uppercase` is a no-op, and `letter-spacing: .09em` **breaks cursive letter joining**, rendering connected Arabic words as visually disconnected glyphs. This is already a live bug — `label.l`, `.stat .k`, `.tk .k`, `.proc .pl`, `.tag`, `.ckline`, and `details.cols summary` all carry `text-transform: uppercase; letter-spacing: .08em` and all get translated. Gate it:
   ```css
   .drawer[dir=rtl] .l, .drawer[dir=rtl] .k, .drawer[dir=rtl] .tag /* … */
   { text-transform: none; letter-spacing: normal }
   ```
   Adopting `--tracking-wide` at `.09em` without this gate makes an existing defect worse.

2. **Directional gradients need flipping.** `.track > i` uses `linear-gradient(90deg, teal, gold)` and `.ckbar > i` uses `(90deg, gold, teal)`. In RTL the bar fills right-to-left while the gradient still runs left-to-right. §3.8's recommendation — solid fills — removes the problem rather than patching it.

3. **Text disclosure markers cannot flip.** `details.cols summary::before { content: '▸ ' }` points right regardless of direction. Replace with a rotatable SVG chevron (§3.6).

4. **The LTR islands are correct — do not touch them.** `.num` (`direction: ltr; unicode-bidi: isolate; tabular-nums`) and `.log` (`direction: ltr; text-align: left; unicode-bidi: plaintext`) are exactly right: numbers, TINs, UUIDs, dates, and file paths must stay LTR inside RTL text, and the log is a technical console where Arabic words still render RTL via the bidi algorithm. Any new mono/numeric surface added under this handoff must carry `.num`.

### 6.3 Self-containment inside a third-party page

- **Keep `:host { all: initial }`.** It is the single line preventing the ETA portal's stylesheet from leaking in. Every token must be defined on `:host`, never inherited.
- **`--focus-ring` cannot reference `--bg-page`** — there is no page ground inside the drawer. Rebind to `--bg2` (§2.8).
- **The drawer's edge shadow must stay heavy** — the portal's background colour is not ours to predict (§2.7).
- **Keep `z-index: 2147483647`** on pill, drawer, and modal scrim; keep the `MutationObserver` that re-appends the host when the portal's SPA wipes it.
- **Theme default asymmetry.** The site is light-default with `[data-theme=dark]` opt-in. The drawer is dark-default with `:host([data-theme=light])` opt-in, and its dark scheme is the hand-tuned original. Do **not** flip the drawer to light-default to match the site — users run this over the portal's own light UI, and a dark panel is what separates the tool from the page. Instead, define **both** themes explicitly (§7) so neither default is implicit.

---

## 7. Shared identity with the admin dashboard

`dash.html` (74KB, self-contained, worker-served) already uses `:root[data-theme="dark"]` / `:root[data-theme="light"]`, bootstrapped from `localStorage.eta_admin_theme` with a `prefers-color-scheme` fallback — **the same mechanism as both the site and the drawer.** Three surfaces, one switching model. That is the foundation; it needs no change.

Its current palette is cool-grey/blue (`--bg:#0e1116`, `--panel:#161b22`, `--line:#28303c`, `--text:#e9edf3`, `--muted:#8b95a5`) with the same gold as the drawer (`--gold:#e3a552` / `#b9822c`). It shares the drawer's exact `--line`, `--gold`, `--gold2`, and light-theme `--text`/`--muted` values — the two are already siblings. Warming both together keeps that relationship.

### 7.1 Reusable as-is

| Layer | Reuse | Note |
|---|---|---|
| Colour primitives | **Full** — `paper-0..3`, `line-1..2`, `ink-1..4`, clay/moss/teal/gold, all statuses | The whole §2.1 table drops into both |
| Status semantics | **Full** — success/warning/danger + soft variants | `dash` already has `good`/`warn`/`bad` + `bg`/`ln` triplets; a 1:1 rename |
| Radius scale | **Full** | `dash` uses 3,5,6,9,11,12,14,16,999 → same snapping as §2.6 |
| Spacing scale | **Full** (`--space-1..8` for dash — it has real page width) | |
| Motion | **Full** — `--dur-1..3`, `--ease-out`, `prefers-reduced-motion` | |
| Elevation | **Full** — `--shadow-card` / `--pop` / `--inset` | `dash`'s single `--shadow` becomes three |
| Focus ring | **Full** | `dash` can use `var(--bg-page)` literally, since it *has* a page ground |
| Type scale + tracking | **Full** | `--text-2xs..5xl` all get used on a real page |
| Typefaces | **Full — and only here** | See §7.3 |

### 7.2 Needs a decision

- **`--super` (purple `#b9a6f0` / `#6b4fc4`)** exists in `dash` and has no counterpart on the site or in the drawer. Do not invent a purple for the shared palette — **remap it to `--secondary` (moss, `#44685a` / `#8fae97`)**, which is the site's fourth accent and is currently unused by either tool. That completes the accent set as clay (interactive) / gold (in-flight) / teal (waiting, informational) / moss (this fourth category), with no hue doing two jobs anywhere.
- **Gold's demotion (§2.3) hits `dash` hardest**, since gold is its dominant accent. If clay becomes the shared interactive colour, `dash`'s buttons, links, and active nav all move to clay and gold retreats to warnings and in-flight state. That is the right call for one identity, but it is the largest visible change in this whole handoff and should be agreed before either surface is touched.
- **Theme defaults should be normalised** to `dash`'s pattern — explicit `[data-theme=dark]` *and* `[data-theme=light]` blocks in all three surfaces — so the drawer's dark-default and the site's light-default stop being implicit and diverging.

### 7.3 The asymmetry that defines the shared identity

**Only `dash.html` can load the typefaces.** It is served from the worker's own origin, under its own CSP, with no third-party page in the way — it can carry Bricolage Grotesque, Source Serif 4, and IBM Plex Mono in full. The drawer, injected into the ETA portal under a foreign CSP with no `web_accessible_resources`, most likely cannot (§6.1).

So the shared identity **cannot be carried by type.** It has to live in the layer both surfaces can guarantee:

> **warm paper-and-ink palette · clay interactive / gold in-flight · hairline warm borders · uppercase mono micro-labels · 4px spacing grid · 6/10/16 radii · 120/200/350ms on `cubic-bezier(.22,1,.36,1)`**

Two surfaces built on that will read as one product whether or not the fonts load — and if the font spike in §6.1 succeeds, the drawer picks up IBM Plex Mono and closes most of the remaining gap on its own.

---

## 8. Suggested order

1. **Decide §2.3** (clay interactive / gold in-flight) — everything downstream depends on it.
2. **Fix the accessibility defects that exist today**, independent of any repaint: merge `--dim` into `--muted`, gate uppercase/tracking behind `:not([dir=rtl])`, switch `:focus` → `:focus-visible`, add `prefers-reduced-motion`.
3. **Land the token layer** in `drawer.js`'s `CSS` block — colour, type, spacing, radius, shadow, motion — on `system-ui`/`ui-monospace`. Highest visual return, no new dependencies.
4. **Per-surface passes**, in stakes order: Run card → Rejection tab → Gate → Configure/Plan/Tools → modals/banners.
5. **Spike the font question** (§6.1) in parallel; adopt IBM Plex Mono only if it survives the live portal.
6. **Port the same token layer to `dash.html`**, with the full typeface set.
7. Decide §7.2's `--super` remap and normalise theme defaults across all three surfaces.
