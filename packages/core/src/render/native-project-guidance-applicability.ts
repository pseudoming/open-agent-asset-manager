/** Exact-build applicability for project and global native Guidance declarations. */

import type { AdapterNativeGuidanceRenderDeclarationV1 } from "../contracts/source-import";
import { isSha256Digest } from "../foundation/validators";
import type { Sha256Digest } from "../types";
import type { VerifiedNativeGuidanceBuild } from "./native-project-guidance-profiles";
import {
    applicabilityPredicateRef,
    makeNativeProjectGuidanceContractParts,
    PLATFORM_FACT_KEY,
    PROJECT_BINDING_FACT_KEY,
} from "./native-project-guidance-profiles";
import { trustedNonProjectTargetFactEvidence } from "./native-project-target-authority";
import { trustedProjectEvidence } from "./native-project-target-evidence";
import type { TargetApplicabilityPredicateImplementation } from "./render-registry";
import { resolveTargetBuildCompatibility } from "./target-build-compatibility";

/** Test-only catalog lookup; production target contexts come from fresh probe evidence. */
export function makeApplicabilityPredicate(
    declaration: AdapterNativeGuidanceRenderDeclarationV1,
    build: VerifiedNativeGuidanceBuild,
): TargetApplicabilityPredicateImplementation {
    const contractProfile = makeNativeProjectGuidanceContractParts(declaration).profile;
    return {
        ref: applicabilityPredicateRef(
            build,
            declaration.declarationKind === "native_project_guidance_v1" ? "project" : "global",
            declaration.buildCompatibility,
        ),
        ...(declaration.buildCompatibility === undefined ? {} : { allowsBuildIdentityMismatch: true as const }),
        evaluate(context) {
            const facts = Object.fromEntries(context.renderFacts.map((fact) => [fact.key, fact]));
            const trustedFacts =
                context.agentRuntimeId === build.agentRuntimeId &&
                facts[PLATFORM_FACT_KEY]?.value === build.platform &&
                facts[PLATFORM_FACT_KEY]?.evidenceLevel === "agent_runtime_verified" &&
                Object.entries(contractProfile.requiredFacts).every(
                    ([key, value]) =>
                        facts[key]?.value === value &&
                        (key === PROJECT_BINDING_FACT_KEY
                            ? trustedProjectEvidence(facts[key]?.evidenceLevel)
                            : trustedNonProjectTargetFactEvidence(key, facts[key]?.evidenceLevel)),
                );
            if (!trustedFacts || !isSha256Digest(context.buildIdentity)) return false;
            const resolution = resolveTargetBuildCompatibility({
                anchors: declaration.verifiedBuilds,
                policy: declaration.buildCompatibility,
                current: {
                    agentRuntimeId: context.agentRuntimeId,
                    versionText: context.versionText,
                    buildIdentity: context.buildIdentity as Sha256Digest,
                    platform: build.platform,
                },
            });
            return (
                resolution.status !== "blocked" &&
                resolution.anchor.versionText === build.versionText &&
                resolution.anchor.buildIdentity === build.buildIdentity
            );
        },
    };
}
