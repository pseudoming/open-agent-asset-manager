# Using OAAM

[English](USAGE.md) · [简体中文](USAGE.zh-CN.md) · [日本語](USAGE.ja.md) · [Deutsch](USAGE.de.md) · [README](../README.md)

## Download, extract and start

1. Open [Releases](https://github.com/pseudoming/open-agent-asset-manager/releases) and choose a published beta. Download the Windows x64 ZIP or Linux x64 tar.gz and its `.manifest.json`. GitHub's source-code archives are separate from the Desktop packages.
2. Extract the complete archive into a folder you own. On Windows, run `oaam-desktop.exe`. On Linux, open a terminal in the extracted folder and run `./oaam-desktop`; the tar archive preserves executable permissions. Linux requires a graphical desktop session; the verified environment is Ubuntu WSL/WSLg.
3. The packages include Electron/Node and OAAM's application dependencies; Linux desktop system libraries are installed separately. Install the coding tools whose assets you want to manage separately. Node.js and compilers are needed only for [building from source](BUILD.md).

## Linux runtime libraries

Linux also needs a graphical desktop session and system libraries such as GTK and NSS. On **Ubuntu 22.04**, install the runtime packages below if they are missing; no compiler or source build is required.

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y libgtk-3-0 libnss3 libasound2 libgbm1
```

The validated Linux environment is Ubuntu WSL/WSLg. Other Ubuntu releases may use different package names and are not covered by this instruction.

## Updating a beta

Close OAAM, extract the new archive into a new folder and start its executable. Beta versions use the same **OAAM Preview** profile, so the saved library is kept outside the program folder. Regular releases use a separate **OAAM** profile. Before an update, create a state backup in the interface; automatic updates and migration between these profiles are not provided.

The archive's manifest records its SHA-256 and complete file inventory. `build-info.json` beside the executable identifies the version and source. Include that version when reporting a problem.

## First import

1. Choose the tools and environments you want OAAM to inspect. Start the WSL distribution first if needed,
   then select it explicitly. Finding an environment does not authorize scanning it.
2. Choose a Project or the Global library, inspect the available sources and select the intended tool entry.
   CLI and App interpretations of the same physical source can differ.
3. Review the asset and its resources, then import it. A saved Version is distinct from the live source.
4. Select that Version and check where it can be used. Inspect existing files, the complete proposed graph,
   conversions and required authorization. Apply only after the exact review is acceptable.
5. Later, refresh the usage state to detect external changes. Review whether to keep, repair or accept them
   as a new Version; a backup's saved baseline does not silently adopt later runtime edits.

## Managing assets and projects

Versions retain saved content and complete native resources. An asset's editable display metadata is separate.
Review an export before sharing it: asset archives carry asset content, while support bundles and traces have
different purposes. Saved authorizations can be inspected and revoked in the selected Asset's context.

Project rename/rebind/stop/restore acts on the Project's identity and management state. Rebinding a Project
does not relocate or overwrite previously deployed files. Review retained locations before acting on them.

## Backups and recovery

Create and inspect a whole-state backup before relying on destructive lifecycle changes. Restoration asks
for an explicit review and replaces state as a unit; it does not merge arbitrary database fragments. If the
database is missing, the recovery interface can inspect a selected backup and restore it. After returning to
the normal interface, refresh managed locations to check external changes against the restored baseline.

## Known limits

- Support is exact to tool entry, kind, direction, platform and build. Use the displayed analysis; unsupported
  invocation or private semantics can block a conversion. Preserve the source instead of deleting meaningful
  fields to make an operation pass.
- Some definite unsupported Workflow outcomes still use temporary-failure/retry wording.
- A retained-deployment notice after Project rebind can appear in the Global library with an inaccurate subject.
- Successful restoration can lose its persistent completion notice when the Host is replaced. Inspect the
  restored state and refresh usage; do not repeatedly restore solely because that notice disappeared.
- The recovery-only entry has minor wording that refers to a backup inventory it does not display.
- Interaction remains complex and latency varies. Unchecked tool/platform/language/display combinations are
  not established by representative tests. No watcher-backed background synchronization is promised.

For the conversion and deployment design, read [how OAAM works](ARCHITECTURE.md).
