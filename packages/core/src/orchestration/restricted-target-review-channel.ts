import { bindRestrictedTargetReadChannel, type AssetUsageTargetReview } from "./restricted-target-read-channel";
/** Host recomputes review and container patches from one bound service observation. */
import { hasExactKeys } from "../foundation/validators";
import {
    DeploymentPreWritePreviewError,
    projectCapturedDeploymentPreWritePreview,
    type CapturedDeploymentPreWritePreview,
    type DeploymentPreWritePreviewInput,
} from "../deployment/deployment-prewrite-preview";
import type {
    RestrictedTargetBinding,
    RestrictedTargetOperation,
    RestrictedTargetResult,
} from "../deployment/restricted-target-contract";
import { decodeRestrictedReplacementAuthority } from "../deployment/restricted-target-graph-codec";
import { encodeRestrictedPreview } from "../deployment/restricted-target-preview-codec";
import {
    validateCapturedDeploymentInspectionTarget,
    type CaptureDeploymentInspectionTarget,
} from "./deployment-inspection-capture";
import { DeploymentInspectionFailure } from "./deployment-inspection-errors";
import { decodeRestrictedInspectionFailure, decodeRestrictedInspectionPlan } from "./restricted-target-inspection-codec";

export interface DeploymentTargetReview extends AssetUsageTargetReview {
    capturePreWritePreview(input: DeploymentPreWritePreviewInput): CapturedDeploymentPreWritePreview;
    captureInspectionTarget: CaptureDeploymentInspectionTarget;
}

/** A validated business refusal leaves the session usable; malformed captures still retire it. */
class RestrictedPreviewRefusal extends DeploymentPreWritePreviewError {}

export function bindRestrictedTargetReviewChannel(
    binding: RestrictedTargetBinding,
    call: (binding: RestrictedTargetBinding, operation: RestrictedTargetOperation) => RestrictedTargetResult,
    invalidate: () => void,
): DeploymentTargetReview {
    return Object.freeze<DeploymentTargetReview>({
        ...bindRestrictedTargetReadChannel(binding, (operation) => call(binding, operation), invalidate),
        captureInspectionTarget(plan, targetRootPath) {
            let refusal: Error | undefined;
            try {
                if (targetRootPath !== binding.targetRootPath) throw new Error("restricted inspection target binding mismatch");
                const validated = decodeRestrictedInspectionPlan(plan);
                if (validated === null) throw new Error("invalid restricted inspection input");
                const result = call(binding, { kind: "inspection_capture", plan: validated });
                if (result.kind !== "inspection_capture") throw new Error("restricted inspection result mismatch");
                if (result.outcome === "failed") {
                    if (!hasExactKeys(result, ["kind", "outcome", "failure"]))
                        throw new Error("invalid restricted inspection failure");
                    const error = decodeRestrictedInspectionFailure(result.failure, binding.targetRootPath);
                    if (error === null) throw new Error("invalid restricted inspection failure taxonomy");
                    refusal = error;
                    throw error;
                }
                if (result.outcome !== "captured" || !hasExactKeys(result, ["kind", "outcome", "authority"]))
                    throw new Error("invalid restricted inspection capture");
                const authority = decodeRestrictedReplacementAuthority(result.authority);
                if (authority === null) throw new Error("invalid restricted inspection bytes or identities");
                validateCapturedDeploymentInspectionTarget(plan, authority);
                return authority;
            } catch (error) {
                if (refusal !== undefined && error === refusal) throw error;
                invalidate();
                throw new DeploymentInspectionFailure(
                    "scan.inspection_unavailable",
                    `Deployment inspection authority is unavailable: ${String(error)}`,
                    "unavailable",
                    true,
                );
            }
        },
        capturePreWritePreview(input) {
            try {
                if (input.deploymentId !== binding.deploymentId || input.targetRootPath !== binding.targetRootPath)
                    throw new Error("restricted preview target binding mismatch");
                const result = call(binding, { kind: "preview", input: encodeRestrictedPreview(input) });
                if (result.kind !== "preview") throw new Error("restricted preview result mismatch");
                if (result.outcome === "failed") {
                    if (
                        !hasExactKeys(result, ["kind", "outcome", "code", "message"]) ||
                        typeof result.message !== "string" ||
                        ![
                            "render.preview_target_invalid",
                            "render.preview_target_unavailable",
                            "render.preview_file_limit",
                            "render.preview_text_limit",
                        ].includes(result.code)
                    )
                        throw new Error("invalid restricted preview failure");
                    throw new RestrictedPreviewRefusal(result.code, result.message);
                }
                if (result.outcome !== "captured" || !hasExactKeys(result, ["kind", "outcome", "authority"]))
                    throw new Error("invalid restricted preview capture");
                const authority = decodeRestrictedReplacementAuthority(result.authority);
                if (authority === null) throw new Error("invalid restricted preview bytes or identities");
                return projectCapturedDeploymentPreWritePreview(input, authority);
            } catch (error) {
                if (error instanceof RestrictedPreviewRefusal) throw error;
                invalidate();
                if (error instanceof DeploymentPreWritePreviewError) throw error;
                throw new DeploymentPreWritePreviewError("render.preview_target_unavailable", String(error));
            }
        },
    });
}
