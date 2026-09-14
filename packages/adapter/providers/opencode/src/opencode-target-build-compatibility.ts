/** OpenCode-owned build ordering and non-exact target review warnings. */

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
import { OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS } from "./opencode-target-builds";

export interface OpenCodeTargetBuildDeclaration {
    agentRuntimeId: AgentRuntimeId;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: TargetBuildCompatibilityAnchor[];
}

export function resolveOpencodeTargetBuildCompatibility(
    current: TargetBuildCompatibilityAnchor,
    declaration: OpenCodeTargetBuildDeclaration,
) {
    return resolveTargetBuildCompatibility({
        anchors: declaration.verifiedBuilds,
        policy: declaration.buildCompatibility,
        current,
    });
}

export const OPENCODE_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export const OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION = {
    agentRuntimeId: "OPENCODE_CLI",
    buildCompatibility: OPENCODE_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS.map((anchor) => ({
        ...anchor,
        agentRuntimeId: "OPENCODE_CLI" as const,
    })),
} satisfies OpenCodeTargetBuildDeclaration;

export function appendOpencodeBuildCompatibilityWarning(
    result: AdapterRenderAnalysisResult,
    input: RenderAnalysisInput,
    declaration: OpenCodeTargetBuildDeclaration,
): AdapterRenderAnalysisResult {
    const contexts = input.deployment.targetContexts.filter((context) => context.agentRuntimeId === declaration.agentRuntimeId);
    const context = contexts[0];
    if (contexts.length !== 1 || context === undefined) return result;
    const platformValue = context.renderFacts.find((fact) => fact.key === "oaam.platform")?.value;
    if (!isPlatform(platformValue) || !isSha256Digest(context.buildIdentity)) return result;
    const resolution = resolveOpencodeTargetBuildCompatibility(
        {
            agentRuntimeId: context.agentRuntimeId,
            versionText: context.versionText,
            buildIdentity: context.buildIdentity as Sha256Digest,
            platform: platformValue,
        },
        declaration,
    );
    if (resolution.status !== "compatible") return result;
    return {
        ...result,
        diagnostics: [
            ...result.diagnostics,
            adapterOperationDiagnostic(
                "render",
                "opencode_target_build_compatibility_inferred",
                `OpenCode ${context.versionText} uses the nearest verified ${resolution.anchor.versionText} target contract; this build has not been re-verified`,
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
