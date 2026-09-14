/** Codex-owned target-build ordering and non-exact review warning. */

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

export const CODEX_CLI_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export const CODEX_APP_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export function codexTargetBuildCompatibilityFor(
    agentRuntimeId: "CODEX_CLI" | "CODEX_APP",
): AdapterTargetBuildCompatibilityPolicyV1 {
    return agentRuntimeId === "CODEX_APP" ? CODEX_APP_TARGET_BUILD_COMPATIBILITY : CODEX_CLI_TARGET_BUILD_COMPATIBILITY;
}

interface CodexDeclaration {
    agentRuntimeId: AgentRuntimeId;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: TargetBuildCompatibilityAnchor[];
}

export function appendCodexBuildCompatibilityWarning(
    result: AdapterRenderAnalysisResult,
    input: RenderAnalysisInput,
    declaration: CodexDeclaration,
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
    const runtimeLabel = declaration.agentRuntimeId === "CODEX_APP" ? "Codex App" : "Codex CLI";
    return {
        ...result,
        diagnostics: [
            ...result.diagnostics,
            adapterOperationDiagnostic(
                "render",
                "codex_target_build_compatibility_inferred",
                `${runtimeLabel} ${context.versionText} uses the nearest verified ${resolution.anchor.versionText} target contract; this build has not been re-verified`,
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
