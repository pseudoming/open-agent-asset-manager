import type { ProtocolDiagnosticV1, ProtocolOperationParams } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopDisplayText, localizedText, uniqueProtocolDiagnostics } from "../../presentation";
import {
    buildImportBatchRequest,
    callableBindingSubjectKey,
    canTargetBinding,
    canTargetExistingAsset,
    type ExistingAssetSummaryView,
    type ImportBatchResultView,
    type ImportBindingSelection,
    type ImportCandidateView,
    type ImportDestinationSelection,
    type ImportPreviewDetailView,
    type ImportPreviewView,
} from "./import-review-model";

export type ImportReviewDetailState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly candidateId: string; readonly logicalPath: string | undefined }
    | { readonly status: "ready"; readonly value: ImportPreviewDetailView }
    | {
          readonly status: "failed";
          readonly candidateId: string;
          readonly logicalPath: string | undefined;
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
          readonly refreshRequired: boolean;
      };

export type ImportReviewActivity = "idle" | "accepting" | "accept_failed" | "cancelling" | "cancel_failed";

export interface ImportReviewResultAsset {
    readonly candidateId: string;
    readonly displayName: string;
    readonly action: "create_asset" | "create_version";
}

export interface ImportReadSourcePresentation {
    readonly probeResultRowId: string;
    readonly sourceRootRowId: string;
    readonly sourceRootId: string;
    readonly adapterId: string;
    readonly environmentLabel: DesktopDisplayText;
    readonly toolLabel: DesktopDisplayText;
    readonly displayPath: string;
}

export interface ImportReviewPreparation {
    readonly request: ProtocolOperationParams<"adapter.read">;
    readonly sources: readonly ImportReadSourcePresentation[];
}

export interface ImportReadIssueView extends ImportReadSourcePresentation {
    readonly status: "partial" | "failed" | "not_found" | "unreported";
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
}

