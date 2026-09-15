<div align="center">

# Open Agent Asset Manager

### Your agent assets follow you. You choose the tools.

Your skills, instructions and workflows deserve a home beyond a single coding tool.

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [Deutsch](docs/README.de.md)

[Download](https://github.com/pseudoming/open-agent-asset-manager/releases) · [Usage guide](docs/USAGE.md) · [Build from source](docs/BUILD.md) · [How it works](docs/ARCHITECTURE.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) · Desktop beta

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

## Download and start

Download a published beta from [Releases](https://github.com/pseudoming/open-agent-asset-manager/releases): choose the Windows x64 ZIP or Linux x64 tar.gz and its matching manifest. Extract the entire archive, then run `oaam-desktop.exe` on Windows or `./oaam-desktop` in the extracted Linux folder. The desktop packages include Electron/Node and OAAM dependencies. Linux also needs [desktop system libraries](docs/USAGE.md#linux-runtime-libraries); Node.js and build tools are only needed for [source development](docs/BUILD.md).

Beta versions share the **OAAM Preview** profile. Close OAAM and extract an update into a new folder; your saved library remains in that profile. See [startup and updates](docs/USAGE.md) before your first import.

## Current scope

- Desktop archives are available for **Windows x64 and Linux x64**. Linux verification covers Ubuntu WSL/WSLg; native Ubuntu and macOS installed acceptance remain pending. The Windows app can also manage assets in a WSL distribution you explicitly select.
- This preview adds Linux project Skill deployment and reverse acceptance for **Claude Code CLI 2.1.220**. Other runtime, scope and asset combinations retain their own support limits.
- Chat transcripts, credentials, private sessions, plugin-private data and built-in managed content are outside OAAM's asset library.

## Build with us

Useful contributions start with a concrete workflow, a reproducible problem or a focused improvement. Read the [build and test guide](docs/BUILD.md), then open an issue or pull request. Documentation improvements are welcome in all four README languages.

Reviewed contributions may ship together in a public snapshot. We preserve contributors' chosen public attribution.

## License

OAAM's first-party code is licensed under [Apache License 2.0](LICENSE). Third-party dependencies and imported assets retain their own licenses.
