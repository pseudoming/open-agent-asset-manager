# Build, run and test

[English](BUILD.md) · [简体中文](BUILD.zh-CN.md) · [日本語](BUILD.ja.md) · [Deutsch](BUILD.de.md) · [README](../README.md)

## Prerequisites

The source-run path below is a **Linux x64 development preview**, including Ubuntu with a desktop session
or WSLg. Use **Node.js 22.14 or newer**, npm, Python 3, a C++ compiler and make. Electron also needs its
usual Linux desktop libraries. The renderer checks use Xvfb when no display is available.

The default Shared package contains Unix-like physical mechanisms. The Linux build compiles its filesystem
helper and file-lock module. These are required product safeguards, not optional test stubs.

The current Linux build requires **g++ 11.4.0** at `/usr/bin/x86_64-linux-gnu-g++-11`. The verified setup
and CI use **Ubuntu 22.04 x64**. Another Ubuntu release may install a different g++-11 version. On Ubuntu 22.04, prepare the build with:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y g++-11 make python3 xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1
```

## Install dependencies and build

Run at the repository root:

```sh
npm ci
npm run build
```

The lockfile fixes dependency resolution. The build derives workspace order from manifests, checks declared
dependencies and TypeScript input/output boundaries, cleans declared output directories and checks built entries.

## Start the desktop from source

After building, prepare SQLite for the pinned Electron version and launch the existing desktop entry:

```sh
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

The rebuild command changes the local SQLite native module to Electron's ABI. The product version comes from
the root package.json. Regular versions use the OS user's OAAM profile; beta versions use OAAM Preview.
Each channel keeps the same profile across upgrades. A dev.N build requires an explicit absolute profile:

```sh
npm run start --workspace @oaam/client-desktop -- --user-data-dir=/absolute/path/to/your/oaam-dev-profile
```

Use a directory you own and reserve for this preview. Close the desktop before changing its dependencies.

## Run the checks

If you prepared SQLite for Electron, first restore the Node build before running tests:

```sh
npm rebuild better-sqlite3
npm run verify
```

From a fresh npm ci, you can run npm run verify directly. It builds the source, checks formatting and types,
runs architecture and asset conformance tests, verifies the rendered desktop, and runs workspace coverage gates.
These checks use synthetic fixtures and do not require private documents, saved machine evidence, credentials
or installed coding tools. Running them does not establish an exact external tool's loading capability.

## Platform and packaging boundaries

CI runs source builds, architecture tests and selected path tests on Windows x64 and macOS 26 ARM64.
On macOS, this evidence covers source checks only. The safe filesystem operations required for asset reads,
writes and recovery have not yet been adapted to Darwin, so complete asset journeys are not supported there.
Desktop packaging and UI testing also remain pending.

The current desktop delivery focus is Windows x64 with explicitly selected Ubuntu WSL x64 environments.
The source preview above does **not** construct that Windows delivery: its native Shared target, Electron
resources and matching selected-WSL Linux runtime/service must be prepared together. Building the TypeScript
workspaces alone does not produce a Windows portable package or certify another installed platform.

Windows native development requires Visual Studio C++ build tools and Python. The source includes a common
distribution builder. After npm ci and npm run build, build from a clean checkout into new absolute output directories:

```sh
npm run package:desktop -- --output /absolute/new/oaam-linux
npm run package:wsl-resource -- --output /absolute/new/oaam-wsl-resource
```

The first command produces the full Linux Desktop; the second produces only the supporting Linux service for
Windows. Copy that service archive and its manifest to Windows, using the same source commit on both hosts.
After npm ci and npm run build on Windows, run in PowerShell:

```powershell
$archive = 'C:\oaam-build\OAAM-0.1.0-beta.1-restricted-wsl-support-linux-x64.tar.gz'
$nodeExecutable = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$npmCli = Join-Path (Split-Path -Parent $nodeExecutable) 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Node installation is missing npm-cli.js' }
& $nodeExecutable $npmCli run package:desktop -- --output C:\oaam-build\desktop-windows --wsl-archive $archive --wsl-manifest "$archive.manifest.json"
```

Each output's artifacts directory contains a versioned Desktop ZIP or tar.gz and its SHA-256/file manifest.
The builder verifies the actual archive after extraction. Linux executable modes are preserved. build-info.json
beside the executable records component, product version/channel, source commit, build time/number and tools.
Use --build-number and --build-time to supply explicit build inputs; local builds otherwise record local and UTC now.
The assembly recipe in tests/repository/package-assembly fixes external resolution independently of newly built
internal tarballs. The Windows package also verifies its same-commit WSL service and actual PE metadata.

Public main pushes generate expiring Actions test artifacts, which require GitHub sign-in. Exact v&lt;version&gt; tags
create Release drafts after checks and both packages succeed; beta drafts are prereleases. Drafts remain unpublished
until candidate review and publication. Public Release downloads are the ordinary distribution path. Building a
package alone does not establish an installed journey: Linux acceptance is scoped to Ubuntu WSL/WSLg, and
Windows local/selected-WSL results remain separate. The supporting WSL service is neither Linux Desktop nor standalone Headless.

The Headless package is a technical Client/Host protocol entry, not an interactive desktop substitute. It needs
explicit data, database, platform and access-root configuration; the automated tests demonstrate isolated setup.

## Making changes

Keep product code and tests in TypeScript. Preserve meaningful failure, stale-authority and complete-file-graph
cases. Run affected tests for a focused change; run the full public verification for shared build, protocol,
authorization or persistence changes.

Read [how OAAM works](ARCHITECTURE.md) for the design and [usage](USAGE.md) for the interface.
