import type { ProtocolDiagnosticV1, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import {
    type DesktopDisplayText,
    localizedText,
    nonInformationalProtocolDiagnostics,
    type ProtocolFeedback,
    protocolFeedback,
} from "../../presentation";
import type { AssetFilePreviewState, AssetVersionFilePreviewView } from "../asset-content-preview";
import type { AssetVersionFileTreeEntryView, AssetVersionSummaryView, AssetView } from "./project-library-model";

type ComparisonValue = Extract<
    ProtocolOperationTerminal<"asset_version.compare">,
    { readonly status: "complete" | "partial" }
>["value"];

export type AssetComparisonState =
    | { readonly status: "idle" }
    | {
          readonly status: "running" | "cancelling";
          readonly operationId?: string;
          readonly stage?: string;
          readonly completedUnits?: number;
          readonly totalUnits?: number;
      }
    | { readonly status: "ready"; readonly comparison: ComparisonValue }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

export type AssetExportKind = "native_files" | "oaam_version_package";

export type AssetExportState =
    | { readonly status: "idle" }
    | { readonly status: "running"; readonly exportKind: AssetExportKind }
    | { readonly status: "complete"; readonly exportKind: AssetExportKind; readonly archiveByteLength: number }
    | {
          readonly status: "failed";
          readonly exportKind: AssetExportKind;
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

export type AssetInspectorState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly assetId: string }
    | {
          readonly status: "failed";
          readonly assetId: string;
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "ready";
          readonly asset: AssetView;
          readonly versions: readonly AssetVersionSummaryView[];
          readonly versionsHaveMore: boolean;
          readonly nextVersionsCursor?: string;
          readonly selectedVersion: AssetVersionSummaryView;
          readonly directoryPath: string;
          readonly files: readonly AssetVersionFileTreeEntryView[];
          readonly filesHaveMore: boolean;
          readonly nextFilesCursor?: string;
          readonly preview: AssetFilePreviewState;
          readonly comparison: AssetComparisonState;
          readonly exportState: AssetExportState;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

function resultFeedback(diagnostics: readonly ProtocolDiagnosticV1[], fallback: DesktopDisplayText): ProtocolFeedback {
    return protocolFeedback(fallback, diagnostics);
}

export class AssetInspectorController {
    readonly #client: DesktopApplicationClientApi;
    readonly #listeners = new Set<(state: AssetInspectorState) => void>();
    #state: AssetInspectorState = Object.freeze({ status: "none" });
    #generation = 0;
    #activeComparisonOperationId: string | undefined;

    public constructor(client: DesktopApplicationClientApi) {
        this.#client = client;
    }

    public get state(): AssetInspectorState {
        return this.#state;
    }

    public subscribe(listener: (state: AssetInspectorState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => this.#listeners.delete(listener);
    }

    public dispose(): void {
        this.#generation += 1;
        this.#cancelInvalidatedComparison();
        this.#listeners.clear();
    }

    public clear(): void {
        this.#generation += 1;
        this.#cancelInvalidatedComparison();
        this.#transition(Object.freeze({ status: "none" }));
    }

    public async load(assetId: string, initialVersionId?: string): Promise<void> {
        const generation = ++this.#generation;
        this.#cancelInvalidatedComparison();
        if (
            !this.#client.supportsOperation("asset.get") ||
            !this.#client.supportsOperation("asset_version.list") ||
            !this.#client.supportsOperation("asset_version.file_children")
        ) {
            this.#transition({
                status: "failed",
                assetId,
                message: localizedText("library.asset_detail_unavailable"),
                diagnostics: Object.freeze([]),
            });
            return;
        }
        this.#transition(Object.freeze({ status: "loading", assetId }));
        try {
            const [assetOutcome, versionsOutcome] = await Promise.all([
                this.#client.getAsset({ assetId }),
                this.#client.listAssetVersions({ assetId, pageSize: 50 }),
            ]);
            if (generation !== this.#generation) return;
            if (assetOutcome.status === "failed" || versionsOutcome.status === "failed") {
                const diagnostics = assetOutcome.status === "failed" ? assetOutcome.diagnostics : versionsOutcome.diagnostics;
                this.#fail(assetId, localizedText("library.asset_detail_unavailable"), diagnostics);
                return;
            }
            if (!assetOutcome.value.found || !versionsOutcome.value.found || versionsOutcome.value.value.versions.length === 0) {
                this.#fail(assetId, localizedText("library.asset_missing"), [
                    ...assetOutcome.diagnostics,
                    ...versionsOutcome.diagnostics,
                ]);
                return;
            }
            let versionsPage = versionsOutcome.value.value;
            const versions = [...versionsPage.versions];
            const versionDiagnostics = [...versionsOutcome.diagnostics];
            let selectedVersion =
                initialVersionId === undefined ? versions[0] : versions.find((version) => version.versionId === initialVersionId);
            const seenCursors = new Set<string>();
            while (selectedVersion === undefined && versionsPage.hasMore && !seenCursors.has(versionsPage.nextCursor)) {
                seenCursors.add(versionsPage.nextCursor);
                const next = await this.#client.listAssetVersions({ assetId, pageSize: 50, cursor: versionsPage.nextCursor });
                if (generation !== this.#generation) return;
                if (next.status === "failed" || !next.value.found) {
                    this.#fail(assetId, localizedText("library.asset_detail_unavailable"), next.diagnostics);
                    return;
                }
                versionsPage = next.value.value;
                versions.push(
                    ...versionsPage.versions.filter(
                        (version) => !versions.some((known) => known.versionId === version.versionId),
                    ),
                );
                versionDiagnostics.push(...next.diagnostics);
                selectedVersion = versions.find((version) => version.versionId === initialVersionId);
            }
            if (selectedVersion === undefined) {
                this.#fail(assetId, localizedText("library.asset_detail_unavailable"), versionDiagnostics);
                return;
            }
            const filesOutcome = await this.#client.listAssetVersionFileChildren({
                assetId,
                versionId: selectedVersion.versionId,
                directoryPath: "",
                pageSize: 50,
            });
            if (generation !== this.#generation) return;
            if (filesOutcome.status === "failed" || !filesOutcome.value.found) {
                this.#fail(assetId, localizedText("library.asset_detail_unavailable"), filesOutcome.diagnostics);
                return;
            }
            const files = filesOutcome.value.value;
            this.#transition(
                Object.freeze({
                    status: "ready",
                    asset: assetOutcome.value.value,
                    versions: Object.freeze(versions),
                    versionsHaveMore: versionsPage.hasMore,
                    ...(versionsPage.hasMore ? { nextVersionsCursor: versionsPage.nextCursor } : {}),
                    selectedVersion,
                    directoryPath: "",
                    files: Object.freeze([...files.entries]),
                    filesHaveMore: files.hasMore,
                    ...(files.hasMore ? { nextFilesCursor: files.nextCursor } : {}),
                    preview: Object.freeze({ status: "none" }),
                    comparison: Object.freeze({ status: "idle" }),
                    exportState: Object.freeze({ status: "idle" }),
                    diagnostics: nonInformationalProtocolDiagnostics([
                        ...assetOutcome.diagnostics,
                        ...versionDiagnostics,
                        ...filesOutcome.diagnostics,
                    ]),
                }),
            );
        } catch {
            if (generation === this.#generation) {
                this.#fail(assetId, localizedText("library.asset_detail_interrupted"));
            }
        }
    }

    public async loadMoreVersions(): Promise<void> {
        const current = this.#state;
        if (current.status !== "ready" || !current.versionsHaveMore || current.nextVersionsCursor === undefined) return;
        const generation = this.#generation;
        try {
            const outcome = await this.#client.listAssetVersions({
                assetId: current.asset.assetId,
                pageSize: 50,
                cursor: current.nextVersionsCursor,
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (outcome.status === "failed" || !outcome.value.found) {
                this.#fail(current.asset.assetId, localizedText("library.load_failed"), outcome.diagnostics);
                return;
            }
            const page = outcome.value.value;
            this.#transition({
                ...this.#state,
                versions: Object.freeze([...this.#state.versions, ...page.versions]),
                versionsHaveMore: page.hasMore,
                ...(page.hasMore ? { nextVersionsCursor: page.nextCursor } : { nextVersionsCursor: undefined }),
                diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
            });
        } catch {
            if (generation === this.#generation) {
                this.#fail(current.asset.assetId, localizedText("library.load_interrupted"));
            }
        }
    }

    public async selectVersion(versionId: string): Promise<void> {
        const current = this.#state;
        if (current.status !== "ready") return;
        const version = current.versions.find((candidate) => candidate.versionId === versionId);
        if (version === undefined || version.versionId === current.selectedVersion.versionId) return;
        await this.#loadDirectory(current.asset, version, "");
    }

    public async enterDirectory(directoryPath: string): Promise<void> {
        const current = this.#state;
        if (current.status !== "ready" || directoryPath === current.directoryPath) return;
        await this.#loadDirectory(current.asset, current.selectedVersion, directoryPath);
    }

    public async loadMoreFiles(): Promise<void> {
        const current = this.#state;
        if (current.status !== "ready" || !current.filesHaveMore || current.nextFilesCursor === undefined) return;
        const generation = this.#generation;
        try {
            const outcome = await this.#client.listAssetVersionFileChildren({
                assetId: current.asset.assetId,
                versionId: current.selectedVersion.versionId,
                directoryPath: current.directoryPath,
                pageSize: 50,
                cursor: current.nextFilesCursor,
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (outcome.status === "failed" || !outcome.value.found) {
                this.#fail(current.asset.assetId, localizedText("library.load_failed"), outcome.diagnostics);
                return;
            }
            const page = outcome.value.value;
            this.#transition({
                ...this.#state,
                files: Object.freeze([...this.#state.files, ...page.entries]),
                filesHaveMore: page.hasMore,
                ...(page.hasMore ? { nextFilesCursor: page.nextCursor } : { nextFilesCursor: undefined }),
                diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
            });
        } catch {
            if (generation === this.#generation) {
                this.#fail(current.asset.assetId, localizedText("library.load_interrupted"));
            }
        }
    }

    public async selectFile(logicalPath: string): Promise<void> {
        const current = this.#state;
        if (current.status !== "ready" || !this.#client.supportsOperation("asset_version.file_preview")) return;
        const generation = ++this.#generation;
        this.#cancelInvalidatedComparison();
        this.#transition({ ...current, preview: { status: "loading", logicalPath } });
        try {
            const outcome = await this.#client.readAssetVersionFilePreview({
                assetId: current.asset.assetId,
                versionId: current.selectedVersion.versionId,
                logicalPath,
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (outcome.status === "failed" || !outcome.value.found) {
                const feedback = resultFeedback(outcome.diagnostics, localizedText("library.file_preview_failed"));
                this.#transition({
                    ...this.#state,
                    preview: {
                        status: "failed",
                        logicalPath,
                        ...feedback,
                    },
                });
                return;
            }
            const preview = outcome.value.value;
            if (preview.previewKind !== "large_text") {
                this.#transition({
                    ...this.#state,
                    preview: {
                        status: "ready",
                        logicalPath,
                        preview,
                        textPages: Object.freeze([]),
                        hasMoreText: false,
                    },
                    comparison: { status: "idle" },
                    diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
                });
                return;
            }
            await this.#loadFirstTextPage(generation, current, logicalPath, preview, outcome.diagnostics);
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition({
                    ...this.#state,
                    preview: {
                        status: "failed",
                        logicalPath,
                        message: localizedText("library.file_preview_failed"),
                        diagnostics: Object.freeze([]),
                    },
                });
            }
        }
    }

    public async loadMoreText(): Promise<void> {
        const current = this.#state;
        if (
            current.status !== "ready" ||
            current.preview.status !== "ready" ||
            !current.preview.hasMoreText ||
            current.preview.nextTextCursor === undefined
        ) {
            return;
        }
        const generation = this.#generation;
        try {
            const outcome = await this.#client.readAssetVersionTextPage({
                assetId: current.asset.assetId,
                versionId: current.selectedVersion.versionId,
                logicalPath: current.preview.logicalPath,
                cursor: current.preview.nextTextCursor,
            });
            if (generation !== this.#generation || this.#state.status !== "ready" || this.#state.preview.status !== "ready") {
                return;
            }
            if (outcome.status === "failed" || !outcome.value.found) {
                const feedback = resultFeedback(outcome.diagnostics, localizedText("library.file_preview_failed"));
                this.#transition({
                    ...this.#state,
                    preview: {
                        status: "failed",
                        logicalPath: current.preview.logicalPath,
                        ...feedback,
                    },
                });
                return;
            }
            const page = outcome.value.value;
            this.#transition({
                ...this.#state,
                preview: {
                    ...this.#state.preview,
                    textPages: Object.freeze([...this.#state.preview.textPages, page]),
                    hasMoreText: page.hasMore,
                    ...(page.hasMore ? { nextTextCursor: page.nextCursor } : { nextTextCursor: undefined }),
                },
                diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
            });
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition({
                    ...this.#state,
                    preview: {
                        status: "failed",
                        logicalPath: current.preview.logicalPath,
                        message: localizedText("library.file_preview_failed"),
                        diagnostics: Object.freeze([]),
                    },
                });
            }
        }
    }

    public async compareWith(versionId: string): Promise<void> {
        const current = this.#state;
        if (
            current.status !== "ready" ||
            current.comparison.status === "running" ||
            current.comparison.status === "cancelling" ||
            versionId === current.selectedVersion.versionId
        ) {
            return;
        }
        const other = current.versions.find((candidate) => candidate.versionId === versionId);
        if (other === undefined || !this.#client.supportsOperation("asset_version.compare")) return;
        const generation = this.#generation;
        let operationId: string | undefined;
        this.#transition({ ...current, comparison: { status: "running" } });
        const logicalPath =
            current.preview.status === "ready" || current.preview.status === "loading" || current.preview.status === "failed"
                ? current.preview.logicalPath
                : undefined;
        try {
            const outcome = await this.#client.compareAssetVersions(
                {
                    assetId: current.asset.assetId,
                    left: {
                        versionId: other.versionId,
                        versionFingerprint: other.fingerprint,
                    },
                    right: {
                        versionId: current.selectedVersion.versionId,
                        versionFingerprint: current.selectedVersion.fingerprint,
                    },
                    ...(logicalPath === undefined ? {} : { logicalPath }),
                },
                (update) => {
                    operationId = update.operationId;
                    if (generation !== this.#generation || this.#state.status !== "ready") {
                        this.#requestComparisonCancellation(update.operationId);
                        return;
                    }
                    this.#activeComparisonOperationId = update.operationId;
                    const cancelling = this.#state.comparison.status === "cancelling";
                    this.#transition({
                        ...this.#state,
                        comparison:
                            update.status === "accepted"
                                ? { status: cancelling ? "cancelling" : "running", operationId: update.operationId }
                                : {
                                      status: cancelling ? "cancelling" : "running",
                                      operationId: update.operationId,
                                      stage: update.progress.stage,
                                      completedUnits: update.progress.completedUnits,
                                      totalUnits: update.progress.totalUnits,
                                  },
                    });
                },
            );
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            this.#transition({
                ...this.#state,
                comparison:
                    outcome.status === "failed"
                        ? {
                              status: "failed",
                              ...resultFeedback(outcome.diagnostics, localizedText("library.compare_failed")),
                          }
                        : { status: "ready", comparison: outcome.value },
                diagnostics:
                    outcome.status === "failed"
                        ? this.#state.diagnostics
                        : nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
            });
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition({
                    ...this.#state,
                    comparison: {
                        status: "failed",
                        message: localizedText("library.compare_failed"),
                        diagnostics: Object.freeze([]),
                    },
                });
            }
        } finally {
            if (operationId !== undefined && this.#activeComparisonOperationId === operationId) {
                this.#activeComparisonOperationId = undefined;
            }
        }
    }

    public async cancelComparison(): Promise<void> {
        const current = this.#state;
        if (
            current.status !== "ready" ||
            current.comparison.status !== "running" ||
            current.comparison.operationId === undefined
        ) {
            return;
        }
        this.#transition({ ...current, comparison: { ...current.comparison, status: "cancelling" } });
        try {
            await this.#client.cancelOperation({ operationId: current.comparison.operationId });
        } catch {
            if (this.#state.status === "ready") {
                this.#transition({
                    ...this.#state,
                    comparison: {
                        status: "failed",
                        message: localizedText("library.compare_failed"),
                        diagnostics: Object.freeze([]),
                    },
                });
            }
        }
    }

    public async exportSelected(
        exportKind: AssetExportKind,
        localPathSelectionToken: string,
        userActionId: string,
    ): Promise<void> {
        const current = this.#state;
        const operation = exportKind === "native_files" ? "asset_version.export_native" : "asset_version.export";
        if (current.status !== "ready" || !this.#client.supportsOperation(operation)) return;
        const generation = this.#generation;
        this.#transition({ ...current, exportState: { status: "running", exportKind } });
        try {
            const params = {
                source: {
                    assetId: current.asset.assetId,
                    versionId: current.selectedVersion.versionId,
                    versionFingerprint: current.selectedVersion.fingerprint,
                    originAuthorityFingerprint: current.selectedVersion.originAuthorityFingerprint,
                },
                localPathSelectionToken,
                userActionId,
            };
            const outcome =
                exportKind === "native_files"
                    ? await this.#client.exportAssetVersionNative(params)
                    : await this.#client.exportAssetVersion(params);
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            const failureMessage =
                exportKind === "native_files"
                    ? localizedText("library.native_export.failed")
                    : localizedText("library.export.failed");
            this.#transition({
                ...this.#state,
                exportState:
                    outcome.status === "failed"
                        ? {
                              status: "failed",
                              exportKind,
                              ...resultFeedback(outcome.diagnostics, failureMessage),
                          }
                        : { status: "complete", exportKind, archiveByteLength: outcome.value.archiveByteLength },
                diagnostics:
                    outcome.status === "failed"
                        ? this.#state.diagnostics
                        : nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
            });
        } catch {
            if (generation === this.#generation && this.#state.status === "ready") {
                this.#transition({
                    ...this.#state,
                    exportState: {
                        status: "failed",
                        exportKind,
                        message:
                            exportKind === "native_files"
                                ? localizedText("library.native_export.failed")
                                : localizedText("library.export.failed"),
                        diagnostics: Object.freeze([]),
                    },
                });
            }
        }
    }

    public replaceAsset(asset: AssetView): void {
        if (this.#state.status !== "ready" || this.#state.asset.assetId !== asset.assetId) return;
        this.#transition({ ...this.#state, asset });
    }

    async #loadDirectory(asset: AssetView, version: AssetVersionSummaryView, directoryPath: string): Promise<void> {
        const generation = ++this.#generation;
        this.#cancelInvalidatedComparison();
        try {
            const outcome = await this.#client.listAssetVersionFileChildren({
                assetId: asset.assetId,
                versionId: version.versionId,
                directoryPath,
                pageSize: 50,
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (outcome.status === "failed" || !outcome.value.found) {
                this.#fail(asset.assetId, localizedText("library.load_failed"), outcome.diagnostics);
                return;
            }
            const page = outcome.value.value;
            this.#transition({
                ...this.#state,
                selectedVersion: version,
                directoryPath,
                files: Object.freeze([...page.entries]),
                filesHaveMore: page.hasMore,
                ...(page.hasMore ? { nextFilesCursor: page.nextCursor } : { nextFilesCursor: undefined }),
                preview: { status: "none" },
                comparison: { status: "idle" },
                exportState: { status: "idle" },
                diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...outcome.diagnostics]),
            });
        } catch {
            if (generation === this.#generation) {
                this.#fail(asset.assetId, localizedText("library.load_interrupted"));
            }
        }
    }

    async #loadFirstTextPage(
        generation: number,
        current: Extract<AssetInspectorState, { readonly status: "ready" }>,
        logicalPath: string,
        preview: Extract<AssetVersionFilePreviewView, { readonly previewKind: "large_text" }>,
        previewDiagnostics: readonly ProtocolDiagnosticV1[],
    ): Promise<void> {
        if (!this.#client.supportsOperation("asset_version.text_page")) {
            this.#transition({
                ...current,
                preview: { status: "ready", logicalPath, preview, textPages: [], hasMoreText: false },
                diagnostics: nonInformationalProtocolDiagnostics([...current.diagnostics, ...previewDiagnostics]),
            });
            return;
        }
        const outcome = await this.#client.readAssetVersionTextPage({
            assetId: current.asset.assetId,
            versionId: current.selectedVersion.versionId,
            logicalPath,
        });
        if (generation !== this.#generation || this.#state.status !== "ready") return;
        if (outcome.status === "failed" || !outcome.value.found) {
            const feedback = resultFeedback(outcome.diagnostics, localizedText("library.file_preview_failed"));
            this.#transition({
                ...this.#state,
                preview: {
                    status: "failed",
                    logicalPath,
                    ...feedback,
                },
            });
            return;
        }
        const page = outcome.value.value;
        this.#transition({
            ...this.#state,
            preview: {
                status: "ready",
                logicalPath,
                preview,
                textPages: Object.freeze([page]),
                hasMoreText: page.hasMore,
                ...(page.hasMore ? { nextTextCursor: page.nextCursor } : {}),
            },
            comparison: { status: "idle" },
            diagnostics: nonInformationalProtocolDiagnostics([
                ...this.#state.diagnostics,
                ...previewDiagnostics,
                ...outcome.diagnostics,
            ]),
        });
    }

    #fail(assetId: string, message: DesktopDisplayText, diagnostics: readonly ProtocolDiagnosticV1[] = []): void {
        this.#transition(
            Object.freeze({
                status: "failed",
                assetId,
                message,
                diagnostics: nonInformationalProtocolDiagnostics(diagnostics),
            }),
        );
    }

    #cancelInvalidatedComparison(): void {
        const operationId = this.#activeComparisonOperationId;
        this.#activeComparisonOperationId = undefined;
        if (operationId !== undefined) this.#requestComparisonCancellation(operationId);
    }

    #requestComparisonCancellation(operationId: string): void {
        if (!this.#client.supportsOperation("operation.cancel")) return;
        void this.#client.cancelOperation({ operationId }).catch(() => undefined);
    }

    #transition(state: AssetInspectorState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
