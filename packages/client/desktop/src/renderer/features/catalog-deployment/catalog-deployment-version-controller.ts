import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopDisplayText, localizedText, mergeNonInformationalProtocolDiagnostics } from "../../presentation";
import { type DeploymentView, replaceCatalogProjectionById } from "./catalog-deployment-model";
import type { CatalogDeploymentState } from "./catalog-deployment-state";

interface VersionUpdateOptions {
    readonly client: DesktopApplicationClientApi;
    readonly current: () => CatalogDeploymentState;
    readonly transition: (state: CatalogDeploymentState) => void;
    readonly nextGeneration: () => number;
    readonly isCurrentGeneration: (generation: number) => boolean;
    readonly busy: () => boolean;
    readonly start: () => void;
    readonly fail: (message: DesktopDisplayText, diagnostics?: readonly ProtocolDiagnosticV1[]) => void;
    readonly failThrown: (error: unknown, mutation: boolean) => void;
    readonly reload: () => Promise<void>;
    readonly analyze: (deploymentId: string) => Promise<void>;
}

export interface DeploymentVersionUpdate {
    readonly deploymentId: string;
    readonly assetId: string;
    readonly previousVersionId: string;
    readonly versionId: string;
    readonly allowIncomplete: boolean;
}

function sameSelection(left: DeploymentView, right: DeploymentView): boolean {
    return (
        left.deploymentId === right.deploymentId &&
        !right.deleted &&
        left.targetRootPath === right.targetRootPath &&
        left.environment.platform === right.environment.platform &&
        left.environment.platformInstanceId === right.environment.platformInstanceId &&
        left.subject.subjectKind === right.subject.subjectKind &&
        (left.subject.subjectKind !== "project" ||
            (right.subject.subjectKind === "project" && left.subject.projectId === right.subject.projectId)) &&
        left.consumerAgentRuntimeIds.length === right.consumerAgentRuntimeIds.length &&
        left.consumerAgentRuntimeIds.every((id, index) => id === right.consumerAgentRuntimeIds[index]) &&
        left.assets.length === right.assets.length &&
        left.assets.every((asset, index) => {
            const current = right.assets[index];
            return (
                current !== undefined &&
                asset.assetId === current.assetId &&
                asset.versionId === current.versionId &&
                asset.allowIncomplete === current.allowIncomplete
            );
        })
    );
}

export class CatalogDeploymentVersionController {
    public constructor(private readonly options: VersionUpdateOptions) {}

    public async update(input: DeploymentVersionUpdate): Promise<void> {
        const state = this.options.current();
        if (
            state.status !== "ready" ||
            this.options.busy() ||
            state.stale ||
            state.requiresReconciliation ||
            !this.options.client.supportsOperation("deployment.update_inputs")
        )
            return;
        const deployment = state.deployments.find((value) => value.deploymentId === input.deploymentId);
        const firstConsumer = deployment?.consumerAgentRuntimeIds[0];
        const asset = state.assets.find((value) => value.assetId === input.assetId && !value.deleted);
        const selected = deployment?.assets.find((value) => value.assetId === input.assetId);
        if (
            deployment === undefined ||
            firstConsumer === undefined ||
            deployment.deleted ||
            asset === undefined ||
            selected === undefined ||
            deployment.actionHints.some((hint) => hint === "recover" || hint === "contact_support") ||
            selected.versionId !== input.previousVersionId ||
            asset.currentVersionId !== input.versionId ||
            selected.versionId === input.versionId ||
            (asset.currentVersionStatus === "incomplete" && !input.allowIncomplete)
        )
            return;
        const generation = this.options.nextGeneration();
        this.options.start();
        let mutating = false;
        try {
            const current = await this.options.client.getDeployment({ deploymentId: input.deploymentId });
            if (!this.options.isCurrentGeneration(generation)) return;
            const observed = this.options.current();
            if (
                current.status !== "complete" ||
                !current.value.found ||
                current.value.value === undefined ||
                !sameSelection(deployment, current.value.value) ||
                current.value.value.actionHints.some((hint) => hint === "recover" || hint === "contact_support") ||
                observed.status !== "ready" ||
                observed.stale ||
                observed.requiresReconciliation
            ) {
                this.options.fail(localizedText("catalog.version_update.changed"), current.diagnostics);
                const failed = this.options.current();
                if (failed.status === "ready") this.options.transition(Object.freeze({ ...failed, stale: true }));
                return;
            }
            const [first, ...rest] = deployment.assets.map((value) =>
                value.assetId === input.assetId
                    ? { ...value, versionId: input.versionId, allowIncomplete: input.allowIncomplete }
                    : value,
            );
            if (first === undefined) throw new Error("The selected Asset is no longer part of this location");
            mutating = true;
            const result = await this.options.client.updateDeploymentInputs({
                deploymentId: input.deploymentId,
                assets: [first, ...rest],
                expectedInputs: {
                    consumerAgentRuntimeIds: [firstConsumer, ...deployment.consumerAgentRuntimeIds.slice(1)],
                    assets: [...deployment.assets],
                },
            });
            if (!this.options.isCurrentGeneration(generation)) return;
            const latest = this.options.current();
            if (latest.status !== "ready") return;
            if (result.status === "failed") {
                const changed = result.diagnostics.some((diagnostic) => diagnostic.code === "deploy.inputs_changed");
                this.options.fail(
                    localizedText(changed ? "catalog.version_update.changed" : "catalog.version_update.failed"),
                    result.diagnostics,
                );
                const failed = this.options.current();
                if (changed && failed.status === "ready") this.options.transition(Object.freeze({ ...failed, stale: true }));
                return;
            }
            this.options.transition(
                Object.freeze({
                    ...latest,
                    deployments: replaceCatalogProjectionById(latest.deployments, result.value, (value) => value.deploymentId),
                    analysis: Object.freeze({ status: "none" }),
                    preview: Object.freeze({ status: "none" }),
                    inspection: Object.freeze({ status: "none" }),
                    reverse: Object.freeze({ status: "none" }),
                    completedMutation: undefined,
                    activity: Object.freeze({ status: "idle" }),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(latest.diagnostics, result.diagnostics),
                }),
            );
            await this.options.reload();
            const refreshed = this.options.current();
            if (
                refreshed.status === "ready" &&
                refreshed.deployments.some(
                    (value) =>
                        value.deploymentId === input.deploymentId &&
                        value.assets.some((entry) => entry.assetId === input.assetId && entry.versionId === input.versionId),
                )
            ) {
                await this.options.analyze(input.deploymentId);
            }
        } catch (error) {
            if (this.options.isCurrentGeneration(generation)) this.options.failThrown(error, mutating);
        }
    }
}
