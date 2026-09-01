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

## Spend remains zero after upgrade

The first successful v0.2.2 balance read establishes a baseline and intentionally records no spend. Later balance decreases are accumulated after each successful refresh. Pre-upgrade changes cannot be reconstructed.

## Spend is assigned to an unexpected day

A decrease is assigned to the Beijing calendar day when the later balance observation occurs. If the host was offline across midnight, usage since the previous observation is attributed to that later day.

## Reset balance history

Stop `dsh web`, remove `$DSH_HOME/whale-pet/balance-spend.json`, then restart. The next successful balance read creates a new zero-spend baseline.

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
