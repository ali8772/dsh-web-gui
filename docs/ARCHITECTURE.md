# Architecture

## Overview

```text
DSH credentials ──> balance API ──> persistent balance ledger ──> state API ──> client overlay
session logs ─────────────────────> call counts / task progress ────────────┘
OpenCode Go gateway ──────────────> quota cache ───> opencode-go API ────────┘
local Cubism Core + PIXI chunk ───> same-origin JS routes ───> Live2D canvas
```

## Packaging

`package.json` ships `lib/index.js` (host), `lib/client.js` (browser overlay), `lib/live2d.js` (dynamic renderer), and `lib/live2dcubismcore.min.js` (official redistributable runtime). `cordis.patch.yml` inserts `dsh-whale-pet` exactly once; bundle membership changes require a profile restart. `vendor/live2dcubismcore.min.js` is pinned in the repository with its license and SHA-256 recorded in `ASSET_NOTICE.md`.

## Host

The host injects `credentials` and `webServer` and exposes:

- `GET /api/whale-pet/health`: readiness and version.
- `GET /api/whale-pet/state`: balance plus spend snapshot.
- `POST /api/whale-pet/tasks`: progress for requested session IDs.
- `POST /api/whale-pet/task-summary`: token/cost summary priced per model.
- `GET /api/whale-pet/opencode-go`: OpenCode Go quota (5-hour / 7-day / monthly windows).
- `GET /dsh-whale-pet-live2dcubismcore.min.js`: local Cubism Core runtime.
- `GET /dsh-whale-pet-live2d.js`: dynamically imported PIXI/Live2D renderer.

Balance uses DSH credentials and DeepSeek `/user/balance`. The first successful observation establishes a baseline; later decreases accumulate under `$DSH_HOME/whale-pet/balance-spend.json` for the current Beijing calendar day. Session logs provide call counts and task activity only.

## Client Live2D flow

The main bundle never imports PIXI. Opening the settings or restoring a saved model:

1. `runtime.ts` injects the local Cubism Core `<script>` and waits for `Live2DCubismCore`.
2. Only then does the widget `import('/dsh-whale-pet-live2d.js')`; that chunk checks the global runtime at module load, so ordering is fixed.
3. `ui.ts` (no PIXI) parses/validates imports, enforces root-bound relative paths, limits ZIPs to 2,048 files and 256 MiB unpacked, then atomically stores one IndexedDB record plus a localStorage config pointer.
4. `core.ts` builds a `Cubism4ModelSettings` whose `resolveURL` returns per-file blob object URLs, mounts the model, sizes it into the whale box, and adds pointer-focus, hit-area click motions, idle/random motions, and expressions.

Failures at any step leave the default PNG active; the dialog shows the reason and keeps prior state unless an import succeeded.

## Trust boundaries

- Credential values remain on the host; no route returns a raw key.
- Imported models never leave the browser (IndexedDB), and URL import fetches only the user-supplied server.
- Zip bombs and path traversal are rejected before persistence; model assets are served only as same-origin blob URLs.
- Local APIs expose account/session summaries and should remain inside a trusted local DSH environment.
- The Windows companions are separate source-only software, not part of the plugin bundle.