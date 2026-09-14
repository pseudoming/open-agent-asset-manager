<div align="center">

# Open Agent Asset Manager

### Your agent assets follow you. You choose the tools.

Your skills, instructions and workflows deserve a home beyond a single coding tool.

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [Deutsch](docs/README.de.md)

[View guide](docs/USAGE.md) · [Run from source](#run-from-source) · [How it works](docs/ARCHITECTURE.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) · Source preview

</div>

![OAAM showing a saved team coding guide in the Atlas Notes demonstration project](docs/images/oaam-overview.png)

*A saved team coding guide in the synthetic Atlas Notes demonstration project.*

## What you can do

**Bring your work with you**

Save reusable skills and instructions in one versioned library, with their supporting files.

**See the change first**

Choose a target tool and review the proposed file changes before applying them.

**Keep the improvements**

Bring supported external edits back as a new saved version.

OAAM manages **Guidance, Rules, Workflows, Skills, Subagent declarations and Memory**. Project assets and a Global library keep shared knowledge close without mixing project ownership. Complete directory assets retain their resources, relative paths, bytes and executable attributes.

Adapters cover **Claude Code, Codex, Cursor, OpenCode, Antigravity and zcode**. Available operations depend on the exact App, CLI or IDE entry, asset kind, platform and detected build. OAAM explains conversion limits and requests confirmation before applying changes that lose detail.

**Carry the settings, too**

A Skill configured to run only when you invoke it should keep that behavior after a move. OAAM records this setting separately from its instructions and can preserve it in supported Claude Code and Cursor conversions. Model and effort choices are also retained for target analysis. [See examples and limits](docs/ARCHITECTURE.md#invocation-settings).

## A first workflow

1. Add a project and select the tool locations you want OAAM to read.
2. Import existing instructions or a skill, then inspect its saved version and files.
3. Choose another supported tool, review the destination and changes, then apply.
4. When supported files change outside OAAM, review and save those improvements as another version.

Start with the [usage guide](docs/USAGE.md). A scan or preview does not apply changes.

## Run from source

For the **Linux x64 development preview**, use **Node.js 22.14 or newer**, npm and your host's C++ build tools. Follow the [build guide](docs/BUILD.md) for Python, system libraries and native-module details.

```sh
git clone https://github.com/pseudoming/open-agent-asset-manager.git
cd open-agent-asset-manager
npm ci
npm run build
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

The native-module step prepares SQLite for Electron. For Node-based tests afterwards, follow the rebuild instructions in the build guide. This source preview does not include a downloadable desktop package.

## Current scope

- The desktop delivery focus is **Windows x64**, including explicitly selected Ubuntu WSL x64 environments. Building source on another host does not establish installed-platform support.
- Chat transcripts, credentials, private sessions, plugin-private data and built-in managed content are outside OAAM's asset library.

## Build with us

Useful contributions start with a concrete workflow, a reproducible problem or a focused improvement. Read the [build and test guide](docs/BUILD.md), then open an issue or pull request. Documentation improvements are welcome in all four README languages.

Reviewed contributions may ship together in a public snapshot. We preserve contributors' chosen public attribution.

## License

OAAM's first-party code is licensed under [Apache License 2.0](LICENSE). Third-party dependencies and imported assets retain their own licenses.
