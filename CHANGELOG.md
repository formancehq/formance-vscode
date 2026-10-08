# Changelog

All notable changes to this extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0]

### Added

- Windows support for the language server download.
- SHA-256 verification of the downloaded language server against the release checksums.
- `Numscript: Download or update language server` command.
- "Numscript" output channel with the extension logs.
- Highlighting for `oneof`, `with scaling through`, `#![feature(...)]`, `/* */` comments, the `\` asset restriction, variable account segments (`@users:$id`) and the `overdraft`, `get_asset`, `get_amount` and `scoped` functions.
- `save` snippet.
- Toggle block comment (`/* */`). Single quotes, which Numscript does not use, are no longer auto-closed.
- Releases are published to Open VSX, for VSCodium, Cursor and other VS Code forks.

### Changed

- Requires VS Code 1.94 or later, the first version whose extension `fetch` uses the VS Code proxy settings.
- The extension is bundled with esbuild: the package shrinks from 407 KB to 117 KB.
- The extension starts the installed language server immediately and checks for updates in the background, instead of blocking until the GitHub check and the download prompt complete.
- The language server starts even when GitHub is unreachable, if a version is already installed.
- `numscript.server-path` can only be set in user or remote settings, not in workspace settings, so that a repository cannot make the extension run an arbitrary binary.
- Changing `numscript.server-path` restarts the language server.
- A new language server version is kept only if it starts; otherwise the previous version stays in use.
- A language server that does not answer within 30 seconds is stopped instead of blocking the extension.

### Removed

- The unused `Numscript: hello world` command.

### Fixed

- Download progress now reaches 100%.
- The language server is stopped when the extension is deactivated, and restarting never leaves a second server running.
- Several VS Code windows can download the same language server version at the same time.

## [0.0.4]

- Initial Marketplace releases.
