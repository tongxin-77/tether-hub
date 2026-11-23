# Changelog

English edition of [CHANGELOG.md](CHANGELOG.md) (Simplified Chinese), kept version-for-version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Versions before 0.5.0 are summarized briefly; see the Chinese changelog for full details.

## [0.5.1] - 2026-11-19

### 🐛 Fixed

- **The mobile top bar navigation no longer wraps onto two lines**
  - On phones the navigation tabs read “Machines” and “Audit”; desktop is unchanged

## [0.5.0] - 2026-11-19

### ✨ Added

- **Create sessions on a machine from the web** (requires Tether 0.5.6)
  - Supports local sessions (optional directory), SSH sessions (choose a host), and resuming past Claude conversations
  - The new session opens in the web page right away
  - The machine must allow hub remote takeover; new endpoints `GET /api/create-options`, `GET /api/claude-history`, `POST /api/session/create`; audit records `create` / `create_failed`
- **Text view on mobile: long-press to select and copy, scroll for long screenshots**
  - The “Text” button in the takeover terminal title bar shows all terminal output as plain text
  - “Copy all” is supported, and system scrolling / full-page screenshots capture the whole content

### 🔧 Changed

- **Images are compressed automatically before upload**
  - Images whose long edge exceeds 2000px are scaled down and phone photos are converted to JPEG, so uploads are faster and less likely to hit the size limit
  - Small PNG screenshots are uploaded as-is to keep text crisp; HEIC and similar formats are converted automatically
- **Pasting images on phones is easier**
  - Long-press to paste an image in the “Paste” sheet
  - The “Image” key can pick several images at once and uploads them in turn

## [0.4.0] - 2026-11-15

### Added

- Takeover scrollback (loads up to 3000 lines of saved history), pasting images into local sessions, a “Paste” key on mobile, tapping numbered Claude Code options on touch screens, and closing sessions from the web; protocol capability bits (`caps`). Requires Tether 0.5.0+.

### Changed

- Session status “Waiting” renamed to “Unread”; Claude status “Subagent running” renamed to “Running in background”.

## [0.3.0] - 2026-11-15

### Added

- Manage machine tokens from the web, a Windows installer that runs the hub as a service, one-click updates via per-platform packages verified with `SHA256SUMS`, a GitHub Actions release pipeline, and touch scrolling plus a shortcut key bar for the mobile terminal.

## [0.2.0] - 2026-11-15

### Added

- Update checks against GitHub Releases and one-click updates from the web page with automatic rollback on failure.

## [0.1.0] - 2026-11-15

First release, for Tether 0.4.0 and later (daemon ↔ hub protocol v2).

### Added

- Machine connections with per-machine tokens, a live session overview, remote takeover in the browser, an audit log, and a web admin UI with light / dark themes and a mobile layout.

[0.5.1]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.5.1
[0.5.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.5.0
[0.4.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.4.0
[0.3.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.3.0
[0.2.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.2.0
[0.1.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.1.0
