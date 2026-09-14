import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import {
    type DesktopDisplayText,
    localizedText,
    mergeNonInformationalProtocolDiagnostics,
    protocolFeedback,
} from "../../presentation";
import type { AssetVersionFilePreviewView } from "../asset-content-preview";
import type { CatalogDeploymentState } from "./catalog-deployment-state";

type ReadyCatalogState = Extract<CatalogDeploymentState, { readonly status: "ready" }>;
type ReadyAssetDetailState = Extract<ReadyCatalogState["assetDetail"], { readonly status: "ready" }>;
type ReadyCatalogAssetDetailState = Omit<ReadyCatalogState, "assetDetail"> & {
    readonly assetDetail: ReadyAssetDetailState;
};

interface CatalogAssetDetailControllerOptions {
    readonly client: DesktopApplicationClientApi;
    readonly current: () => CatalogDeploymentState;
    readonly transition: (state: CatalogDeploymentState) => void;
    readonly nextOwnerGeneration: () => number;
    readonly isCurrentOwnerGeneration: (generation: number) => boolean;
    readonly busy: () => boolean;
}

export class CatalogAssetDetailController {
    readonly #options: CatalogAssetDetailControllerOptions;
    #generation = 0;

    public constructor(options: CatalogAssetDetailControllerOptions) {
        this.#options = options;
    }

    public invalidate(): void {
        this.#generation += 1;
    }

