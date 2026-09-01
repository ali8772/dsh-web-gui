# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

## [0.2.1] - 2026-08-31

### Fixed
- Calculate today and seven-day spend from persisted account balance decreases instead of token pricing or platform usage data.
- Treat top-ups and grants as baseline increases so they never erase accumulated spend.
- Persist the balance baseline and Beijing-calendar daily totals across host restarts.

### Changed
- The spend source badge now reads `余额变化`.
- Session logs supply call counts and task progress only; they no longer determine spend amounts.
- The first successful balance read establishes a zero-spend baseline.

### Tests
- Added a deterministic state-route regression covering balance decreases, top-ups, persistence across host reloads, and Beijing day boundaries.

## [0.2.0] - 2026-08-31

### Added
- Whale-chan image overlay with transparent artwork and floating/drag animation.
- Live task-progress page derived from todo, tool, turn, and step events.
- Up to ten running tasks, five-row viewport, automatic scrolling, and session navigation.
- Combined today/seven-day spend panel, Beijing peak/off-peak badge, adaptive presentation, and top-up link.
- `POST /api/whale-pet/tasks` host endpoint.
- Source-only Windows PowerShell/WPF companion.
- Bilingual documentation, portable build, package audit, and GitHub release automation.

### Changed
- Display modes are balance, combined spend, and conditional task progress.
- Standard DSH bundle installation now activates the plugin directly.
- Release version synchronized at `0.2.0`.

### Security
- Credentials remain host-side and are not returned to browser code.
- Local-auth E2E tests, real account screenshots, session data, and local credentials are excluded from Git and release packages.

## [0.1.1]

### Added
- Initial draggable pet with balance, today spend, seven-day spend, and local estimation.

[Unreleased]: https://github.com/ali8772/dsh-web-gui/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/ali8772/dsh-web-gui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ali8772/dsh-web-gui/releases/tag/v0.2.0
