/** Cursor-owned version compatibility data; Core performs only bounded routing. */

import type {
    AdapterTargetBuildCompatibilityPolicyV1,
    AdapterRenderAnalysisResult,
    AgentRuntimeId,
    Platform,
    RenderAnalysisInput,
    Sha256Digest,
    TargetBuildCompatibilityAnchor,
} from "@oaam/core";
import { resolveTargetBuildCompatibility } from "@oaam/core/adapter-spi";
import { adapterOperationDiagnostic } from "@oaam/adapter-framework";

export const CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY: AdapterTargetBuildCompatibilityPolicyV1 = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
};

interface CursorDeclaration {
    agentRuntimeId: AgentRuntimeId;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: TargetBuildCompatibilityAnchor[];
}

export function appendCursorBuildCompatibilityWarning(
    result: AdapterRenderAnalysisResult,
    input: RenderAnalysisInput,
    declaration: CursorDeclaration,
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
            buildIdentity: context.buildIdentity,
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
                "cursor_target_build_compatible_unverified",
                `Cursor ${context.versionText} uses the nearest verified ${resolution.anchor.versionText} target contract; this build has not been re-verified`,
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
