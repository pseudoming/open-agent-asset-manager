import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopResolvedLocale,
} from "../src/presentation/presentation-preferences";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { ImportReviewWorkspace } from "../src/renderer/features/import-review/ImportReviewWorkspace";
import { ImportReviewController } from "../src/renderer/features/import-review/import-review-controller";
import { callableBindingSubjectKey } from "../src/renderer/features/import-review/import-review-model";
import { localizedText } from "../src/renderer/presentation";
import { toggleFirstInteractionDisclosure } from "./desktop-interaction-test-harness";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import {
    ASSET_ID,
    candidate,
    controller,
    DIGEST,
    diagnostic,
    EXISTING_SUBAGENT,
    EXISTING_WORKFLOW,
    fakeImportClient,
    INVALID_READ_PREVIEW,
    OPTIONAL_FILE_BINDING,
    PREVIEW,
    READ_PARAMS,
    READ_PREPARATION,
    selectWorkbenchOption,
    VERSION_ID,
    WORKFLOW_ASSET_ID,
    WORKFLOW_BINDING,
    WORKFLOW_VERSION_ID,
} from "./import-review-test-fixtures";

afterEach(() => {
    cleanup();
});

describe("Desktop import review controller", () => {
    it("stops a partial read before preview and retains an attributed retry state", async () => {
        const client = fakeImportClient({
            readSources: vi.fn(async () => ({
                status: "partial",
                value: {
                    readToken: "read-token",
                    reports: [
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-root",
                            status: "partial",
                            candidateCount: 1,
                            diagnostics: [diagnostic("read.partial", "One source was partial.", "warning")],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [diagnostic("read.partial", "One source was partial.", "warning")],
            })),
        });
        const review = controller(client);
        const states: unknown[] = [];
        const unsubscribe = review.subscribe((state) => states.push(state));
        renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));

        await act(async () => review.prepare(READ_PREPARATION));

        expect(client.readSources).toHaveBeenCalledOnce();
        expect(client.readSources).toHaveBeenCalledWith(READ_PARAMS);
        expect(client.previewImport).not.toHaveBeenCalled();
        expect(review.state).toMatchObject({
            status: "read_attention",
            completeSourcePreparation: undefined,
            issues: [
                expect.objectContaining({
                    sourceRootId: "source-root",
                    status: "partial",
                    displayPath: "/home/user/.agent",
                }),
            ],
        });
        expect(states).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ status: "idle" }),
                expect.objectContaining({ status: "preparing", phase: "reading" }),
                expect.objectContaining({ status: "read_attention" }),
            ]),
        );
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.waitFor(() => expect(client.readSources).toHaveBeenCalledTimes(2));
        expect(review.state).toMatchObject({ status: "read_attention" });
        unsubscribe();
    });

    it("re-reads complete roots after Core rejects an incomplete mixed snapshot", async () => {
        const mixedRequest: ProtocolOperationParams<"adapter.read"> = {
            probeToken: "probe-token",
            selections: [{ probeResultRowId: "probe-row", sourceRootRowIds: ["good-row", "bad-row"] }],
        };
        const readSources = vi
            .fn<DesktopApplicationClientApi["readSources"]>()
            .mockResolvedValueOnce({
                status: "partial",
                value: {
                    readToken: "mixed-read",
                    reports: [
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "good-root",
                            status: "complete",
                            candidateCount: 1,
                            diagnostics: [],
                        },
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "bad-root",
                            status: "failed",
                            candidateCount: 0,
                            diagnostics: [diagnostic("read.failed", "Bad root.")],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [diagnostic("read.failed", "Bad root.")],
            })
            .mockResolvedValueOnce({
                status: "complete",
                value: { readToken: "complete-read", reports: [], candidateCount: PREVIEW.candidates.length },
                diagnostics: [],
            });
        const client = fakeImportClient({ readSources });
        vi.mocked(client.previewImport).mockResolvedValueOnce(INVALID_READ_PREVIEW);
        const review = controller(client);
        renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));

        await act(async () =>
            review.prepare({
                request: mixedRequest,
                sources: [
                    {
                        ...READ_PREPARATION.sources[0],
                        sourceRootRowId: "good-row",
                        sourceRootId: "good-root",
                        displayPath: "/home/user/.agent/good",
                    },
                    {
                        ...READ_PREPARATION.sources[0],
                        sourceRootRowId: "bad-row",
                        sourceRootId: "bad-root",
                        displayPath: "/home/user/.agent/bad",
                    },
                ],
            }),
        );

        expect(readSources).toHaveBeenCalledTimes(2);
        expect(readSources).toHaveBeenNthCalledWith(1, mixedRequest);
        expect(readSources).toHaveBeenNthCalledWith(2, {
            probeToken: "probe-token",
            selections: [{ probeResultRowId: "probe-row", sourceRootRowIds: ["good-row"] }],
        });
        expect(client.previewImport).toHaveBeenCalledTimes(2);
        expect(client.previewImport).toHaveBeenCalledWith({ readToken: "complete-read" });
        expect(review.state).toMatchObject({
            status: "review",
            readIssues: [expect.objectContaining({ sourceRootId: "bad-root", status: "failed" })],
        });
        expect(screen.getByText("Scan notes · 1")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "Continue with readable locations" })).toBeNull();
        fireEvent.click(screen.getByText("Scan notes · 1"));
        expect(screen.getByText("/home/user/.agent/bad")).not.toBeNull();
    });

    it("stops after a failed read and distinguishes failed, empty and interrupted previews", async () => {
        const readFailed = fakeImportClient({
            readSources: vi
                .fn()
                .mockResolvedValueOnce({
                    status: "failed",
                    diagnostics: [diagnostic("read.failed", "Read failed.")],
                })
                .mockResolvedValueOnce({
                    status: "complete",
                    value: { readToken: "retry-read", reports: [], candidateCount: PREVIEW.candidates.length },
                    diagnostics: [],
                }),
        });
        const first = controller(readFailed);
        await first.prepare(READ_PARAMS);
        expect(first.state).toEqual({
            status: "failed",
            message: localizedText("import.read.failed"),
            preparation: { request: READ_PARAMS, sources: [] },
            diagnostics: [expect.objectContaining({ code: "read.failed" })],
            refreshRequired: false,
        });
        expect(readFailed.previewImport).not.toHaveBeenCalled();
        await first.retryFailed();
        expect(first.state.status).toBe("review");
        expect(readFailed.previewImport).toHaveBeenCalledWith({ readToken: "retry-read" });
        const previewFailed = controller(
            fakeImportClient({
                previewImport: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [diagnostic("host.review_record_unavailable", "Read token expired.")],
                })),
            }),
        );
        await previewFailed.prepare(READ_PARAMS);
        expect(previewFailed.state).toEqual({
            status: "failed",
            message: localizedText("import.preview.failed"),
            preparation: { request: READ_PARAMS, sources: [] },
            diagnostics: [expect.objectContaining({ code: "host.review_record_unavailable" })],
            refreshRequired: true,
        });
        const empty = controller(
            fakeImportClient({
                previewImport: vi.fn(async () => ({
                    status: "complete",
                    value: { ...PREVIEW, candidates: [] },
                    diagnostics: [],
                })),
            }),
        );
        await empty.prepare(READ_PARAMS);
        expect(empty.state).toMatchObject({
            status: "review",
            message: localizedText("import.no_candidates"),
        });

        const interruptedRead = controller(
            fakeImportClient({
                readSources: vi.fn(async () => {
                    throw new Error("transport closed");
                }),
            }),
        );
        await interruptedRead.prepare(READ_PARAMS);
        expect(interruptedRead.state).toMatchObject({ status: "failed", refreshRequired: false });

        const interruptedPreview = controller(
            fakeImportClient({
                previewImport: vi.fn(async () => {
                    throw new Error("transport closed");
                }),
            }),
        );
        await interruptedPreview.prepare(READ_PARAMS);
        expect(interruptedPreview.state).toMatchObject({ status: "failed", refreshRequired: false });
    });

    it("selects compatible dependencies and dispatches exactly one batch accept", async () => {
        const client = fakeImportClient();
        const review = controller(client);
        await review.prepare(READ_PARAMS);
        expect(review.state).toMatchObject({
            status: "review",
            selectedCandidateIds: ["workflow", "subagent", "skill"],
            destinationSelections: [
                { candidateId: "workflow", action: "create_asset" },
                { candidateId: "subagent", action: "create_asset" },
                { candidateId: "skill", action: "create_asset" },
            ],
        });
        review.toggleCandidate("blocked");
        review.toggleCandidate("stale");
        review.toggleCandidate("skill");
        review.setBindingCandidateTarget("workflow", callableBindingSubjectKey(WORKFLOW_BINDING.subject), "skill");
        expect(review.state).toMatchObject({ message: localizedText("import.choose_compatible_candidate") });
        review.setBindingCandidateTarget("workflow", callableBindingSubjectKey(WORKFLOW_BINDING.subject), "subagent");
        review.setBindingCandidateTarget("workflow", callableBindingSubjectKey(WORKFLOW_BINDING.subject), "subagent");
        expect(
            review.state.status === "review"
                ? review.state.bindingSelections.filter(
                      (selection) =>
                          selection.candidateId === "workflow" &&
                          selection.subjectKey === callableBindingSubjectKey(WORKFLOW_BINDING.subject),
                  )
                : [],
        ).toHaveLength(1);
        review.clearBindingTarget("workflow", callableBindingSubjectKey(OPTIONAL_FILE_BINDING.subject));
        review.toggleCandidate("subagent");
        expect(review.state).toMatchObject({
            selectedCandidateIds: ["workflow"],
            destinationSelections: [{ candidateId: "workflow", action: "create_asset" }],
            bindingSelections: [],
        });
        review.toggleCandidate("subagent");
        review.setBindingCandidateTarget("workflow", callableBindingSubjectKey(WORKFLOW_BINDING.subject), "subagent");

        await review.accept();

        expect(client.acceptImportBatch).toHaveBeenCalledOnce();
        expect(client.acceptImportBatch).toHaveBeenCalledWith(
            expect.objectContaining({
                previewToken: "preview-token",
                decisions: expect.arrayContaining([
                    expect.objectContaining({ candidateId: "workflow", action: "create_asset" }),
                    expect.objectContaining({ candidateId: "subagent", action: "create_asset" }),
                ]),
            }),
        );
        expect(review.state).toMatchObject({ status: "result", result: { schemaVersion: 1 } });
    });

    it("edits exact existing-Asset destinations and existing-Version dependency bindings", async () => {
        const onCatalogChanged = vi.fn();
        const review = new ImportReviewController(
            fakeImportClient({
                listAssets: vi.fn(async () => ({
                    status: "complete",
                    value: { assets: [EXISTING_WORKFLOW, EXISTING_SUBAGENT] },
                    diagnostics: [],
                })),
            }),
            {
                createUserActionId: () => "user-action",
                onCatalogChanged,
            },
        );
        const subjectKey = callableBindingSubjectKey(WORKFLOW_BINDING.subject);
        await review.prepare(READ_PARAMS);
        review.toggleCandidate("subagent");
        review.toggleCandidate("skill");

        review.setDestination("workflow", EXISTING_SUBAGENT);
        expect(review.state).toMatchObject({
            status: "review",
            destinationSelections: [{ candidateId: "workflow", action: "create_asset" }],
            message: localizedText("import.choose_compatible_asset"),
        });
        review.setDestination("workflow", EXISTING_WORKFLOW);
        expect(review.state).toMatchObject({
            destinationSelections: [
                {
                    candidateId: "workflow",
                    action: "create_version",
                    assetId: WORKFLOW_ASSET_ID,
                    parentVersionId: WORKFLOW_VERSION_ID,
                },
            ],
        });
        review.setDestination("workflow", undefined);
        expect(review.state).toMatchObject({ destinationSelections: [] });
        review.setDestination("workflow", EXISTING_WORKFLOW);

        review.setBindingExistingVersionTarget("workflow", subjectKey, EXISTING_WORKFLOW);
        expect(review.state).toMatchObject({
            bindingSelections: [],
            message: localizedText("import.choose_existing_version"),
        });
        review.setBindingExistingVersionTarget("workflow", subjectKey, EXISTING_SUBAGENT);
        review.setBindingExistingVersionTarget("workflow", subjectKey, EXISTING_SUBAGENT);
        expect(review.state).toMatchObject({
            bindingSelections: [
                {
                    candidateId: "workflow",
                    subjectKey,
                    targetKind: "asset_version",
                    targetAssetVersionId: VERSION_ID,
                },
            ],
        });
        review.clearBindingTarget("workflow", subjectKey);
        expect(review.state).toMatchObject({ bindingSelections: [] });
        review.setBindingExistingVersionTarget("workflow", subjectKey, EXISTING_SUBAGENT);

        await review.accept();

        expect(review.state.status).toBe("result");
        expect(onCatalogChanged).toHaveBeenCalledOnce();
    });

    it("does not dispatch an invalid empty selection and ignores edits outside an active review", async () => {
        const client = fakeImportClient();
        const review = controller(client);
        review.toggleCandidate("subagent");
        review.setBindingCandidateTarget("workflow", callableBindingSubjectKey(WORKFLOW_BINDING.subject), "subagent");
        await review.loadDetail("subagent");
        await review.cancel();
        await review.accept();
        expect(client.acceptImportBatch).not.toHaveBeenCalled();

        await review.prepare(READ_PARAMS);
        review.toggleCandidate("workflow");
        review.toggleCandidate("subagent");
        review.toggleCandidate("skill");
        await review.accept();
        expect(review.state).toMatchObject({
            status: "review",
            message: localizedText("import.validation.no_selection"),
        });
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
    });

    it("keeps definitive accept failures editable but freezes an uncertain transport outcome", async () => {
        const failedClient = fakeImportClient({
            acceptImportBatch: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("import.denied", "Import rejected.")],
            })),
        });
        const failed = controller(failedClient);
        await failed.prepare(READ_PARAMS);
        failed.toggleCandidate("workflow");
        failed.toggleCandidate("skill");
        await failed.accept();
        expect(failed.state).toMatchObject({
            status: "review",
            activity: "accept_failed",
            message: localizedText("import.batch.failed"),
            diagnostics: [expect.objectContaining({ code: "import.denied" })],
            refreshRequired: false,
        });
        failed.toggleCandidate("subagent");
        expect(failed.state).toMatchObject({ selectedCandidateIds: [] });

        const interruptedClient = fakeImportClient({
            acceptImportBatch: vi.fn(async () => {
                throw new Error("transport closed");
            }),
        });
        const interrupted = controller(interruptedClient);
        await interrupted.prepare(READ_PARAMS);
        interrupted.toggleCandidate("workflow");
        interrupted.toggleCandidate("skill");
        await interrupted.accept();
        expect(interrupted.state).toMatchObject({
            status: "review",
            activity: "accept_failed",
            refreshRequired: true,
        });
        interrupted.toggleCandidate("subagent");
        expect(interrupted.state).toMatchObject({ selectedCandidateIds: ["subagent"] });
    });

    it("loads bounded text and binary details and turns stale member failures into refresh-required state", async () => {
        const getImportPreviewDetail = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete",
                value: {
                    candidateId: "subagent",
                    logicalPath: "subagent.md",
                    mediaType: "text/markdown",
                    contentKind: "text",
                    text: { text: "text", byteLength: 4, truncated: true },
                    byteLength: 12,
                    contentHash: DIGEST,
                },
                diagnostics: [diagnostic("detail.warning", "Text was bounded.", "warning")],
            })
            .mockResolvedValueOnce({
                status: "complete",
                value: {
                    candidateId: "subagent",
                    logicalPath: "blob.bin",
                    mediaType: "application/octet-stream",
                    contentKind: "binary",
                    byteLength: 20,
                    contentHash: DIGEST,
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "failed",
                diagnostics: [diagnostic("host.review_record_member_unavailable", "Member expired.")],
            });
        const review = controller(fakeImportClient({ getImportPreviewDetail }));
        await review.prepare(READ_PARAMS);
        await review.loadDetail("subagent", "subagent.md");
        expect(review.state).toMatchObject({
            status: "review",
            detail: { status: "ready", value: { contentKind: "text" } },
            diagnostics: [expect.objectContaining({ code: "detail.warning" })],
        });
        await review.loadDetail("subagent", "blob.bin");
        expect(review.state).toMatchObject({
            status: "review",
            detail: { status: "ready", value: { contentKind: "binary" } },
        });
        await review.loadDetail("subagent", "gone.md");
        expect(review.state).toMatchObject({
            status: "review",
            detail: { status: "failed", refreshRequired: true },
            refreshRequired: true,
        });
        await review.loadDetail("absent");
        expect(getImportPreviewDetail).toHaveBeenCalledTimes(3);
    });

    it("uses first-file detail params, reports interrupted details and drops obsolete detail outcomes", async () => {
        let resolveDetail:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["getImportPreviewDetail"]>>) => void)
            | undefined;
        const getImportPreviewDetail = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveDetail = resolve;
                    }),
            )
            .mockRejectedValueOnce(new Error("transport closed"));
        const client = fakeImportClient({ getImportPreviewDetail });
        const review = controller(client);
        await review.prepare(READ_PARAMS);
        const obsolete = review.loadDetail("subagent");
        await review.prepare(READ_PARAMS);
        resolveDetail?.({
            status: "complete",
            value: {
                candidateId: "subagent",
                mediaType: "text/markdown",
                contentKind: "text",
                text: { text: "obsolete", byteLength: 8, truncated: false },
                byteLength: 8,
                contentHash: DIGEST,
            },
            diagnostics: [],
        });
        await obsolete;
        expect(getImportPreviewDetail).toHaveBeenNthCalledWith(1, {
            previewToken: "preview-token",
            candidateId: "subagent",
        });
        expect(review.state).toMatchObject({ status: "review", detail: { status: "none" } });

        await review.loadDetail("subagent");
        expect(review.state).toMatchObject({
            status: "review",
            detail: {
                status: "failed",
                message: localizedText("import.detail.interrupted"),
                refreshRequired: false,
            },
        });
    });

    it("cancels only the retained token and preserves retryable cancellation failures", async () => {
        const failedClient = fakeImportClient({
            cancelImportPreview: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("cancel.denied", "Cancel failed.")],
            })),
        });
        const failed = controller(failedClient);
        await failed.prepare(READ_PARAMS);
        await failed.cancel();
        expect(failedClient.cancelImportPreview).toHaveBeenCalledWith({ previewToken: "preview-token" });
        expect(failed.state).toMatchObject({
            status: "review",
            activity: "cancel_failed",
            message: localizedText("import.cancel.failed"),
            diagnostics: [expect.objectContaining({ code: "cancel.denied" })],
        });

        const client = fakeImportClient();
        const complete = controller(client);
        await complete.prepare(READ_PARAMS);
        await complete.cancel();
        expect(complete.state).toEqual({
            status: "idle",
            message: localizedText("import.cancelled"),
        });

        const interrupted = controller(
            fakeImportClient({
                cancelImportPreview: vi.fn(async () => {
                    throw new Error("transport closed");
                }),
            }),
        );
        await interrupted.prepare(READ_PARAMS);
        await interrupted.cancel();
        expect(interrupted.state).toMatchObject({
            status: "review",
            activity: "cancel_failed",
            message: localizedText("import.cancel.interrupted"),
        });
    });

    it("drops stale async detail and preparation completions", async () => {
        let resolveRead: ((value: Awaited<ReturnType<DesktopApplicationClientApi["readSources"]>>) => void) | undefined;
        const readSources = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveRead = resolve;
                    }),
            )
            .mockResolvedValueOnce({
                status: "complete",
                value: { readToken: "second-read", reports: [], candidateCount: PREVIEW.candidates.length },
                diagnostics: [],
            });
        const client = fakeImportClient({ readSources });
        const review = controller(client);
        const stale = review.prepare(READ_PARAMS);
        await review.prepare(READ_PARAMS);
        resolveRead?.({
            status: "complete",
            value: { readToken: "stale-read", reports: [], candidateCount: 0 },
            diagnostics: [],
        });
        await stale;
        expect(client.previewImport).toHaveBeenCalledOnce();
        expect(client.previewImport).toHaveBeenCalledWith({ readToken: "second-read" });
        expect(review.state.status).toBe("review");
    });
});

