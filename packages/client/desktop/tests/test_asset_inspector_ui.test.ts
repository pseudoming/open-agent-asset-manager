import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { AssetInspector } from "../src/renderer/features/project-library/AssetInspector";
import { toggleFirstInteractionDisclosure, toggleInteractionDisclosure } from "./desktop-interaction-test-harness";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PREVIOUS_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = "a".repeat(64);

function selectWorkbenchOption(label: string, option: string | RegExp): void {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(screen.getByRole("option", { name: option }));
}

const PROJECT = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/work/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

const ASSET = {
    assetId: ASSET_ID,
    kind: "Skill" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: ".agents/skills/example",
    displayName: "Example Skill",
    displayDescription: "A complete inspector fixture",
    versionIds: [PREVIOUS_VERSION_ID, VERSION_ID],
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

function version(versionId: string, revision: number, status: "complete" | "incomplete" = "complete") {
    return {
        assetId: ASSET_ID,
        versionId,
        revision,
        status,
        fingerprint: DIGEST,
        originAuthorityFingerprint: DIGEST,
        versionCanonicalContentFingerprint: DIGEST,
        changeKind: revision === 1 ? ("create" as const) : ("edit" as const),
        sourceVersionId: revision === 1 ? "" : PREVIOUS_VERSION_ID,
        sourceDeploymentId: "",
        changeNote: "",
        fileCount: 4,
        createdAt: revision,
    };
}

const CURRENT_VERSION = version(VERSION_ID, 2, "incomplete");
const PREVIOUS_VERSION = version(PREVIOUS_VERSION_ID, 1);
const THIRD_VERSION = version(THIRD_VERSION_ID, 3);

function file(logicalPath: string, contentKind: "text" | "binary" = "text", executable = false) {
    return {
        fileId:
            logicalPath === "large.md"
                ? "66666666-6666-4666-8666-666666666666"
                : logicalPath === "binary.bin"
                  ? "77777777-7777-4777-8777-777777777777"
                  : "88888888-8888-4888-8888-888888888888",
        logicalPath,
        role: "resource" as const,
        mediaType: contentKind === "binary" ? "application/octet-stream" : "text/markdown",
        contentKind,
        contentHash: DIGEST,
        byteLength: logicalPath === "large.md" ? 4_000_000 : 12,
        executable,
    };
}

function complete<T>(value: T) {
    return { status: "complete" as const, value, diagnostics: [] };
}

function readyClient(): DesktopApplicationClientApi {
    let versionPage = 0;
    let rootFilePage = 0;
    let textPage = 0;
    const client = {
        supportsOperation: vi.fn(() => true),
        getAsset: vi.fn(async () => complete({ found: true, value: ASSET })),
        listAssetVersions: vi.fn(async ({ cursor }: { cursor?: string }) => {
            if (cursor !== undefined) {
                versionPage += 1;
                return complete({
                    found: true,
                    value: { versions: [THIRD_VERSION], totalCount: 3, hasMore: false },
                });
            }
            return complete({
                found: true,
                value: {
                    versions: [CURRENT_VERSION, PREVIOUS_VERSION],
                    totalCount: 3,
                    hasMore: true,
                    nextCursor: "versions-next",
                },
            });
        }),
        listAssetVersionFileChildren: vi.fn(async ({ directoryPath, cursor }: { directoryPath: string; cursor?: string }) => {
            if (directoryPath === "docs") {
                return complete({
                    found: true,
                    value: {
                        entries: [{ entryKind: "file", relativeName: "small.md", file: file("docs/small.md") }],
                        totalCount: 1,
                        hasMore: false,
                    },
                });
            }
            if (cursor !== undefined) {
                rootFilePage += 1;
                return complete({
                    found: true,
                    value: {
                        entries: [{ entryKind: "file", relativeName: "binary.bin", file: file("binary.bin", "binary") }],
                        totalCount: 4,
                        hasMore: false,
                    },
                });
            }
            return complete({
                found: true,
                value: {
                    entries: [
                        { entryKind: "directory", relativeName: "docs", logicalPath: "docs", descendantFileCount: 1 },
                        { entryKind: "file", relativeName: "large.md", file: file("large.md", "text", true) },
                    ],
                    totalCount: 4,
                    hasMore: true,
                    nextCursor: "files-next",
                },
            });
        }),
        readAssetVersionFilePreview: vi.fn(async ({ logicalPath }: { logicalPath: string }) => {
            if (logicalPath === "binary.bin") {
                return complete({ found: true, value: { previewKind: "binary", file: file(logicalPath, "binary") } });
            }
            if (logicalPath === "large.md") {
                return complete({
                    found: true,
                    value: { previewKind: "large_text", file: file(logicalPath, "text", true), limitReason: "byte_limit" },
                });
            }
            return complete({
                found: true,
                value: { previewKind: "text", file: file(logicalPath), text: "small text\n", lineCount: 2 },
            });
        }),
        readAssetVersionTextPage: vi.fn(async ({ cursor }: { cursor?: string }) => {
            textPage += 1;
            return complete({
                found: true,
                value:
                    cursor === undefined
                        ? {
                              file: file("large.md", "text", true),
                              text: "first page\n",
                              loadedByteStart: 0,
                              loadedByteEnd: 11,
                              totalBytes: 22,
                              firstLine: 1,
                              lastLine: 1,
                              totalLines: 2,
                              hasMore: true,
                              nextCursor: "text-next",
                          }
                        : {
                              file: file("large.md", "text", true),
                              text: "second page\n",
                              loadedByteStart: 11,
                              loadedByteEnd: 22,
                              totalBytes: 22,
                              firstLine: 2,
                              lastLine: 2,
                              totalLines: 2,
                              hasMore: false,
                          },
            });
        }),
        compareAssetVersions: vi.fn(async (_params, listener) => {
            listener?.({ status: "accepted", operationId: "compare-operation" });
            listener?.({
                status: "progress",
                operationId: "compare-operation",
                sequence: 1,
                progress: { stage: "diffing", completedUnits: 1, totalUnits: 2 },
            });
            return complete({
                schemaVersion: 1,
                assetId: ASSET_ID,
                left: { versionId: PREVIOUS_VERSION_ID, versionFingerprint: DIGEST },
                right: { versionId: VERSION_ID, versionFingerprint: DIGEST },
                files: [
                    {
                        logicalPath: "large.md",
                        changeKind: "modified",
                        left: { state: "present", file: file("large.md") },
                        right: { state: "present", file: file("large.md", "text", true) },
                    },
                ],
                selectedFile: {
                    comparisonKind: "text",
                    logicalPath: "large.md",
                    left: { state: "present", file: file("large.md") },
                    right: { state: "present", file: file("large.md", "text", true) },
                    algorithm: "myers",
                    leftLineCount: 1,
                    rightLineCount: 1,
                    hunks: [
                        {
                            leftStart: 1,
                            leftLineCount: 1,
                            rightStart: 1,
                            rightLineCount: 1,
                            lines: [
                                { lineKind: "remove", text: "old", leftLine: 1 },
                                { lineKind: "add", text: "new", rightLine: 1 },
                            ],
                        },
                    ],
                },
            });
        }),
        cancelOperation: vi.fn(async () => complete({ status: "requested" as const })),
        exportAssetVersion: vi.fn(async () =>
            complete({
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST,
                archiveIndexFingerprint: DIGEST,
                archiveByteLength: 1_024,
            }),
        ),
        exportAssetVersionNative: vi.fn(async () =>
            complete({
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST,
                dialectId: "fixture-native-v1",
                representationFingerprint: DIGEST,
                fileCount: 1,
                archiveByteLength: 512,
            }),
        ),
        updateAssetDisplay: vi.fn(async () => complete(ASSET)),
        copyAsset: vi.fn(async () => complete({ asset: ASSET, version: CURRENT_VERSION })),
        softDeleteAsset: vi.fn(async () => complete({ ...ASSET, deleted: true })),
        restoreAsset: vi.fn(async () => complete(ASSET)),
        inspectAssetPurge: vi.fn(),
        getStateBackupPromptPolicy: vi.fn(),
        listStateBackups: vi.fn(),
        replaceStateBackupPromptPolicy: vi.fn(),
        inspectStateBackup: vi.fn(),
        createStateBackup: vi.fn(),
        commitAssetPurge: vi.fn(),
        get counters() {
            return { versionPage, rootFilePage, textPage };
        },
    };
    return client as unknown as DesktopApplicationClientApi;
}

afterEach(cleanup);

describe("Asset inspector UI", () => {
    it.each([
        PREVIOUS_VERSION_ID,
        THIRD_VERSION_ID,
    ])("opens the exact imported Version %s even when another Version is first", async (initialVersionId) => {
        const client = readyClient();
        renderWithPresentation(
            createElement(AssetInspector, {
                client,
                assetId: ASSET_ID,
                initialVersionId,
                projects: [PROJECT],
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                onClose: vi.fn(),
            }),
        );
        await vi.waitFor(() =>
            expect(client.listAssetVersionFileChildren).toHaveBeenCalledWith({
                assetId: ASSET_ID,
                versionId: initialVersionId,
                directoryPath: "",
                pageSize: 50,
            }),
        );
        expect(client.listAssetVersionFileChildren).not.toHaveBeenCalledWith(expect.objectContaining({ versionId: VERSION_ID }));
        if (initialVersionId === THIRD_VERSION_ID)
            expect(client.listAssetVersions).toHaveBeenCalledWith({
                assetId: ASSET_ID,
                cursor: "versions-next",
                pageSize: 50,
            });
        expect(screen.getByRole("combobox", { name: "Exact Version" }).textContent).toContain(
            initialVersionId === PREVIOUS_VERSION_ID ? "Version 1" : "Version 3",
        );
    });

    it.each([
        "missing",
        "failed",
        "repeated_cursor",
    ] as const)("retains the exact imported Version through a %s later page and retry", async (failure) => {
        const client = readyClient();
        const readVersions = client.listAssetVersions;
        let recovered = false;
        const listAssetVersions = vi.fn<typeof client.listAssetVersions>(async (params) => {
            if (params.cursor === undefined || recovered) return readVersions(params);
            if (failure === "failed") return { status: "failed", diagnostics: [] };
            return complete({
                found: true,
                value:
                    failure === "missing"
                        ? { versions: [], totalCount: 2, hasMore: false }
                        : { versions: [CURRENT_VERSION], totalCount: 3, hasMore: true, nextCursor: "versions-next" },
            });
        });
        renderWithPresentation(
            createElement(AssetInspector, {
                client: { ...client, listAssetVersions },
                assetId: ASSET_ID,
                initialVersionId: THIRD_VERSION_ID,
                projects: [PROJECT],
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                onClose: vi.fn(),
            }),
        );
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(listAssetVersions).toHaveBeenCalledTimes(2);
        expect(client.listAssetVersionFileChildren).not.toHaveBeenCalled();
        recovered = true;
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.waitFor(() =>
            expect(client.listAssetVersionFileChildren).toHaveBeenCalledWith({
                assetId: ASSET_ID,
                versionId: THIRD_VERSION_ID,
                directoryPath: "",
                pageSize: 50,
            }),
        );
        expect(client.listAssetVersionFileChildren).not.toHaveBeenCalledWith(expect.objectContaining({ versionId: VERSION_ID }));
    });

    it("consumes a row shortcut once instead of reopening it after a preview round trip", async () => {
        const client = readyClient();
        const { container } = renderWithPresentation(
            createElement(AssetInspector, {
                client,
                assetId: ASSET_ID,
                projects: [PROJECT],
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                initialAction: "metadata",
                onClose: vi.fn(),
            }),
        );

        await vi.waitFor(() => expect(container.querySelector(".asset-action-form")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(container.querySelector(".asset-action-form")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "File preview" }));
        await vi.waitFor(() => expect(screen.queryByRole("region", { name: "File source with line numbers" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Metadata" }));

        expect(container.querySelector(".asset-action-form")).toBeNull();
        expect(screen.getByRole("button", { name: "Edit name and description" })).not.toBeNull();
    });

    it("browses exact Versions and file pages, progressively previews, compares, exports, and closes", async () => {
        const client = readyClient();
        const pickAssetVersionExport = vi.fn(async () => ({
            status: "selected" as const,
            localPathSelectionToken: "export-token",
        }));
        const onLibraryChanged = vi.fn();
        const onClose = vi.fn();
        const { container } = renderWithPresentation(
            createElement(AssetInspector, {
                client,
                assetId: ASSET_ID,
                projects: [PROJECT],
                pickAssetVersionExport,
                onLibraryChanged,
                onPurged: vi.fn(),
                onClose,
            }),
        );

        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: ASSET.displayName })).not.toBeNull());
        expect(screen.getByText(ASSET.displayDescription)).not.toBeNull();
        expect(screen.getByText(/current Version is incomplete/u)).not.toBeNull();
        expect(screen.getByText(PROJECT.displayName)).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain(ASSET_ID);
        expect(ordinarySurfaceText(container)).not.toContain(VERSION_ID);
        expect(ordinarySurfaceText(container)).not.toContain(DIGEST);
        expect(container.textContent).toContain(ASSET_ID);
        expect(container.textContent).toContain(VERSION_ID);
        expect(container.textContent).toContain(DIGEST);
        expect(container.textContent).toContain("Path: large.md");
        expect(container.querySelectorAll(".inspector-fact-value > .workbench-technical-fact")).toHaveLength(1);
        expect(container.querySelectorAll(".inspector-file-meta > .workbench-technical-fact").length).toBeGreaterThan(0);
        toggleInteractionDisclosure("features.project-library.asset_inspector.004", container);
        toggleInteractionDisclosure("features.project-library.asset_inspector.007", container);
        toggleFirstInteractionDisclosure("features.project-library.asset_inspector.013", container);
        expect(screen.queryByRole("region", { name: "File source with line numbers" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "File preview" }));
        await vi.waitFor(() => expect(screen.queryByRole("region", { name: "File source with line numbers" })).not.toBeNull());
        expect(container.querySelectorAll(".asset-file-preview .import-preview-line-number")).toHaveLength(2);
        expect(container.querySelector(".asset-file-preview-identity")?.textContent).toContain("Version 2");
        const wrapLines = screen.getByRole("button", { name: "Wrap long lines" });
        const renderMarkdown = screen.getByRole("button", { name: "Preview Markdown" });
        expect(wrapLines.querySelector("[data-oaam-icon='wrap']")).not.toBeNull();
        expect(renderMarkdown.querySelector("[data-oaam-icon='render']")).not.toBeNull();
        fireEvent.click(wrapLines);
        expect(container.querySelector(".import-preview-source")?.getAttribute("data-soft-wrap")).toBe("true");
        fireEvent.click(renderMarkdown);
        expect(screen.getByRole("region", { name: "Rendered Markdown preview" })).not.toBeNull();
        const showSource = screen.getByRole("button", { name: "Show Markdown source" });
        expect(showSource.querySelector("[data-oaam-icon='source']")).not.toBeNull();
        fireEvent.click(showSource);
        fireEvent.click(screen.getByRole("button", { name: "Metadata" }));
        expect(screen.getByRole("heading", { name: "Overview" })).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Load 50 more Versions" }));
        await vi.waitFor(() => expect((client as never as { counters: { versionPage: number } }).counters.versionPage).toBe(1));
        selectWorkbenchOption("Exact Version", /^Version 1 ·/u);
        await vi.waitFor(() =>
            expect(client.listAssetVersionFileChildren).toHaveBeenCalledWith({
                assetId: ASSET_ID,
                versionId: PREVIOUS_VERSION_ID,
                directoryPath: "",
                pageSize: 50,
            }),
        );

        fireEvent.click(screen.getByRole("button", { name: /docs\//u }));
        await vi.waitFor(() => expect(screen.queryByText("small.md")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: /^large\.md/u })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Load 50 more entries" }));
        await vi.waitFor(() => expect(screen.queryByText("binary.bin")).not.toBeNull());

        fireEvent.click(screen.getByRole("button", { name: /binary\.bin/u }));
        await vi.waitFor(() => expect(screen.queryByText("This file is binary and cannot be previewed.")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Metadata" }));
        fireEvent.click(screen.getByRole("button", { name: /large\.md/u }));
        await vi.waitFor(() => expect(screen.queryByText("first page")).not.toBeNull());
        expect(screen.getByText(/Bytes 0–11 of 22/u)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Load the next text page" }));
        await vi.waitFor(() => expect(screen.queryByText(/second page/u)).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Metadata" }));

        fireEvent.click(screen.getByRole("button", { name: "Compare exact Versions" }));
        await vi.waitFor(() => expect(screen.queryByRole("table", { name: "Unified" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
        expect(screen.getByRole("table", { name: "Side by side" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Unified" }));
        expect(screen.getByRole("table", { name: "Unified" })).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Export original files" }));
        await vi.waitFor(() => expect(screen.queryByText(/Exported 512 bytes of original files/u)).not.toBeNull());
        expect(pickAssetVersionExport).toHaveBeenCalledWith("native_files", "Example Skill-revision-1-original-files.zip");
        expect(client.exportAssetVersionNative).toHaveBeenCalledWith(
            expect.objectContaining({
                localPathSelectionToken: "export-token",
                source: expect.objectContaining({ assetId: ASSET_ID, versionId: PREVIOUS_VERSION_ID }),
            }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Export OAAM Version package" }));
        await vi.waitFor(() => expect(screen.queryByText(/Exported the .*byte OAAM Version package/u)).not.toBeNull());
        expect(pickAssetVersionExport).toHaveBeenLastCalledWith(
            "oaam_version_package",
            "Example Skill-revision-1-oaam-version.zip",
        );
        expect(client.exportAssetVersion).toHaveBeenCalledWith(
            expect.objectContaining({
                localPathSelectionToken: "export-token",
                source: expect.objectContaining({ assetId: ASSET_ID, versionId: PREVIOUS_VERSION_ID }),
            }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(onLibraryChanged).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        await vi.waitFor(() => expect(onLibraryChanged).toHaveBeenCalledTimes(2));

        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("surfaces unavailable detail and export-picker failures without inventing an empty Asset", async () => {
        const unavailable = readyClient();
        (unavailable.supportsOperation as ReturnType<typeof vi.fn>).mockReturnValue(false);
        renderWithPresentation(
            createElement(AssetInspector, {
                client: unavailable,
                assetId: ASSET_ID,
                projects: [],
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                onClose: vi.fn(),
            }),
        );
        await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
        const unavailableAlert = screen.getByRole("alert");
        expect(unavailableAlert.textContent).toBe("OAAM could not load the selected Asset details.");
        expect(unavailableAlert.textContent).not.toMatch(/\bHost\b/u);

        cleanup();
        const client = readyClient();
        renderWithPresentation(
            createElement(AssetInspector, {
                client,
                assetId: ASSET_ID,
                projects: [PROJECT],
                pickAssetVersionExport: async () => {
                    throw new Error("picker failed");
                },
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                onClose: vi.fn(),
            }),
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: ASSET.displayName })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Export original files" }));
        await vi.waitFor(() =>
            expect(
                screen.queryByText(
                    "The original files could not be exported. This Version may not have one unambiguous, directly restorable original format; you can still export the OAAM Version package.",
                ),
            ).not.toBeNull(),
        );
    });

    it("retries the exact failed Asset read and restores the same inspector", async () => {
        const client = readyClient();
        vi.mocked(client.getAsset)
            .mockResolvedValueOnce({ status: "failed", diagnostics: [] })
            .mockResolvedValueOnce(complete({ found: true, value: ASSET }));
        renderWithPresentation(
            createElement(AssetInspector, {
                client,
                assetId: ASSET_ID,
                projects: [PROJECT],
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        expect(await screen.findByRole("alert")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        expect(await screen.findByRole("heading", { name: ASSET.displayName })).not.toBeNull();
        expect(client.getAsset).toHaveBeenCalledTimes(2);
    });

    it("offers cancellation while a complete comparison is still running", async () => {
        const client = readyClient();
        let resolveComparison:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["compareAssetVersions"]>>) => void)
            | undefined;
        vi.mocked(client.compareAssetVersions).mockImplementation(
            async (_params, listener) =>
                await new Promise((resolve) => {
                    resolveComparison = resolve;
                    listener?.({
                        status: "accepted",
                        operation: "asset_version.compare",
                        operationId: "pending-comparison",
                    });
                }),
        );
        const { container } = renderWithPresentation(
            createElement(AssetInspector, {
                client,
                assetId: ASSET_ID,
                projects: [PROJECT],
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                onLibraryChanged: vi.fn(),
                onPurged: vi.fn(),
                onClose: vi.fn(),
            }),
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: ASSET.displayName })).not.toBeNull());
        selectWorkbenchOption("Compare against", "Version 1");
        fireEvent.click(screen.getByRole("button", { name: "Compare exact Versions" }));
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await vi.waitFor(() => expect(client.cancelOperation).toHaveBeenCalledWith({ operationId: "pending-comparison" }));

        resolveComparison?.({
            status: "failed",
            diagnostics: [
                {
                    severity: "error",
                    code: "asset.compare.cancelled",
                    operation: "asset",
                    causeKind: "conflict",
                    retryable: true,
                    suggestedActions: ["retry"],
                    message: "Comparison cancelled.",
                },
            ],
        });
        await vi.waitFor(() =>
            expect(
                screen.queryByText("This action conflicts with the current state. Review the latest result before continuing."),
            ).not.toBeNull(),
        );
        const comparison = container.querySelector(".asset-comparison-section");
        expect(comparison?.querySelectorAll("[role='alert']")).toHaveLength(1);
        expect(comparison?.querySelector(".workbench-notice .workbench-notice")).toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain("Comparison cancelled.");
        expect(screen.queryByText("Original detail: Comparison cancelled.")).not.toBeNull();
    });
});
