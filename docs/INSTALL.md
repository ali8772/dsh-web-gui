# Installation

## Requirements

- DeepSeek Harness with the `web` profile.
- Node.js 24+ and `pnpm` on `PATH`.
- A trusted `dsh-whale-pet-0.4.1.tgz` release artifact.

## Install

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.4.1.tgz
```

Restart the running `dsh web` process because bundle membership changes at profile startup, then refresh the browser. Do not manually insert a second `dsh-whale-pet` row into the profile patch.

## Credentials

Configure through DSH credentials, never source files:

- `DEEPSEEK_API_KEY` for balance and balance-change spend accounting.
- `OPENCODE_GO_API_KEY` (optional) for OpenCode Go quota; falls back to the opencode CLI login file.

The first successful balance read establishes a baseline. Later decreases are persisted in `$DSH_HOME/whale-pet/balance-spend.json`; increases update the baseline without reducing accumulated spend. Session logs are used only for call counts and task progress. Private `/api/whale-pet/*` data requires the authenticated DSH browser session, so an unauthenticated `curl` state probe should return `401` rather than data.

## Pair a Windows companion

1. Open the pet's `⚙️` settings in an authenticated DSH browser.
2. Under **桌面伴侣配对**, enter a device label and choose **生成令牌**.
3. Confirm the warning and copy the `wpg1.…` token immediately; plaintext is shown once.
4. Follow `windows/README.md` or `windows-rust/README.md` to import it into OS-protected storage.
5. Return to the same settings section to revoke that device when rotating or retiring it.

Never place the token in a URL, query string, JSON state file, issue report, screenshot, or shell history. Create a separate grant for each device.

## Live2D

Open the pet's `⚙️` settings to import a Cubism 3/4/5 `.model3.json` via ZIP or URL (the server must allow CORS). The model is stored in the browser's IndexedDB and restores after refresh. The official Cubism Core is already bundled and served locally, so no network runtime is required. Only import models you have rights to use; details in `ASSET_NOTICE.md`.

## Verify

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
curl -i http://127.0.0.1:3080/api/whale-pet/state # expected 401 without browser auth
```

Health must report `dsh-whale-pet`, `0.4.1`, and `ok: true`; the unauthenticated private request must not expose data.

## Upgrade

Run the `add` command with the new tarball, restart `dsh web`, refresh, and verify health.

## Remove

```sh
dsh plugin --profile web remove dsh-whale-pet
```

Restart and refresh. Browser localStorage may retain `dsh-whale-pet:pos` and `dsh-whale-pet:scale`; removing them is optional. Imported model data remains in the site's IndexedDB until removed from settings or browser storage. Revoke companion grants before uninstalling if their credentials might be reused later.

## Windows companions

The PowerShell/WPF and Rust companions are excluded from the tarball. Obtain trusted repository source, review each README, and audit PowerShell execution-policy implications before running them.