# dsh-whale-pet 🐳

[中文](README.md) · [Installation](docs/INSTALL.md) · [Architecture](docs/ARCHITECTURE.md) · [Changelog](CHANGELOG.md)

`dsh-whale-pet` is a Whale-chan overlay plugin for the DeepSeek Harness Web GUI. It displays account balance and spend, OpenCode Go plan quota (rolling 5-hour / 7-day / monthly windows with used and remaining), and live progress plus per-model completion summary for running sessions.

![Sanitized Whale-chan demo in DSH Web GUI](docs/images/whale-chan-demo.png)

> The screenshot uses fixed example data (balance ¥88.88) and contains no real account information.

## v0.3.0 highlights

### Balance and spend (merged page)
- Host-side balance lookup using `DEEPSEEK_API_KEY`; credentials are never exposed to browser code.
- Balance and today/seven-day spend now share a single page: the title shows the balance amount with the peak/off-peak badge, and the panel below shows `今日消费` / `近 7 天消费` (today and seven-day spend) with their amount and call counts.
- Today and seven Beijing-calendar-day spend are strictly accumulated from account balance decreases. Top-ups or grants update the baseline and never reduce accumulated spend.
- The first successful balance read establishes a baseline and records no spend. Later successful refreshes attribute each balance decrease to the current Beijing date.

### OpenCode Go plan quota
- Dedicated page that calls the official gateway `https://opencode.ai/zen/go/v1/usage` for the rolling 5-hour, 7-day, and monthly windows.
- Each row shows used percentage, remaining percentage (=100 − used), status, and reset time.
- Credentials are resolved from the `OPENCODE_GO_API_KEY` environment variable first and fall back to the opencode CLI login file at `~/.local/share/opencode/auth.json` (`opencode-go.key`). The API key never leaves the host; the browser only hits a same-origin proxy route.
- The host applies a 30-second cache with concurrent coalescing, and falls back to the last successful snapshot with a "temporarily unable to refresh" hint on failure.

### Tasks and completion dialog
- Up to ten running sessions are surfaced; subagent rows nest visually under their parent task family rather than appearing as siblings.
- Click a row to open the corresponding session; the list auto-scrolls when it exceeds five rows. Each row shows todo progress, stage (thinking / tool / idle), current tool, turn, and step.
- `approval/asked` turns the status dot yellow to signal awaiting user action; `approval/decided` clears the yellow indicator immediately.
- When a task finishes, a dialog reports token counts and estimated cost split between the latest conversation and the full session, with per-model breakdowns so mixed-model usage is priced using each model's own rate.

### Whale-chan and interactions
- Draggable animated Whale-chan with saved position, click-to-cycle pages, theme adaptation, peak/off-peak status, top-up link, and OpenCode Go quota page.

### Refresh cadence
- Balance and spend refresh every 60 seconds; task progress refreshes more frequently; the OpenCode Go quota page fetches on entry and every 60 seconds while it is open.

## Install

Requirements: Node.js 20+, a working DSH CLI, and `pnpm` on `PATH`.

Download `dsh-whale-pet-0.3.0.tgz` from [Releases](https://github.com/ali8772/dsh-web-gui/releases), then run:

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.3.0.tgz
```

Restart `dsh web`, then refresh the browser. Do not manually add another plugin insertion to the profile patch; the packaged bundle activates itself. See [docs/INSTALL.md](docs/INSTALL.md) for upgrades, removal, and verification.

## Host routes

| Path | Purpose |
|---|---|
| `GET /api/whale-pet/health` | Health probe returning `{ plugin, version, ok }` |
| `GET /api/whale-pet/state` | Balance plus today/seven-day spend and call counts |
| `POST /api/whale-pet/tasks` | Live task progress (todo / tool / turn / step + awaiting-user flag) |
| `POST /api/whale-pet/task-summary` | Per-session token and cost summary, priced per model |
| `GET /api/whale-pet/opencode-go` | OpenCode Go plan quota (5-hour / 7-day / monthly windows) |

## Data and privacy

Credentials stay on the host. The balance ledger is stored at `$DSH_HOME/whale-pet/balance-spend.json` and contains only currency, the last observed balance, and per-day accumulated decreases—never an API key. Session logs are used only for call counts, task progress, and per-model pricing, not for spend amounts. The browser only reaches the local DSH Web server on `127.0.0.1`, and no route returns a raw credential. Never commit credentials, profile files, session logs, or real account screenshots; the repository `.gitignore` already excludes them.

## Windows companion

The repository includes an experimental PowerShell 5.1/WPF companion under `windows/`. It is source-only and excluded from the plugin tarball. Review the scripts before running them and never hard-code credentials.

## Development

```sh
npm ci
npm run build
npm test
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASE.md](docs/RELEASE.md) for the full process.

## License

Code is [MIT](LICENSE). See [ASSET_NOTICE.md](ASSET_NOTICE.md) for artwork and trademark notices. This project is not affiliated with or endorsed by DeepSeek.