    public async selectAsset(assetId: string): Promise<void> {
        const current = this.#options.current();
        if (current.status !== "ready" || this.#options.busy()) return;
        const summary = current.assets.find((asset) => asset.assetId === assetId);
        if (summary === undefined) return;
        const ownerGeneration = this.#options.nextOwnerGeneration();
        const generation = ++this.#generation;
        this.#options.transition(
            Object.freeze({
                ...current,
                assetDetail: Object.freeze({ status: "loading", assetId }),
                message: undefined,
            }),
        );
        try {
            const [asset, version] = await Promise.all([
                this.#options.client.getAsset({ assetId }),
                this.#options.client.getAssetVersion({ assetId, versionId: summary.currentVersionId }),
            ]);
            const ready = this.#current(ownerGeneration, generation);
            if (ready === undefined) return;
            if (asset.status === "failed" || version.status === "failed") {
                const diagnostics = asset.status === "failed" ? asset.diagnostics : version.diagnostics;
                this.#setFailure(ready, assetId, localizedText("catalog.asset.detail_unavailable"), diagnostics);
                return;
            }
            if (!asset.value.found || !version.value.found) {
                this.#setFailure(ready, assetId, localizedText("catalog.asset.missing"));
                return;
            }
            this.#options.transition(
                Object.freeze({
                    ...ready,
                    assetDetail: Object.freeze({
                        status: "ready",
                        asset: asset.value.value,
                        version: version.value.value,
                        preview: Object.freeze({ status: "none" }),
                    }),
                    diagnostics: mergeNonInformationalProtocolDiagnostics(
                        ready.diagnostics,
                        asset.diagnostics,
                        version.diagnostics,
                    ),
                }),
            );
            const firstFile = version.value.value.files[0];
            if (firstFile !== undefined) await this.selectFile(firstFile.logicalPath);
        } catch {
            const ready = this.#current(ownerGeneration, generation);
            if (ready !== undefined) this.#setFailure(ready, assetId, localizedText("catalog.asset.detail_interrupted"));
        }
    }

    public clear(): void {
        const current = this.#options.current();
        if (current.status !== "ready" || current.assetDetail.status === "none") return;
        this.invalidate();
        this.#options.transition({ ...current, assetDetail: Object.freeze({ status: "none" }) });
    }

    public async selectFile(logicalPath: string): Promise<void> {
        const current = this.#options.current();
        if (
            current.status !== "ready" ||
            current.assetDetail.status !== "ready" ||
            !current.assetDetail.version.files.some((file) => file.logicalPath === logicalPath)
        ) {
            return;
        }
        const detail = current.assetDetail;
        if (!this.#options.client.supportsOperation("asset_version.file_preview")) {
            this.#options.transition({
                ...current,
                assetDetail: {
                    ...detail,
                    preview: {
                        status: "failed",
                        logicalPath,
                        message: localizedText("library.file_preview_failed"),
                        diagnostics: Object.freeze([]),
                    },
                },
            });
            return;
        }
        const generation = ++this.#generation;
        this.#options.transition({ ...current, assetDetail: { ...detail, preview: { status: "loading", logicalPath } } });
        try {
            const outcome = await this.#options.client.readAssetVersionFilePreview({
                assetId: detail.asset.assetId,
                versionId: detail.version.versionId,
                logicalPath,
            });
            const ready = this.#readyDetail(generation);
            if (ready === undefined) return;
            if (outcome.status === "failed" || !outcome.value.found) {
                const feedback = protocolFeedback(localizedText("library.file_preview_failed"), outcome.diagnostics);
                this.#options.transition({
                    ...ready,
                    assetDetail: { ...ready.assetDetail, preview: { status: "failed", logicalPath, ...feedback } },
                });
                return;
            }
            const preview = outcome.value.value;
            if (preview.previewKind !== "large_text") {
                this.#options.transition({
                    ...ready,
                    assetDetail: {
                        ...ready.assetDetail,
                        preview: {
                            status: "ready",
                            logicalPath,
                            preview,
                            textPages: Object.freeze([]),
                            hasMoreText: false,
                        },
                    },
                    diagnostics: mergeNonInformationalProtocolDiagnostics(ready.diagnostics, outcome.diagnostics),
                });
                return;
            }
            await this.#loadFirstTextPage(generation, ready, logicalPath, preview, outcome.diagnostics);
        } catch {
            const ready = this.#readyDetail(generation);
            if (ready !== undefined) this.#setPreviewFailure(ready, logicalPath);
        }
    }

    public async loadMoreText(): Promise<void> {
        const current = this.#options.current();
        if (current.status !== "ready" || current.assetDetail.status !== "ready") return;
        const detail = current.assetDetail;
        const preview = detail.preview;
        if (preview.status !== "ready" || !preview.hasMoreText || preview.nextTextCursor === undefined) return;
        const generation = this.#generation;
        try {
            const outcome = await this.#options.client.readAssetVersionTextPage({
                assetId: detail.asset.assetId,
                versionId: detail.version.versionId,
                logicalPath: preview.logicalPath,
                cursor: preview.nextTextCursor,
            });
            const ready = this.#readyDetail(generation);
            if (ready === undefined) return;
            if (outcome.status === "failed" || !outcome.value.found) {
                const feedback = protocolFeedback(localizedText("library.file_preview_failed"), outcome.diagnostics);
                this.#options.transition({
                    ...ready,
                    assetDetail: {
                        ...ready.assetDetail,
                        preview: { status: "failed", logicalPath: preview.logicalPath, ...feedback },
                    },
                });
                return;
            }
            const page = outcome.value.value;
            const activePreview = ready.assetDetail.preview;
            if (activePreview.status !== "ready" || activePreview.logicalPath !== preview.logicalPath) return;
            this.#options.transition({
                ...ready,
                assetDetail: {
                    ...ready.assetDetail,
                    preview: {
                        ...activePreview,
                        textPages: Object.freeze([...activePreview.textPages, page]),
                        hasMoreText: page.hasMore,
                        ...(page.hasMore ? { nextTextCursor: page.nextCursor } : { nextTextCursor: undefined }),
                    },
                },
                diagnostics: mergeNonInformationalProtocolDiagnostics(ready.diagnostics, outcome.diagnostics),
            });
        } catch {
            const ready = this.#readyDetail(generation);
            if (ready !== undefined) this.#setPreviewFailure(ready, preview.logicalPath);
        }
    }

    async #loadFirstTextPage(
        generation: number,
        current: ReadyCatalogAssetDetailState,
        logicalPath: string,
        preview: Extract<AssetVersionFilePreviewView, { readonly previewKind: "large_text" }>,
        previewDiagnostics: readonly ProtocolDiagnosticV1[],
    ): Promise<void> {
        if (!this.#options.client.supportsOperation("asset_version.text_page")) {
            this.#options.transition({
                ...current,
                assetDetail: {
                    ...current.assetDetail,
                    preview: { status: "ready", logicalPath, preview, textPages: [], hasMoreText: false },
                },
                diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, previewDiagnostics),
            });
            return;
        }
        const outcome = await this.#options.client.readAssetVersionTextPage({
            assetId: current.assetDetail.asset.assetId,
            versionId: current.assetDetail.version.versionId,
            logicalPath,
        });
        const ready = this.#readyDetail(generation);
        if (ready === undefined) return;
        if (outcome.status === "failed" || !outcome.value.found) {
            const feedback = protocolFeedback(localizedText("library.file_preview_failed"), outcome.diagnostics);
            this.#options.transition({
                ...ready,
                assetDetail: { ...ready.assetDetail, preview: { status: "failed", logicalPath, ...feedback } },
            });
            return;
        }
        const page = outcome.value.value;
        this.#options.transition({
            ...ready,
            assetDetail: {
                ...ready.assetDetail,
                preview: {
                    status: "ready",
                    logicalPath,
                    preview,
                    textPages: Object.freeze([page]),
                    hasMoreText: page.hasMore,
                    ...(page.hasMore ? { nextTextCursor: page.nextCursor } : {}),
                },
            },
            diagnostics: mergeNonInformationalProtocolDiagnostics(ready.diagnostics, previewDiagnostics, outcome.diagnostics),
        });
    }

    #current(ownerGeneration: number, generation: number): ReadyCatalogState | undefined {
        const current = this.#options.current();
        return this.#options.isCurrentOwnerGeneration(ownerGeneration) &&
            generation === this.#generation &&
            current.status === "ready"
            ? current
            : undefined;
    }

    #readyDetail(generation: number): ReadyCatalogAssetDetailState | undefined {
        const current = this.#options.current();
        return generation === this.#generation && current.status === "ready" && current.assetDetail.status === "ready"
            ? (current as ReadyCatalogAssetDetailState)
            : undefined;
    }

    #setPreviewFailure(current: ReadyCatalogAssetDetailState, logicalPath: string): void {
        this.#options.transition({
            ...current,
            assetDetail: {
                ...current.assetDetail,
                preview: {
                    status: "failed",
                    logicalPath,
                    message: localizedText("library.file_preview_failed"),
                    diagnostics: Object.freeze([]),
                },
            },
        });
    }

    #setFailure(
        current: ReadyCatalogState,
        assetId: string,
        message: DesktopDisplayText,
        diagnostics: readonly ProtocolDiagnosticV1[] = [],
    ): void {
        this.#options.transition(
            Object.freeze({
                ...current,
                assetDetail: Object.freeze({ status: "failed", assetId, message }),
                diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, diagnostics),
            }),
        );
    }
}
