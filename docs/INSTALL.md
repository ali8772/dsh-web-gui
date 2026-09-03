# Installation

## Requirements

- DeepSeek Harness with the `web` profile.
- Node.js 20+ and `pnpm` on `PATH`.
- A trusted `dsh-whale-pet-0.4.0.tgz` release artifact.

## Install

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.4.0.tgz
```

Restart the running `dsh web` process because bundle membership changes at profile startup, then refresh the browser. Do not manually insert a second `dsh-whale-pet` row into the profile patch.

## Credentials

Configure through DSH credentials, never source files:

- `DEEPSEEK_API_KEY` for balance and balance-change spend accounting.
- `OPENCODE_GO_API_KEY` (optional) for OpenCode Go quota; falls back to the opencode CLI login file.

The first successful balance read establishes a baseline. Later decreases are persisted in `$DSH_HOME/whale-pet/balance-spend.json`; increases update the baseline without reducing accumulated spend. Session logs are used only for call counts and task progress.

## Live2D

Open the pet's `⚙️` settings to import a Cubism 3/4/5 `.model3.json` via ZIP or URL (the server must allow CORS). The model is stored in the browser's IndexedDB and restores after refresh. The official Cubism Core is already bundled and served locally, so no network runtime is required. Only import models you have rights to use; details in `ASSET_NOTICE.md`.

## Verify

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
curl http://127.0.0.1:3080/api/whale-pet/state
```

Health must report `dsh-whale-pet`, `0.4.0`, and `ok: true`.

## Upgrade

Run the `add` command with the new tarball, restart `dsh web`, refresh, and verify health.

## Remove

```sh
dsh plugin --profile web remove dsh-whale-pet
```

Restart and refresh. Browser localStorage may retain `dsh-whale-pet:pos`; removing it is optional.

## Windows companions

The PowerShell/WPF and Rust companions are excluded from the tarball. Obtain trusted repository source, review each README, and audit PowerShell execution-policy implications before running them.