import { useEffect, useRef } from "react";
import type { CatalogDeploymentController } from "./catalog-deployment-controller";
import {
    type AssetUsageAnalysisRequest,
    type DeploymentTargetView,
    type DeploymentView,
    deploymentTargetForDeployment,
} from "./catalog-deployment-model";
import type { CatalogDeploymentState } from "./catalog-deployment-state";

interface CatalogAssetUsageInput {
    readonly controller: CatalogDeploymentController;
    readonly state: CatalogDeploymentState;
    readonly initialAssetId: string | undefined;
    readonly requests: readonly AssetUsageAnalysisRequest[];
    readonly requestKey: string;
    readonly targets: readonly DeploymentTargetView[];
    readonly probeToken: string | undefined;
    readonly onSettled: (() => void) | undefined;
}

export function useCatalogAssetUsage({
    controller,
    state,
    initialAssetId,
    requests,
    requestKey,
    targets,
    probeToken,
    onSettled,
}: CatalogAssetUsageInput): void {
    const observedDeployments = useRef<
        | {
              readonly requestKey: string;
              readonly deployments: readonly DeploymentView[];
          }
        | undefined
    >(undefined);
    useEffect(() => {
        if (initialAssetId === undefined || state.status !== "ready") return;
        if (state.activity.status !== "idle" || state.reverse.status === "prepared") return;
        if (requests.length === 0) {
            observedDeployments.current = undefined;
            if (state.assetUsage.status !== "none") void controller.analyzeAssetUsage("reset", []);
            return;
        }
        if (state.assetUsage.status === "none" || state.assetUsage.requestKey !== requestKey) {
            observedDeployments.current = { requestKey, deployments: state.deployments };
            void controller.analyzeAssetUsage(requestKey, requests);
            return;
        }
        if (state.assetUsage.status !== "ready") return;
        const previous = observedDeployments.current;
        observedDeployments.current = { requestKey, deployments: state.deployments };
        if (previous?.requestKey !== requestKey || previous.deployments === state.deployments) return;
        const previousById = new Map(previous.deployments.map((deployment) => [deployment.deploymentId, deployment]));
        const currentIds = new Set(state.deployments.map((deployment) => deployment.deploymentId));
        const changed = [
            ...state.deployments.filter(
                (deployment) => JSON.stringify(previousById.get(deployment.deploymentId)) !== JSON.stringify(deployment),
            ),
            ...previous.deployments.filter((deployment) => !currentIds.has(deployment.deploymentId)),
        ];
        const changedTargetKeys = new Set(
            changed.flatMap((deployment) => {
                const target = deploymentTargetForDeployment(targets, deployment);
                return target === undefined ? [] : [target.key];
            }),
        );
        const changedRequests = requests.filter((request) => changedTargetKeys.has(request.targetKey));
        if (changedRequests.length > 0) {
            // Re-read the exact affected target; never turn a persisted Deployment into fabricated disk evidence.
            void controller.refreshAssetUsageTargets(requestKey, changedRequests);
        }
    }, [controller, initialAssetId, requestKey, requests, state, targets]);
    useEffect(() => {
        if (onSettled === undefined || initialAssetId === undefined || probeToken === undefined || state.status !== "ready")
            return;
        if (
            requests.length === 0 ||
            ((state.assetUsage.status === "ready" || state.assetUsage.status === "failed") &&
                state.assetUsage.requestKey === requestKey)
        ) {
            onSettled();
        }
    }, [initialAssetId, onSettled, probeToken, requestKey, requests.length, state]);
}
