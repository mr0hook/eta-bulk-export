# ADR-001 — Serve the admin dashboard as a text module, not Workers Static Assets

Date: 2026-08-09 · Status: accepted · Context: admin roadmap A0 / SPEC-015

## Context

The admin dashboard (74 KB) and the privacy policy (5 KB) were template literals inside
`worker.js`. A0 moves them out so they become reviewable, diffable files. Two ways to serve HTML
from a Cloudflare Worker:

1. **Workers Static Assets** — an `[assets]` directory the platform serves.
2. **Text module import** — `[[rules]] type = "Text"` makes `import DASH from './dash.html'`
   yield the file's text; the Worker returns it exactly as before.

The roadmap draft assumed option 1.

## Decision

Text module import.

## Why

**Static Assets are served ahead of the Worker.** With an assets directory bound, the platform
answers matching paths before Worker code runs, unless `run_worker_first` is configured. The
dashboard is served at `/` and `/admin` — the two most generic paths in the app. Handing those to
the asset layer changes who answers them, and `/` currently returns the dashboard *from Worker
code*. That is a behaviour change, and SPEC-015's entire acceptance bar is that nothing changes.

Secondary reasons:

- One deployable artifact, one bundle, no second serving path to reason about.
- The 29-route parity check compares Worker responses. If the platform started serving two of
  those routes, the check could not cover them.
- Cost of reversing this later is one config block; nothing in the code depends on which
  mechanism delivered the string.

## Consequences

- The HTML counts toward the Worker bundle: 124.96 KiB total, 33.31 KiB gzipped. Comfortably
  inside the 3 MB free-tier limit, but it is no longer free — if the dashboard grows several
  hundred KB, revisit.
- Node cannot import `.html` natively, so the smoke harness needs a module load hook. It needed a
  hook for `cloudflare:workers` anyway; `smoke-hooks.mjs` handles both, and its `.html` branch
  mirrors what the wrangler Text rule produces.
- `[[rules]]` must be repeated per environment — wrangler environments do not inherit them.

## Alternatives rejected

- **Static Assets with `run_worker_first`** — restores the routing but adds a config knob whose
  failure mode is silent (the dashboard becoming publicly served by the platform, bypassing the
  Worker). Not worth it for two files.
- **Leave the HTML in `worker.js`** — the status quo A0 exists to end.
