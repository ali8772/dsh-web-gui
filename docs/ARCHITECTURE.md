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
- `GET /api/whale-pet/opencode-go`: OpenCode Go quota (5-hour / 7-day / monthly windows).
- `GET /dsh-whale-pet-live2dcubismcore.min.js`: local Cubism Core runtime.
- `GET /api/whale-pet/companions` plus issue/revoke POST routes: browser-authenticated grant management.
- `/dsh-whale-pet/companion/v1/{state,tasks,task-summary,opencode-go}`: loopback socket + trusted Host/Origin + Bearer data carrier.
- `GET /dsh-whale-pet-live2d.js`: dynamically imported PIXI/Live2D renderer.
- `GET /dsh-whale-pet-live2d-zip-worker.js`: dedicated ZIP parsing Worker.

Request JSON is limited to 64 KiB. Task IDs are deduplicated, capped at 32, and individually bounded; corrupt session rows are isolated. `SessionProjection` shares a one-second, bounded session-tree index across browser and companion task routes, while progress and summary caches each have hard entry budgets.

Balance uses DSH credentials and DeepSeek `/user/balance`. The first successful observation establishes a baseline; later decreases accumulate under `$DSH_HOME/whale-pet/balance-spend.json` for the current Beijing calendar day. Session logs provide call counts and task activity only.

## Client Live2D flow

The main bundle never imports PIXI. Opening the settings or restoring a saved model:

1. `runtime.ts` injects the local Cubism Core `<script>` and waits for `Live2DCubismCore`.
2. Only then does the widget `import('/dsh-whale-pet-live2d.js')`; that chunk checks the global runtime at module load, so ordering is fixed.
3. `zip-client.ts` transfers ZIP bytes to `zip-worker.ts`; the Worker parses/validates off the UI thread and enforces 2,048 files / 256 MiB unpacked. URL imports use `ModelDownloader` with 256 files, 32 MiB per file, 128 MiB total, and concurrency four.
4. `Live2DRepository` stores metadata and assets together in one IndexedDB `active` record, so no secondary marker can diverge.
5. `core.ts` builds a `Cubism4ModelSettings` whose `resolveURL` returns per-file blob object URLs, mounts the model, sizes it into the whale box, and adds pointer-focus, hit-area click motions, idle/random motions, and expressions.
6. Every PIXI renderer leases a newly created canvas from `canvas.ts`. PIXI 6 deliberately loses its WebGL context during `destroy()`, so the canvas is removed and never reused. Model replacement stages a hidden successor, commits durable state, then reveals it and disposes the prior renderer; model removal likewise keeps the current renderer until durable deletion succeeds.

Failures at any step leave the default PNG active; the dialog shows the reason and keeps prior state unless an import succeeded.

## Trust boundaries

- Credential values remain on the host; no route returns a raw key.
- Imported models never leave the browser (IndexedDB), and URL import fetches only the user-supplied server.
- Zip bombs and path traversal are rejected before persistence; model assets are served only as same-origin blob URLs.
- Browser-private APIs require DSH Host/Origin validation and the authenticated browser session; all data responses are `no-store`.
- Companion tokens use `wpg1.<128-bit id>.<256-bit secret>`; only a domain-separated SHA-256 verifier is stored in the plugin-owned DSH credential record. The token is returned once, supports independent device grants, and is never accepted in cookies or query strings.
- Companion routes trust the socket address—not proxy headers—and require loopback, a loopback Host/same-origin browser marker policy, and Bearer authentication. PowerShell uses CurrentUser DPAPI; Rust uses Windows Credential Manager.
- Runtime JS assets use immutable long-lived caching; CI enforces bundle budgets and an explicit production-audit allowlist for the upstream `pixi-live2d-display -> gh-pages` packaging defect.
- The Windows companions are separate source-only software, not part of the plugin bundle.