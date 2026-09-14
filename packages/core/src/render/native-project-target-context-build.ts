/** Provider declaration projection for one native project target-context build. */

import type { AdapterProviderSummary } from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import type { AgentRuntimeId, Platform, Sha256Digest } from "../types";
import type { TargetBuildCompatibilityAnchor } from "./target-build-compatibility";

export interface VerifiedNativeProjectTargetContextBuild {
    agentRuntimeId: AgentRuntimeId;
    versionText: string;
    buildIdentity: Sha256Digest;
    platform: Platform;
    targetContextSchemaId: string;
    requiredFacts: Readonly<Record<string, string>>;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    compatibilityAnchors: readonly TargetBuildCompatibilityAnchor[];
}

export function targetContextBuild(
    declaration: AdapterProviderSummary["renderContractDeclarations"][number],
    build: AdapterProviderSummary["renderContractDeclarations"][number]["verifiedBuilds"][number],
    anchors: readonly AdapterProviderSummary["renderContractDeclarations"][number]["verifiedBuilds"][number][] = declaration.verifiedBuilds,
): VerifiedNativeProjectTargetContextBuild {
    return {
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        platform: build.platform,
        targetContextSchemaId: declaration.target.targetContextSchemaId,
        requiredFacts: structuredClone(declaration.target.requiredFacts),
        ...("buildCompatibility" in declaration && declaration.buildCompatibility !== undefined
            ? { buildCompatibility: structuredClone(declaration.buildCompatibility) }
            : {}),
        compatibilityAnchors: anchors.map((anchor) => ({
            agentRuntimeId: anchor.agentRuntimeId,
            versionText: anchor.versionText,
            buildIdentity: anchor.buildIdentity,
            platform: anchor.platform,
        })),
    };
}
