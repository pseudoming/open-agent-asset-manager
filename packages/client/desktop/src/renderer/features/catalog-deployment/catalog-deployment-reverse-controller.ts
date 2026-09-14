import { ClientProtocolFaultError, ClientTransportError } from "@oaam/client-framework";
import type { DesktopApplicationClientApi, DesktopLongOperationUpdate } from "../../client";
import {
    type DesktopDisplayText,
    type DesktopMessageId,
    localizedText,
    mergeNonInformationalProtocolDiagnostics,
} from "../../presentation";
import { buildRenderSelection, type RenderOptionSelection } from "./catalog-deployment-model";
import type { CatalogDeploymentState, DeploymentReverseState } from "./catalog-deployment-state";

export type { DeploymentReverseState } from "./catalog-deployment-state";

type ReverseOperation = "reverse_accept.prepare" | "reverse_accept.commit" | "reverse_accept.cancel";
type ReverseActivityKind = "reverse_prepare" | "reverse_commit" | "reverse_cancel";

const REVERSE_ACTIVITY_MESSAGES = Object.freeze({
    reverse_prepare: "catalog.activity.reverse_prepare",
    reverse_commit: "catalog.activity.reverse_commit",
    reverse_cancel: "catalog.activity.reverse_cancel",
} as const satisfies Readonly<Record<ReverseActivityKind, DesktopMessageId>>);

export interface CatalogDeploymentReverseControllerContext {
    readonly client: DesktopApplicationClientApi;
    readonly current: () => CatalogDeploymentState;
    readonly transition: (state: CatalogDeploymentState) => void;
    readonly nextGeneration: () => number;
    readonly isCurrentGeneration: (generation: number) => boolean;
    readonly createUserActionId: () => string;
}

function label(kind: ReverseActivityKind): DesktopDisplayText {
    return localizedText(REVERSE_ACTIVITY_MESSAGES[kind]);
}

function isUncertainDelivery(error: unknown): boolean {
    return (
        (error instanceof ClientTransportError && error.delivery === "uncertain") ||
        (error instanceof ClientProtocolFaultError && error.delivery === "uncertain")
    );
}

export class CatalogDeploymentReverseController {
    readonly #context: CatalogDeploymentReverseControllerContext;

    public constructor(context: CatalogDeploymentReverseControllerContext) {
        this.#context = context;
    }

    public async prepare(): Promise<void> {
        const state = this.#readyIdle();
        if (state === undefined || state.inspection.status !== "ready") return;
        const inspection = state.inspection.value;
        const deployment = state.deployments.find((candidate) => candidate.deploymentId === inspection.deploymentId);
        if (!deployment?.actionHints.includes("review_external_changes")) return;
        const generation = this.#context.nextGeneration();
        this.#context.transition(
            Object.freeze({
                ...state,
                reverse: Object.freeze({ status: "preparing", deploymentId: inspection.deploymentId }),
                activity: Object.freeze({ status: "starting", kind: "reverse_prepare", message: label("reverse_prepare") }),
                message: undefined,
                diagnostics: Object.freeze([]),
            }),
        );
        try {
            const result = await this.#context.client.prepareReverseAccept(
                {
                    deploymentId: inspection.deploymentId,
                    inspectionToken: inspection.inspectionToken,
                    inspectionResultFingerprint: inspection.inspectionResultFingerprint,
                },
                (update) => this.#track(generation, "reverse_prepare", update),
            );
            const current = this.#currentReady(generation);
            if (current === undefined) return;
            if (result.status === "failed" && !("value" in result)) {
                this.#context.transition(
                    Object.freeze({
                        ...current,
                        reverse: Object.freeze({
                            status: "failed",
                            deploymentId: inspection.deploymentId,
                            message: localizedText("catalog.reverse.prepare_failed"),
                        }),
                        activity: Object.freeze({ status: "idle" }),
                        stale: true,
                        requiresReconciliation: true,
                        diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            const prepared = result.value.preparationState === "prepared";
            this.#context.transition(
                Object.freeze({
                    ...current,
                    analysis: prepared ? Object.freeze({ status: "none" }) : current.analysis,
                    inspection: prepared ? Object.freeze({ status: "none" }) : current.inspection,
                    preview: prepared ? Object.freeze({ status: "none" }) : current.preview,
                    reverse: prepared
                        ? Object.freeze({ status: "prepared", value: result.value })
                        : Object.freeze({
                              status: "not_prepared",
                              deploymentId: inspection.deploymentId,
                              message: localizedText("catalog.reverse.not_prepared"),
                          }),
                    activity: Object.freeze({ status: "idle" }),
                    message: localizedText(prepared ? "catalog.reverse.prepared" : "catalog.reverse.not_prepared"),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(result.diagnostics),
                }),
            );
        } catch (error) {
            this.#finishThrown(generation, inspection.deploymentId, "reverse_prepare", error);
        }
    }

