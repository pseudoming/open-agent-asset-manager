/** Trusted App Server lifetime around an already authorized Deployment target operation. */
import { getCanonicalPhysicalAccessPathKind, isSelectedWslPhysicalRootMapping } from "@oaam/shared/paths";
import type { AssetUsageTargetExecution, DeploymentTargetExecution } from "./restricted-target-channel";
import type { Platform, PlatformContext } from "../types";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import { selectPlatformContext } from "./deployment-render-probe-snapshot";

export interface SelectedWslTargetRequest {
    readonly platformContext: PlatformContext;
    readonly deploymentId: string;
    readonly targetRootPath: string;
}

export type SelectedWslUsageTargetRequest = Omit<SelectedWslTargetRequest, "deploymentId">;

export interface SelectedWslTargetExecution {
    withTarget<T>(request: SelectedWslTargetRequest, run: (execution: DeploymentTargetExecution) => T | Promise<T>): Promise<T>;
    withUsageTarget<T>(
        request: SelectedWslUsageTargetRequest,
        run: (execution: AssetUsageTargetExecution) => T | Promise<T>,
    ): Promise<T>;
}

/** Core selects the logical Environment; Bootstrap owns process admission and release. */
export async function withSelectedWslTargetExecution<T>(
    configuration: { platformContexts: readonly PlatformContext[]; selectedWslTargetExecution?: SelectedWslTargetExecution },
    target: { platform: Platform; platformInstanceId: string; deploymentId: string; targetRootPath: string },
    run: (execution: DeploymentTargetExecution) => T | Promise<T>,
): Promise<T> {
    if (target.platform !== "wsl" || getCanonicalPhysicalAccessPathKind(target.targetRootPath) !== "win32") {
        throw new DeploymentRenderFailure(
            "render.selected_wsl_target_mismatch",
            "Selected WSL execution requires its exact physical target",
            "unavailable",
            false,
            [],
        );
    }
    if (configuration.selectedWslTargetExecution === undefined) {
        throw new DeploymentRenderFailure(
            "render.selected_wsl_target_unavailable",
            "Selected WSL target execution is unavailable",
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
    return configuration.selectedWslTargetExecution.withTarget(
        { platformContext, deploymentId: target.deploymentId, targetRootPath: target.targetRootPath },
        (execution) => {
            const binding = execution.binding;
            if (
                binding.deploymentId !== target.deploymentId ||
                binding.targetRootPath !== target.targetRootPath ||
                binding.platformInstanceId !== target.platformInstanceId ||
                !isSelectedWslPhysicalRootMapping(
                    binding.targetRootPath,
                    binding.executionRootPath,
                    binding.platformInstanceId,
                ) ||
                execution.graph === undefined ||
                execution.review === undefined
            ) {
                throw new DeploymentRenderFailure(
                    "render.selected_wsl_target_mismatch",
                    "Selected WSL execution does not own this exact Deployment target",
                    "unavailable",
                    false,
                    [],
                );
            }
            return run(execution);
        },
    );
}
