/** Provider-owned exact OpenCode target evidence anchors. */

export interface OpencodeTargetBuildAnchor {
    versionText: "1.17.11" | "1.18.15";
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    fixtureDate: "2026-08-08" | "2026-08-09" | "2026-08-17";
    exactLoadMarker?: string;
}

export interface OpencodeCliVersionObservationAnchor {
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
}

export const OPENCODE_CLI_TARGET_BUILD_ANCHORS = [
    {
        versionText: "1.18.15",
        buildIdentity: "sha256:c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d",
        platform: "wsl",
        fixtureDate: "2026-08-08",
    },
    {
        versionText: "1.18.15",
        buildIdentity: "sha256:fd254474def7ee35f07416cf4674c361f07e7bcd9c7ffb284af21bb011066ee3",
        platform: "win32",
        fixtureDate: "2026-08-09",
    },
] as const satisfies readonly OpencodeTargetBuildAnchor[];

/**
 * Exact executable identities whose version was independently observed.
 * These are version-observation facts, not additional target/load anchors.
 */
export const OPENCODE_CLI_VERSION_OBSERVATION_ANCHORS = [
    {
        versionText: "1.18.11",
        buildIdentity: "sha256:8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089",
        platform: "wsl",
    },
    ...OPENCODE_CLI_TARGET_BUILD_ANCHORS.map(({ versionText, buildIdentity, platform }) => ({
        versionText,
        buildIdentity,
        platform,
    })),
] as const satisfies readonly OpencodeCliVersionObservationAnchor[];

export const OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS = [
    {
        versionText: "1.17.11",
        buildIdentity: "sha256:0254a429cd0e6cf0ba53fc01672cf98e4a8dc728f7fa94be88f1e4b3645e6ded",
        platform: "wsl",
        fixtureDate: "2026-08-17",
        exactLoadMarker: "OPENCODE_GUIDANCE_LOAD_MARKER_20260729",
    },
    ...OPENCODE_CLI_TARGET_BUILD_ANCHORS,
] as const satisfies readonly OpencodeTargetBuildAnchor[];

export const OPENCODE_APP_TARGET_BUILD_ANCHORS = [
    {
        versionText: "1.18.15",
        buildIdentity: "sha256:c5fe1808131d04a1fba13ec237fbf675bb4951dcaa669a48da58cb20b3396c6f",
        platform: "wsl",
        fixtureDate: "2026-08-08",
    },
] as const satisfies readonly OpencodeTargetBuildAnchor[];

export const OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS = [
    ...OPENCODE_CLI_TARGET_BUILD_ANCHORS,
    {
        versionText: "1.17.11",
        buildIdentity: "sha256:0254a429cd0e6cf0ba53fc01672cf98e4a8dc728f7fa94be88f1e4b3645e6ded",
        platform: "wsl",
        fixtureDate: "2026-08-17",
        exactLoadMarker: "oaam-historical-opencode-cli-wsl-1-17-11-43abac09593ff92d",
    },
] as const satisfies readonly OpencodeTargetBuildAnchor[];

export const OPENCODE_APP_PROJECT_SKILL_TARGET_BUILD_ANCHORS = [
    ...OPENCODE_APP_TARGET_BUILD_ANCHORS,
    {
        versionText: "1.17.11",
        buildIdentity: "sha256:f044dea8bb82ebb514380f4782bac8439b870abc82741f7f50effe9ccbeb4e75",
        platform: "wsl",
        fixtureDate: "2026-08-17",
        exactLoadMarker: "oaam-historical-opencode-app-linux-1-17-11-0555b4e5dfeca3db",
    },
] as const satisfies readonly OpencodeTargetBuildAnchor[];
