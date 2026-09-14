import { getCanonicalPhysicalAccessPathKind, isSelectedWslPhysicalRootMapping } from "@oaam/shared/paths";
/** Select one target implementation per authorized operation; callers use the same semantic methods. */
import type { ImportSourceSnapshotV1 } from "../contracts/persistence";
import { resolveDeploymentContainerPatches } from "../deployment/deployment-container-patch";
import { captureDeploymentPreWritePreview } from "../deployment/deployment-prewrite-preview";
import type { DeploymentTargetTransactions } from "../deployment/deployment-target-transaction";
import { bindLocalTargetTransactions } from "../deployment/local-target-transaction";
import { selectedWslTargetTransactions } from "../deployment/selected-wsl-target-transaction";
import type { TargetCheckObservationSnapshot } from "../render/native-project-target-observation-snapshot";
import type { CoreRenderMaterializationView } from "../render/render-materialization-contract";
import type { PosixRelativePath } from "../types";
import { assetUsageTargetFailureObservation } from "./asset-usage-target-diagnostics";
import {
    type AssetUsageTargetObservation,
    createAssetUsageTargetExpectation,
    observeAssetUsageExpectedTargets,
    observeAssetUsageTargetAsync,
    primeAssetUsageTargetFilesForCheck,
} from "./asset-usage-target-observation";
import { captureDeploymentInspectionTarget } from "./deployment-inspection-capture";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import type { RenderBaseAuthority } from "./deployment-render-authority";
import { selectPlatformContext } from "./deployment-render-probe-snapshot";
import { type CaptureMemoryCatalogTargets, captureMemoryCatalogTargets } from "./deployment-render-target-snapshot";
import type { AssetUsageTargetReview } from "./restricted-target-read-channel";
import type { DeploymentTargetReview } from "./restricted-target-review-channel";
import { withSelectedWslTargetExecution } from "./selected-wsl-target-execution";

export interface AssetUsageTargetOperations {
    readonly review: AssetUsageTargetReview;
    primeUsageFiles(relativePaths: readonly PosixRelativePath[], snapshot?: TargetCheckObservationSnapshot): Promise<void>;
    observeUsageTargets(
        materializations: readonly CoreRenderMaterializationView[],
        sourceSnapshot?: ImportSourceSnapshotV1,
        snapshot?: TargetCheckObservationSnapshot,
    ): Promise<readonly AssetUsageTargetObservation[]>;
}

export interface DeploymentTargetOperations {
    readonly execution: DeploymentTargetTransactions;
    readonly review: DeploymentTargetReview;
}

export async function withAssetUsageTargetOperations<T>(
    configuration: Parameters<typeof withSelectedWslTargetExecution>[0],
    target: Parameters<typeof withSelectedWslTargetExecution>[1],
    run: (operations: AssetUsageTargetOperations) => T | Promise<T>,
): Promise<T> {
    if (target.platform !== "wsl" || getCanonicalPhysicalAccessPathKind(target.targetRootPath) !== "win32") {
        return withDeploymentTargetOperations(configuration, target, (operations) => {
            const platformContext = selectPlatformContext(
                [...configuration.platformContexts],
                target.platform,
                target.platformInstanceId,
                target.targetRootPath,
            );
            return run(
                Object.freeze<AssetUsageTargetOperations>({
                    review: operations.review,
                    primeUsageFiles(relativePaths, targetCheckSnapshot) {
                        return primeAssetUsageTargetFilesForCheck({
                            relativePaths,
                            targetRootPath: target.targetRootPath,
                            platformContext,
                            targetCheckSnapshot,
                        });
                    },
                    observeUsageTargets(materializations, sourceSnapshot, targetCheckSnapshot) {
                        return Promise.all(
                            materializations.map((materialization) =>
                                observeAssetUsageTargetAsync({
                                    materialization,
                                    targetRootPath: target.targetRootPath,
                                    platformContext,
                                    sourceSnapshot,
                                    targetCheckSnapshot,
                                }),
                            ),
                        );
                    },
                }),
            );
        });
    }
    const owner = configuration.selectedWslTargetExecution;
    if (owner?.withUsageTarget === undefined) {
        throw new DeploymentRenderFailure(
            "render.selected_wsl_usage_unavailable",
            "Selected WSL asset usage execution is unavailable",
            "unavailable",
            false,
            [],
        );
    }
    const platformContext = selectPlatformContext(
        [...configuration.platformContexts],
        target.platform,
        target.platformInstanceId,
        target.targetRootPath,
    );
    return owner.withUsageTarget({ platformContext, targetRootPath: target.targetRootPath }, (execution) => {
        const binding = execution.binding;
        if (
            binding.kind !== "asset_usage" ||
            "deploymentId" in binding ||
            binding.targetRootPath !== target.targetRootPath ||
            binding.platformInstanceId !== target.platformInstanceId ||
            !isSelectedWslPhysicalRootMapping(binding.targetRootPath, binding.executionRootPath, binding.platformInstanceId) ||
            execution.review === undefined
        ) {
            throw new DeploymentRenderFailure(
                "render.selected_wsl_usage_mismatch",
                "Selected WSL usage execution does not own this exact target",
                "unavailable",
                false,
                [],
            );
        }
        return run(
            Object.freeze<AssetUsageTargetOperations>({
                review: execution.review,
                async primeUsageFiles() {},
                async observeUsageTargets(materializations, sourceSnapshot) {
                    const prepared = materializations.map((value) => {
                        try {
                            return {
                                state: "expected" as const,
                                value: createAssetUsageTargetExpectation(value, sourceSnapshot),
                            };
                        } catch (error) {
                            return { state: "failed" as const, value: assetUsageTargetFailureObservation(error) };
                        }
                    });
                    const expectations = prepared.flatMap((item) => (item.state === "expected" ? [item.value] : []));
                    const observations = expectations.length === 0 ? [] : execution.review.observeAssetUsageTargets(expectations);
                    let observedIndex = 0;
                    return prepared.map((item) => (item.state === "failed" ? item.value : observations[observedIndex++]!));
                },
            }),
        );
    });
}

