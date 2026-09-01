# Architecture

## Overview

```text
DSH credentials ──> balance API ──> persistent balance ledger ──> state API ──> client overlay
session logs ─────────────────────> call counts / task progress ────────────┘
DSH sessions service ───────────────────────────────> task list and open
```

## Packaging

`package.json` exports `lib/index.js` and `lib/client.js`, declares the web client platform, and exposes `cordis.patch.yml` as a bundle layer. The layer inserts `dsh-whale-pet` exactly once. Adding/removing/updating bundle membership requires a profile restart.

## Host

The host injects `credentials` and `webServer` and exposes:

- `GET /api/whale-pet/health`: readiness and version.
- `GET /api/whale-pet/state`: balance plus spend snapshot.
- `POST /api/whale-pet/tasks`: progress for requested session IDs.

Balance uses DSH credentials and DeepSeek `/user/balance`. The first successful observation establishes a baseline. Later decreases are accumulated under `$DSH_HOME/whale-pet/balance-spend.json` for the current Beijing calendar day; balance increases update the baseline without reducing prior spend. Session logs provide call counts and task activity only. Task parsing incrementally replays plain or zstd logs.

## Client

The client injects `slots` and `sessions`, registers in `shell.overlay`, and injects scoped CSS. It polls state every 60 seconds, tracks running sessions, requests progress, and opens a clicked session. Position is stored under `dsh-whale-pet:pos`.

## Trust boundaries

- Credential values remain on the host.
- The browser receives derived balance, spend, and progress data.
- Local APIs expose account/session summaries and should remain inside a trusted local DSH environment.
- Spend is accumulated from successful balance observations; pre-baseline history cannot be reconstructed.
- The Windows companion is separate source-only software and is not loaded by the plugin bundle.
