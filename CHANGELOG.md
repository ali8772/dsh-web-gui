# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/ali8772/dsh-web-gui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ali8772/dsh-web-gui/releases/tag/v0.2.0
