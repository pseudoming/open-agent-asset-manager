/** Exact observed physical-target authority for native render contexts. */

import { physicalAccessPathContains } from "@oaam/shared/paths";
import type { ProbeResult, SourceEvidenceLevel } from "../contracts/source-import";
import { isCanonicalTargetRootPath } from "../foundation/validators";
import type { OperationDiagnostic } from "../types";
import type {
    ObservedNativeProjectGuidanceTargetContextResolution,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
} from "./native-project-guidance-profiles";
import { diagnostic, TARGET_KIND_FACT_KEY } from "./native-project-guidance-profiles";

export interface ReadyObservedTargetCandidate {
    targetCandidateId: string;
    targetKind: ProbeResult["observation"]["targetCandidates"][number]["targetKind"];
    evidenceLevel: SourceEvidenceLevel;
}

export function resolveReadyObservedTargetCandidate(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
):
    | { status: "complete"; candidate: ReadyObservedTargetCandidate }
    | Extract<ObservedNativeProjectGuidanceTargetContextResolution, { status: "failed" }> {
    if (input.probeResult.status === "failed") {
        return observedTargetFailure(
            "native_guidance_probe_failed",
            "A failed probe snapshot cannot authorize target rendering",
            "unavailable",
        );
    }
    const { accessRootPath, platform } = input.probeResult.observation.platformContext;
    if (
        !isCanonicalTargetRootPath(accessRootPath, platform) ||
        !isCanonicalTargetRootPath(input.targetRootPath, platform) ||
        !physicalAccessPathContains(accessRootPath, input.targetRootPath) ||
        (input.projectRootPath !== "" &&
            (!isCanonicalTargetRootPath(input.projectRootPath, platform) ||
                !physicalAccessPathContains(accessRootPath, input.projectRootPath)))
    ) {
        return observedTargetFailure(
            "native_guidance_target_root_invalid",
            "The selected target or Project root is not canonical within the probed platform root",
            "invalid_schema",
            input.targetRootPath,
        );
    }
    const matches = input.probeResult.observation.targetCandidates.filter(
        (candidate) => candidate.targetRootPath === input.targetRootPath,
    );
    if (matches.length !== 1) {
        return observedTargetFailure(
            matches.length === 0 ? "native_guidance_target_candidate_missing" : "native_guidance_target_candidate_ambiguous",
            matches.length === 0
                ? "The current probe has no exact physical target candidate for the selected write root"
                : "The current probe repeats the selected physical target root",
            "verification_failed",
            input.targetRootPath,
        );
    }
    const target = matches[0] as (typeof matches)[number];
    if (target.targetKind === "unknown" || target.diagnostics.some((item) => item.severity === "error")) {
        return observedTargetFailure(
            "native_guidance_target_candidate_invalid",
            "The exact physical target candidate is unknown or contains blocking diagnostics",
            "verification_failed",
            input.targetRootPath,
        );
    }
    const applicabilities = target.entryApplicabilities.filter((candidate) => candidate.agentRuntimeId === input.agentRuntimeId);
    if (applicabilities.length !== 1) {
        return observedTargetFailure(
            "native_guidance_target_applicability_invalid",
            "The exact physical target must contain one applicability for the selected agent runtime",
            "invalid_schema",
            input.targetRootPath,
        );
    }
    const applicability = applicabilities[0] as (typeof applicabilities)[number];
    const trustedEvidence = applicability.locatorEvidence
        .map((evidence) => evidence.evidenceLevel)
        .filter(trustedTargetLocatorEvidence)
        .sort((left, right) => targetLocatorEvidenceRank(right) - targetLocatorEvidenceRank(left));
    const evidenceLevel = trustedEvidence[0];
    if (
        applicability.status !== "ready_for_plan" ||
        applicability.diagnostics.some((item) => item.severity === "error") ||
        evidenceLevel === undefined
    ) {
        return observedTargetFailure(
            "native_guidance_target_not_ready",
            "The exact physical target is not ready for the selected agent runtime",
            applicability.status === "unknown" ? "unavailable" : "verification_failed",
            input.targetRootPath,
        );
    }
    return {
        status: "complete",
        candidate: { targetCandidateId: target.targetCandidateId, targetKind: target.targetKind, evidenceLevel },
    };
}

export function observedTargetFailure(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    diagnosticPath = "",
): Extract<ObservedNativeProjectGuidanceTargetContextResolution, { status: "failed" }> {
    return {
        status: "failed",
        diagnostics: [
            {
                ...diagnostic("render", code, message, causeKind, "error"),
                path: diagnosticPath,
            },
        ],
    };
}

export function trustedTargetLocatorEvidence(
    value: SourceEvidenceLevel | undefined,
): value is Extract<SourceEvidenceLevel, "agent_runtime_verified" | "local_artifact" | "user_provided"> {
    return value === "agent_runtime_verified" || value === "local_artifact" || value === "user_provided";
}

export function trustedNonProjectTargetFactEvidence(key: string, value: SourceEvidenceLevel | undefined): boolean {
    return key === TARGET_KIND_FACT_KEY ? trustedTargetLocatorEvidence(value) : value === "agent_runtime_verified";
}

function targetLocatorEvidenceRank(
    value: Extract<SourceEvidenceLevel, "agent_runtime_verified" | "local_artifact" | "user_provided">,
): number {
    if (value === "agent_runtime_verified") return 3;
    if (value === "local_artifact") return 2;
    return 1;
}
