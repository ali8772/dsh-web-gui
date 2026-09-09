# Release process

## Prepare

1. Move changelog entries from Unreleased and set the release date.
2. Synchronize `package.json`, `dsh.plugin.json`, and host health version.
3. Confirm `cordis.patch.yml` inserts `dsh-whale-pet` exactly once.
4. Verify vendor/local runtime checksum matches `ASSET_NOTICE.md` and its license is current.
5. Run a secret/path scan and verify ignored local E2Es, screenshots, sessions, credentials, companion tokens, local model fixtures, and Windows intermediates are not tracked.
6. If Rust dependencies changed, regenerate and review `windows-rust/Cargo.lock`, then run `cargo fmt --check`, `cargo check --locked`, `cargo test --locked`, and `cargo clippy --locked -- -D warnings` on a supported toolchain.
7. Install and validate:

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run check
npm run check:size
npm run audit:prod
```

## Audit package

```sh
npm pack --dry-run
npm pack
sha256sum dsh-whale-pet-*.tgz
```

The tarball must contain only runtime host/client bundles (including `lib/live2d-zip-worker.js`), manifests, bundle patch, README files, asset notice, and license. It must exclude maps, source, Windows tooling, E2Es, screenshots, credentials, companion-token files, session logs, and personal paths. `check:size` enforces reviewed uncompressed budgets for every JS artifact. `audit:prod` uses the canonical npm registry, fails new advisories, and temporarily allows only GHSA-8mmm-9v2q-x3f9: `pixi-live2d-display@0.4.0` incorrectly declares the unused publishing tool `gh-pages@4` as a runtime dependency. Remove the exception when upstream resolves it; never use `npm audit fix --force` to downgrade the renderer.

## Smoke test

Install the generated artifact with the documented DSH command in a disposable profile. Restart and refresh the existing DSH Web URL; do not validate against a replacement server. Test browser authentication rejection, malformed/oversized requests, balance baseline/decrease/top-up handling, task batch isolation, navigation, keyboard task activation, modal focus/Escape behavior, ARIA announcements, reduced motion, companion issue/use/revoke for both clients, themes, ZIP Worker import, bounded URL import, hidden-page ticker pause, pointer focus, click motion, refresh restore, and removal fallback. Remove it afterward.

## GitHub release

Create and push the version tag for the intended release (for this fix, `v0.4.1`). GitHub Actions builds from a clean checkout, runs tests, checks package contents, creates the tarball and SHA-256 file, and uploads them to the GitHub Release. Do not move tags or silently replace artifacts.

## Rollback

Remove the faulty version, reinstall the last known-good tarball, restart the profile, and publish a patch release.
