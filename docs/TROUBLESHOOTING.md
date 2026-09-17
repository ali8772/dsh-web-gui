# Troubleshooting

## Whale-chan does not appear

1. Check `/api/whale-pet/health`.
2. Confirm the package is installed in the web profile.
3. Restart `dsh web` and refresh the browser.
4. Ensure the plugin is inserted exactly once; zero entries do not load it and duplicates may fail startup.

## `dsh plugin` cannot run

The command requires `pnpm` on `PATH`. Configure pnpm and rerun from the tarball directory.

## Balance is unavailable

Configure a valid `DEEPSEEK_API_KEY` through DSH credentials and check network access. Never paste keys into reports. Direct unauthenticated requests to `/api/whale-pet/state` now intentionally return `401`; inspect data from the authenticated DSH page, not a bare curl.

## Browser data routes return 401/403

Refresh the authenticated DSH GUI and confirm its Host/Origin matches the running local server. Do not disable the trust fence and do not pass browser cookies or companion tokens in query parameters. Health and immutable JavaScript assets remain public; account/session data does not.

## Desktop companion says pairing is required

1. In the authenticated Web pet settings, generate a fresh grant for that device.
2. Import it once with `DSH_WHALE_PET_COMPANION_TOKEN` as documented in the companion README, then clear that environment variable.
3. Keep the base URL loopback (`127.0.0.1`, `localhost`, or `[::1]`); remote/proxied sockets are rejected even if the Host header is forged.
4. If the token was revoked or the protected store is corrupt, delete the local stored token and pair again. Never paste a token into an issue.

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

## A recent Live2D model disappeared

The library intentionally retains at most five models including the active one. Importing a sixth model permanently evicts the least recently used model and its IndexedDB assets. Switching a model moves it to the front. “恢复默认鲸鱼娘” preserves history; the `×` button on a model row permanently deletes it after confirmation.

## Upgrade still reports an old version

Restart the web profile, hard-refresh the browser, verify health, and inspect the resolved profile dependency. GitHub `main` may be ahead of tagged Releases while retaining the same package version during development; compare the installed source/commit and do not infer feature availability from `0.4.1` alone.

## Live2D does not render after import

1. Check the settings dialog status: import, Core loading, or renderer errors are shown there.
2. Confirm the ZIP contains one `.model3.json` and all referenced files (`.moc3`, textures, physics, motions), and that entries are not duplicate or path-escaped.
3. For URL import, the server must allow browser CORS on the JSON and all assets; otherwise fetches are blocked. Imports over 256 files, 32 MiB per file, or 128 MiB total are intentionally rejected.
4. ZIP parsing now runs in a module Worker. A 404 for `/dsh-whale-pet-live2d-zip-worker.js` means the installed package/build is incomplete; rebuild/reinstall and restart the Web profile.
5. Headless/software environments without WebGL keep the default PNG; a GPU-enabled browser is required for Live2D rendering.
6. Clicking the model plays hit-area motions (`TapBody` by default); small models may not declare hit areas.
7. If an older `0.4.0` client reports `Invalid value of \`0\` passed to \`checkMaxIfStatementsInShader\`` after removing and re-importing a model, upgrade to `0.4.1` and refresh. `0.4.1` gives every renderer a fresh canvas instead of reusing a PIXI-destroyed WebGL context.

## Live2D model disappears after refresh

The active model restores from the IndexedDB library manifest and its separate `model:<id>` record. Open settings and try another recent-model button; permanently delete a damaged row with `×`, or clear browser storage for the site if the manifest itself is stale. “恢复默认鲸鱼娘” intentionally keeps recent models. The obsolete localStorage pointer and legacy single-model `active` record are no longer used after automatic migration.

## Safe issue reports

Include versions, OS/browser, reproduction steps, sanitized endpoint status, and errors. Remove credentials, session text, financial values, usernames, and personal paths.
