# Installation

## Requirements

- DeepSeek Harness with the `web` profile.
- Node.js 20+ and `pnpm` on `PATH`.
- A trusted `dsh-whale-pet-0.2.0.tgz` release artifact.

## Install

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.2.0.tgz
```

Restart the running `dsh web` process because bundle membership changes at profile startup, then refresh the browser. Do not manually insert a second `dsh-whale-pet` row into the profile patch.

## Credentials

Configure through DSH credentials, never source files:

- `DEEPSEEK_API_KEY` for balance.
- Optional `DEEPSEEK_PLATFORM_TOKEN` for the platform spend source.

Without the platform token, spend is estimated from local DSH session logs.

## Verify

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
curl http://127.0.0.1:3080/api/whale-pet/state
```

Health must report `dsh-whale-pet`, `0.2.0`, and `ok: true`.

## Upgrade

Run the `add` command with the new tarball, restart `dsh web`, refresh, and verify health.

## Remove

```sh
dsh plugin --profile web remove dsh-whale-pet
```

Restart and refresh. Browser localStorage may retain `dsh-whale-pet:pos`; removing it is optional.

## Windows companion

The WPF companion is excluded from the tarball. Obtain trusted repository source, review `windows/README.md`, and audit PowerShell execution-policy implications before running it.
