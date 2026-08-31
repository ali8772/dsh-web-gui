# dsh-whale-pet 🐳

[中文](README.md) · [Installation](docs/INSTALL.md) · [Architecture](docs/ARCHITECTURE.md) · [Changelog](CHANGELOG.md)

`dsh-whale-pet` is a Whale-chan overlay plugin for the DeepSeek Harness Web GUI. It displays account balance, today/seven-day spend, and live progress for running sessions.

![Sanitized Whale-chan demo in DSH Web GUI](docs/images/whale-chan-demo.png)

> The screenshot uses fixed example data (balance ¥88.88) and contains no real account information.

## v0.2.0 highlights

- Host-side balance lookup using `DEEPSEEK_API_KEY`; credentials are never exposed to browser code.
- Today and seven Beijing-calendar-day spend on one page, with optional platform data and local session-log estimation fallback.
- Up to ten running sessions, five visible rows, five-second scrolling, real todo/tool/turn/step activity, and click-through to the session.
- Draggable animated Whale-chan with saved position, click-to-cycle pages, theme adaptation, peak/off-peak status, and a top-up link.
- Balance/spend refresh every 60 seconds; tasks refresh more frequently.

> Local estimates cover only calls represented in readable DSH logs and are not billing records.

## Install

Requirements: Node.js 20+, a working DSH CLI, and `pnpm` on `PATH`.

Download `dsh-whale-pet-0.2.0.tgz` from [Releases](https://github.com/ali8772/dsh-web-gui/releases), then run:

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.2.0.tgz
```

Restart `dsh web`, then refresh the browser. Do not manually add another plugin insertion to the profile patch; the packaged bundle activates itself. See [docs/INSTALL.md](docs/INSTALL.md) for upgrades, removal, and verification.

## Data and privacy

Credentials stay on the host. An optional `DEEPSEEK_PLATFORM_TOKEN` may supply spend data; otherwise the host reads local DSH session logs for estimates and progress. Use the local API only in a trusted DSH environment and never commit credentials, profile files, session logs, or real account screenshots.

## Windows companion

The repository includes an experimental PowerShell 5.1/WPF companion under `windows/`. It is source-only and excluded from the plugin tarball. Review the scripts before running them and never hard-code credentials.

## Development

```sh
npm ci
npm run build
npm run check
npm pack --dry-run
```

## License

Code is [MIT](LICENSE). See [ASSET_NOTICE.md](ASSET_NOTICE.md) for artwork and trademark notices. This project is not affiliated with or endorsed by DeepSeek.
