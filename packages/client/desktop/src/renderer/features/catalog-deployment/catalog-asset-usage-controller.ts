import type { DesktopApplicationClientApi } from "../../client";
import { localizedText, mergeNonInformationalProtocolDiagnostics } from "../../presentation";
import { analyzeOneAssetUsageTarget, type AssetUsageTargetOutcome } from "./catalog-asset-usage-analysis";
import type { AssetUsageAnalysisRequest, AssetUsageTargetView } from "./catalog-deployment-model";
import type { CatalogDeploymentState } from "./catalog-deployment-state";

interface AssetUsageControllerContext {
    readonly client: DesktopApplicationClientApi;
    readonly current: () => CatalogDeploymentState;
    readonly transition: (state: CatalogDeploymentState) => void;
    readonly busy: () => boolean;
}

export class CatalogAssetUsageController {
    readonly #context: AssetUsageControllerContext;
    #generation = 0;

    public constructor(context: AssetUsageControllerContext) {
        this.#context = context;
    }

    public invalidate(): void {
        this.#generation += 1;
    }

    public async analyze(requestKey: string, requests: readonly AssetUsageAnalysisRequest[]): Promise<void> {
        await this.#analyze(requestKey, requests, []);
    }

    public async refreshTargets(requestKey: string, requests: readonly AssetUsageAnalysisRequest[]): Promise<void> {
        const state = this.#context.current();
        if (
            state.status !== "ready" ||
            state.assetUsage.status !== "ready" ||
            state.assetUsage.requestKey !== requestKey ||
            requests.length === 0
        )
            return;
        const changed = new Set(requests.map((request) => request.targetKey));
        await this.#analyze(
            requestKey,
            requests,
            state.assetUsage.targets.filter((target) => !changed.has(target.targetKey)),
        );
    }

    async #analyze(
        requestKey: string,
        requests: readonly AssetUsageAnalysisRequest[],
        retainedTargets: readonly AssetUsageTargetView[],
    ): Promise<void> {
        const initial = this.#context.current();
        if (initial.status !== "ready" || this.#context.busy() || requestKey.trim() === "") return;
        const generation = ++this.#generation;
        if (requests.length === 0) {
            this.#context.transition(Object.freeze({ ...initial, assetUsage: Object.freeze({ status: "none" }) }));
            return;
        }
        this.#context.transition(
            Object.freeze({
                ...initial,
                assetUsage: Object.freeze({
                    status: "loading",
                    requestKey,
                    completedCount: 0,
                    totalCount: requests.length,
                    targets: retainedTargets,
                }),
            }),
        );
        try {
            const partial: Array<AssetUsageTargetOutcome | undefined> = new Array(requests.length);
            const outcomes = await Promise.all(
                requests.map(async (request, index): Promise<AssetUsageTargetOutcome> => {
                    const outcome = await analyzeOneAssetUsageTarget(this.#context.client, request);
                    partial[index] = outcome;
                    const state = this.#context.current();
                    if (
                        generation === this.#generation &&
                        state.status === "ready" &&
                        state.assetUsage.status === "loading" &&
                        state.assetUsage.requestKey === requestKey
                    ) {
                        const completedTargets = partial.flatMap((candidate) => {
                            if (candidate === undefined) return [];
                            return [candidate];
                        });
                        this.#context.transition(
                            Object.freeze({
                                ...state,
                                assetUsage: Object.freeze({
                                    status: "loading",
                                    requestKey,
                                    completedCount: completedTargets.length,
                                    totalCount: requests.length,
                                    targets: Object.freeze([...retainedTargets, ...completedTargets]),
                                }),
                            }),
                        );
                    }
                    return outcome;
                }),
            );
            const state = this.#context.current();
            if (generation !== this.#generation || state.status !== "ready") return;
            const diagnostics = outcomes.flatMap((outcome) => outcome.diagnostics);
            const targets = outcomes;
            this.#context.transition(
                Object.freeze({
                    ...state,
                    assetUsage: Object.freeze({
                        status: "ready",
                        requestKey,
                        targets: Object.freeze([...retainedTargets, ...targets]),
                    }),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(state.diagnostics, diagnostics),
                }),
            );
        } catch {
            const state = this.#context.current();
            if (generation !== this.#generation || state.status !== "ready") return;
            this.#context.transition(
                Object.freeze({
                    ...state,
                    assetUsage: Object.freeze({
                        status: "failed",
                        requestKey,
                        message: localizedText("catalog.asset_usage.interrupted"),
                    }),
                }),
            );
        }
    }
}
