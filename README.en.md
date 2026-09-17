# dsh-whale-pet 🐳

[中文](README.md) · [Installation](docs/INSTALL.md) · [Architecture](docs/ARCHITECTURE.md) · [Changelog](CHANGELOG.md)

`dsh-whale-pet` is a Whale-chan overlay plugin for the DeepSeek Harness Web GUI. It shows account balance and spend, OpenCode Go plan quota, live task progress with per-model completion summaries, and lets you import your own Cubism 3/4/5 Live2D models that replace the default Whale-chan with interactive motions.

![Sanitized Whale-chan demo in DSH Web GUI](docs/images/whale-chan-demo.png)

![Sanitized Live2D recent-model quick-switch interface](docs/images/live2d-model-library.png)

> The screenshots use fixed example data and sample model names; they contain no real account information.

## Current source highlights (`main`)

> The npm package version remains `0.4.1`. The authentication, desktop-pairing, performance, Worker, and accessibility changes below have been on GitHub `main` since commit [`7a50895`](https://github.com/ali8772/dsh-web-gui/commit/7a50895bda73bd07f61406583a2b9ac1fd3a5387), but no matching Release/tag has been created yet. Build from trusted source if you need them now, and use the version and checksums published on the Releases page for formal installs.
>
> **Security note:** older tagged versions do not contain the private-route authentication and companion Bearer protections described below. Do not expose their data routes to an untrusted network while awaiting a formal security release.

### Live2D model import and interaction

- Open Live2D settings with the `⚙️` button in the pet's top-right corner.
- Import a `.zip` that contains one `.model3.json` plus its referenced `.moc3`, textures, physics, motions, expressions, etc.; an outer folder is fine.
- Import an HTTP/HTTPS `.model3.json` URL (the asset server must allow browser CORS). Referenced assets are downloaded and the model later restores from the browser's IndexedDB.
- Supports Cubism 3/4/5 `.model3.json`; legacy Cubism 2 `.model.json` is not supported.
- Interactions: mouse movement drives eye/head focus, clicking a hit area plays its same-named motion (commonly `TapBody`), and the settings panel can play a random motion or expression; models also provide idle motions, eye blink, breath, and physics.
- Opening settings with the `⚙️` button does not cycle pages. The settings panel also includes a pet size slider (50%–200%) that scales only the pet model — bubbles and dialogs keep their size — persists the choice, and offers a one-click reset.
- On import failure, incomplete assets, or missing WebGL, the current renderer (or default PNG) stays active and the plugin never fails to start. You can return to default and re-import in the same page; each Live2D mount gets its own canvas so it never reuses a WebGL context destroyed by PIXI.
- The official Cubism Core is served locally by the plugin via a same-origin route, so the runtime does not depend on an external CDN. The PIXI/Live2D renderer loads only when Live2D is actually used.
- ZIP extraction and validation run in a dedicated Worker, and the Live2D ticker pauses while the page is hidden. URL imports allow at most 256 assets, 32 MiB per file, 128 MiB total, and four concurrent requests. A newer import or widget unmount aborts obsolete URL downloads and terminates the old ZIP Worker.
- The recent-model library keeps up to five models including the active one. Importing or switching moves a model to the front; settings provide one-click switching, returning to default preserves history, each item can be permanently deleted, and a sixth model evicts the least recently used assets.
- IndexedDB keeps the active ID and MRU order in a small atomic manifest while storing each model's assets separately; the former single-model `active` record migrates automatically.

### Secure desktop-companion pairing

- The `⚙️` settings dialog has a “desktop companion” section that creates an independent PowerShell/Rust token per device. Plaintext is shown once; the host stores only a verifier.
- Grants can be revoked individually. Companion data routes require a loopback peer, trusted Host/Origin headers, and `Authorization: Bearer …`.
- PowerShell protects its token with CurrentUser DPAPI; Rust uses Windows Credential Manager. Never put a token in a URL, query string, log, or screenshot.

> Only import models you are entitled to use. The independent Cubism Core license and source are documented in [ASSET_NOTICE.md](ASSET_NOTICE.md).

### Balance and spend (merged page)

- Host-side balance lookup via `DEEPSEEK_API_KEY`; credentials never reach the browser.
- Balance and today/seven-day spend share one page; amounts are strictly accumulated from account balance decreases.
- Top-ups or grants update the baseline and never reduce accumulated spend; the first successful read establishes a zero-spend baseline.

### OpenCode Go plan quota

- Dedicated page for rolling 5-hour, 7-day, and monthly windows with used, remaining, status, and reset time.
- Credentials resolve from `OPENCODE_GO_API_KEY` first, then the opencode CLI login file `~/.local/share/opencode/auth.json` (`opencode-go.key`); keys stay on the host.
- The host applies a 30-second cache with concurrent coalescing and falls back to the last successful snapshot.

### Tasks and completion dialog

- Up to ten running sessions surface; subagent rows nest under their parent task family and auto-scroll past five rows.
- `approval/asked` turns the status dot yellow; `approval/decided` clears it immediately.
- The completion dialog splits the latest conversation and full-session totals, pricing each message with its actual model and time.

### Whale-chan and refresh

- Draggable pet with saved position, click-to-cycle pages, theme adaptation, peak/off-peak badge, and top-up link.
- Balance/spend refresh every 60 seconds; task progress refreshes more often; OpenCode Go refreshes every 60 seconds while open.

## Install

Requirements: Node.js 24+, a working DSH CLI, and `pnpm` on `PATH`.

### Release installation

Download the `dsh-whale-pet-<version>.tgz` actually listed on [GitHub Releases](https://github.com/ali8772/dsh-web-gui/releases), verify its checksum, then install it:

```sh
dsh plugin --profile web add ./dsh-whale-pet-<version>.tgz
```

GitHub `main` is currently ahead of the tagged releases; do not assume the repository's `0.4.1` package has been published on Releases. To test current source, run `npm ci && npm run pack:plugin` in a trusted checkout and install the generated `.tgz`.

Restart `dsh web`, then refresh the browser. Do not add a second insertion to the profile patch; the packaged bundle activates itself. See [docs/INSTALL.md](docs/INSTALL.md) for upgrades, removal, and verification.

## Host routes

| Path | Purpose |
|---|---|
| `GET /api/whale-pet/health` | Health probe returning `{ plugin, version, ok }` |
| `GET /api/whale-pet/state` | Balance plus today/seven-day spend and call counts; DSH browser-authenticated |
| `POST /api/whale-pet/tasks` | Live task progress and awaiting-user state; up to 32 unique session IDs |
| `POST /api/whale-pet/task-summary` | Per-session token and cost summary, priced per model |
| `GET /api/whale-pet/opencode-go` | OpenCode Go plan quota |
| `GET/POST /api/whale-pet/companions*` | Browser-authenticated grant list, issue, and revoke operations |
| `/dsh-whale-pet/companion/v1/*` | Loopback + Bearer state/tasks/task-summary/opencode-go companion routes |
| `GET /dsh-whale-pet-live2dcubismcore.min.js` | Local Cubism Core runtime, loaded only when Live2D is used |
| `GET /dsh-whale-pet-live2d.js` | Dynamic PIXI/Live2D renderer |
| `GET /dsh-whale-pet-live2d-zip-worker.js` | ZIP extraction and model-validation Worker |

## Data and privacy

- Credentials always stay on the host; no route returns a raw key.
- The balance ledger at `$DSH_HOME/whale-pet/balance-spend.json` stores only currency, the last observed balance, and per-day accumulated decreases.
- Session logs are used only for call counts, task progress, and per-model pricing.
- Imported Live2D models stay in the current browser's IndexedDB and are not uploaded to the plugin host or third parties. During URL import the browser fetches directly from the model server you enter.
- ZIP extraction is limited to 2,048 files and 256 MiB uncompressed, and rejects absolute URLs/paths and references escaping the archive root; URL imports have separate 256-file/32-MiB-per-file/128-MiB-total budgets.
- Private browser routes apply the DSH Host/Origin and browser-session checks plus a 64 KiB body cap. A corrupt session log is isolated to one batch row rather than failing healthy rows.
- A companion token appears in plaintext only in its issue response; DSH credentials store a verifier, and the browser never persists the token.

Never commit credentials, profile files, session logs, real account screenshots, or Live2D models you are not entitled to distribute.

## Verify

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
# Private state/task routes require the authenticated DSH browser; bare curl should get 401
```

Expected:

```json
{"plugin":"dsh-whale-pet","version":"0.4.1","ok":true}
```

## Windows companions

`windows/` is an experimental PowerShell/WPF companion and `windows-rust/` is an independent Rust experiment; neither is part of the DSH bundle or shipped in the plugin package. Create a per-device companion grant in Web settings, then import its token once as described in each README.

## Development

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run check
npm run check:size
npm run audit:prod
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/RELEASE.md](docs/RELEASE.md), and [ASSET_NOTICE.md](ASSET_NOTICE.md).

## License

Project code is [MIT](LICENSE). Artwork, the separate Live2D Cubism Core license, and trademark notices are in [ASSET_NOTICE.md](ASSET_NOTICE.md). This project is not affiliated with or endorsed by DeepSeek or Live2D Inc.