describe("Desktop import review UI", () => {
    it.each([
        "en",
        "zh-CN",
        "de",
        "ja",
    ] as const)("keeps protocol identities, raw diagnostics and storage IDs out of the %s ordinary surface", async (locale: DesktopResolvedLocale) => {
        const candidateId = "candidate-internal-raw-sentinel";
        const assetId = "55555555-5555-4555-8555-555555555555";
        const versionId = "66666666-6666-4666-8666-666666666666";
        const rawDiagnostic = "RAW_IMPORT_DIAGNOSTIC_SENTINEL";
        const client = fakeImportClient({
            previewImport: vi.fn(async () => ({
                status: "partial",
                value: {
                    ...PREVIEW,
                    candidates: [
                        candidate(candidateId, "Guidance", {
                            displayName: "Readable guidance",
                            displayDescription: "A user-visible description",
                            scope: "project",
                            freshness: "fresh",
                            logicalPaths: ["guidance.md"],
                        }),
                        candidate("blocked-internal-sentinel", "Memory", {
                            displayName: "Private memory",
                            displayDescription: "",
                            status: "blocked",
                            freshness: "stale",
                            logicalPaths: ["MEMORY.md"],
                        }),
                    ],
                },
                diagnostics: [diagnostic("preview.raw", rawDiagnostic, "warning")],
            })),
            acceptImportBatch: vi.fn(async () => ({
                status: "complete",
                value: {
                    schemaVersion: 1,
                    items: [
                        {
                            status: "complete",
                            candidateId,
                            version: { assetId, versionId },
                            diagnostics: [],
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        const review = controller(client);
        const snapshot = createDesktopPresentationSnapshot(
            {
                ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                language: locale,
                onboardingCompleted: true,
            },
            [locale],
            false,
        );
        const { container } = renderWithPresentation(
            createElement(ImportReviewWorkspace, { controller: review }),
            createDesktopPresentationTestBridge(snapshot),
        );

        await act(async () => review.prepare(READ_PARAMS));
        let ordinaryText = ordinarySurfaceText(container);
        expect(ordinaryText).not.toContain(candidateId);
        expect(ordinaryText).not.toContain("blocked-internal-sentinel");
        expect(ordinaryText).not.toContain(rawDiagnostic);
        expect(ordinaryText).not.toMatch(/\b(?:blocked|stale)\b/u);
        expect(container.textContent).toContain(rawDiagnostic);

        await act(async () => review.accept());

        ordinaryText = ordinarySurfaceText(container);
        expect(ordinaryText).toContain("Readable guidance");
        expect(ordinaryText).not.toContain(candidateId);
        expect(ordinaryText).not.toContain(assetId);
        expect(ordinaryText).not.toContain(versionId);
        expect(ordinaryText).not.toContain(rawDiagnostic);
        expect(container.textContent).toContain(candidateId);
        expect(container.textContent).toContain(assetId);
        expect(container.textContent).toContain(versionId);
        expect(container.textContent).toContain(rawDiagnostic);
    });

    it("shows truthful candidate eligibility, resolves a required binding and presents per-item outcomes", async () => {
        const client = fakeImportClient({
            listAssets: vi.fn(async () => ({
                status: "complete",
                value: { assets: [EXISTING_WORKFLOW, EXISTING_SUBAGENT] },
                diagnostics: [],
            })),
            previewImport: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...PREVIEW,
                    candidates: [
                        ...PREVIEW.candidates,
                        candidate("too-many", "Workflow", {
                            callableBindingRequestCount: 129,
                            callableBindingRequestsTruncated: true,
                        }),
                    ],
                },
                diagnostics: [diagnostic("preview.warning", "Preview warning.", "warning")],
            })),
            acceptImportBatch: vi.fn(async () => ({
                status: "partial",
                value: {
                    schemaVersion: 1,
                    items: [
                        {
                            status: "complete",
                            candidateId: "subagent",
                            version: { assetId: ASSET_ID, versionId: VERSION_ID },
                            diagnostics: [],
                        },
                        {
                            status: "failed",
                            candidateId: "workflow",
                            diagnostics: [diagnostic("import.failed", "Workflow import failed.")],
                        },
                        {
                            status: "dependency_failed",
                            candidateId: "other",
                            failedDependencyCandidateIds: ["workflow"],
                            diagnostics: [],
                        },
                    ],
                },
                diagnostics: [diagnostic("import.partial", "Some items failed.", "warning")],
            })),
        });
        const review = controller(client);
        const { container } = renderWithPresentation(
            createElement(ImportReviewWorkspace, {
                controller: review,
            }),
        );
        expect(screen.getByText("No Assets selected for review")).not.toBeNull();

        await act(async () => review.prepare(READ_PARAMS));
        const stale = screen.getByRole("checkbox", { name: "Select stale" }) as HTMLInputElement;
        const blocked = screen.getByRole("checkbox", { name: "Select blocked" }) as HTMLInputElement;
        const tooMany = screen.getByRole("checkbox", { name: "Select too-many" }) as HTMLInputElement;
        expect(stale.disabled).toBe(true);
        expect(blocked.disabled).toBe(true);
        expect(tooMany.disabled).toBe(true);
        expect(screen.getByText(/129 related Assets/u)).not.toBeNull();
        fireEvent.click(screen.getByRole("checkbox", { name: "Select skill" }));
        selectWorkbenchOption("How to save workflow", "Add Version after Existing workflow revision 1");
        selectWorkbenchOption("How to save subagent", "Create a new OAAM Asset");
        selectWorkbenchOption("Related Asset for workflow: reviewer", /^subagent \(Subagent\)/u);
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));

        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: "Import results" })).not.toBeNull());
        expect(screen.getByText("New Asset saved in the OAAM library")).not.toBeNull();
        expect(screen.queryByText("Imported")).toBeNull();
        expect(screen.getByText("Failed")).not.toBeNull();
        expect(screen.getByText("Required Asset was not imported")).not.toBeNull();
        toggleFirstInteractionDisclosure("features.import-review.import_review_workspace.005", container);
        expect(screen.getByText(/does not undo an Asset that was imported successfully/u)).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain("Preview warning.");
        expect(ordinarySurfaceText(container)).not.toContain("Some items failed.");
        expect(container.textContent).toContain("Preview warning.");
        expect(container.textContent).toContain("Some items failed.");
        expect(client.acceptImportBatch).toHaveBeenCalledOnce();
        expect(client.acceptImportBatch).toHaveBeenCalledWith(
            expect.objectContaining({
                decisions: expect.arrayContaining([
                    expect.objectContaining({
                        candidateId: "workflow",
                        action: "create_version",
                        assetId: WORKFLOW_ASSET_ID,
                        parentVersionId: WORKFLOW_VERSION_ID,
                    }),
                ]),
            }),
        );
    });

    it("renders truncated text, binary metadata and refresh-required detail failures without HTML interpretation", async () => {
        const getImportPreviewDetail = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete",
                value: {
                    candidateId: "subagent",
                    logicalPath: "subagent.md",
                    mediaType: "text/markdown",
                    contentKind: "text",
                    text: { text: "<script>unsafe()</script>", byteLength: 25, truncated: true },
                    byteLength: 50,
                    contentHash: DIGEST,
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "complete",
                value: {
                    candidateId: "subagent",
                    logicalPath: "subagent.md",
                    mediaType: "application/octet-stream",
                    contentKind: "binary",
                    byteLength: 50,
                    contentHash: DIGEST,
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "failed",
                diagnostics: [diagnostic("host.review_record_unavailable", "Preview expired.")],
            });
        const review = controller(fakeImportClient({ getImportPreviewDetail }));
        const { container } = renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));
        await act(async () => review.prepare(READ_PARAMS));

        fireEvent.click(screen.getByRole("button", { name: "View subagent" }));
        await vi.waitFor(() => expect(screen.queryByText("<script>unsafe()</script>")).not.toBeNull());
        expect(screen.getByText("<script>unsafe()</script>")).not.toBeNull();
        expect(document.querySelector("script")).toBeNull();
        expect(screen.getByText(/text is truncated/u)).not.toBeNull();
        await act(async () => review.loadDetail("subagent", "subagent.md"));
        expect(screen.getByText(/binary file is not shown/u)).not.toBeNull();
        await act(async () => review.loadDetail("subagent", "subagent.md"));
        expect(ordinarySurfaceText(container)).not.toContain("Preview expired.");
        expect(container.textContent).toContain("Preview expired.");
        expect(screen.getByText(/Scan again before importing/u)).not.toBeNull();
    });

    it("wires existing destination and Version binding choices without inventing identifiers", async () => {
        const client = fakeImportClient({
            listAssets: vi.fn(async () => ({
                status: "complete",
                value: { assets: [EXISTING_WORKFLOW, EXISTING_SUBAGENT] },
                diagnostics: [],
            })),
        });
        const review = controller(client);
        renderWithPresentation(
            createElement(ImportReviewWorkspace, {
                controller: review,
            }),
        );
        await act(async () => review.prepare(READ_PARAMS));

        fireEvent.click(screen.getByRole("combobox", { name: "How to save workflow" }));
        expect(screen.queryByRole("option", { name: "Choose a destination" })).toBeNull();
        expect(screen.getByRole("option", { name: "Create a new OAAM Asset" })).not.toBeNull();
        expect(screen.getByRole("option", { name: "Add Version after Existing workflow revision 1" })).not.toBeNull();
        fireEvent.click(screen.getByRole("option", { name: "Create a new OAAM Asset" }));

        fireEvent.click(screen.getByRole("button", { name: "View workflow" }));
        await vi.waitFor(() =>
            expect(client.getImportPreviewDetail).toHaveBeenCalledWith({
                previewToken: "preview-token",
                candidateId: "workflow",
                logicalPath: "workflow.md",
            }),
        );
        selectWorkbenchOption("How to save workflow", "Add Version after Existing workflow revision 1");
        selectWorkbenchOption("How to save workflow", "Create a new OAAM Asset");
        expect(review.state).toMatchObject({
            destinationSelections: expect.arrayContaining([{ candidateId: "workflow", action: "create_asset" }]),
        });
        selectWorkbenchOption("How to save workflow", "Add Version after Existing workflow revision 1");

        selectWorkbenchOption("Related Asset for workflow: reviewer", /^Add Version after Existing reviewer revision 1/u);
        expect(review.state).toMatchObject({
            status: "review",
            bindingSelections: [
                expect.objectContaining({
                    targetKind: "asset_version",
                    targetAssetVersionId: VERSION_ID,
                }),
            ],
        });
        selectWorkbenchOption("Related Asset for workflow: reviewer", "Choose a related Asset");
        expect(review.state).toMatchObject({ status: "review", bindingSelections: [] });
    });

    it("renders preparation, failed and empty states and wires bounded detail plus exact cancellation controls", async () => {
        let resolveRead: ((value: Awaited<ReturnType<DesktopApplicationClientApi["readSources"]>>) => void) | undefined;
        const client = fakeImportClient({
            readSources: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveRead = resolve;
                    }),
            ),
            previewImport: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...PREVIEW,
                    candidates: [
                        candidate("first-file", "Skill", {
                            fileCount: 2,
                            logicalPaths: [],
                            logicalPathsTruncated: true,
                            displayDescription: "",
                        }),
                    ],
                },
                diagnostics: [diagnostic("preview.warning", "Summary was bounded.", "warning")],
            })),
        });
        const review = controller(client);
        const { container } = renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));
        let preparing: Promise<void> | undefined;
        act(() => {
            preparing = review.prepare(READ_PARAMS);
        });
        expect(screen.getByRole("heading", { name: "Reading selected sources" })).not.toBeNull();
        expect(document.querySelector("[data-oaam-loading-indicator]")).not.toBeNull();
        expect(document.querySelector(".status-card-compact.import-review-progress")).not.toBeNull();
        await act(async () => {
            resolveRead?.({
                status: "complete",
                value: { readToken: "read-token", reports: [], candidateCount: 1 },
                diagnostics: [],
            });
            await preparing;
        });
        expect(screen.getByText(/More files belong to this Asset/u)).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain("Summary was bounded.");
        expect(container.textContent).toContain("Summary was bounded.");
        fireEvent.click(screen.getByRole("button", { name: "View first-file" }));
        await vi.waitFor(() =>
            expect(client.getImportPreviewDetail).toHaveBeenCalledWith({
                previewToken: "preview-token",
                candidateId: "first-file",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Close Asset review" }));
        await vi.waitFor(() => expect(client.cancelImportPreview).toHaveBeenCalledWith({ previewToken: "preview-token" }));
        await vi.waitFor(() => expect(screen.queryByText("No Assets selected for review")).not.toBeNull());
        const failedClient = fakeImportClient({
            readSources: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("read.failed", "No readable sources.")],
            })),
        });
        const failed = controller(failedClient);
        cleanup();
        renderWithPresentation(createElement(ImportReviewWorkspace, { controller: failed }));
        await act(async () => failed.prepare(READ_PARAMS));
        expect(screen.getByRole("heading", { name: "Import review unavailable" })).not.toBeNull();
        expect(screen.getByRole("alert").getAttribute("data-oaam-tone")).toBe("danger");
        expect(document.querySelector(".import-review-failure .import-review-status")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.waitFor(() => expect(failedClient.readSources).toHaveBeenCalledTimes(2));
        const empty = controller(
            fakeImportClient({
                previewImport: vi.fn(async () => ({
                    status: "complete",
                    value: { ...PREVIEW, candidates: [] },
                    diagnostics: [],
                })),
            }),
        );
        cleanup();
        renderWithPresentation(createElement(ImportReviewWorkspace, { controller: empty }));
        await act(async () => empty.prepare(READ_PARAMS));
        expect(screen.getByText("The selected sources contain no Assets ready to import.")).not.toBeNull();
    });
});
