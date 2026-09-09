# Contributing

Thanks for contributing to `dsh-whale-pet`.

## Safety

Never commit API keys, platform tokens, DSH profile files, credential stores, session logs, authenticated cookies, real account screenshots, usernames, or personal absolute paths. Keep all secrets on the host side.

## Development

Requirements: Node.js 24+, npm, DSH, and pnpm for profile management.

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run check
npm run check:size
npm run audit:prod
npm pack --dry-run
```

Build scripts must be portable. Do not add machine-specific dependency paths. Local browser E2E tests require a running authenticated DSH GUI and are intentionally excluded from the public repository; run equivalent tests only in a disposable local environment.

## Test checklist

- Health, state, and tasks API success/failure paths.
- Missing credentials without leaks.
- First balance baseline, later decreases, top-ups/grants, restart persistence, and Beijing day rollover.
- Balance/spend/task switching, dragging, themes, resize clamping, scrolling, and session opening.
- Browser authentication/Host-Origin rejection and loopback Bearer pairing issue/use/revoke without token leakage.
- Request size/count limits and per-row isolation for corrupt session logs.
- Poll coalescing/disposal, bounded session projections, and cache budgets.
- Keyboard task operation, modal focus/Escape/return, ARIA announcements, and reduced-motion behavior.
- ZIP Worker transfer, atomic IndexedDB replacement/removal, URL resource budgets, and hidden-page ticker pause.
- Exact `npm pack --dry-run` contents, bundle budgets, and canonical production audit policy.
- Chinese and English docs for user-visible changes.

## Pull requests

Explain motivation, behavior, tests, privacy/security impact, and package impact. Add sanitized visuals for UI changes. Contributions are accepted under the MIT license.
