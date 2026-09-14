import { projectDisplayName } from "../../presentation/project-label";
import type {
    ProtocolDiagnosticV1,
    ProtocolInvalidationV1,
    ProtocolOperationParams,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi, DesktopLongOperationUpdate } from "../../client";
import { type DesktopDisplayText, localizedText, mergeNonInformationalProtocolDiagnostics } from "../../presentation";
import { CatalogAssetDetailController } from "./catalog-asset-detail-controller";
import { CatalogAssetUsageController } from "./catalog-asset-usage-controller";
import type {
    AssetUsageAnalysisRequest,
    DeploymentTargetView,
    DeploymentView,
    RenderOptionSelection,
} from "./catalog-deployment-model";
import {
    buildRenderSelection,
    deploymentStatusMessage,
    replaceCatalogProjectionById as replaceById,
} from "./catalog-deployment-model";
import {
    type CatalogDeploymentMutationKind,
    catalogDeploymentCompletedMutation,
    catalogDeploymentInvalidation,
    catalogDeploymentReviewedFilePaths,
} from "./catalog-deployment-mutation-result";
import { CatalogDeploymentReverseController, reverseDeploymentId } from "./catalog-deployment-reverse-controller";
import {
    type CatalogDeploymentState,
    catalogDeploymentDeliveryIsUncertain as isUncertainDelivery,
    type OrdinaryCatalogDeploymentActivityKind,
    catalogDeploymentOperationLabel as operationLabel,
} from "./catalog-deployment-state";
import { CatalogDeploymentVersionController, type DeploymentVersionUpdate } from "./catalog-deployment-version-controller";
import { CatalogPromotionAuthorizationController } from "./catalog-promotion-authorization-controller";

export type {
    CatalogAssetDetailState,
    CatalogDeploymentActivity,
    CatalogDeploymentState,
    DeploymentAnalysisState,
    DeploymentInspectionState,
    DeploymentPreviewState,
    DeploymentReverseState,
} from "./catalog-deployment-state";

export type CatalogDeploymentControllerOptions = Readonly<{ createUserActionId: () => string }>;

type DeploymentTerminalOperation = "deployment.deploy" | "deployment.scan" | "deployment.repair" | "deployment.recover";

export class CatalogDeploymentController {
    readonly #client: DesktopApplicationClientApi;
    readonly #options: CatalogDeploymentControllerOptions;
    readonly #assetDetailController: CatalogAssetDetailController;
    readonly #assetUsageController: CatalogAssetUsageController;
    readonly #promotionAuthorizationController: CatalogPromotionAuthorizationController;
    readonly #reverseController: CatalogDeploymentReverseController;
    readonly #versionController: CatalogDeploymentVersionController;
    readonly #listeners = new Set<(state: CatalogDeploymentState) => void>();
    #state: CatalogDeploymentState = Object.freeze({ status: "loading", message: localizedText("catalog.loading") });
    #generation = 0;
    #unsubscribeInvalidation: (() => void) | undefined;

