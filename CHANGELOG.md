# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

> The changes in this section are available from GitHub `main` starting at commit [`7a50895`](https://github.com/ali8772/dsh-web-gui/commit/7a50895bda73bd07f61406583a2b9ac1fd3a5387). They have not yet been assigned a new release version or tag; the package metadata still reports `0.4.1`.

### Fixed
- Price non-DeepSeek provider/model routes from a validated weekly `models.dev` snapshot instead of forcing every external model to zero; preserve exact provider separation and DeepSeek's curated historical policies.
- Price the DSH adapter's `deepseek-flash` model id with the curated official Flash policy instead of reporting zero cost.
- Discover the newest versioned session-log artifacts (`session.v4.jsonl[.zstd]` and later) so task progress and usage statistics include current sessions after a persistence upgrade.
- Require Node.js 24 consistently because the host session reader uses Node's Zstandard API.
- Recover newline-complete task and usage events from a torn final Zstandard session-log frame.
- Track all running sessions separately from the ten-row display window, preventing reordering and parent grouping from producing false completion dialogs.
- Leave unknown/non-DeepSeek models unpriced and prefer each assistant message's actual model provenance.

### Added
- Add an atomic, size-bounded, last-known-good local price catalog under `$DSH_HOME/whale-pet/models-dev.json`, with stale-while-revalidate refresh, retry backoff, cache-read fallback, provenance, and deterministic USD-to-CNY estimate conversion.
- Add an authenticated `GET /api/whale-pet/pricing` route and a searchable API price-table dialog: DeepSeek's current official peak/off-peak/flat prices plus every priced models.dev provider/model, with 7-day per-model calls, tokens, and cost computed from the same pricing snapshot.
- Show the catalog update time, revision time, next weekly refresh, and failure state in the price table.
- Keep a five-model Live2D MRU library in IndexedDB with accessible one-click switching, current-model state, default-character fallback that preserves history, per-model permanent deletion, and cancellation of superseded imports.
- Protect every private browser route with DSH Host/Origin and authenticated-session checks, bounded JSON bodies, stable errors, deduplicated task IDs, and corrupt-session row isolation.
- Add independently revocable desktop-companion grants with one-time plaintext `wpg1` tokens, verifier-only credential storage, loopback/Host/Origin fencing, and Bearer-only companion routes.
- Add browser pairing management; PowerShell stores tokens with CurrentUser DPAPI and Rust uses Windows Credential Manager.
- Add one-lane polling with coalesced triggers, abort-on-dispose, shared bounded session projection, and hard limits on task projection caches.
- Move ZIP parsing/validation into a transferable module Worker; add bounded-concurrency URL downloads and explicit per-file/total resource limits.
- Add keyboard-operable task rows, modal semantics with Escape/focus return, polite status announcements, focus indicators, and reduced-motion styles.
- Add per-artifact bundle budgets and canonical production-audit gates to local packaging, CI, and releases.

### Changed
- Refresh the models.dev catalog automatically every 7 days while the host keeps running (hourly staleness check), instead of only on process start.
- Replay call counts from session logs modified within the 7-day window only, so a cold state request no longer scans the entire history.
- Reuse a single Beijing-day formatter and cache sessions with no billable events, removing multi-second synchronous aggregation stalls.
- Add strict TypeScript checking to local packaging, CI, and release validation.
- Replace the localStorage model pointer with an atomic IndexedDB manifest plus per-model records, preserving config/resource consistency while supporting the bounded recent-model library.
- Pause the PIXI ticker and idle motion loop while the page is hidden.
- Serve immutable local Live2D runtime assets with long-lived caching while all private JSON responses remain `no-store`.

### Security
- Bound URL model imports to 256 files, 32 MiB per file, 128 MiB total, and four concurrent downloads.
- Never place companion plaintext tokens in query parameters, cookies, logs, or browser persistence; revoke grants independently from settings.
- Document the narrowly allowed upstream `pixi-live2d-display -> gh-pages` audit advisory without applying a destructive renderer downgrade.

## 0.4.1 source milestone — 2026-09-03 (not tagged)

### Fixed
- Restoring the default Whale-chan and importing Live2D again no longer reuses a canvas whose WebGL context PIXI destroyed. Every renderer now owns a fresh canvas that is removed with the renderer, fixing `Invalid value of \`0\` passed to \`checkMaxIfStatementsInShader\``.
- Replacing one active Live2D model with another now disposes the previous renderer before mounting the replacement, preventing overlapping PIXI applications and canvas leaks.
- Pet size scaling now uses the model center as the scaling origin.
- The bubble/dialog tracks the model top as the pet scales up or down, keeping the 4px gap instead of overlapping the model.
- The pager (mode dots) tracks the model bottom and moves with the pet scale, instead of staying fixed at the pet container edge.
- The random-expression control only applies when the model defines expressions; models without expressions show a disabled button with a hint instead of silently doing nothing.
- Live2D rendering resolution now scales with the pet size (`dpr × scale`) with no artificial cap, so zooming in keeps the model sharp at any device-pixel ratio.
- The Live2D model renders exactly at the canvas center and the scale transform is merged with the centering translate, eliminating any perceived horizontal drift.

## 0.4.0 source milestone — 2026-09-03 (not tagged)

### Added
- Live2D model import that replaces the default Whale-chan: ZIP (`.model3.json`) and URL import with CORS-enabled servers, persisted to the browser's IndexedDB and restored on refresh.
- Cubism 3/4/5 support via a locally served official Cubism Core runtime; the PIXI/Live2D renderer loads dynamically only when Live2D is in use, so the default pet no longer requires the runtime or a CDN.
- Interactive motions: pointer tracking drives eye/head focus, clicking a hit area plays its same-named motion (falling back to `TapBody`), plus play-motion/random-expression controls in settings and a 25-second ambient random motion loop.
- Hardened import parsing: root-bound relative asset resolution, duplicate-archive detection, 2,048-file and 256 MiB unpack limits, and rejection of absolute/URL references.
- Asset notice documenting the official Cubism Core source, SHA-256, and license.

### Changed
- Plugin version raised to `0.4.0`; new host routes `GET /dsh-whale-pet-live2dcubismcore.min.js` and `GET /dsh-whale-pet-live2d.js`.
- Live2D settings gear no longer triggers page cycling; a size slider (50%–200%, persisted) and a reset button adjust only the pet model, leaving bubbles and dialogs unchanged.
- Legacy Cubism 2 `.model.json` is deliberately not supported by the Cubism 4 runtime.

### Security
- Imported Live2D models never leave the browser; URL import fetches only user-provided model servers.
- Local live2d E2E tests, local fixture models, and real-account screenshots remain excluded from Git and release packages.

## 0.3.0 source milestone — 2026-09-03 (not tagged)

### Added
- OpenCode Go quota page showing used percentage, remaining quota, and reset time for the rolling 5-hour, 7-day, and monthly windows. The host reads the official gateway `https://opencode.ai/zen/go/v1/usage` with the CLI login file as a transparent credential source; the API key never leaves the host.
- Task-completion dialog that displays split token counts and estimated cost for the latest conversation and the full session, with per-model breakdowns so mixed-model usage is priced using each model's own rate.
- Subagent rows now nest visually under their parent task family in the task progress page.
- `approval/decided` clears the yellow awaiting-user indicator immediately so the task dot returns to green after approval.

### Changed
- Balance and combined spend are now a single page; the task progress page and the OpenCode Go quota page are separate modes. The pager shows two dots when idle and three when a task is running.
- The latest model used in the current conversation is preserved so its pricing is not silently downgraded to a fallback model after the user boundary.

### Security
- Local-auth E2E scripts and real account screenshots remain excluded from Git and release packages; no credentials are bundled with the plugin.

## [0.2.2] - 2026-09-01

### Fixed
- Calculate today and seven-day spend from persisted account balance decreases instead of token pricing or platform usage data.
- Treat top-ups and grants as baseline increases so they never erase accumulated spend.
- Persist the balance baseline and Beijing-calendar daily totals across host restarts.

### Changed
- The spend source badge now reads `余额变化`.
- Session logs supply call counts and task progress only; they no longer determine spend amounts.
- The first successful balance read establishes a zero-spend baseline.

### Tests
- Added a deterministic state-route regression covering balance decreases, top-ups, persistence across host reloads, and Beijing day boundaries.

## [0.2.0] - 2026-08-31

### Added
- Whale-chan image overlay with transparent artwork and floating/drag animation.
- Live task-progress page derived from todo, tool, turn, and step events.
- Up to ten running tasks, five-row viewport, automatic scrolling, and session navigation.
- Combined today/seven-day spend panel, Beijing peak/off-peak badge, adaptive presentation, and top-up link.
- `POST /api/whale-pet/tasks` host endpoint.
- Source-only Windows PowerShell/WPF companion.
- Bilingual documentation, portable build, package audit, and GitHub release automation.

### Changed
- Display modes are balance, combined spend, and conditional task progress.
- Standard DSH bundle installation now activates the plugin directly.
- Release version synchronized at `0.2.0`.

### Security
- Credentials remain host-side and are not returned to browser code.
- Local-auth E2E tests, real account screenshots, session data, and local credentials are excluded from Git and release packages.

## [0.1.1]

### Added
- Initial draggable pet with balance, today spend, seven-day spend, and local estimation.

[Unreleased]: https://github.com/ali8772/dsh-web-gui/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/ali8772/dsh-web-gui/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ali8772/dsh-web-gui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ali8772/dsh-web-gui/releases/tag/v0.2.0
