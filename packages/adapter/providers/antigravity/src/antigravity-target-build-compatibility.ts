/** Antigravity-owned build ordering, deny data, and non-exact review warning. */

import { adapterOperationDiagnostic } from "@oaam/adapter-framework";
import {
    type AdapterNativeExactGraphRenderDeclarationV1,
    type AdapterNativeGuidanceRenderDeclarationV1,
    type AdapterNativeProjectExactFileRenderDeclarationV1,
    type AdapterRenderAnalysisResult,
    type AdapterTargetBuildCompatibilityPolicyV1,
    type Platform,
    type RenderAnalysisInput,
    resolveTargetBuildCompatibility,
    type Sha256Digest,
} from "@oaam/core/adapter-spi";

export const ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export const ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export const ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export const ANTIGRAVITY_APP_SUBAGENT_TARGET_BUILD_COMPATIBILITY = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
} as const satisfies AdapterTargetBuildCompatibilityPolicyV1;

export function appendAntigravityBuildCompatibilityWarning(
    result: AdapterRenderAnalysisResult,
    input: RenderAnalysisInput,
    declaration:
        | AdapterNativeGuidanceRenderDeclarationV1
        | AdapterNativeProjectExactFileRenderDeclarationV1
        | AdapterNativeExactGraphRenderDeclarationV1,
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
    const runtimeLabel =
        declaration.agentRuntimeId === "ANTIGRAVITY_CLI"
            ? "Antigravity CLI"
            : declaration.agentRuntimeId === "ANTIGRAVITY_APP"
              ? "Antigravity App"
              : declaration.agentRuntimeId === "ANTIGRAVITY_IDE"
                ? "Antigravity IDE"
                : "Antigravity";
    const diagnostics = [
        ...result.diagnostics,
        adapterOperationDiagnostic(
            "render",
            "antigravity_target_build_compatibility_inferred",
            `${runtimeLabel} ${context.versionText} uses the nearest verified ${resolution.anchor.versionText} ${"assetKind" in declaration ? declaration.assetKind : "Guidance"} target contract; this build has not been re-verified`,
            "partial",
            "warning",
        ),
    ];
    if (
        declaration.agentRuntimeId === "ANTIGRAVITY_APP" &&
        "assetKind" in declaration &&
        declaration.assetKind === "Subagent" &&
        context.versionText === "2.4.3" &&
        platformValue === "win32" &&
        context.buildIdentity === "sha256:4dbd1be0a6ebe48ebd370babf9b7d046630b8eac7bb69fbb0469db1aea12bcf8"
    ) {
        diagnostics.push(
            adapterOperationDiagnostic(
                "render",
                "antigravity_app_2_4_3_win32_subagent_loader_regression",
                "Antigravity App 2.4.3 has a known Subagent loading regression; OAAM can still apply the verified 2.2.1-compatible folder format, but this runtime build may not load it",
                "partial",
                "warning",
            ),
        );
    }
    return {
        ...result,
        diagnostics,
    };
}

function isPlatform(value: string | undefined): value is Platform {
    return value === "win32" || value === "darwin" || value === "linux" || value === "wsl";
}

function isSha256Digest(value: string): value is Sha256Digest {
    return /^sha256:[a-f0-9]{64}$/u.test(value);
}
