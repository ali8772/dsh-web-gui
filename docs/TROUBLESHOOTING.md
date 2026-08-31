# Troubleshooting

## Whale-chan does not appear

1. Check `/api/whale-pet/health`.
2. Confirm the package is installed in the web profile.
3. Restart `dsh web` and refresh the browser.
4. Ensure the plugin is inserted exactly once; zero entries do not load it and duplicates may fail startup.

## `dsh plugin` cannot run

The command requires `pnpm` on `PATH`. Configure pnpm and rerun from the tarball directory.

## Balance is unavailable

Configure a valid `DEEPSEEK_API_KEY` through DSH credentials and check network access. Never paste keys into reports.

## Spend shows “本地估算”

This is expected when the optional platform source is unavailable. Estimates include only readable DSH calls and may differ from billing.

## Task page is missing

It appears only while a session is marked running. Sessions without todo events may show activity without a percentage. Missing or unreadable logs reduce detail.

## Data is stale

Balance/spend refresh every 60 seconds and host caches are similar. Retry after a minute; inspect sanitized host errors if failures persist.

## Position is wrong

Remove localStorage key `dsh-whale-pet:pos` and refresh.

## Upgrade still reports an old version

Restart the web profile, hard-refresh the browser, verify health, and inspect the resolved profile dependency.

## Safe issue reports

Include versions, OS/browser, reproduction steps, sanitized endpoint status, and errors. Remove credentials, session text, financial values, usernames, and personal paths.
