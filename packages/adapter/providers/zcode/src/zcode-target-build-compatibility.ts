/** ZCode-owned App build ordering and non-exact review warning. */

import { adapterOperationDiagnostic } from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type AdapterTargetBuildCompatibilityPolicyV1,
    type AgentRuntimeId,
    type Platform,
    type RenderAnalysisInput,
    resolveTargetBuildCompatibility,
    type Sha256Digest,
    type TargetBuildCompatibilityAnchor,
} from "@oaam/core/adapter-spi";
import { ZCODE_HISTORICAL_DECLARATION_FLOOR } from "./zcode-target-builds";

interface ZcodeTargetBuildDeclaration {
    agentRuntimeId: AgentRuntimeId;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: TargetBuildCompatibilityAnchor[];
}

export const ZCODE_APP_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export const ZCODE_APP_SUBAGENT_TARGET_BUILD_COMPATIBILITY = {
    ...ZCODE_APP_TARGET_BUILD_COMPATIBILITY,
    deniedBuilds: [
        {
            versionText: ZCODE_HISTORICAL_DECLARATION_FLOOR.versionText,
            buildIdentity: ZCODE_HISTORICAL_DECLARATION_FLOOR.buildIdentity,
            reasonCode: "zcode_subagent_root_absent_3_1_8",
        },
    ],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export function appendZcodeBuildCompatibilityWarning(
    result: AdapterRenderAnalysisResult,
    input: RenderAnalysisInput,
    declaration: ZcodeTargetBuildDeclaration,
): AdapterRenderAnalysisResult {
    const contexts = input.deployment.targetContexts.filter((context) => context.agentRuntimeId === declaration.agentRuntimeId);
    const context = contexts[0];
    if (contexts.length !== 1 || context === undefined) return result;
    const platformValue = context.renderFacts.find((fact) => fact.key === "oaam.platform")?.value;
    if (!isPlatform(platformValue) || !isSha256Digest(context.buildIdentity)) return result;
    const resolution = resolveTargetBuildCompatibility({
        anchors: declaration.verifiedBuilds,
        policy: declaration.buildCompatibility,
        current: {
            agentRuntimeId: context.agentRuntimeId,
            versionText: context.versionText,
            buildIdentity: context.buildIdentity as Sha256Digest,
            platform: platformValue,
        },
    });
    if (resolution.status !== "compatible") return result;
    return {
        ...result,
        diagnostics: [
            ...result.diagnostics,
            adapterOperationDiagnostic(
                "render",
                "zcode_target_build_compatibility_inferred",
                `ZCode App ${context.versionText} uses the nearest verified ${resolution.anchor.versionText} target contract; this build has not been re-verified`,
                "partial",
                "warning",
            ),
        ],
    };
}

function isPlatform(value: string | undefined): value is Platform {
    return value === "win32" || value === "darwin" || value === "linux" || value === "wsl";
}

function isSha256Digest(value: string): value is Sha256Digest {
    return /^sha256:[a-f0-9]{64}$/u.test(value);
}
