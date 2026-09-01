# Release process

## Prepare

1. Move changelog entries from Unreleased and set the release date.
2. Synchronize `package.json`, `dsh.plugin.json`, and host health version.
3. Confirm `cordis.patch.yml` inserts `dsh-whale-pet` exactly once.
4. Run a secret/path scan and verify ignored local E2Es, screenshots, sessions, credentials, and Windows intermediates are not tracked.
5. Install and validate:

```sh
npm ci
npm run build
npm test
npm run check
```

## Audit package

```sh
npm pack --dry-run
npm pack
sha256sum dsh-whale-pet-*.tgz
```

The tarball must contain only runtime host/client bundles, manifests, bundle patch, README files, asset notice, and license. It must exclude maps, source, Windows tooling, E2Es, screenshots, credentials, session logs, and personal paths.

## Smoke test

Install the generated artifact with the documented DSH command in a disposable profile. Restart, refresh, and test APIs, rendering, first balance baseline, later balance decrease, top-up handling, tasks, navigation, drag persistence, and themes. Remove it afterward.

## GitHub release

Create and push the version tag (for this fix, `v0.2.1`). GitHub Actions builds from a clean checkout, runs tests, checks package contents, creates the tarball and SHA-256 file, and uploads them to the GitHub Release. Do not move tags or silently replace artifacts.

## Rollback

Remove the faulty version, reinstall the last known-good tarball, restart the profile, and publish a patch release.
