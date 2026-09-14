import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { CatalogDeploymentState } from "./catalog-deployment-state";

export type CatalogDeploymentMutationKind = "deploy" | "scan" | "repair" | "recover";

const PREVIEW_INVALIDATION_DIAGNOSTICS = new Set([
    "host.review_record_unavailable",
    "render.preview_stale",
    "render.preview_action_mismatch",
]);
const RENDER_INVALIDATION_DIAGNOSTICS = new Set(["render.action_time_context_changed", "render.action_time_selection_changed"]);

type ReadyCatalogDeploymentState = Extract<CatalogDeploymentState, { readonly status: "ready" }>;

export function catalogDeploymentReviewedFilePaths(
    state: ReadyCatalogDeploymentState,
    kind: CatalogDeploymentMutationKind,
    deploymentId: string,
): readonly string[] {
    const prior = state.completedMutation;
    const recoveredReversePaths =
        kind === "recover" &&
        state.reverse.status === "result" &&
        state.reverse.deploymentId === deploymentId &&
        state.reverse.value.commitState === "committed"
            ? state.reverse.reviewedFilePaths
            : undefined;
    return Object.freeze(
        [
            ...(kind === "deploy" && state.preview.status === "ready"
                ? state.preview.value.files.map((file) => file.relativePath)
                : []),
            ...(kind === "repair" && state.inspection.status === "ready"
                ? state.inspection.value.details
                      .filter((detail) => detail.detailKind === "file_attribution")
                      .map((detail) => detail.displayName)
                : []),
            ...(recoveredReversePaths ??
                ((kind === "repair" || kind === "recover") && prior?.deploymentId === deploymentId
                    ? prior.reviewedFilePaths
                    : [])),
        ]
            .filter((filePath, index, paths) => filePath.trim() !== "" && paths.indexOf(filePath) === index)
            .sort(),
    );
}

export function catalogDeploymentCompletedMutation(
    kind: CatalogDeploymentMutationKind,
    deploymentId: string,
    reviewedFilePaths: readonly string[],
): Pick<ReadyCatalogDeploymentState, "completedMutation"> | Readonly<Record<string, never>> {
    if (kind === "scan") return Object.freeze({});
    return Object.freeze({
        completedMutation: Object.freeze({ kind, deploymentId, reviewedFilePaths }),
    });
}

export function catalogDeploymentInvalidation(
    kind: CatalogDeploymentMutationKind,
    diagnostics: readonly ProtocolDiagnosticV1[],
): Readonly<{ renderInvalid: boolean; previewInvalid: boolean }> {
    const renderInvalid = kind === "deploy" && diagnostics.some((item) => RENDER_INVALIDATION_DIAGNOSTICS.has(item.code));
    return Object.freeze({
        renderInvalid,
        previewInvalid:
            renderInvalid || (kind === "deploy" && diagnostics.some((item) => PREVIEW_INVALIDATION_DIAGNOSTICS.has(item.code))),
    });
}
