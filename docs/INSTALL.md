# Installation

## Requirements

- DeepSeek Harness with the `web` profile.
- Node.js 20+ and `pnpm` on `PATH`.
- A trusted `dsh-whale-pet-0.2.1.tgz` release artifact.

## Install

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.2.1.tgz
```

Restart the running `dsh web` process because bundle membership changes at profile startup, then refresh the browser. Do not manually insert a second `dsh-whale-pet` row into the profile patch.

## Credentials

Configure through DSH credentials, never source files:

- `DEEPSEEK_API_KEY` for balance and balance-change spend accounting.

The first successful balance read establishes a baseline. Later decreases are persisted in `$DSH_HOME/whale-pet/balance-spend.json`; increases update the baseline without reducing accumulated spend. Session logs are used only for call counts and task progress.

## Verify

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
curl http://127.0.0.1:3080/api/whale-pet/state
```

Health must report `dsh-whale-pet`, `0.2.1`, and `ok: true`.

## Upgrade

Run the `add` command with the new tarball, restart `dsh web`, refresh, and verify health.

## Remove

```sh
dsh plugin --profile web remove dsh-whale-pet
```

Restart and refresh. Browser localStorage may retain `dsh-whale-pet:pos`; removing it is optional.

## Windows companion

The WPF companion is excluded from the tarball. Obtain trusted repository source, review `windows/README.md`, and audit PowerShell execution-policy implications before running it.
