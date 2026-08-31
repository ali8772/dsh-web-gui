# Contributing

Thanks for contributing to `dsh-whale-pet`.

## Safety

Never commit API keys, platform tokens, DSH profile files, credential stores, session logs, authenticated cookies, real account screenshots, usernames, or personal absolute paths. Keep all secrets on the host side.

## Development

Requirements: Node.js 20+, npm, DSH, and pnpm for profile management.

```sh
npm ci
npm run build
npm run check
npm pack --dry-run
```

Build scripts must be portable. Do not add machine-specific dependency paths. Local browser E2E tests require a running authenticated DSH GUI and are intentionally excluded from the public repository; run equivalent tests only in a disposable local environment.

## Test checklist

- Health, state, and tasks API success/failure paths.
- Missing credentials without leaks.
- Official spend and local-estimate fallback.
- Balance/spend/task switching, dragging, themes, resize clamping, scrolling, and session opening.
- Exact `npm pack --dry-run` contents.
- Chinese and English docs for user-visible changes.

## Pull requests

Explain motivation, behavior, tests, privacy/security impact, and package impact. Add sanitized visuals for UI changes. Contributions are accepted under the MIT license.
