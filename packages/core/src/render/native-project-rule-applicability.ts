/** Exact-build applicability for project and global native Rule declarations. */

import type { AdapterNativeRuleRenderDeclarationV1 } from "../contracts/source-import";
import { isSha256Digest } from "../foundation/validators";
import type { Sha256Digest } from "../types";
import { PLATFORM_FACT_KEY, PROJECT_BINDING_FACT_KEY } from "./native-project-guidance-profiles";
import {
    makeNativeProjectRuleContractParts,
    makeRuleApplicabilityPredicateRef,
    type VerifiedNativeRuleBuild,
} from "./native-project-rule-profiles";
import { trustedProjectEvidence } from "./native-project-target-evidence";
import type { TargetApplicabilityPredicateImplementation } from "./render-registry";
import { resolveTargetBuildCompatibility } from "./target-build-compatibility";

export function makeRuleApplicabilityPredicate(
    declaration: AdapterNativeRuleRenderDeclarationV1,
    build: VerifiedNativeRuleBuild,
): TargetApplicabilityPredicateImplementation {
    const profile = makeNativeProjectRuleContractParts(declaration).profile;
    return {
        ref: makeRuleApplicabilityPredicateRef(build, profile.targetScope, declaration.buildCompatibility),
        ...(declaration.buildCompatibility === undefined ? {} : { allowsBuildIdentityMismatch: true as const }),
        evaluate(context) {
            const facts = Object.fromEntries(context.renderFacts.map((fact) => [fact.key, fact]));
            const trustedFacts =
                context.agentRuntimeId === build.agentRuntimeId &&
                facts[PLATFORM_FACT_KEY]?.value === build.platform &&
                facts[PLATFORM_FACT_KEY]?.evidenceLevel === "agent_runtime_verified" &&
                Object.entries(profile.requiredFacts).every(
                    ([key, value]) =>
                        facts[key]?.value === value &&
                        (key === PROJECT_BINDING_FACT_KEY
                            ? trustedProjectEvidence(facts[key]?.evidenceLevel)
                            : facts[key]?.evidenceLevel === "agent_runtime_verified"),
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
