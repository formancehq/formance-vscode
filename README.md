# Formance support for VS Code

Language support for [Numscript](https://docs.formance.com/modules/numscript), the DSL that describes money movements in the Formance Ledger.

## Features

- Syntax highlighting and snippets for `.num` files.
- Diagnostics, hover, go to definition, document symbols and quick fixes from the [numscript](https://github.com/formancehq/numscript) language server.

The first time you open a `.num` file, the extension offers to download the latest numscript release for your platform (macOS, Linux and Windows, x86_64 and arm64). It verifies the archive checksum before installing it, and offers an update when a new release is published.

## Settings

- `numscript.server-path`: path to a `numscript` binary to use as language server instead of the downloaded release. This setting is read from user and remote settings only.

## Commands

- `Numscript: Restart language server`
- `Numscript: Download or update language server`

Logs are in the **Numscript** output channel.

## Development

Requirements: Node.js (version in `.nvmrc`) and Yarn 1.

```sh
yarn install
yarn bundle         # bundle the extension to dist/ with esbuild (yarn watch to rebuild on change)
yarn compile        # type-check and build the tests to out/
yarn lint
yarn format:check
yarn test:grammar   # syntax highlighting assertions in test/grammar
yarn test           # unit and extension tests in a VS Code instance
yarn package        # build the .vsix
```

Press F5 in VS Code to launch an Extension Development Host.

## Release

1. Bump `version` in `package.json` and update `CHANGELOG.md`.
2. Publish a GitHub release tagged `v<version>`. The release workflow checks the tag matches `package.json`, publishes to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=formance.formance-vscode) and [Open VSX](https://open-vsx.org/extension/formance/formance-vscode), and attaches the `.vsix` to the release.

The workflow needs two repository secrets: `VS_MARKETPLACE_TOKEN` (Azure DevOps personal access token with the Marketplace "Manage" scope) and `OVSX_TOKEN` (Open VSX access token of a `formance` namespace member).
