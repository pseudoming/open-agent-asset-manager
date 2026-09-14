import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi, DesktopLongOperationListener } from "../src/renderer/client";
import { AssetInspectorController, type AssetInspectorState } from "../src/renderer/features/project-library";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PREVIOUS_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const ASSET = {
    assetId: ASSET_ID,
    kind: "Guidance" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Project rules",
    versionIds: [CURRENT_VERSION_ID, PREVIOUS_VERSION_ID],
    deleted: false,
    createdAt: 1,
    updatedAt: 3,
};

const CURRENT_VERSION = {
    assetId: ASSET_ID,
    versionId: CURRENT_VERSION_ID,
    revision: 2,
    status: "complete" as const,
    fingerprint: DIGEST_A,
    originAuthorityFingerprint: DIGEST_B,
    versionCanonicalContentFingerprint: DIGEST_A,
    changeKind: "edit" as const,
    sourceVersionId: PREVIOUS_VERSION_ID,
    sourceDeploymentId: "",
    changeNote: "Updated guidance",
    fileCount: 2,
    createdAt: 3,
};

const PREVIOUS_VERSION = {
    ...CURRENT_VERSION,
    versionId: PREVIOUS_VERSION_ID,
    revision: 1,
    fingerprint: DIGEST_B,
    changeKind: "create" as const,
    sourceVersionId: "",
    changeNote: "",
    createdAt: 2,
};

const FILE = {
    fileId: FILE_ID,
    logicalPath: "AGENTS.md",
    role: "entry" as const,
    mediaType: "text/markdown",
    contentKind: "text" as const,
    contentHash: DIGEST_A,
    byteLength: 3_000_000,
    executable: false,
};

const ERROR = {
    severity: "error" as const,
    code: "asset.failed",
    operation: "asset" as const,
    causeKind: "internal_error" as const,
    retryable: true,
    suggestedActions: ["retry"],
    message: "The exact Asset could not be loaded.",
};

const OPERATIONS: readonly ProtocolOperationName[] = [
    "asset.get",
    "asset_version.list",
    "asset_version.file_children",
    "asset_version.file_preview",
    "asset_version.text_page",
    "asset_version.compare",
    "asset_version.export",
    "asset_version.export_native",
    "operation.cancel",
];

function complete<T>(value: T) {
    return { status: "complete" as const, value, diagnostics: [] };
}

function failed(message = ERROR.message) {
    return {
        status: "failed" as const,
        diagnostics: [{ ...ERROR, message }],
    };
}

function fakeClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    return {
        availableOperations: OPERATIONS,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => OPERATIONS.includes(operation)),
        getAsset: vi.fn(async () => complete({ found: true as const, value: ASSET })),
        listAssetVersions: vi.fn(async ({ cursor }) =>
            complete({
                found: true as const,
                value:
                    cursor === undefined
                        ? {
                              versions: [CURRENT_VERSION],
                              totalCount: 2,
                              hasMore: true as const,
                              nextCursor: "previous",
                          }
                        : {
                              versions: [PREVIOUS_VERSION],
                              totalCount: 2,
                              hasMore: false as const,
                          },
            }),
        ),
        listAssetVersionFileChildren: vi.fn(async ({ directoryPath, cursor }) =>
            complete({
                found: true as const,
                value:
                    cursor === undefined
                        ? {
                              entries:
                                  directoryPath === ""
                                      ? [
                                            {
                                                entryKind: "directory" as const,
                                                relativeName: "references",
                                                logicalPath: "references",
                                                descendantFileCount: 1,
                                            },
                                            { entryKind: "file" as const, relativeName: "AGENTS.md", file: FILE },
                                        ]
                                      : [
                                            {
                                                entryKind: "file" as const,
                                                relativeName: "guide.md",
                                                file: { ...FILE, logicalPath: "references/guide.md" },
                                            },
                                        ],
                              totalCount: directoryPath === "" ? 3 : 1,
                              hasMore: directoryPath === "" ? (true as const) : (false as const),
                              ...(directoryPath === "" ? { nextCursor: "more-files" } : {}),
                          }
                        : {
                              entries: [
                                  {
                                      entryKind: "file" as const,
                                      relativeName: "README.md",
                                      file: { ...FILE, logicalPath: "README.md" },
                                  },
                              ],
                              totalCount: 3,
                              hasMore: false as const,
                          },
            }),
        ),
        readAssetVersionFilePreview: vi.fn(async ({ logicalPath }) =>
            complete({
                found: true as const,
                value:
                    logicalPath === "small.md"
                        ? {
                              previewKind: "text" as const,
                              file: { ...FILE, logicalPath, byteLength: 8 },
                              text: "# Small\n",
                              lineCount: 2,
                          }
                        : logicalPath === "binary.bin"
                          ? {
                                previewKind: "binary" as const,
                                file: { ...FILE, logicalPath, contentKind: "binary" as const },
                            }
                          : {
                                previewKind: "large_text" as const,
                                file: { ...FILE, logicalPath },
                                limitReason: "byte_limit" as const,
                            },
            }),
        ),
        readAssetVersionTextPage: vi.fn(async ({ cursor }) =>
            complete({
                found: true as const,
                value:
                    cursor === undefined
                        ? {
                              file: FILE,
                              text: "first page\n",
                              loadedByteStart: 0,
                              loadedByteEnd: 11,
                              totalBytes: 22,
                              firstLine: 1,
                              lastLine: 1,
                              totalLines: 2,
                              hasMore: true as const,
                              nextCursor: "second-page",
                          }
                        : {
                              file: FILE,
                              text: "second page\n",
                              loadedByteStart: 11,
                              loadedByteEnd: 22,
                              totalBytes: 22,
                              firstLine: 2,
                              lastLine: 2,
                              totalLines: 2,
                              hasMore: false as const,
                          },
            }),
        ),
        compareAssetVersions: vi.fn(
            async (_params: unknown, listener?: DesktopLongOperationListener<"asset_version.compare">) => {
                listener?.({
                    status: "accepted",
                    operation: "asset_version.compare",
                    operationId: "compare-operation",
                });
                listener?.({
                    status: "progress",
                    operation: "asset_version.compare",
                    operationId: "compare-operation",
                    sequence: 1,
                    progress: { stage: "diffing", completedUnits: 1, totalUnits: 1 },
                });
                return complete({
                    schemaVersion: 1 as const,
                    assetId: ASSET_ID,
                    left: { versionId: PREVIOUS_VERSION_ID, versionFingerprint: DIGEST_B },
                    right: { versionId: CURRENT_VERSION_ID, versionFingerprint: DIGEST_A },
                    files: [
                        {
                            logicalPath: "AGENTS.md",
                            changeKind: "modified" as const,
                            left: { state: "present" as const, file: { ...FILE, contentHash: DIGEST_B } },
                            right: { state: "present" as const, file: FILE },
                        },
                    ],
                    selectedFile: { comparisonKind: "not_requested" as const },
                });
            },
        ),
        exportAssetVersion: vi.fn(async () =>
            complete({
                assetId: ASSET_ID,
                versionId: CURRENT_VERSION_ID,
                versionFingerprint: DIGEST_A,
                archiveIndexFingerprint: DIGEST_B,
                archiveByteLength: 1_024,
            }),
        ),
        exportAssetVersionNative: vi.fn(async () =>
            complete({
                assetId: ASSET_ID,
                versionId: CURRENT_VERSION_ID,
                versionFingerprint: DIGEST_A,
                dialectId: "fixture-native-v1",
                representationFingerprint: DIGEST_B,
                fileCount: 1,
                archiveByteLength: 512,
            }),
        ),
        cancelOperation: vi.fn(async () => complete({ operationId: "compare-operation", cancellationRequested: true })),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
}

function readyState(controller: AssetInspectorController): Extract<AssetInspectorState, { readonly status: "ready" }> {
    expect(controller.state.status).toBe("ready");
    return controller.state as Extract<AssetInspectorState, { readonly status: "ready" }>;
}

async function loadedController(client = fakeClient()): Promise<AssetInspectorController> {
    const controller = new AssetInspectorController(client);
    await controller.load(ASSET_ID);
    return controller;
}

