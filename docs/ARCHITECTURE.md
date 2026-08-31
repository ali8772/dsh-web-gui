# Architecture

## Overview

```text
DSH credentials ──> host plugin ──> /api/whale-pet/{health,state,tasks} ──> client overlay
session logs ─────> spend/task parsers ────────────────────────────────────┘
DSH sessions service ───────────────────────────────> task list and open
```

## Packaging

`package.json` exports `lib/index.js` and `lib/client.js`, declares the web client platform, and exposes `cordis.patch.yml` as a bundle layer. The layer inserts `dsh-whale-pet` exactly once. Adding/removing/updating bundle membership requires a profile restart.

## Host

The host injects `credentials` and `webServer` and exposes:

- `GET /api/whale-pet/health`: readiness and version.
- `GET /api/whale-pet/state`: balance plus spend snapshot.
- `POST /api/whale-pet/tasks`: progress for requested session IDs.

Balance uses DSH credentials and DeepSeek `/user/balance`. Optional platform spend is preferred; otherwise session token use is grouped by Beijing calendar day and priced locally. Task parsing incrementally replays plain or zstd session logs. `todo/write` supplies completion state; tool, turn, and step events supply activity context.

## Client

The client injects `slots` and `sessions`, registers in `shell.overlay`, and injects scoped CSS. It polls state every 60 seconds, tracks running sessions, requests progress, and opens a clicked session. Position is stored under `dsh-whale-pet:pos`.

## Trust boundaries

- Credential values remain on the host.
- The browser receives derived balance, spend, and progress data.
- Local APIs expose account/session summaries and should remain inside a trusted local DSH environment.
- Session-log estimates can be incomplete and are not official billing.
- The Windows companion is separate source-only software and is not loaded by the plugin bundle.