export type ImportReviewState =
    | { readonly status: "idle"; readonly message: DesktopDisplayText }
    | { readonly status: "preparing"; readonly phase: "reading" | "previewing"; readonly message: DesktopDisplayText }
    | {
          readonly status: "read_attention";
          readonly message: DesktopDisplayText;
          readonly preparation: ImportReviewPreparation;
          readonly completeSourcePreparation: ImportReviewPreparation | undefined;
          readonly issues: readonly ImportReadIssueView[];
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly preparation: ImportReviewPreparation;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
          readonly refreshRequired: boolean;
      }
    | {
          readonly status: "review";
          readonly preview: ImportPreviewView;
          readonly existingAssets: readonly ExistingAssetSummaryView[];
          readonly selectedCandidateIds: readonly string[];
          readonly destinationSelections: readonly ImportDestinationSelection[];
          readonly bindingSelections: readonly ImportBindingSelection[];
          readonly detail: ImportReviewDetailState;
          readonly activity: ImportReviewActivity;
          readonly message: DesktopDisplayText | undefined;
          readonly readIssues: readonly ImportReadIssueView[];
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
          readonly refreshRequired: boolean;
      }
    | {
          readonly status: "result";
          readonly result: ImportBatchResultView;
          readonly reviewedAssets: readonly ImportReviewResultAsset[];
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

export interface ImportReviewControllerOptions {
    readonly createUserActionId: () => string;
    readonly onCatalogChanged?: () => void;
}

const REFRESH_REQUIRED_CODES = new Set([
    "host.review_record_unavailable",
    "host.review_record_member_unavailable",
    "import.preview_tampered_or_stale",
    "import.source_changed",
    "import.source_authority_changed",
]);

function mergeDiagnostics(...groups: readonly (readonly ProtocolDiagnosticV1[])[]): readonly ProtocolDiagnosticV1[] {
    return uniqueProtocolDiagnostics(groups.flat());
}

function diagnosticsRequireRefresh(diagnostics: readonly ProtocolDiagnosticV1[]): boolean {
    return diagnostics.some((diagnostic) => REFRESH_REQUIRED_CODES.has(diagnostic.code));
}

function candidateFor(preview: ImportPreviewView, candidateId: string): ImportCandidateView | undefined {
    return preview.candidates.find((candidate) => candidate.candidateId === candidateId);
}

function isSelectableCandidate(candidate: ImportCandidateView): boolean {
    return candidate.status === "importable" && candidate.freshness === "fresh" && !candidate.callableBindingRequestsTruncated;
}

function isBusy(activity: ImportReviewActivity): boolean {
    return activity === "accepting" || activity === "cancelling";
}

function normalizePreparation(input: ProtocolOperationParams<"adapter.read"> | ImportReviewPreparation): ImportReviewPreparation {
    return "request" in input ? input : Object.freeze({ request: input, sources: Object.freeze([]) });
}

type ReadProjection = Extract<
    Awaited<ReturnType<DesktopApplicationClientApi["readSources"]>>,
    { readonly value: unknown }
>["value"];

function reportKey(adapterId: string, sourceRootId: string): string {
    return `${adapterId}\0${sourceRootId}`;
}

function classifyReadAttention(
    preparation: ImportReviewPreparation,
    read: ReadProjection,
): {
    readonly completeSourcePreparation: ImportReviewPreparation | undefined;
    readonly issues: readonly ImportReadIssueView[];
} {
    const reportsBySource = new Map<string, ReadProjection["reports"][number][]>();
    for (const report of read.reports) {
        const key = reportKey(report.adapterId, report.sourceRootId);
        const reports = reportsBySource.get(key) ?? [];
        reports.push(report);
        reportsBySource.set(key, reports);
    }
    const completeSourceRows = new Set<string>();
    const issues: ImportReadIssueView[] = [];
    for (const source of preparation.sources) {
        const reports = reportsBySource.get(reportKey(source.adapterId, source.sourceRootId)) ?? [];
        if (reports.length > 0 && reports.every((report) => report.status === "complete")) {
            completeSourceRows.add(`${source.probeResultRowId}\0${source.sourceRootRowId}`);
            continue;
        }
        let status: ImportReadIssueView["status"] = "unreported";
        if (reports.some((report) => report.status === "failed")) status = "failed";
        else if (reports.some((report) => report.status === "partial")) status = "partial";
        else if (reports.some((report) => report.status === "not_found")) status = "not_found";
        issues.push(
            Object.freeze({
                ...source,
                status,
                diagnostics: Object.freeze(reports.flatMap((report) => report.diagnostics)),
            }),
        );
    }
    const selections = preparation.request.selections.flatMap((selection) => {
        const sourceRootRowIds = selection.sourceRootRowIds.filter((sourceRootRowId) =>
            completeSourceRows.has(`${selection.probeResultRowId}\0${sourceRootRowId}`),
        );
        const firstSourceRootRowId = sourceRootRowIds[0];
        return firstSourceRootRowId === undefined
            ? []
            : [
                  {
                      ...selection,
                      sourceRootRowIds: [firstSourceRootRowId, ...sourceRootRowIds.slice(1)] as const,
                  },
              ];
    });
    const firstSelection = selections[0];
    const completeSources = preparation.sources.filter((source) =>
        completeSourceRows.has(`${source.probeResultRowId}\0${source.sourceRootRowId}`),
    );
    return {
        completeSourcePreparation:
            firstSelection === undefined
                ? undefined
                : Object.freeze({
                      request: {
                          probeToken: preparation.request.probeToken,
                          selections: [firstSelection, ...selections.slice(1)] as const,
                      },
                      sources: Object.freeze(completeSources),
                  }),
        issues: Object.freeze(issues),
    };
}

export class ImportReviewController {
    readonly #client: DesktopApplicationClientApi;
    readonly #options: ImportReviewControllerOptions;
    readonly #listeners = new Set<(state: ImportReviewState) => void>();
    #state: ImportReviewState = Object.freeze({
        status: "idle",
        message: localizedText("import.idle"),
    });
    #generation = 0;
    #detailGeneration = 0;

    public constructor(client: DesktopApplicationClientApi, options: ImportReviewControllerOptions) {
        this.#client = client;
        this.#options = options;
    }

    public get state(): ImportReviewState {
        return this.#state;
    }

    public subscribe(listener: (state: ImportReviewState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    public async prepare(input: ProtocolOperationParams<"adapter.read"> | ImportReviewPreparation): Promise<void> {
        const preparation = normalizePreparation(input);
        const generation = ++this.#generation;
        this.#detailGeneration += 1;
        await this.#readAndPreview(preparation, preparation, generation, true, Object.freeze([]), Object.freeze([]));
    }

    async #readAndPreview(
        preparation: ImportReviewPreparation,
        retryPreparation: ImportReviewPreparation,
        generation: number,
        allowAutomaticCompleteSourceRetry: boolean,
        retainedIssues: readonly ImportReadIssueView[],
        retainedDiagnostics: readonly ProtocolDiagnosticV1[],
    ): Promise<void> {
        this.#transition(Object.freeze({ status: "preparing", phase: "reading", message: localizedText("import.reading") }));
        try {
            const read = await this.#client.readSources(preparation.request);
            if (generation !== this.#generation) return;
            if (read.status === "failed") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("import.read.failed"),
                        preparation: retryPreparation,
                        diagnostics: Object.freeze([...read.diagnostics]),
                        refreshRequired: diagnosticsRequireRefresh(read.diagnostics),
                    }),
                );
                return;
            }
            let readIssues = retainedIssues;
            let readDiagnostics = mergeDiagnostics(retainedDiagnostics, read.diagnostics);
            let completeSourceRetry: ImportReviewPreparation | undefined;
            if (read.status === "partial") {
                const attention = classifyReadAttention(preparation, read.value);
                readIssues = Object.freeze([...retainedIssues, ...attention.issues]);
                readDiagnostics = mergeDiagnostics(
                    readDiagnostics,
                    read.value.reports.flatMap((report) => report.diagnostics),
                );
                if (!allowAutomaticCompleteSourceRetry || attention.completeSourcePreparation === undefined) {
                    this.#transition(
                        Object.freeze({
                            status: "read_attention",
                            message: localizedText("import.read.attention"),
                            preparation: retryPreparation,
                            completeSourcePreparation: attention.completeSourcePreparation,
                            issues: readIssues,
                            diagnostics: readDiagnostics,
                        }),
                    );
                    return;
                }
                completeSourceRetry = attention.completeSourcePreparation;
            }
            this.#transition(
                Object.freeze({
                    status: "preparing",
                    phase: "previewing",
                    message: localizedText("import.previewing"),
                }),
            );
            const assets = await this.#client.listAssets();
            if (generation !== this.#generation) return;
            if (assets.status !== "complete") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("import.catalog.failed"),
                        preparation: retryPreparation,
                        diagnostics: mergeDiagnostics(readDiagnostics, assets.diagnostics),
                        refreshRequired: diagnosticsRequireRefresh(assets.diagnostics),
                    }),
                );
                return;
            }
            const preview = await this.#client.previewImport({ readToken: read.value.readToken });
            if (generation !== this.#generation) return;
            if (preview.status === "failed") {
                if (
                    completeSourceRetry !== undefined &&
                    preview.diagnostics.length > 0 &&
                    preview.diagnostics.every((diagnostic) => diagnostic.code === "import.read_snapshot_invalid")
                ) {
                    await this.#readAndPreview(
                        completeSourceRetry,
                        retryPreparation,
                        generation,
                        false,
                        readIssues,
                        readDiagnostics,
                    );
                    return;
                }
                const diagnostics = mergeDiagnostics(readDiagnostics, preview.diagnostics);
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("import.preview.failed"),
                        preparation: retryPreparation,
                        diagnostics,
                        refreshRequired: diagnosticsRequireRefresh(diagnostics),
                    }),
                );
                return;
            }
            const selectedCandidates = preview.value.candidates.filter(isSelectableCandidate);
            this.#transition(
                Object.freeze({
                    status: "review",
                    preview: preview.value,
                    existingAssets: assets.value.assets,
                    selectedCandidateIds: Object.freeze(selectedCandidates.map((candidate) => candidate.candidateId)),
                    destinationSelections: Object.freeze(
                        selectedCandidates.map((candidate) =>
                            Object.freeze({ candidateId: candidate.candidateId, action: "create_asset" as const }),
                        ),
                    ),
                    bindingSelections: Object.freeze([]),
                    detail: Object.freeze({ status: "none" }),
                    activity: "idle",
                    message: localizedText(
                        preview.value.candidates.length === 0 ? "import.no_candidates" : "import.choose_candidates",
                    ),
                    readIssues: Object.freeze([...readIssues]),
                    diagnostics: mergeDiagnostics(readDiagnostics, assets.diagnostics, preview.diagnostics),
                    refreshRequired: false,
                }),
            );
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("import.interrupted"),
                        preparation: retryPreparation,
                        diagnostics: Object.freeze([]),
                        refreshRequired: false,
                    }),
                );
            }
        }
    }

    public async retryRead(): Promise<void> {
        if (this.#state.status !== "read_attention") return;
        await this.prepare(this.#state.preparation);
    }

    public async retryFailed(): Promise<void> {
        if (this.#state.status !== "failed" || this.#state.refreshRequired) return;
        await this.prepare(this.#state.preparation);
    }

    public async continueWithCompleteSources(): Promise<void> {
        if (this.#state.status !== "read_attention" || this.#state.completeSourcePreparation === undefined) return;
        await this.prepare(this.#state.completeSourcePreparation);
    }

    public toggleCandidate(candidateId: string): void {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        const candidate = candidateFor(this.#state.preview, candidateId);
        if (candidate === undefined || !isSelectableCandidate(candidate)) return;
        const selected = new Set(this.#state.selectedCandidateIds);
        const wasSelected = selected.has(candidateId);
        if (wasSelected) selected.delete(candidateId);
        else selected.add(candidateId);
        const retainedDestinations = this.#state.destinationSelections.filter((destination) =>
            selected.has(destination.candidateId),
        );
        const destinationSelections = wasSelected
            ? retainedDestinations
            : [...retainedDestinations, Object.freeze({ candidateId, action: "create_asset" as const })];
        const bindingSelections = this.#state.bindingSelections.filter(
            (binding) =>
                selected.has(binding.candidateId) &&
                (binding.targetKind === "asset_version" || selected.has(binding.targetCandidateId)),
        );
        const detailBelongsToDeselectedCandidate =
            wasSelected &&
            this.#state.detail.status !== "none" &&
            (this.#state.detail.status === "ready"
                ? this.#state.detail.value.candidateId === candidateId
                : this.#state.detail.candidateId === candidateId);
        if (detailBelongsToDeselectedCandidate) this.#detailGeneration += 1;
        this.#transition(
            Object.freeze({
                ...this.#state,
                selectedCandidateIds: Object.freeze(
                    this.#state.preview.candidates
                        .filter((previewCandidate) => selected.has(previewCandidate.candidateId))
                        .map((previewCandidate) => previewCandidate.candidateId),
                ),
                destinationSelections: Object.freeze(destinationSelections),
                bindingSelections: Object.freeze(bindingSelections),
                detail: detailBelongsToDeselectedCandidate ? Object.freeze({ status: "none" as const }) : this.#state.detail,
                activity: "idle",
                message: undefined,
            }),
        );
    }

    public setDestination(candidateId: string, asset: ExistingAssetSummaryView | "create_asset" | undefined): void {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        const candidate = candidateFor(this.#state.preview, candidateId);
        if (candidate === undefined || !this.#state.selectedCandidateIds.includes(candidateId)) return;
        const retained = this.#state.destinationSelections.filter((destination) => destination.candidateId !== candidateId);
        if (asset === undefined) {
            this.#transition(
                Object.freeze({ ...this.#state, destinationSelections: Object.freeze(retained), message: undefined }),
            );
            return;
        }
        if (asset !== "create_asset" && (asset.deleted || asset.kind !== candidate.kind)) {
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    message: localizedText("import.choose_compatible_asset"),
                }),
            );
            return;
        }
        const destination: ImportDestinationSelection =
            asset === "create_asset"
                ? Object.freeze({ candidateId, action: "create_asset" })
                : Object.freeze({
                      candidateId,
                      action: "create_version",
                      assetId: asset.assetId,
                      parentVersionId: asset.currentVersionId,
                  });
        this.#transition(
            Object.freeze({
                ...this.#state,
                destinationSelections: Object.freeze([...retained, destination]),
                message: undefined,
            }),
        );
    }

    public clearBindingTarget(candidateId: string, subjectKey: string): void {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        const retained = this.#state.bindingSelections.filter(
            (binding) => binding.candidateId !== candidateId || binding.subjectKey !== subjectKey,
        );
        this.#transition(Object.freeze({ ...this.#state, bindingSelections: Object.freeze(retained), message: undefined }));
    }

    public setBindingCandidateTarget(candidateId: string, subjectKey: string, targetCandidateId: string): void {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        const owner = candidateFor(this.#state.preview, candidateId);
        const request = owner?.callableBindingRequests.find(
            (candidateRequest) => callableBindingSubjectKey(candidateRequest.subject) === subjectKey,
        );
        const retained = this.#state.bindingSelections.filter(
            (binding) => binding.candidateId !== candidateId || binding.subjectKey !== subjectKey,
        );
        const target = candidateFor(this.#state.preview, targetCandidateId);
        if (
            request === undefined ||
            target === undefined ||
            targetCandidateId === candidateId ||
            !this.#state.selectedCandidateIds.includes(candidateId) ||
            !this.#state.selectedCandidateIds.includes(targetCandidateId) ||
            !canTargetBinding(request, target)
        ) {
            this.#transition(Object.freeze({ ...this.#state, message: localizedText("import.choose_compatible_candidate") }));
            return;
        }
        this.#transition(
            Object.freeze({
                ...this.#state,
                bindingSelections: Object.freeze([
                    ...retained,
                    Object.freeze({ candidateId, subjectKey, targetKind: "candidate", targetCandidateId }),
                ]),
                message: undefined,
            }),
        );
    }

    public setBindingExistingVersionTarget(candidateId: string, subjectKey: string, asset: ExistingAssetSummaryView): void {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        const owner = candidateFor(this.#state.preview, candidateId);
        const request = owner?.callableBindingRequests.find(
            (candidateRequest) => callableBindingSubjectKey(candidateRequest.subject) === subjectKey,
        );
        const retained = this.#state.bindingSelections.filter(
            (binding) => binding.candidateId !== candidateId || binding.subjectKey !== subjectKey,
        );
        if (
            request === undefined ||
            !this.#state.selectedCandidateIds.includes(candidateId) ||
            !canTargetExistingAsset(request, asset)
        ) {
            this.#transition(Object.freeze({ ...this.#state, message: localizedText("import.choose_existing_version") }));
            return;
        }
        this.#transition(
            Object.freeze({
                ...this.#state,
                bindingSelections: Object.freeze([
                    ...retained,
                    Object.freeze({
                        candidateId,
                        subjectKey,
                        targetKind: "asset_version",
                        targetAssetVersionId: asset.currentVersionId,
                    }),
                ]),
                message: undefined,
            }),
        );
    }

    public async loadDetail(candidateId: string, logicalPath?: string): Promise<void> {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        if (candidateFor(this.#state.preview, candidateId) === undefined) return;
        const generation = this.#generation;
        const detailGeneration = ++this.#detailGeneration;
        const current = this.#state;
        this.#transition(
            Object.freeze({
                ...current,
                detail: Object.freeze({ status: "loading", candidateId, logicalPath }),
                message: undefined,
            }),
        );
        try {
            const detail = await this.#client.getImportPreviewDetail({
                previewToken: current.preview.previewToken,
                candidateId,
                ...(logicalPath === undefined ? {} : { logicalPath }),
            });
            if (
                generation !== this.#generation ||
                detailGeneration !== this.#detailGeneration ||
                this.#state.status !== "review"
            ) {
                return;
            }
            if (detail.status === "failed") {
                const refreshRequired = diagnosticsRequireRefresh(detail.diagnostics);
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        detail: Object.freeze({
                            status: "failed",
                            candidateId,
                            logicalPath,
                            message: localizedText("import.detail.unavailable"),
                            diagnostics: Object.freeze([...detail.diagnostics]),
                            refreshRequired,
                        }),
                        refreshRequired: this.#state.refreshRequired || refreshRequired,
                    }),
                );
                return;
            }
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    detail: Object.freeze({ status: "ready", value: detail.value }),
                    diagnostics: mergeDiagnostics(this.#state.diagnostics, detail.diagnostics),
                }),
            );
        } catch {
            if (
                generation === this.#generation &&
                detailGeneration === this.#detailGeneration &&
                this.#state.status === "review"
            ) {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        detail: Object.freeze({
                            status: "failed",
                            candidateId,
                            logicalPath,
                            message: localizedText("import.detail.interrupted"),
                            diagnostics: Object.freeze([]),
                            refreshRequired: false,
                        }),
                    }),
                );
            }
        }
    }

    public async cancel(): Promise<void> {
        if (this.#state.status !== "review" || this.#state.activity === "accepting" || this.#state.activity === "cancelling")
            return;
        const generation = ++this.#generation;
        this.#detailGeneration += 1;
        const current = this.#state;
        this.#transition(Object.freeze({ ...current, activity: "cancelling", message: localizedText("import.cancelling") }));
        try {
            const outcome = await this.#client.cancelImportPreview({ previewToken: current.preview.previewToken });
            if (generation !== this.#generation) return;
            if (outcome.status === "failed") {
                const refreshRequired = diagnosticsRequireRefresh(outcome.diagnostics);
                this.#transition(
                    Object.freeze({
                        ...current,
                        activity: "cancel_failed",
                        message: localizedText("import.cancel.failed"),
                        diagnostics: mergeDiagnostics(current.diagnostics, outcome.diagnostics),
                        refreshRequired: current.refreshRequired || refreshRequired,
                    }),
                );
                return;
            }
            this.#transition(Object.freeze({ status: "idle", message: localizedText("import.cancelled") }));
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        ...current,
                        activity: "cancel_failed",
                        message: localizedText("import.cancel.interrupted"),
                    }),
                );
            }
        }
    }

    public async accept(): Promise<void> {
        if (this.#state.status !== "review" || isBusy(this.#state.activity) || this.#state.refreshRequired) return;
        const current = this.#state;
        const request = buildImportBatchRequest(
            current.preview,
            current.selectedCandidateIds,
            current.destinationSelections,
            current.bindingSelections,
            current.existingAssets,
            this.#options.createUserActionId(),
        );
        if (request.status === "invalid") {
            this.#transition(Object.freeze({ ...current, message: request.message }));
            return;
        }
        const generation = this.#generation;
        this.#detailGeneration += 1;
        this.#transition(Object.freeze({ ...current, activity: "accepting", message: localizedText("import.accepting") }));
        try {
            const outcome = await this.#client.acceptImportBatch(request.params);
            if (generation !== this.#generation || this.#state.status !== "review") return;
            if (outcome.status === "failed") {
                const refreshRequired = diagnosticsRequireRefresh(outcome.diagnostics);
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "accept_failed",
                        message: localizedText("import.batch.failed"),
                        diagnostics: mergeDiagnostics(current.diagnostics, outcome.diagnostics),
                        refreshRequired: current.refreshRequired || refreshRequired,
                    }),
                );
                return;
            }
            this.#generation += 1;
            this.#transition(
                Object.freeze({
                    status: "result",
                    result: outcome.value,
                    reviewedAssets: Object.freeze(
                        current.preview.candidates
                            .filter((candidate) => current.selectedCandidateIds.includes(candidate.candidateId))
                            .map((candidate) =>
                                Object.freeze({
                                    candidateId: candidate.candidateId,
                                    displayName: candidate.displayName,
                                    action:
                                        request.params.decisions.find(
                                            (decision) => decision.candidateId === candidate.candidateId,
                                        )?.action ?? "create_asset",
                                }),
                            ),
                    ),
                    message: localizedText(outcome.status === "partial" ? "import.batch.partial" : "import.batch.complete"),
                    diagnostics: mergeDiagnostics(current.diagnostics, outcome.diagnostics),
                }),
            );
            if (outcome.value.items.some((item) => item.status === "complete")) this.#options.onCatalogChanged?.();
        } catch {
            if (generation === this.#generation && this.#state.status === "review") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        activity: "accept_failed",
                        message: localizedText("import.connection_ended"),
                        refreshRequired: true,
                    }),
                );
            }
        }
    }

    #transition(state: ImportReviewState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
