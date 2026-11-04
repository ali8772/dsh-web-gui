# Architecture

## Overview

```text
DSH credentials ──> balance API ──> persistent balance ledger ──> state API ──> client overlay
session logs ─────────────────────> call counts / task progress ────────────┘
OpenCode Go gateway ──────────────> quota cache ───> opencode-go API ────────┘
browser auth ──> private /api routes ──────────────────────────────────────┘
one-time grant verifier ──> loopback + Bearer companion routes ────────────┘
local Cubism Core + PIXI + ZIP Worker ─> same-origin JS routes ─> Live2D canvas
```

## Packaging

`package.json` ships `lib/index.js` (host), `lib/client.js` (browser overlay), `lib/live2d.js` (dynamic renderer), `lib/live2d-zip-worker.js` (off-main-thread ZIP parser), and `lib/live2dcubismcore.min.js` (official redistributable runtime). `cordis.patch.yml` inserts `dsh-whale-pet` exactly once; bundle membership changes require a profile restart. `vendor/live2dcubismcore.min.js` is pinned in the repository with its license and SHA-256 recorded in `ASSET_NOTICE.md`.

## Host

The host injects `credentials`, `webServer`, and `connection`. Health and immutable JS assets are public; browser-private data routes call the DSH connection trust/authentication seam before reading credentials, bodies, or session data. It exposes:

- `GET /api/whale-pet/health`: readiness and version.
- `GET /api/whale-pet/state`: balance plus spend snapshot.
- `POST /api/whale-pet/tasks`: progress for requested session IDs.
- `POST /api/whale-pet/task-summary`: token/cost summary priced per model.
- `GET /api/whale-pet/pricing`: the current weekly price table (official DeepSeek plus models.dev) and 7-day per-model usage priced by the same snapshot.
- `GET /api/whale-pet/opencode-go`: OpenCode Go quota (5-hour / 7-day / monthly windows).
- `GET /dsh-whale-pet-live2dcubismcore.min.js`: local Cubism Core runtime.
- `GET /api/whale-pet/companions` plus issue/revoke POST routes: browser-authenticated grant management.
- `/dsh-whale-pet/companion/v1/{state,tasks,task-summary,opencode-go}`: loopback socket + trusted Host/Origin + Bearer data carrier.
- `GET /dsh-whale-pet-live2d.js`: dynamically imported PIXI/Live2D renderer.
- `GET /dsh-whale-pet-live2d-zip-worker.js`: dedicated ZIP parsing Worker.

Request JSON is limited to 64 KiB. Task IDs are deduplicated, capped at 32, and individually bounded; corrupt session rows are isolated. `SessionProjection` shares a one-second, bounded session-tree index across browser and companion task routes, while progress and summary caches each have hard entry budgets.

Balance uses DSH credentials and DeepSeek `/user/balance`. The first successful observation establishes a baseline; later decreases accumulate under `$DSH_HOME/whale-pet/balance-spend.json` for the current Beijing calendar day. Session logs provide call counts and task activity only.

Pricing has two layers: curated official DeepSeek policies with peak/off-peak windows, and a compact last-known-good models.dev catalog in `$DSH_HOME/whale-pet/models-dev.json` for every other provider. The host checks catalog staleness hourly and refreshes every 7 days; a failed refresh keeps the last valid snapshot. The price table and usage statistics are projected from one immutable snapshot so displayed prices and computed costs cannot diverge. Usage aggregation reads the highest session-log version present (`session.v4.jsonl[.zstd]` and later) and, for windowed statistics only, skips files whose last write predates the window to avoid re-pricing hundreds of megabytes of history.

## Client Live2D flow

The main bundle never imports PIXI. Opening the settings or restoring a saved model:

1. `runtime.ts` injects the local Cubism Core `<script>` and waits for `Live2DCubismCore`.
2. Only then does the widget `import('/dsh-whale-pet-live2d.js')`; that chunk checks the global runtime at module load, so ordering is fixed.
3. `zip-client.ts` transfers ZIP bytes to `zip-worker.ts`; the Worker parses/validates off the UI thread and enforces 2,048 files / 256 MiB unpacked. URL imports use `ModelDownloader` with 256 files, 32 MiB per file, 128 MiB total, and concurrency four.
4. `Live2DModelLibrary` owns a bounded five-item MRU manifest (`activeModelId`, order, and display metadata) and stores each complete model under a separate IndexedDB key. Every manifest/model write, eviction, or deletion is one read-write transaction; listing and switching do not clone unrelated model blobs. The previous single-model `active` record migrates atomically on first read.
5. Importing or switching moves that model to the MRU front. A sixth model evicts the least recently used record and assets. Returning to the default PNG clears only `activeModelId`; per-item delete permanently releases that model's record.
6. `core.ts` builds a `Cubism4ModelSettings` whose `resolveURL` returns per-file blob object URLs, mounts the model, sizes it into the whale box, and adds pointer-focus, hit-area click motions, idle/random motions, and expressions.
7. Every PIXI renderer leases a newly created canvas from `canvas.ts`. PIXI 6 deliberately loses its WebGL context during `destroy()`, so the canvas is removed and never reused. Imports and saved-model switches stage a hidden successor and coordinate renderer/durable commits through one mutation queue; failures before a durable commit discard the staged renderer, while every successful durable commit is reflected before a newer queued operation supersedes it.

Failures before persistence retain the previous renderer (or default PNG); the dialog shows the reason. IndexedDB mutations are atomic, so rejected writes need no compensation. Coordination is guaranteed within one widget/browser realm; another open tab reconciles its visible renderer after reload.

## Trust boundaries

- Credential values remain on the host; no route returns a raw key.
- Imported models never leave the browser (IndexedDB), and URL import fetches only the user-supplied server.
- Zip bombs and path traversal are rejected before persistence; model assets are served only as same-origin blob URLs.
- Browser-private APIs require DSH Host/Origin validation and the authenticated browser session; all data responses are `no-store`.
- Companion tokens use `wpg1.<128-bit id>.<256-bit secret>`; only a domain-separated SHA-256 verifier is stored in the plugin-owned DSH credential record. The token is returned once, supports independent device grants, and is never accepted in cookies or query strings.
- Companion routes trust the socket address—not proxy headers—and require loopback, a loopback Host/same-origin browser marker policy, and Bearer authentication. PowerShell uses CurrentUser DPAPI; Rust uses Windows Credential Manager.
- Runtime JS assets use immutable long-lived caching; CI enforces bundle budgets and an explicit production-audit allowlist for the upstream `pixi-live2d-display -> gh-pages` packaging defect.
- The Windows companions are separate source-only software, not part of the plugin bundle.