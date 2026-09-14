/** Shared read-only Target captures, with no graph or Deployment authority. */
import type { CoreResult } from "../types";
import { completeResult } from "../foundation/core-result";
import { hasExactKeys, isSha256Digest } from "../foundation/validators";
import type { CoreRenderMaterializationView } from "../render/render-materialization-contract";
import {
    deploymentContainerPatchIntents,
    resolveCapturedDeploymentContainerPatches,
} from "../deployment/deployment-container-patch";
import { DeploymentPreWritePreviewError } from "../deployment/deployment-prewrite-preview";
import type {
    RestrictedTargetRootBinding,
    RestrictedTargetOperation,
    RestrictedTargetResult,
} from "../deployment/restricted-target-contract";
import {
    decodeRestrictedContainerCapture,
    encodeRestrictedContainerPatches,
    isRestrictedContainerFailure,
} from "../deployment/restricted-target-container-codec";
import { isMemoryCatalogTargetPaths, type CaptureMemoryCatalogTargets } from "./deployment-render-target-snapshot";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import type { AssetUsageTargetExpectation, AssetUsageTargetObservation } from "./asset-usage-target-observation";
import {
    encodeRestrictedUsageExpectations,
    isRestrictedUsageObservation,
    restrictedUsageExpectationFingerprint,
} from "./restricted-target-usage-codec";

export interface AssetUsageTargetReview {
    observeAssetUsageTargets(expectations: readonly AssetUsageTargetExpectation[]): readonly AssetUsageTargetObservation[];
    captureMemoryCatalogTargets: CaptureMemoryCatalogTargets;
    resolveContainerPatches(materialization: CoreRenderMaterializationView): CoreResult<CoreRenderMaterializationView>;
}

export function bindRestrictedTargetReadChannel(
    binding: RestrictedTargetRootBinding,
    call: (operation: RestrictedTargetOperation) => RestrictedTargetResult,
    invalidate: () => void,
): AssetUsageTargetReview {
    return Object.freeze<AssetUsageTargetReview>({
        observeAssetUsageTargets(expectations) {
            try {
                const result = call({ kind: "asset_usage", expectations: encodeRestrictedUsageExpectations(expectations) });
                if (
                    result.kind !== "asset_usage" ||
                    !hasExactKeys(result, ["kind", "observations"]) ||
                    !Array.isArray(result.observations) ||
                    result.observations.length !== expectations.length ||
                    !result.observations.every(
                        (item, index) =>
                            hasExactKeys(item, ["expectationFingerprint", "observation"]) &&
                            item.expectationFingerprint === restrictedUsageExpectationFingerprint(expectations[index]!) &&
                            isRestrictedUsageObservation(item.observation),
                    )
                )
                    throw new Error("invalid restricted asset usage observations");
                return result.observations.map((item) => structuredClone(item.observation));
            } catch (error) {
                invalidate();
                throw new DeploymentRenderFailure(
                    "render.selected_wsl_usage_unavailable",
                    `Selected WSL asset usage capture failed: ${String(error)}`,
                    "unavailable",
                    true,
                    [],
                );
            }
        },
        captureMemoryCatalogTargets(paths, targetRootPath) {
            let refusal: DeploymentRenderFailure | undefined;
            try {
                if (targetRootPath !== binding.targetRootPath || !isMemoryCatalogTargetPaths(paths))
                    throw new Error("invalid restricted Memory Catalog target closure");
                const result = call({ kind: "memory_catalog_snapshots", paths: [...paths] });
                if (result.kind !== "memory_catalog_snapshots")
                    throw new Error("restricted Memory Catalog snapshot result mismatch");
                if (result.outcome === "failed") {
                    if (
                        !hasExactKeys(result, ["kind", "outcome", "code", "message", "retryable"]) ||
                        typeof result.message !== "string" ||
                        !(
                            (result.code === "render.shared_target_unavailable" && result.retryable === true) ||
                            (result.code === "render.shared_target_path_closure_invalid" && result.retryable === false)
                        )
                    )
                        throw new Error("invalid restricted Memory Catalog failure");
                    refusal = new DeploymentRenderFailure(result.code, result.message, "unavailable", result.retryable, []);
                    throw refusal;
                }
                if (
                    result.outcome !== "captured" ||
                    !hasExactKeys(result, ["kind", "outcome", "snapshots"]) ||
                    !Array.isArray(result.snapshots) ||
                    result.snapshots.length !== paths.length
                )
                    throw new Error("invalid restricted Memory Catalog snapshots");
                for (const [index, snapshot] of result.snapshots.entries()) {
                    if (snapshot?.relativePath !== paths[index])
                        throw new Error("restricted Memory Catalog snapshot paths changed");
                    if (snapshot.snapshotState === "missing") {
                        if (!hasExactKeys(snapshot, ["relativePath", "snapshotState"]))
                            throw new Error("invalid missing Memory Catalog snapshot");
                    } else if (
                        snapshot.snapshotState !== "present" ||
                        !hasExactKeys(snapshot, ["relativePath", "snapshotState", "contentHash", "byteSize", "executable"]) ||
                        !isSha256Digest(snapshot.contentHash) ||
                        !Number.isSafeInteger(snapshot.byteSize) ||
                        snapshot.byteSize < 0 ||
                        snapshot.byteSize > 4 * 1024 * 1024 ||
                        typeof snapshot.executable !== "boolean"
                    )
                        throw new Error("invalid present Memory Catalog snapshot");
                }
                return structuredClone(result.snapshots);
            } catch (error) {
                if (refusal !== undefined && error === refusal) throw error;
                invalidate();
                throw new DeploymentRenderFailure(
                    "render.shared_target_unavailable",
                    `Memory Catalog target snapshot failed: ${String(error)}`,
                    "unavailable",
                    true,
                    [],
                );
            }
        },
        resolveContainerPatches(materialization) {
            try {
                const intents = deploymentContainerPatchIntents(materialization);
                if (intents.length === 0) return completeResult(structuredClone(materialization));
                const result = call({ kind: "container_patches", intents: encodeRestrictedContainerPatches(intents) });
                if (result.kind !== "container_patches") throw new Error("restricted container patch result mismatch");
                if (result.outcome === "failed") {
                    if (!hasExactKeys(result, ["kind", "outcome", "failure"]) || !isRestrictedContainerFailure(result.failure))
                        throw new Error("invalid restricted container patch failure");
                    return {
                        status: "failed",
                        value: undefined as unknown as CoreRenderMaterializationView,
                        diagnostics: [
                            {
                                ...structuredClone(result.failure),
                                severity: "error",
                                operation: "render",
                                path: "",
                                traceId: "",
                                suggestedActions: [],
                                rawSummary: "",
                            },
                        ],
                    };
                }
                if (result.outcome !== "captured" || !hasExactKeys(result, ["kind", "outcome", "targets"]))
                    throw new Error("invalid restricted container capture");
                const captured = decodeRestrictedContainerCapture(result.targets);
                const paths = new Set(intents.map((intent) => intent.relativePath));
                if (
                    captured === null ||
                    captured.length !== paths.size ||
                    captured.some((target) => !paths.has(target.relativePath))
                )
                    throw new Error("restricted container capture changes its reviewed targets");
                return resolveCapturedDeploymentContainerPatches(materialization, captured);
            } catch (error) {
                invalidate();
                throw new DeploymentPreWritePreviewError("render.preview_target_unavailable", String(error));
            }
        },
    });
}