describe("AssetInspectorController", () => {
    it("loads exact bounded Version/file pages and resets dependent views when selection changes", async () => {
        const client = fakeClient();
        const controller = await loadedController(client);

        expect(client.getAsset).toHaveBeenCalledWith({ assetId: ASSET_ID });
        expect(client.listAssetVersions).toHaveBeenCalledWith({ assetId: ASSET_ID, pageSize: 50 });
        expect(client.listAssetVersionFileChildren).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            versionId: CURRENT_VERSION_ID,
            directoryPath: "",
            pageSize: 50,
        });

        await controller.loadMoreVersions();
        expect(client.listAssetVersions).toHaveBeenLastCalledWith({
            assetId: ASSET_ID,
            pageSize: 50,
            cursor: "previous",
        });
        expect(readyState(controller).versions).toHaveLength(2);

        await controller.loadMoreFiles();
        expect(client.listAssetVersionFileChildren).toHaveBeenLastCalledWith({
            assetId: ASSET_ID,
            versionId: CURRENT_VERSION_ID,
            directoryPath: "",
            pageSize: 50,
            cursor: "more-files",
        });
        expect(readyState(controller).files).toHaveLength(3);

        await controller.enterDirectory("references");
        expect(readyState(controller)).toMatchObject({
            directoryPath: "references",
            filesHaveMore: false,
            preview: { status: "none" },
            comparison: { status: "idle" },
            exportState: { status: "idle" },
        });

        await controller.selectVersion(PREVIOUS_VERSION_ID);
        expect(readyState(controller)).toMatchObject({
            selectedVersion: { versionId: PREVIOUS_VERSION_ID },
            directoryPath: "",
        });
    });

    it("keeps small/binary previews bounded and progressively reads a large text file", async () => {
        const client = fakeClient();
        const controller = await loadedController(client);

        await controller.selectFile("small.md");
        expect(readyState(controller).preview).toMatchObject({
            status: "ready",
            logicalPath: "small.md",
            preview: { previewKind: "text", text: "# Small\n" },
            textPages: [],
            hasMoreText: false,
        });
        expect(client.readAssetVersionTextPage).not.toHaveBeenCalled();

        await controller.selectFile("binary.bin");
        expect(readyState(controller).preview).toMatchObject({
            status: "ready",
            preview: { previewKind: "binary" },
            hasMoreText: false,
        });

        await controller.selectFile("large.md");
        expect(client.readAssetVersionTextPage).toHaveBeenLastCalledWith({
            assetId: ASSET_ID,
            versionId: CURRENT_VERSION_ID,
            logicalPath: "large.md",
        });
        expect(readyState(controller).preview).toMatchObject({
            status: "ready",
            preview: { previewKind: "large_text" },
            textPages: [{ text: "first page\n" }],
            hasMoreText: true,
            nextTextCursor: "second-page",
        });

        await controller.loadMoreText();
        expect(client.readAssetVersionTextPage).toHaveBeenLastCalledWith({
            assetId: ASSET_ID,
            versionId: CURRENT_VERSION_ID,
            logicalPath: "large.md",
            cursor: "second-page",
        });
        expect(readyState(controller).preview).toMatchObject({
            status: "ready",
            textPages: [{ text: "first page\n" }, { text: "second page\n" }],
            hasMoreText: false,
        });
    });

    it("binds compare and export to the selected Version identities", async () => {
        const client = fakeClient();
        const controller = await loadedController(client);
        await controller.loadMoreVersions();
        await controller.selectFile("small.md");

        await controller.compareWith(PREVIOUS_VERSION_ID);
        expect(client.compareAssetVersions).toHaveBeenCalledWith(
            {
                assetId: ASSET_ID,
                left: { versionId: PREVIOUS_VERSION_ID, versionFingerprint: DIGEST_B },
                right: { versionId: CURRENT_VERSION_ID, versionFingerprint: DIGEST_A },
                logicalPath: "small.md",
            },
            expect.any(Function),
        );
        expect(readyState(controller).comparison).toMatchObject({
            status: "ready",
            comparison: { schemaVersion: 1, assetId: ASSET_ID },
        });

        await controller.exportSelected("oaam_version_package", "export-path-token", "user-action");
        expect(client.exportAssetVersion).toHaveBeenCalledWith({
            source: {
                assetId: ASSET_ID,
                versionId: CURRENT_VERSION_ID,
                versionFingerprint: DIGEST_A,
                originAuthorityFingerprint: DIGEST_B,
            },
            localPathSelectionToken: "export-path-token",
            userActionId: "user-action",
        });
        expect(readyState(controller).exportState).toEqual({
            status: "complete",
            exportKind: "oaam_version_package",
            archiveByteLength: 1_024,
        });
        await controller.exportSelected("native_files", "native-path-token", "native-user-action");
        expect(client.exportAssetVersionNative).toHaveBeenCalledWith({
            source: {
                assetId: ASSET_ID,
                versionId: CURRENT_VERSION_ID,
                versionFingerprint: DIGEST_A,
                originAuthorityFingerprint: DIGEST_B,
            },
            localPathSelectionToken: "native-path-token",
            userActionId: "native-user-action",
        });
        expect(readyState(controller).exportState).toEqual({
            status: "complete",
            exportKind: "native_files",
            archiveByteLength: 512,
        });
    });

    it("fails explicitly for unavailable, rejected and interrupted operations and ignores disposed work", async () => {
        const unavailable = new AssetInspectorController(
            fakeClient({
                supportsOperation: vi.fn(() => false),
            }),
        );
        await unavailable.load(ASSET_ID);
        expect(unavailable.state.status).toBe("failed");

        const rejected = new AssetInspectorController(
            fakeClient({
                getAsset: vi.fn(async () => ({ status: "failed", diagnostics: [ERROR] })),
            }),
        );
        await rejected.load(ASSET_ID);
        expect(rejected.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.asset_detail_unavailable" },
            diagnostics: [ERROR],
        });

        const interrupted = await loadedController(
            fakeClient({
                readAssetVersionFilePreview: vi.fn(async () => {
                    throw new Error("offline");
                }),
            }),
        );
        await interrupted.selectFile("AGENTS.md");
        expect(readyState(interrupted).preview.status).toBe("failed");

        let resolveAsset: ((value: ReturnType<typeof complete<{ found: true; value: typeof ASSET }>>) => void) | undefined;
        const delayed = new AssetInspectorController(
            fakeClient({
                getAsset: vi.fn(
                    () =>
                        new Promise((resolve) => {
                            resolveAsset = resolve;
                        }),
                ),
            }),
        );
        const load = delayed.load(ASSET_ID);
        delayed.dispose();
        resolveAsset?.(complete({ found: true, value: ASSET }));
        await load;
        expect(delayed.state.status).toBe("loading");
    });

    it("reports every incomplete initial authority instead of constructing a partial inspector", async () => {
        const missingAsset = new AssetInspectorController(
            fakeClient({
                getAsset: vi.fn(async () => complete({ found: false as const })),
            }),
        );
        await missingAsset.load(ASSET_ID);
        expect(missingAsset.state.status).toBe("failed");

        const emptyHistory = new AssetInspectorController(
            fakeClient({
                listAssetVersions: vi.fn(async () =>
                    complete({
                        found: true as const,
                        value: { versions: [], totalCount: 0, hasMore: false as const },
                    }),
                ),
            }),
        );
        await emptyHistory.load(ASSET_ID);
        expect(emptyHistory.state.status).toBe("failed");

        const missingFiles = new AssetInspectorController(
            fakeClient({
                listAssetVersionFileChildren: vi.fn(async () => complete({ found: false as const })),
            }),
        );
        await missingFiles.load(ASSET_ID);
        expect(missingFiles.state.status).toBe("failed");

        const interrupted = new AssetInspectorController(
            fakeClient({
                getAsset: vi.fn(async () => {
                    throw new Error("offline");
                }),
            }),
        );
        await interrupted.load(ASSET_ID);
        expect(interrupted.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.asset_detail_interrupted" },
        });
    });

    it("fails closed when later Version or file pages are rejected or interrupted", async () => {
        const rejectedVersionsClient = fakeClient();
        const rejectedVersions = await loadedController(rejectedVersionsClient);
        vi.mocked(rejectedVersionsClient.listAssetVersions).mockResolvedValueOnce(failed("Version page rejected"));
        await rejectedVersions.loadMoreVersions();
        expect(rejectedVersions.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.load_failed" },
            diagnostics: [{ ...ERROR, message: "Version page rejected" }],
        });

        const interruptedVersionsClient = fakeClient();
        const interruptedVersions = await loadedController(interruptedVersionsClient);
        vi.mocked(interruptedVersionsClient.listAssetVersions).mockRejectedValueOnce(new Error("offline"));
        await interruptedVersions.loadMoreVersions();
        expect(interruptedVersions.state.status).toBe("failed");

        const rejectedFilesClient = fakeClient();
        const rejectedFiles = await loadedController(rejectedFilesClient);
        vi.mocked(rejectedFilesClient.listAssetVersionFileChildren).mockResolvedValueOnce(complete({ found: false as const }));
        await rejectedFiles.loadMoreFiles();
        expect(rejectedFiles.state.status).toBe("failed");

        const interruptedFilesClient = fakeClient();
        const interruptedFiles = await loadedController(interruptedFilesClient);
        vi.mocked(interruptedFilesClient.listAssetVersionFileChildren).mockRejectedValueOnce(new Error("offline"));
        await interruptedFiles.loadMoreFiles();
        expect(interruptedFiles.state.status).toBe("failed");
    });

    it("keeps preview paging explicit when preview or ranged text authority fails", async () => {
        const rejectedPreviewClient = fakeClient();
        const rejectedPreview = await loadedController(rejectedPreviewClient);
        vi.mocked(rejectedPreviewClient.readAssetVersionFilePreview).mockResolvedValueOnce(failed("Preview rejected"));
        await rejectedPreview.selectFile("AGENTS.md");
        expect(readyState(rejectedPreview).preview).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.file_preview_failed" },
            diagnostics: [{ ...ERROR, message: "Preview rejected" }],
        });

        const noPagingClient = fakeClient({
            supportsOperation: vi.fn(
                (operation: ProtocolOperationName) => operation !== "asset_version.text_page" && OPERATIONS.includes(operation),
            ),
        });
        const noPaging = await loadedController(noPagingClient);
        await noPaging.selectFile("large.md");
        expect(readyState(noPaging).preview).toMatchObject({
            status: "ready",
            textPages: [],
            hasMoreText: false,
        });

        const rejectedFirstPageClient = fakeClient();
        const rejectedFirstPage = await loadedController(rejectedFirstPageClient);
        vi.mocked(rejectedFirstPageClient.readAssetVersionTextPage).mockResolvedValueOnce(failed("Text page rejected"));
        await rejectedFirstPage.selectFile("large.md");
        expect(readyState(rejectedFirstPage).preview).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.file_preview_failed" },
            diagnostics: [{ ...ERROR, message: "Text page rejected" }],
        });

        const rejectedNextPageClient = fakeClient();
        const rejectedNextPage = await loadedController(rejectedNextPageClient);
        await rejectedNextPage.selectFile("large.md");
        vi.mocked(rejectedNextPageClient.readAssetVersionTextPage).mockResolvedValueOnce(complete({ found: false as const }));
        await rejectedNextPage.loadMoreText();
        expect(readyState(rejectedNextPage).preview.status).toBe("failed");

        const interruptedNextPageClient = fakeClient();
        const interruptedNextPage = await loadedController(interruptedNextPageClient);
        await interruptedNextPage.selectFile("large.md");
        vi.mocked(interruptedNextPageClient.readAssetVersionTextPage).mockRejectedValueOnce(new Error("offline"));
        await interruptedNextPage.loadMoreText();
        expect(readyState(interruptedNextPage).preview.status).toBe("failed");
    });

    it("surfaces compare, cancellation and export failures without losing the selected Version", async () => {
        const rejectedCompareClient = fakeClient({
            compareAssetVersions: vi.fn(async () => failed("Comparison rejected")),
        });
        const rejectedCompare = await loadedController(rejectedCompareClient);
        await rejectedCompare.loadMoreVersions();
        await rejectedCompare.compareWith(PREVIOUS_VERSION_ID);
        expect(readyState(rejectedCompare).comparison).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.compare_failed" },
            diagnostics: [{ ...ERROR, message: "Comparison rejected" }],
        });

        const interruptedCompareClient = fakeClient({
            compareAssetVersions: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        const interruptedCompare = await loadedController(interruptedCompareClient);
        await interruptedCompare.loadMoreVersions();
        await interruptedCompare.compareWith(PREVIOUS_VERSION_ID);
        expect(readyState(interruptedCompare).comparison.status).toBe("failed");

        let settleComparison:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["compareAssetVersions"]>>) => void)
            | undefined;
        const cancellingClient = fakeClient({
            compareAssetVersions: vi.fn(
                async (_params, listener) =>
                    await new Promise((resolve) => {
                        listener?.({
                            status: "accepted",
                            operation: "asset_version.compare",
                            operationId: "pending-comparison",
                        });
                        settleComparison = resolve;
                    }),
            ),
            cancelOperation: vi.fn(async () => {
                throw new Error("cancel failed");
            }),
        });
        const cancelling = await loadedController(cancellingClient);
        await cancelling.loadMoreVersions();
        const pendingComparison = cancelling.compareWith(PREVIOUS_VERSION_ID);
        await vi.waitFor(() => expect(readyState(cancelling).comparison.status).toBe("running"));
        await cancelling.cancelComparison();
        expect(readyState(cancelling).comparison.status).toBe("failed");
        settleComparison?.(failed("cancelled"));
        await pendingComparison;

        const rejectedExportClient = fakeClient({
            exportAssetVersion: vi.fn(async () => failed("Export rejected")),
        });
        const rejectedExport = await loadedController(rejectedExportClient);
        await rejectedExport.exportSelected("oaam_version_package", "token", "action");
        expect(readyState(rejectedExport).exportState).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.export.failed" },
            diagnostics: [{ ...ERROR, message: "Export rejected" }],
        });

        const interruptedExportClient = fakeClient({
            exportAssetVersion: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        const interruptedExport = await loadedController(interruptedExportClient);
        await interruptedExport.exportSelected("oaam_version_package", "token", "action");
        expect(readyState(interruptedExport).exportState.status).toBe("failed");

        const rejectedNativeExport = await loadedController(
            fakeClient({ exportAssetVersionNative: vi.fn(async () => failed("Native export rejected")) }),
        );
        await rejectedNativeExport.exportSelected("native_files", "token", "action");
        expect(readyState(rejectedNativeExport).exportState).toMatchObject({
            status: "failed",
            exportKind: "native_files",
            message: { kind: "localized", id: "library.native_export.failed" },
        });

        const interruptedNativeExport = await loadedController(
            fakeClient({
                exportAssetVersionNative: vi.fn(async () => {
                    throw new Error("offline");
                }),
            }),
        );
        await interruptedNativeExport.exportSelected("native_files", "token", "action");
        expect(readyState(interruptedNativeExport).exportState).toMatchObject({
            status: "failed",
            exportKind: "native_files",
            message: { kind: "localized", id: "library.native_export.failed" },
        });
    });

    it("keeps cancellation visible across later progress and cancels comparison work invalidated by disposal", async () => {
        let listener: DesktopLongOperationListener<"asset_version.compare"> | undefined;
        let settleComparison:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["compareAssetVersions"]>>) => void)
            | undefined;
        const client = fakeClient({
            compareAssetVersions: vi.fn(
                async (_params, nextListener) =>
                    await new Promise((resolve) => {
                        listener = nextListener;
                        nextListener?.({
                            status: "accepted",
                            operation: "asset_version.compare",
                            operationId: "long-comparison",
                        });
                        settleComparison = resolve;
                    }),
            ),
            cancelOperation: vi.fn(async () => complete({ status: "requested" as const })),
        });
        const controller = await loadedController(client);
        await controller.loadMoreVersions();
        const pendingComparison = controller.compareWith(PREVIOUS_VERSION_ID);
        await vi.waitFor(() => expect(readyState(controller).comparison.status).toBe("running"));

        await controller.cancelComparison();
        expect(readyState(controller).comparison.status).toBe("cancelling");
        listener?.({
            status: "progress",
            operation: "asset_version.compare",
            operationId: "long-comparison",
            sequence: 1,
            progress: { stage: "diffing", completedUnits: 1, totalUnits: 2 },
        });
        expect(readyState(controller).comparison).toMatchObject({
            status: "cancelling",
            stage: "diffing",
            completedUnits: 1,
        });

        controller.dispose();
        expect(client.cancelOperation).toHaveBeenCalledWith({ operationId: "long-comparison" });
        settleComparison?.(failed("cancelled"));
        await pendingComparison;
    });

    it("cancels a comparison accepted after its inspector generation was invalidated", async () => {
        let acceptComparison: (() => void) | undefined;
        let settleComparison:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["compareAssetVersions"]>>) => void)
            | undefined;
        const client = fakeClient({
            compareAssetVersions: vi.fn(
                async (_params, listener) =>
                    await new Promise((resolve) => {
                        acceptComparison = () =>
                            listener?.({
                                status: "accepted",
                                operation: "asset_version.compare",
                                operationId: "late-comparison",
                            });
                        settleComparison = resolve;
                    }),
            ),
            cancelOperation: vi.fn(async () => complete({ status: "requested" as const })),
        });
        const controller = await loadedController(client);
        await controller.loadMoreVersions();
        const pendingComparison = controller.compareWith(PREVIOUS_VERSION_ID);
        controller.dispose();
        acceptComparison?.();
        await vi.waitFor(() => expect(client.cancelOperation).toHaveBeenCalledWith({ operationId: "late-comparison" }));
        settleComparison?.(failed("cancelled"));
        await pendingComparison;
    });

    it("notifies subscribers, replaces only the selected Asset and clears deterministically", async () => {
        const controller = await loadedController();
        const listener = vi.fn();
        const unsubscribe = controller.subscribe(listener);
        expect(listener).toHaveBeenCalledWith(controller.state);

        controller.replaceAsset({ ...ASSET, displayName: "Renamed" });
        expect(readyState(controller).asset.displayName).toBe("Renamed");
        controller.replaceAsset({ ...ASSET, assetId: "77777777-7777-4777-8777-777777777777" });
        expect(readyState(controller).asset.displayName).toBe("Renamed");

        unsubscribe();
        const callsBeforeClear = listener.mock.calls.length;
        controller.clear();
        expect(controller.state.status).toBe("none");
        expect(listener).toHaveBeenCalledTimes(callsBeforeClear);
    });

    it("keeps unavailable transitions as no-ops and rejects failed directory changes", async () => {
        const empty = new AssetInspectorController(fakeClient());
        await empty.loadMoreVersions();
        await empty.selectVersion(PREVIOUS_VERSION_ID);
        await empty.enterDirectory("references");
        await empty.loadMoreFiles();
        await empty.selectFile("AGENTS.md");
        await empty.loadMoreText();
        await empty.compareWith(PREVIOUS_VERSION_ID);
        await empty.cancelComparison();
        await empty.exportSelected("native_files", "token", "action");
        empty.replaceAsset(ASSET);
        expect(empty.state.status).toBe("none");

        const rejectedClient = fakeClient();
        const rejected = await loadedController(rejectedClient);
        vi.mocked(rejectedClient.listAssetVersionFileChildren).mockResolvedValueOnce(failed("Directory rejected"));
        await rejected.enterDirectory("references");
        expect(rejected.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.load_failed" },
            diagnostics: [{ ...ERROR, message: "Directory rejected" }],
        });

        const interruptedClient = fakeClient();
        const interrupted = await loadedController(interruptedClient);
        vi.mocked(interruptedClient.listAssetVersionFileChildren).mockRejectedValueOnce(new Error("offline"));
        await interrupted.enterDirectory("references");
        expect(interrupted.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.load_interrupted" },
        });
    });
});
