/** Exact current runtime builds that own callable Codex target evidence. */

export const CODEX_CURRENT_BUILDS = {
    CODEX_CLI: {
        versionText: "0.142.5",
        buildIdentity: "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
        platform: "wsl",
        fixturePrefix: "codex-cli-0.142.5-wsl",
    },
    CODEX_APP: {
        versionText: "0.147.0-alpha.1.2",
        buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
        platform: "win32",
        fixturePrefix: "codex-app-0.147.0-alpha.1.2-win32",
    },
} as const;

export const CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS = {
    CODEX_CLI: CODEX_CURRENT_BUILDS.CODEX_CLI,
    CODEX_APP: {
        versionText: "0.147.0-alpha.6.5",
        buildIdentity: "sha256:fb5c760e14cf8fe86e12e49e8a3e7f237af06082d6b9fe1e411e463b7229c916",
        platform: "win32",
        fixturePrefix: "codex-app-0.147.0-alpha.6.5-win32-memory-source",
    },
} as const;

export const CODEX_HISTORICAL_TARGET_BUILDS = {
    CODEX_CLI_GUIDANCE_FLOOR: {
        versionText: "0.140.0",
        buildIdentity: "sha256:b3b2a5f4ae29a584e594287d08c717e0454d21e47602e4314fca541e327a3c3e",
        platform: "wsl",
        fixturePrefix: "codex-cli-0.140.0-wsl",
    },
} as const;