    public constructor(client: DesktopApplicationClientApi, options: CatalogDeploymentControllerOptions) {
        this.#client = client;
        this.#options = options;
        this.#assetUsageController = new CatalogAssetUsageController({
            client,
            current: () => this.#state,
            transition: (state) => this.#transition(state),
            busy: () => this.#busy(),
        });
        this.#assetDetailController = new CatalogAssetDetailController({
            client,
            current: () => this.#state,
            transition: (state) => this.#transition(state),
            nextOwnerGeneration: () => ++this.#generation,
            isCurrentOwnerGeneration: (generation) => generation === this.#generation,
            busy: () => this.#busy(),
        });
        this.#promotionAuthorizationController = new CatalogPromotionAuthorizationController({
            client,
            current: () => this.#state,
            transition: (state) => this.#transition(state),
            nextOwnerGeneration: () => ++this.#generation,
            isCurrentOwnerGeneration: (generation) => generation === this.#generation,
            busy: () => this.#busy(),
            createUserActionId: options.createUserActionId,
            start: () => this.#startImmediate("authorize"),
            fail: (message, diagnostics) => this.#finishFailure(message, diagnostics),
            failThrown: (error) => this.#finishThrown(operationLabel("authorize"), error, true),
            reanalyze: (deploymentId) => this.analyze(deploymentId),
        });
        this.#reverseController = new CatalogDeploymentReverseController({
            client,
            current: () => this.#state,
            transition: (state) => this.#transition(state),
            nextGeneration: () => ++this.#generation,
            isCurrentGeneration: (generation) => generation === this.#generation,
            createUserActionId: options.createUserActionId,
        });
        this.#versionController = new CatalogDeploymentVersionController({
            client,
            current: () => this.#state,
            transition: (state) => this.#transition(state),
            nextGeneration: () => ++this.#generation,
            isCurrentGeneration: (generation) => generation === this.#generation,
            busy: () => this.#busy(),
            start: () => this.#startImmediate("update_version"),
            fail: (message, diagnostics) => this.#finishFailure(message, diagnostics, true, true),
            failThrown: (error, mutation) => this.#finishThrown(operationLabel("update_version"), error, mutation),
            reload: () => this.load(),
            analyze: (deploymentId) => this.analyze(deploymentId),
        });
    }

    public get state(): CatalogDeploymentState {
        return this.#state;
    }

    public get supportsVersionUpdate(): boolean {
        return this.#client.supportsOperation("deployment.update_inputs");
    }

    public async updateVersion(input: DeploymentVersionUpdate): Promise<void> {
        await this.#versionController.update(input);
    }

    public subscribe(listener: (state: CatalogDeploymentState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    public dispose(): void {
        this.#generation += 1;
        this.#assetUsageController.invalidate();
        this.#assetDetailController.invalidate();
        this.#unsubscribeInvalidation?.();
        this.#unsubscribeInvalidation = undefined;
        this.#listeners.clear();
    }

    public async load(): Promise<void> {
        const completionRefresh = this.#reverseController.refreshPendingCompletion();
        if (completionRefresh !== undefined) return completionRefresh;
        if (this.#state.status === "ready" && this.#state.reverse.status === "prepared") return;
        const generation = ++this.#generation;
        this.#assetUsageController.invalidate();
        this.#assetDetailController.invalidate();
        this.#ensureInvalidationSubscription();
        this.#transition(Object.freeze({ status: "loading", message: localizedText("catalog.loading") }));
        try {
            const [projects, assets, deployments] = await Promise.all([
                this.#client.listProjects(),
                this.#client.listAssets(),
                this.#client.listDeployments(),
            ]);
            if (generation !== this.#generation) return;
            const failed = [projects, assets, deployments].find((outcome) => outcome.status === "failed");
            if (failed?.status === "failed") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("catalog.load.failed"),
                        diagnostics: mergeNonInformationalProtocolDiagnostics(failed.diagnostics),
                    }),
                );
                return;
            }
            if (projects.status === "failed" || assets.status === "failed" || deployments.status === "failed") {
                throw new Error("unreachable failed catalog outcome");
            }
            this.#transition(
                Object.freeze({
                    status: "ready",
                    projects: projects.value.projects,
                    assets: assets.value.assets,
                    deployments: deployments.value.deployments,
                    assetUsage: Object.freeze({ status: "none" }),
                    assetDetail: Object.freeze({ status: "none" }),
                    analysis: Object.freeze({ status: "none" }),
                    preview: Object.freeze({ status: "none" }),
                    inspection: Object.freeze({ status: "none" }),
                    reverse: Object.freeze({ status: "none" }),
                    activity: Object.freeze({ status: "idle" }),
                    stale: false,
                    requiresReconciliation: false,
                    message: assets.value.assets.length === 0 ? localizedText("catalog.empty") : undefined,
                    diagnostics: mergeNonInformationalProtocolDiagnostics(
                        projects.diagnostics,
                        assets.diagnostics,
                        deployments.diagnostics,
                    ),
                }),
            );
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("catalog.load.interrupted"),
                        diagnostics: Object.freeze([]),
                    }),
                );
            }
        }
    }

    public async selectAsset(assetId: string): Promise<void> {
        await this.#assetDetailController.selectAsset(assetId);
    }

    public async analyzeAssetUsage(requestKey: string, requests: readonly AssetUsageAnalysisRequest[]): Promise<void> {
        await this.#assetUsageController.analyze(requestKey, requests);
    }

    public async refreshAssetUsageTargets(requestKey: string, requests: readonly AssetUsageAnalysisRequest[]): Promise<void> {
        await this.#assetUsageController.refreshTargets(requestKey, requests);
    }

    public clearAssetSelection(): void {
        this.#assetDetailController.clear();
    }

    public async selectAssetFile(logicalPath: string): Promise<void> {
        await this.#assetDetailController.selectFile(logicalPath);
    }

    public async loadMoreAssetText(): Promise<void> {
        await this.#assetDetailController.loadMoreText();
    }

    public async registerProject(localPathSelectionToken: string, displayName?: string): Promise<void> {
        if (this.#state.status !== "ready" || this.#busy() || localPathSelectionToken.trim() === "") return;
        const generation = ++this.#generation;
        this.#startImmediate("register_project");
        try {
            const result = await this.#client.registerProject({
                localPathSelectionToken,
                ...(displayName === undefined || displayName.trim() === "" ? {} : { displayName: displayName.trim() }),
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (result.status === "failed") {
                this.#finishFailure(localizedText("catalog.project.registration_failed"), result.diagnostics);
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    projects: replaceById(this.#state.projects, result.value, (project) => project.projectId),
                    activity: Object.freeze({ status: "idle" }),
                    stale: this.#state.stale,
                    message: localizedText("catalog.project.registered", { project: projectDisplayName(result.value) }),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                }),
            );
        } catch (error) {
            if (generation === this.#generation) this.#finishThrown(operationLabel("register_project"), error, true);
        }
    }

    public async createDeployment(params: ProtocolOperationParams<"deployment.create">): Promise<string | undefined> {
        if (this.#state.status !== "ready" || this.#busy()) return undefined;
        const generation = ++this.#generation;
        this.#startImmediate("create_deployment");
        try {
            const result = await this.#client.createDeployment(params);
            if (generation !== this.#generation || this.#state.status !== "ready") return undefined;
            if (result.status === "failed") {
                this.#finishFailure(localizedText("catalog.deployment.creation_failed"), result.diagnostics);
                return undefined;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    deployments: replaceById(this.#state.deployments, result.value, (deployment) => deployment.deploymentId),
                    analysis: Object.freeze({ status: "none" }),
                    preview: Object.freeze({ status: "none" }),
                    inspection: Object.freeze({ status: "none" }),
                    reverse: Object.freeze({ status: "none" }),
                    activity: Object.freeze({ status: "idle" }),
                    stale: this.#state.stale,
                    message: localizedText("catalog.deployment.created"),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                }),
            );
            return result.value.deploymentId;
        } catch (error) {
            if (generation === this.#generation) this.#finishThrown(operationLabel("create_deployment"), error, true);
            return undefined;
        }
    }

    public async authorizeCurrentVersionForProject(
        identity: { readonly assetId: string; readonly versionId: string; readonly projectId: string },
        deploymentId: string,
        target: DeploymentTargetView,
    ): Promise<void> {
        await this.#promotionAuthorizationController.authorize(identity, deploymentId, target);
    }

    public async analyze(deploymentId: string): Promise<void> {
        if (
            this.#state.status !== "ready" ||
            this.#busy() ||
            !this.#deploymentAllows(deploymentId, "review_deployment", "review_external_changes")
        ) {
            return;
        }
        const generation = ++this.#generation;
        this.#transition(
            Object.freeze({
                ...this.#state,
                analysis: Object.freeze({ status: "loading", deploymentId }),
                diagnostics: Object.freeze([]),
                preview: Object.freeze({ status: "none" }),
                reverse: Object.freeze({ status: "none" }),
                activity: Object.freeze({
                    status: "starting",
                    kind: "analyze",
                    message: operationLabel("analyze"),
                }),
                message: undefined,
            }),
        );
        try {
            const result = await this.#client.analyzeDeployment({ deploymentId }, (update) =>
                this.#trackLongUpdate(generation, "analyze", update),
            );
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (result.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        analysis: Object.freeze({
                            status: "failed",
                            deploymentId,
                            failureKind: "analysis.operation_failed",
                            message: localizedText("catalog.render.analysis_failed"),
                        }),
                        activity: Object.freeze({ status: "idle" }),
                        diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    analysis: Object.freeze({ status: "ready", value: result.value }),
                    activity: Object.freeze({ status: "idle" }),
                    message: localizedText("catalog.render.choose_strategies"),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                }),
            );
        } catch (error) {
            if (generation === this.#generation) this.#finishAnalysisThrown(deploymentId, error);
        }
    }

    public clearPreview(): void {
        if (this.#state.status !== "ready" || this.#state.preview.status === "none" || this.#busy()) return;
        this.#transition(Object.freeze({ ...this.#state, preview: Object.freeze({ status: "none" }) }));
    }

    public async preview(deploymentId: string, selections: readonly RenderOptionSelection[]): Promise<void> {
        if (
            this.#state.status !== "ready" ||
            this.#busy() ||
            this.#state.analysis.status !== "ready" ||
            this.#state.analysis.value.deploymentId !== deploymentId
        ) {
            return;
        }
        const selection = buildRenderSelection(this.#state.analysis.value, selections, this.#options.createUserActionId());
        if (selection.status === "invalid") {
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    preview: Object.freeze({
                        status: "failed",
                        deploymentId,
                        failureKind: "preview.selection_invalid",
                        message: selection.message,
                    }),
                    diagnostics: Object.freeze([]),
                }),
            );
            return;
        }
        const generation = ++this.#generation;
        this.#transition(
            Object.freeze({
                ...this.#state,
                preview: Object.freeze({ status: "loading", deploymentId }),
                diagnostics: Object.freeze([]),
                activity: Object.freeze({
                    status: "starting",
                    kind: "preview",
                    message: operationLabel("preview"),
                }),
                message: undefined,
            }),
        );
        try {
            const result = await this.#client.previewDeployment({ deploymentId, selection: selection.selection }, (update) =>
                this.#trackLongUpdate(generation, "preview", update),
            );
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (result.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        preview: Object.freeze({
                            status: "failed",
                            deploymentId,
                            failureKind: "preview.operation_failed",
                            message: localizedText("catalog.preview.failed"),
                        }),
                        activity: Object.freeze({ status: "idle" }),
                        diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    preview: Object.freeze({ status: "ready", value: result.value }),
                    activity: Object.freeze({ status: "idle" }),
                    message: localizedText("catalog.preview.ready"),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                }),
            );
        } catch (error) {
            if (generation === this.#generation) this.#finishPreviewThrown(deploymentId, error);
        }
    }

    public async deployPreview(action: "apply" | "replace_unmanaged"): Promise<void> {
        if (this.#state.status !== "ready" || this.#state.preview.status !== "ready") return;
        if (
            (action === "apply" && this.#state.preview.value.actionState !== "ready_apply") ||
            (action === "replace_unmanaged" && this.#state.preview.value.actionState !== "requires_unmanaged_replacement")
        ) {
            return;
        }
        const previewToken = this.#state.preview.value.previewToken;
        await this.#runDeploymentMutation("deploy", this.#state.preview.value.deploymentId, (listener) =>
            this.#client.deploy(
                action === "apply"
                    ? { previewToken, deploymentAction: "apply" }
                    : {
                          previewToken,
                          deploymentAction: "replace_unmanaged",
                          userActionId: this.#options.createUserActionId(),
                      },
                listener,
            ),
        );
    }

    public async overwritePreview(): Promise<void> {
        const state = this.#state;
        if (
            state.status !== "ready" ||
            state.preview.status !== "ready" ||
            state.preview.value.actionState !== "blocked_managed_conflict"
        ) {
            return;
        }
        const preview = state.preview.value;
        const deployment = state.deployments.find((candidate) => candidate.deploymentId === preview.deploymentId);
        if (deployment === undefined) return;
        const previewToken = preview.previewToken;
        await this.#runDeploymentMutation("deploy", preview.deploymentId, (listener) =>
            this.#client.deploy(
                {
                    previewToken,
                    deploymentAction: "overwrite_runtime",
                    userActionId: this.#options.createUserActionId(),
                },
                listener,
            ),
        );
    }

    public async scan(deploymentId: string): Promise<void> {
        if (!this.#deploymentAllows(deploymentId, "check_now")) return;
        await this.#runDeploymentMutation("scan", deploymentId, (listener) =>
            this.#client.scanDeployment({ deploymentId }, listener),
        );
    }

    public async inspect(deploymentId: string): Promise<void> {
        if (
            this.#state.status !== "ready" ||
            this.#busy() ||
            !this.#deploymentAllows(deploymentId, "review_external_changes", "review_repair")
        ) {
            return;
        }
        const generation = ++this.#generation;
        this.#transition(
            Object.freeze({
                ...this.#state,
                inspection: Object.freeze({ status: "loading", deploymentId }),
                diagnostics: Object.freeze([]),
                activity: Object.freeze({
                    status: "starting",
                    kind: "inspect",
                    message: operationLabel("inspect"),
                }),
                message: undefined,
            }),
        );
        try {
            const result = await this.#client.inspectRenderedTarget({ deploymentId }, (update) =>
                this.#trackLongUpdate(generation, "inspect", update),
            );
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (result.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        inspection: Object.freeze({
                            status: "failed",
                            deploymentId,
                            failureKind: "inspection.operation_failed",
                            message: localizedText("catalog.target.inspection_failed"),
                        }),
                        activity: Object.freeze({ status: "idle" }),
                        diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    inspection: Object.freeze({
                        status: "ready",
                        value: result.value,
                        detail: Object.freeze({ status: "none" }),
                    }),
                    activity: Object.freeze({ status: "idle" }),
                    message: localizedText(
                        result.value.conflictCount === 0 ? "catalog.inspection.current" : "catalog.inspection.conflict",
                    ),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                }),
            );
        } catch (error) {
            if (generation === this.#generation) this.#finishInspectionThrown(deploymentId, error);
        }
    }

    public async loadInspectionDetail(selector: string): Promise<void> {
        if (this.#state.status !== "ready" || this.#state.inspection.status !== "ready" || this.#busy()) return;
        if (!this.#state.inspection.value.details.some((detail) => detail.selector === selector)) return;
        const generation = ++this.#generation;
        const inspection = this.#state.inspection;
        this.#transition(
            Object.freeze({
                ...this.#state,
                inspection: Object.freeze({
                    ...inspection,
                    detail: Object.freeze({ status: "loading", selector }),
                }),
                diagnostics: Object.freeze([]),
            }),
        );
        try {
            const result = await this.#client.getRenderedInspectionDetail({
                inspectionToken: inspection.value.inspectionToken,
                selector,
            });
            if (generation !== this.#generation || this.#state.status !== "ready" || this.#state.inspection.status !== "ready")
                return;
            if (result.status === "failed") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        inspection: Object.freeze({
                            ...this.#state.inspection,
                            detail: Object.freeze({
                                status: "failed",
                                selector,
                                failureKind: "inspection_detail.operation_failed",
                                message: localizedText("catalog.inspection.detail_unavailable"),
                            }),
                        }),
                        diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    inspection: Object.freeze({
                        ...this.#state.inspection,
                        detail: Object.freeze({ status: "ready", value: result.value }),
                    }),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, result.diagnostics),
                }),
            );
        } catch {
            if (generation === this.#generation && this.#state.status === "ready" && this.#state.inspection.status === "ready") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        inspection: Object.freeze({
                            ...this.#state.inspection,
                            detail: Object.freeze({
                                status: "failed",
                                selector,
                                failureKind: "inspection_detail.interrupted",
                                message: localizedText("catalog.inspection.detail_interrupted"),
                            }),
                        }),
                    }),
                );
            }
        }
    }

    public async repair(): Promise<void> {
        if (this.#state.status !== "ready" || this.#state.inspection.status !== "ready") return;
        const inspection = this.#state.inspection.value;
        const deployment = this.#state.deployments.find((candidate) => candidate.deploymentId === inspection.deploymentId);
        if (!deployment?.actionHints.includes("review_repair")) return;
        await this.#runDeploymentMutation("repair", inspection.deploymentId, (listener) =>
            this.#client.repairDeployment(
                {
                    deploymentId: inspection.deploymentId,
                    inspectionToken: inspection.inspectionToken,
                    expectedInspectionResultFingerprint: inspection.inspectionResultFingerprint,
                    userActionId: this.#options.createUserActionId(),
                },
                listener,
            ),
        );
    }

    public async recover(deploymentId: string): Promise<void> {
        const hasPendingCompletion =
            this.#state.status === "ready" &&
            this.#state.requiresReconciliation &&
            ((this.#state.reverse.status === "result" && reverseDeploymentId(this.#state.reverse) === deploymentId) ||
                this.#state.pendingRecoveryDeploymentId === deploymentId);
        if (
            this.#state.status !== "ready" ||
            (!hasPendingCompletion &&
                !this.#state.deployments
                    .find((candidate) => candidate.deploymentId === deploymentId)
                    ?.actionHints.includes("recover"))
        ) {
            return;
        }
        await this.#runDeploymentMutation("recover", deploymentId, (listener) =>
            this.#client.recoverDeployment({ deploymentId }, listener),
        );
    }

    public async prepareReverse(): Promise<void> {
        await this.#reverseController.prepare();
    }

    public async commitReverse(selections: readonly RenderOptionSelection[], confirmPromotion: boolean): Promise<void> {
        await this.#reverseController.commit(selections, confirmPromotion);
    }

    public async cancelReverse(): Promise<void> {
        await this.#reverseController.cancel();
    }

    async #runDeploymentMutation<TName extends DeploymentTerminalOperation>(
        kind: CatalogDeploymentMutationKind,
        deploymentId: string,
        run: (listener: (update: DesktopLongOperationUpdate<TName>) => void) => Promise<ProtocolOperationTerminal<TName>>,
    ): Promise<void> {
        if (this.#state.status !== "ready" || this.#busy()) return;
        const reviewedFilePaths = catalogDeploymentReviewedFilePaths(this.#state, kind, deploymentId);
        const generation = ++this.#generation;
        this.#transition(
            Object.freeze({
                ...this.#state,
                activity: Object.freeze({ status: "starting", kind, message: operationLabel(kind) }),
                diagnostics: Object.freeze([]),
                message: undefined,
            }),
        );
        try {
            const result = await run((update) => this.#trackLongUpdate(generation, kind, update));
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (result.status === "failed") {
                const { previewInvalid, renderInvalid } = catalogDeploymentInvalidation(kind, result.diagnostics);
                this.#finishFailure(
                    localizedText("catalog.operation.failed", { operation: operationLabel(kind) }),
                    result.diagnostics,
                    previewInvalid,
                    renderInvalid,
                );
                return;
            }
            const recoveryPending = kind === "recover" && result.status === "partial";
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    deployments: replaceById(this.#state.deployments, result.value, (deployment) => deployment.deploymentId),
                    analysis: Object.freeze({ status: "none" }),
                    preview: Object.freeze({ status: "none" }),
                    inspection: Object.freeze({ status: "none" }),
                    reverse: recoveryPending ? this.#state.reverse : Object.freeze({ status: "none" }),
                    activity: Object.freeze({ status: "idle" }),
                    ...(recoveryPending
                        ? {}
                        : catalogDeploymentCompletedMutation(kind, result.value.deploymentId, reviewedFilePaths)),
                    // A successful mutation returns the fresh Core projection
                    // after its action-time checks. An invalidation emitted by
                    // that same mutation must not survive as a false warning.
                    stale: recoveryPending,
                    requiresReconciliation: recoveryPending,
                    pendingRecoveryDeploymentId: recoveryPending ? deploymentId : undefined,
                    message: recoveryPending
                        ? undefined
                        : localizedText("catalog.operation.finished", {
                              operation: operationLabel(kind),
                              stage: localizedText(deploymentStatusMessage(result.value)),
                          }),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(result.diagnostics),
                }),
            );
            if (kind === "recover") await this.#refreshRecoveredAssetSummaries(generation);
        } catch (error) {
            if (generation === this.#generation) this.#finishThrown(operationLabel(kind), error, true);
        }
    }

    async #refreshRecoveredAssetSummaries(generation: number): Promise<void> {
        try {
            const result = await this.#client.listAssets();
            if (
                result.status !== "complete" ||
                generation !== this.#generation ||
                this.#state.status !== "ready" ||
                this.#state.stale ||
                this.#state.requiresReconciliation
            )
                return;
            this.#transition(Object.freeze({ ...this.#state, assets: result.value.assets }));
        } catch {
            // Recovery already returned a trusted terminal. Missing display
            // metadata must not turn it into an uncertain write or a retry.
            // Version labels keep their exact-ID fallback until a later load.
        }
    }

    #ensureInvalidationSubscription(): void {
        this.#unsubscribeInvalidation ??= this.#client.subscribeInvalidation((invalidation) =>
            this.#handleInvalidation(invalidation),
        );
    }

    #handleInvalidation(invalidation: ProtocolInvalidationV1): void {
        if (this.#state.status !== "ready") return;
        if (invalidation.resourceKind === "host_review_record") {
            if (
                invalidation.recordKind === "render_preview" &&
                this.#state.preview.status === "ready" &&
                this.#state.preview.value.previewToken === invalidation.token
            ) {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        preview: Object.freeze({ status: "none" }),
                        message: localizedText("catalog.preview.retained_expired"),
                    }),
                );
            } else if (
                invalidation.recordKind === "rendered_inspection" &&
                this.#state.inspection.status === "ready" &&
                this.#state.inspection.value.inspectionToken === invalidation.token
            ) {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        inspection: Object.freeze({ status: "none" }),
                        message: localizedText("catalog.inspection.retained_expired"),
                    }),
                );
            }
            return;
        }
        if (
            invalidation.resourceKind === "project" ||
            invalidation.resourceKind === "asset" ||
            invalidation.resourceKind === "deployment" ||
            (invalidation.resourceKind === "collection" &&
                ["projects", "assets", "deployments"].includes(invalidation.collection))
        ) {
            if (invalidation.resourceKind !== "deployment") this.#assetDetailController.invalidate();
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    assetDetail:
                        invalidation.resourceKind === "deployment" ? this.#state.assetDetail : Object.freeze({ status: "none" }),
                    analysis: Object.freeze({ status: "none" }),
                    preview: Object.freeze({ status: "none" }),
                    inspection: Object.freeze({ status: "none" }),
                    reverse:
                        this.#state.reverse.status === "prepared" ||
                        (this.#state.reverse.status === "result" &&
                            this.#state.activity.status !== "idle" &&
                            ["reverse_commit", "recover"].includes(this.#state.activity.kind))
                            ? this.#state.reverse
                            : Object.freeze({ status: "none" }),
                    stale: true,
                    message: localizedText("catalog.authority_changed"),
                }),
            );
        }
    }

    #trackLongUpdate<
        TName extends
            | DeploymentTerminalOperation
            | "deployment.render_analyze"
            | "deployment.render_preview"
            | "deployment.inspect_rendered_target",
    >(generation: number, kind: OrdinaryCatalogDeploymentActivityKind, update: DesktopLongOperationUpdate<TName>): void {
        if (generation !== this.#generation || this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                activity:
                    update.status === "accepted"
                        ? Object.freeze({
                              status: "accepted",
                              kind,
                              operationId: update.operationId,
                              message: operationLabel(kind),
                          })
                        : Object.freeze({
                              status: "progress",
                              kind,
                              operationId: update.operationId,
                              completedUnits: update.progress.completedUnits,
                              totalUnits: update.progress.totalUnits,
                              message: operationLabel(kind),
                              technicalStage: update.progress.stage,
                          }),
            }),
        );
    }

    #startImmediate(kind: "register_project" | "create_deployment" | "authorize" | "update_version"): void {
        if (this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                activity: Object.freeze({ status: "starting", kind, message: operationLabel(kind) }),
                diagnostics: Object.freeze([]),
                message: undefined,
            }),
        );
    }

    #finishFailure(
        message: DesktopDisplayText,
        diagnostics: readonly ProtocolDiagnosticV1[] = [],
        clearPreview = false,
        clearAnalysis = false,
    ): void {
        if (this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                analysis: clearAnalysis ? Object.freeze({ status: "none" }) : this.#state.analysis,
                preview: clearPreview ? Object.freeze({ status: "none" }) : this.#state.preview,
                activity: Object.freeze({ status: "idle" }),
                message,
                diagnostics: mergeNonInformationalProtocolDiagnostics(this.#state.diagnostics, diagnostics),
            }),
        );
    }

    #finishThrown(label: DesktopDisplayText, error: unknown, mutation: boolean): void {
        if (this.#state.status !== "ready") return;
        const uncertain = mutation && isUncertainDelivery(error);
        this.#transition(
            Object.freeze({
                ...this.#state,
                activity: Object.freeze({ status: "idle" }),
                stale: this.#state.stale || uncertain,
                requiresReconciliation: this.#state.requiresReconciliation || uncertain,
                analysis: uncertain ? Object.freeze({ status: "none" }) : this.#state.analysis,
                preview: uncertain ? Object.freeze({ status: "none" }) : this.#state.preview,
                inspection: uncertain ? Object.freeze({ status: "none" }) : this.#state.inspection,
                reverse: uncertain ? Object.freeze({ status: "none" }) : this.#state.reverse,
                message: localizedText(uncertain ? "catalog.operation.lost_terminal" : "catalog.operation.interrupted", {
                    operation: label,
                }),
            }),
        );
    }

    #finishAnalysisThrown(deploymentId: string, error: unknown): void {
        if (this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                analysis: Object.freeze({
                    status: "failed",
                    deploymentId,
                    failureKind: isUncertainDelivery(error) ? "analysis.outcome_unavailable" : "analysis.interrupted",
                    message: isUncertainDelivery(error)
                        ? localizedText("catalog.render.lost_channel")
                        : localizedText("catalog.render.interrupted"),
                }),
                activity: Object.freeze({ status: "idle" }),
            }),
        );
    }

    #finishPreviewThrown(deploymentId: string, error: unknown): void {
        if (this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                preview: Object.freeze({
                    status: "failed",
                    deploymentId,
                    failureKind: isUncertainDelivery(error) ? "preview.outcome_unavailable" : "preview.interrupted",
                    message: isUncertainDelivery(error)
                        ? localizedText("catalog.preview.lost_channel")
                        : localizedText("catalog.preview.interrupted"),
                }),
                activity: Object.freeze({ status: "idle" }),
            }),
        );
    }

    #finishInspectionThrown(deploymentId: string, error: unknown): void {
        if (this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                inspection: Object.freeze({
                    status: "failed",
                    deploymentId,
                    failureKind: isUncertainDelivery(error) ? "inspection.outcome_unavailable" : "inspection.interrupted",
                    message: isUncertainDelivery(error)
                        ? localizedText("catalog.inspection.lost_channel")
                        : localizedText("catalog.inspection.interrupted"),
                }),
                activity: Object.freeze({ status: "idle" }),
            }),
        );
    }

    #deploymentAllows(deploymentId: string, ...hints: DeploymentView["actionHints"][number][]): boolean {
        return (
            this.#state.status === "ready" &&
            this.#state.deployments.some(
                (deployment) =>
                    deployment.deploymentId === deploymentId && hints.some((hint) => deployment.actionHints.includes(hint)),
            )
        );
    }

    #busy(): boolean {
        return (
            this.#state.status === "ready" &&
            (this.#state.activity.status !== "idle" || this.#state.reverse.status === "prepared")
        );
    }

    #transition(state: CatalogDeploymentState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