export async function withDeploymentTargetOperations<T>(
    configuration: Parameters<typeof withSelectedWslTargetExecution>[0],
    target: Parameters<typeof withSelectedWslTargetExecution>[1],
    run: (operations: DeploymentTargetOperations) => T | Promise<T>,
): Promise<T> {
    if (target.platform === "wsl" && getCanonicalPhysicalAccessPathKind(target.targetRootPath) === "win32") {
        return withSelectedWslTargetExecution(configuration, target, (execution) =>
            run(
                Object.freeze<DeploymentTargetOperations>({
                    execution: selectedWslTargetTransactions(execution),
                    review: execution.review,
                }),
            ),
        );
    }
    const platformContext = selectPlatformContext(
        [...configuration.platformContexts],
        target.platform,
        target.platformInstanceId,
        target.targetRootPath,
    );
    const targetRootPath = target.targetRootPath;
    const requireRoot = (value: string): void => {
        if (value !== targetRootPath) throw new Error("local target operation root mismatch");
    };
    const review = Object.freeze<DeploymentTargetReview>({
        capturePreWritePreview(input) {
            requireRoot(input.targetRootPath);
            if (input.deploymentId !== target.deploymentId) throw new Error("local target operation Deployment mismatch");
            return captureDeploymentPreWritePreview(input);
        },
        captureInspectionTarget(plan, root) {
            requireRoot(root);
            return captureDeploymentInspectionTarget(plan, targetRootPath);
        },
        captureMemoryCatalogTargets(paths, root) {
            requireRoot(root);
            return captureMemoryCatalogTargets(paths, targetRootPath);
        },
        resolveContainerPatches(materialization) {
            return resolveDeploymentContainerPatches(materialization, targetRootPath);
        },
        observeAssetUsageTargets(expectations) {
            return observeAssetUsageExpectedTargets({ expectations, targetRootPath, platformContext });
        },
    });
    return run(
        Object.freeze<DeploymentTargetOperations>({
            execution: bindLocalTargetTransactions(target),
            review,
        }),
    );
}

/** Only an actual Memory Catalog requirement opens the physical target during ordinary analysis. */
export async function withSelectedMemoryCatalogCapture<T>(
    configuration: Parameters<typeof withDeploymentTargetOperations>[0],
    base: RenderBaseAuthority,
    run: (capture: CaptureMemoryCatalogTargets | undefined) => T | Promise<T>,
): Promise<T> {
    if (
        !base.assets.some(
            (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
        )
    )
        return run(undefined);
    return withDeploymentTargetOperations(configuration, base, (operations) =>
        run(operations.review.captureMemoryCatalogTargets),
    );
}