    public async commit(selections: readonly RenderOptionSelection[], confirmPromotion: boolean): Promise<void> {
        const state = this.#readyIdle();
        if (state === undefined || state.reverse.status !== "prepared") return;
        const preparation = state.reverse.value;
        const validation = buildRenderSelection(preparation.renderAnalysis, selections, "validation-only");
        if (validation.status === "invalid") {
            this.#context.transition(
                Object.freeze({ ...state, reverse: Object.freeze({ ...state.reverse, message: validation.message }) }),
            );
            return;
        }
        if (preparation.promotionState === "user_confirmation_required" && !confirmPromotion) {
            this.#context.transition(
                Object.freeze({
                    ...state,
                    reverse: Object.freeze({
                        ...state.reverse,
                        message: localizedText("catalog.reverse.promotion_confirmation_required"),
                    }),
                }),
            );
            return;
        }
        const userActionId = this.#context.createUserActionId();
        const selection = buildRenderSelection(preparation.renderAnalysis, selections, userActionId);
        if (selection.status === "invalid") return;
        const reviewedFilePaths = Object.freeze(
            preparation.renderAnalysis.outputUnits
                .flatMap((unit) => unit.claims.map((claim) => claim.relativePath))
                .filter((filePath, index, filePaths) => filePath.trim() !== "" && filePaths.indexOf(filePath) === index)
                .sort(),
        );
        const generation = this.#context.nextGeneration();
        this.#context.transition(
            Object.freeze({
                ...state,
                activity: Object.freeze({ status: "starting", kind: "reverse_commit", message: label("reverse_commit") }),
                message: undefined,
                diagnostics: Object.freeze([]),
            }),
        );
        try {
            const result = await this.#context.client.commitReverseAccept(
                {
                    preparationId: preparation.preparationId,
                    expectedPreparationRevision: preparation.preparationRevision,
                    userActionId,
                    newVersionPromotion:
                        preparation.promotionState === "already_authorized"
                            ? "use_existing_authority"
                            : "grant_staged_version_current_target",
                    renderSelection: selection.selection,
                },
                (update) => this.#track(generation, "reverse_commit", update),
            );
            const current = this.#currentReady(generation);
            if (current === undefined) return;
            if (result.status === "failed" && !("value" in result)) {
                this.#context.transition(
                    Object.freeze({
                        ...current,
                        reverse: Object.freeze({
                            status: "failed",
                            deploymentId: preparation.renderAnalysis.deploymentId,
                            message: localizedText("catalog.reverse.commit_failed"),
                        }),
                        activity: Object.freeze({ status: "idle" }),
                        stale: true,
                        requiresReconciliation: true,
                        diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            const committed = result.value.commitState === "committed";
            const pendingCompletion =
                committed &&
                result.diagnostics.some(
                    (diagnostic) =>
                        diagnostic.code === "reverse_accept.completion_pending" ||
                        diagnostic.code === "reverse_accept.index_refresh_pending",
                );
            this.#context.transition(
                Object.freeze({
                    ...current,
                    analysis: Object.freeze({ status: "none" }),
                    preview: Object.freeze({ status: "none" }),
                    reverse: Object.freeze({
                        status: "result",
                        deploymentId: preparation.renderAnalysis.deploymentId,
                        value: result.value,
                        reviewedFilePaths,
                    }),
                    activity: committed
                        ? Object.freeze({
                              status: "starting",
                              kind: "reverse_commit",
                              message: localizedText("catalog.activity.reverse_refresh"),
                          })
                        : Object.freeze({ status: "idle" }),
                    stale: true,
                    // Keep the terminal result and block more actions until
                    // the fresh Core projections have been read.
                    requiresReconciliation: !committed || pendingCompletion,
                    pendingRecoveryDeploymentId: pendingCompletion ? preparation.renderAnalysis.deploymentId : undefined,
                    // CatalogReverseReview owns the structured terminal result.
                    // Keeping the same result in the page-level notice would
                    // duplicate it and make the reconciliation notice look like
                    // a second, contradictory outcome.
                    message: undefined,
                    diagnostics: mergeNonInformationalProtocolDiagnostics(result.diagnostics),
                }),
            );
            if (committed) await this.#refreshCommitted(generation, preparation.renderAnalysis.deploymentId);
        } catch (error) {
            this.#finishThrown(generation, preparation.renderAnalysis.deploymentId, "reverse_commit", error);
        }
    }

    public refreshPendingCompletion(): Promise<void> | undefined {
        const state = this.#context.current();
        if (state.status !== "ready" || state.pendingRecoveryDeploymentId === undefined) return undefined;
        if (state.activity.status !== "idle") return Promise.resolve();
        const generation = this.#context.nextGeneration();
        this.#context.transition(
            Object.freeze({
                ...state,
                activity: Object.freeze({
                    status: "starting",
                    kind: "reverse_commit",
                    message: localizedText("catalog.loading"),
                }),
            }),
        );
        return this.#refreshCommitted(generation, state.pendingRecoveryDeploymentId);
    }

    async #refreshCommitted(generation: number, deploymentId: string): Promise<void> {
        const before = this.#currentReady(generation);
        const results = await Promise.allSettled([
            Promise.resolve().then(() => this.#context.client.listDeployments()),
            Promise.resolve().then(() => this.#context.client.listAssets()),
        ]);
        const current = this.#currentReady(generation);
        if (current === undefined) return;
        const [deploymentResult, assetResult] = results;
        const deployments = deploymentResult.status === "fulfilled" ? deploymentResult.value : undefined;
        const assets = assetResult.status === "fulfilled" ? assetResult.value : undefined;
        const diagnostics = mergeNonInformationalProtocolDiagnostics(
            current.diagnostics,
            deployments?.diagnostics ?? [],
            assets?.diagnostics ?? [],
        );
        const freshDeployment =
            deployments?.status === "complete"
                ? deployments.value.deployments.find((deployment) => deployment.deploymentId === deploymentId)
                : undefined;
        const refreshed =
            current === before &&
            deployments?.status === "complete" &&
            freshDeployment !== undefined &&
            assets?.status === "complete";
        const requiresReconciliation =
            current.pendingRecoveryDeploymentId !== undefined ||
            freshDeployment?.actionHints.includes("recover") === true ||
            diagnostics.some(
                (diagnostic) =>
                    diagnostic.code === "reverse_accept.completion_pending" ||
                    diagnostic.code === "reverse_accept.index_refresh_pending",
            );
        this.#context.transition(
            Object.freeze({
                ...current,
                deployments: refreshed ? deployments.value.deployments : current.deployments,
                assets: refreshed ? assets.value.assets : current.assets,
                activity: Object.freeze({ status: "idle" }),
                stale: !refreshed || requiresReconciliation,
                requiresReconciliation,
                message: undefined,
                diagnostics,
            }),
        );
    }

    public async cancel(): Promise<void> {
        const state = this.#readyIdle();
        if (state === undefined || state.reverse.status !== "prepared") return;
        const preparation = state.reverse.value;
        const generation = this.#context.nextGeneration();
        this.#context.transition(
            Object.freeze({
                ...state,
                activity: Object.freeze({ status: "starting", kind: "reverse_cancel", message: label("reverse_cancel") }),
                message: undefined,
                diagnostics: Object.freeze([]),
            }),
        );
        try {
            const result = await this.#context.client.cancelReverseAccept(
                {
                    preparationId: preparation.preparationId,
                    expectedPreparationRevision: preparation.preparationRevision,
                },
                (update) => this.#track(generation, "reverse_cancel", update),
            );
            const current = this.#currentReady(generation);
            if (current === undefined) return;
            if (result.status === "failed") {
                this.#context.transition(
                    Object.freeze({
                        ...current,
                        reverse: Object.freeze({
                            ...state.reverse,
                            message: localizedText("catalog.reverse.cancel_failed"),
                        }),
                        activity: Object.freeze({ status: "idle" }),
                        diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, result.diagnostics),
                    }),
                );
                return;
            }
            this.#context.transition(
                Object.freeze({
                    ...current,
                    reverse: Object.freeze({ status: "none" }),
                    activity: Object.freeze({ status: "idle" }),
                    message: localizedText("catalog.reverse.cancelled"),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(result.diagnostics),
                }),
            );
        } catch (error) {
            this.#finishThrown(generation, preparation.renderAnalysis.deploymentId, "reverse_cancel", error);
        }
    }

    #readyIdle(): Extract<CatalogDeploymentState, { readonly status: "ready" }> | undefined {
        const state = this.#context.current();
        return state.status === "ready" && state.activity.status === "idle" ? state : undefined;
    }

    #currentReady(generation: number): Extract<CatalogDeploymentState, { readonly status: "ready" }> | undefined {
        if (!this.#context.isCurrentGeneration(generation)) return undefined;
        const state = this.#context.current();
        return state.status === "ready" ? state : undefined;
    }

    #track<TName extends ReverseOperation>(
        generation: number,
        kind: ReverseActivityKind,
        update: DesktopLongOperationUpdate<TName>,
    ): void {
        const state = this.#currentReady(generation);
        if (state === undefined) return;
        if (kind === "reverse_commit" && state.reverse.status === "result") return;
        this.#context.transition(
            Object.freeze({
                ...state,
                activity:
                    update.status === "accepted"
                        ? Object.freeze({
                              status: "accepted",
                              kind,
                              operationId: update.operationId,
                              message: label(kind),
                          })
                        : Object.freeze({
                              status: "progress",
                              kind,
                              operationId: update.operationId,
                              completedUnits: update.progress.completedUnits,
                              totalUnits: update.progress.totalUnits,
                              message: label(kind),
                              technicalStage: update.progress.stage,
                          }),
            }),
        );
    }

    #finishThrown(generation: number, deploymentId: string, kind: ReverseActivityKind, error: unknown): void {
        const state = this.#currentReady(generation);
        if (state === undefined) return;
        const uncertain = isUncertainDelivery(error);
        this.#context.transition(
            Object.freeze({
                ...state,
                reverse: Object.freeze({
                    status: "failed",
                    deploymentId,
                    message: localizedText(uncertain ? "catalog.operation.lost_terminal" : "catalog.operation.interrupted", {
                        operation: label(kind),
                    }),
                }),
                inspection: uncertain ? Object.freeze({ status: "none" }) : state.inspection,
                activity: Object.freeze({ status: "idle" }),
                stale: state.stale || uncertain,
                requiresReconciliation: state.requiresReconciliation || uncertain,
            }),
        );
    }
}

export function reverseDeploymentId(state: DeploymentReverseState): string | undefined {
    switch (state.status) {
        case "none":
            return undefined;
        case "prepared":
            return state.value.renderAnalysis.deploymentId;
        case "preparing":
        case "not_prepared":
        case "result":
        case "failed":
            return state.deploymentId;
    }
}
