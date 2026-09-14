/** Exact Antigravity IDE project/global Guidance targets. */

import {
    type AgentRuntimeDescriptor,
    createNativeGlobalGuidanceProviderSupport,
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeGlobalGuidanceBuild,
    createVerifiedNativeProjectGuidanceBuild,
} from "@oaam/core/adapter-spi";
import {
    ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
} from "./antigravity-target-build-compatibility";

const IDE_BUILDS = [
    {
        versionText: "1.107.0",
        buildIdentity: "sha256:56987be1a655ae5903bc47963a67e147d8ee3c36e41144b03210cc9c3e57336f",
        platform: "wsl",
        fixturePrefix: "antigravity-ide-2.1.1-wsl",
    },
    {
        versionText: "1.107.0",
        buildIdentity: "sha256:dca2f8dc41186aff715298830fa3a10cb310e632cb51bb76dac30c2c2fbe37a2",
        platform: "win32",
        fixturePrefix: "antigravity-ide-2.1.1-win32",
    },
] as const;

const APP_BUILDS = [
    {
        versionText: "2.2.1",
        buildIdentity: "sha256:b0d127772d2983a93771055a93b673d5fdd1726d6e47db8e269b204e665972d6",
        platform: "wsl",
        fixturePrefix: "antigravity-app-2.2.1-wsl",
    },
    {
        versionText: "2.4.3",
        buildIdentity: "sha256:4dbd1be0a6ebe48ebd370babf9b7d046630b8eac7bb69fbb0469db1aea12bcf8",
        platform: "win32",
        fixturePrefix: "antigravity-app-2.4.3-win32",
    },
] as const;

export interface AntigravityIdeGuidanceTargetSupports {
    project: ReturnType<typeof createNativeProjectGuidanceProviderSupport>;
    global: ReturnType<typeof createNativeGlobalGuidanceProviderSupport>;
}

export function createAntigravityIdeGuidanceTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
}): AntigravityIdeGuidanceTargetSupports {
    return createGuidanceTargetSupports(input, {
        agentRuntimeId: "ANTIGRAVITY_IDE",
        profilePrefix: "antigravity-ide",
        outputPrefix: "ANTIGRAVITY_IDE",
        capabilityPrefix: "antigravity.ide",
        projectTargetContextSchemaId: "ANTIGRAVITY_IDE_PROJECT_TARGET_V1",
        globalTargetContextSchemaId: "ANTIGRAVITY_IDE_GLOBAL_TARGET_V1",
        projectLoadMarker: "OAAM_PHASE55_IDE_PROJECT_GUIDANCE",
        globalLoadMarker: "OAAM_PHASE55_IDE_GLOBAL_GUIDANCE",
        buildCompatibility: ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
        builds: IDE_BUILDS,
    });
}

export function createAntigravityAppGuidanceTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
}): AntigravityIdeGuidanceTargetSupports {
    return createGuidanceTargetSupports(input, {
        agentRuntimeId: "ANTIGRAVITY_APP",
        profilePrefix: "antigravity-app",
        outputPrefix: "ANTIGRAVITY_APP",
        capabilityPrefix: "antigravity.app",
        projectTargetContextSchemaId: "ANTIGRAVITY_APP_PROJECT_TARGET_V1",
        globalTargetContextSchemaId: "ANTIGRAVITY_APP_GLOBAL_TARGET_V1",
        projectLoadMarker: "OAAM_PHASE55_APP_PROJECT_GUIDANCE",
        globalLoadMarker: "OAAM_PHASE55_APP_GLOBAL_GUIDANCE",
        buildCompatibility: ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
        builds: APP_BUILDS,
    });
}

function createGuidanceTargetSupports(
    input: { adapterVersion: string; agentRuntimes: readonly AgentRuntimeDescriptor[] },
    spec: {
        agentRuntimeId: "ANTIGRAVITY_APP" | "ANTIGRAVITY_IDE";
        profilePrefix: string;
        outputPrefix: string;
        capabilityPrefix: string;
        projectTargetContextSchemaId: string;
        globalTargetContextSchemaId: string;
        projectLoadMarker: string;
        globalLoadMarker: string;
        buildCompatibility: typeof ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY;
        builds: typeof IDE_BUILDS | typeof APP_BUILDS;
    },
): AntigravityIdeGuidanceTargetSupports {
    const projectProfile = `${spec.profilePrefix}-project-guidance-v1`;
    const globalProfile = `${spec.profilePrefix}-global-guidance-v1`;
    return {
        project: createNativeProjectGuidanceProviderSupport({
            adapterId: "ANTIGRAVITY",
            adapterVersion: input.adapterVersion,
            agentRuntimes: input.agentRuntimes,
            agentRuntimeId: spec.agentRuntimeId,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_GUIDANCE_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-guidance-native-v1`,
            target: {
                relativePath: "AGENTS.md",
                targetContextSchemaId: spec.projectTargetContextSchemaId,
                requiredFacts: { "oaam.project-binding": "registered" },
            },
            buildCompatibility: spec.buildCompatibility,
            verifiedBuilds: spec.builds.map((build) =>
                createVerifiedNativeProjectGuidanceBuild({
                    agentRuntimeId: spec.agentRuntimeId,
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    platform: build.platform,
                    materializationProfileId: projectProfile,
                    fixtureId: `${build.fixturePrefix}-project-agents-md-2026-08-07`,
                    targetRelativePath: "AGENTS.md",
                    exactLoadMarker: spec.projectLoadMarker,
                    reverseFixtureId: `${build.fixturePrefix}-project-guidance-whole-file-reverse-v1`,
                }),
            ),
        }),
        global: createNativeGlobalGuidanceProviderSupport({
            adapterId: "ANTIGRAVITY",
            adapterVersion: input.adapterVersion,
            agentRuntimes: input.agentRuntimes,
            agentRuntimeId: spec.agentRuntimeId,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_GUIDANCE_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-guidance-native-v1`,
            target: {
                relativePath: "GEMINI.md",
                targetContextSchemaId: spec.globalTargetContextSchemaId,
                requiredFacts: {},
            },
            buildCompatibility: spec.buildCompatibility,
            verifiedBuilds: spec.builds.map((build) =>
                createVerifiedNativeGlobalGuidanceBuild({
                    agentRuntimeId: spec.agentRuntimeId,
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    platform: build.platform,
                    materializationProfileId: globalProfile,
                    fixtureId: `${build.fixturePrefix}-global-gemini-md-2026-08-07`,
                    targetRelativePath: "GEMINI.md",
                    exactLoadMarker: spec.globalLoadMarker,
                    reverseFixtureId: `${build.fixturePrefix}-global-guidance-whole-file-reverse-v1`,
                }),
            ),
        }),
    };
}
