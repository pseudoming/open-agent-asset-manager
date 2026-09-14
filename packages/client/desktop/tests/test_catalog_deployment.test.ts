import type { ProtocolOperationParams } from "@oaam/app-server-protocol";
import { ClientTransportError } from "@oaam/client-framework";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import type { CatalogDeploymentState } from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import { localizedText } from "../src/renderer/presentation";
import {
    DEPLOYMENT_PROVIDERS,
    INSPECTION,
    INSPECTION_DETAIL,
    PROBE_REVIEW,
    RENDER_ANALYSIS,
    RENDER_PREVIEW,
} from "./catalog-deployment-test-fixtures";
import {
    ABSENT_DIRECT_ASSET_USAGE,
    ASSET,
    ASSET_DETAIL,
    ASSET_ID,
    createController,
    DEPLOYMENT_ID,
    deployment,
    diagnostic,
    emitLong,
    fakeCatalogClient,
    fakeController,
    NEEDS_REPAIR_DEPLOYMENT_ID,
    PROJECT,
    PROJECT_ID,
    readyState,
    SHA_A,
    SHA_B,
    VERSION,
    VERSION_ID,
} from "./catalog-deployment-test-support";
import { reviewCatalogPreviewFile, reviewCatalogSourceTechnicalDisclosure } from "./catalog-deployment-disclosure-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(cleanup);

describe("Desktop catalog and deployment controller", () => {
    it("loads partial catalog projections and resolves exact Asset and current Version detail", async () => {
        const fake = fakeCatalogClient({
            listProjects: vi.fn(async () => ({
                status: "partial",
                value: { projects: [PROJECT] },
                diagnostics: [diagnostic("Project warning.", "warning")],
            })),
        });
        const controller = createController(fake.client);
        const states: CatalogDeploymentState[] = [];
        const unsubscribe = controller.subscribe((state) => states.push(state));
        await controller.load();
        expect(controller.state).toMatchObject({
            status: "ready",
            projects: [PROJECT],
            assets: [ASSET],
            diagnostics: [diagnostic("Project warning.", "warning")],
        });
        await controller.selectAsset(ASSET_ID);
        expect(controller.state).toMatchObject({
            status: "ready",
            assetDetail: {
                status: "ready",
                asset: ASSET_DETAIL,
                version: VERSION,
                preview: {
                    status: "ready",
                    logicalPath: "AGENTS.md",
                    preview: {
                        previewKind: "text",
                        file: VERSION.files[0],
                        text: "# Project guidance\n",
                        lineCount: 2,
                    },
                    textPages: [],
                    hasMoreText: false,
                },
            },
        });
        expect(fake.client.getAsset).toHaveBeenCalledWith({ assetId: ASSET_ID });
        expect(fake.client.getAssetVersion).toHaveBeenCalledWith({ assetId: ASSET_ID, versionId: VERSION_ID });
        expect(fake.client.readAssetVersionFilePreview).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            logicalPath: "AGENTS.md",
        });
        controller.clearAssetSelection();
        expect(controller.state).toMatchObject({ assetDetail: { status: "none" } });
        expect(states[0]).toEqual({ status: "loading", message: localizedText("catalog.loading") });
        unsubscribe();
        controller.dispose();
        expect(fake.unsubscribed()).toBe(true);
    });

    it("progressively reads the selected current Version when its first file exceeds the preview limit", async () => {
        const largeFile = {
            ...VERSION.files[0],
            logicalPath: "large.md",
            byteLength: 22,
        };
        const largeVersion = { ...VERSION, files: [largeFile] };
        const readAssetVersionTextPage = vi.fn(async ({ cursor }: { readonly cursor?: string }) => ({
            status: "complete" as const,
            value: {
                found: true as const,
                value:
                    cursor === undefined
                        ? {
                              file: largeFile,
                              text: "first page\n",
                              loadedByteStart: 0,
                              loadedByteEnd: 11,
                              totalBytes: 22,
                              firstLine: 1,
                              lastLine: 1,
                              totalLines: 2,
                              hasMore: true as const,
                              nextCursor: "next-page",
                          }
                        : {
                              file: largeFile,
                              text: "second page\n",
                              loadedByteStart: 11,
                              loadedByteEnd: 22,
                              totalBytes: 22,
                              firstLine: 2,
                              lastLine: 2,
                              totalLines: 2,
                              hasMore: false as const,
                          },
            },
            diagnostics: [],
        }));
        const fake = fakeCatalogClient({
            getAssetVersion: vi.fn(async () => ({
                status: "complete",
                value: { found: true, value: largeVersion },
                diagnostics: [],
            })),
            readAssetVersionFilePreview: vi.fn(async () => ({
                status: "complete",
                value: {
                    found: true,
                    value: { previewKind: "large_text", file: largeFile, limitReason: "byte_limit" },
                },
                diagnostics: [],
            })),
            readAssetVersionTextPage,
        });
        const controller = createController(fake.client);

        await controller.load();
        await controller.selectAsset(ASSET_ID);
        expect(controller.state).toMatchObject({
            assetDetail: {
                status: "ready",
                preview: {
                    status: "ready",
                    logicalPath: "large.md",
                    textPages: [{ text: "first page\n" }],
                    hasMoreText: true,
                    nextTextCursor: "next-page",
                },
            },
        });
        expect(readAssetVersionTextPage).toHaveBeenLastCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            logicalPath: "large.md",
        });

        await controller.loadMoreAssetText();
        expect(readAssetVersionTextPage).toHaveBeenLastCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            logicalPath: "large.md",
            cursor: "next-page",
        });
        expect(controller.state).toMatchObject({
            assetDetail: {
                status: "ready",
                preview: {
                    status: "ready",
                    textPages: [{ text: "first page\n" }, { text: "second page\n" }],
                    hasMoreText: false,
                },
            },
        });
        await controller.loadMoreAssetText();
        await controller.selectAssetFile("missing.md");
        controller.clearAssetSelection();
        controller.clearAssetSelection();
        await controller.loadMoreAssetText();
        expect(readAssetVersionTextPage).toHaveBeenCalledTimes(2);
    });

    it("keeps unavailable, rejected and interrupted file preview reads inside the selected Asset", async () => {
        const unavailable = createController(
            fakeCatalogClient({
                supportsOperation: vi.fn(
                    (operation: Parameters<DesktopApplicationClientApi["supportsOperation"]>[0]) =>
                        operation !== "asset_version.file_preview",
                ),
            }).client,
        );
        await unavailable.load();
        await unavailable.selectAsset(ASSET_ID);
        expect(unavailable.state).toMatchObject({
            status: "ready",
            assets: [ASSET],
            assetDetail: {
                status: "ready",
                preview: { status: "failed", message: localizedText("library.file_preview_failed") },
            },
        });

        const rejectedDiagnostic = diagnostic("Preview rejected.");
        const rejected = createController(
            fakeCatalogClient({
                readAssetVersionFilePreview: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [rejectedDiagnostic],
                })),
            }).client,
        );
        await rejected.load();
        await rejected.selectAsset(ASSET_ID);
        expect(rejected.state).toMatchObject({
            status: "ready",
            assets: [ASSET],
            assetDetail: {
                status: "ready",
                preview: {
                    status: "failed",
                    message: localizedText("library.file_preview_failed"),
                    diagnostics: [rejectedDiagnostic],
                },
            },
        });

        const interrupted = createController(
            fakeCatalogClient({
                readAssetVersionFilePreview: vi.fn(async () => Promise.reject(new Error("closed"))),
            }).client,
        );
        await interrupted.load();
        await interrupted.selectAsset(ASSET_ID);
        expect(interrupted.state).toMatchObject({
            status: "ready",
            assets: [ASSET],
            assetDetail: {
                status: "ready",
                preview: {
                    status: "failed",
                    message: localizedText("library.file_preview_failed"),
                    diagnostics: [],
                },
            },
        });
    });

    it("keeps large-file paging unavailable and failed states local to the right-side preview", async () => {
        const largeFile = {
            ...VERSION.files[0],
            logicalPath: "large.md",
            byteLength: 22,
        };
        const largeVersion = { ...VERSION, files: [largeFile] };
        const largePreviewOverrides = {
            getAssetVersion: vi.fn(async () => ({
                status: "complete" as const,
                value: { found: true as const, value: largeVersion },
                diagnostics: [],
            })),
            readAssetVersionFilePreview: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    found: true as const,
                    value: { previewKind: "large_text" as const, file: largeFile, limitReason: "byte_limit" as const },
                },
                diagnostics: [],
            })),
        };
        const firstPage = {
            file: largeFile,
            text: "first page\n",
            loadedByteStart: 0,
            loadedByteEnd: 11,
            totalBytes: 22,
            firstLine: 1,
            lastLine: 1,
            totalLines: 2,
            hasMore: true as const,
            nextCursor: "next-page",
        };

        const noPagingRead = vi.fn();
        const noPaging = createController(
            fakeCatalogClient({
                ...largePreviewOverrides,
                supportsOperation: vi.fn(
                    (operation: Parameters<DesktopApplicationClientApi["supportsOperation"]>[0]) =>
                        operation !== "asset_version.text_page",
                ),
                readAssetVersionTextPage: noPagingRead,
            }).client,
        );
        await noPaging.load();
        await noPaging.selectAsset(ASSET_ID);
        expect(noPaging.state).toMatchObject({
            assetDetail: { status: "ready", preview: { status: "ready", textPages: [], hasMoreText: false } },
        });
        expect(noPagingRead).not.toHaveBeenCalled();

        const firstPageDiagnostic = diagnostic("First page rejected.");
        const rejectedFirstPage = createController(
            fakeCatalogClient({
                ...largePreviewOverrides,
                readAssetVersionTextPage: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [firstPageDiagnostic],
                })),
            }).client,
        );
        await rejectedFirstPage.load();
        await rejectedFirstPage.selectAsset(ASSET_ID);
        expect(rejectedFirstPage.state).toMatchObject({
            assetDetail: {
                status: "ready",
                preview: {
                    status: "failed",
                    message: localizedText("library.file_preview_failed"),
                    diagnostics: [firstPageDiagnostic],
                },
            },
        });

        const nextPageDiagnostic = diagnostic("Next page rejected.");
        const rejectedNextRead = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete",
                value: { found: true, value: firstPage },
                diagnostics: [],
            })
            .mockResolvedValueOnce({ status: "failed", diagnostics: [nextPageDiagnostic] });
        const rejectedNextPage = createController(
            fakeCatalogClient({ ...largePreviewOverrides, readAssetVersionTextPage: rejectedNextRead }).client,
        );
        await rejectedNextPage.load();
        await rejectedNextPage.selectAsset(ASSET_ID);
        await rejectedNextPage.loadMoreAssetText();
        expect(rejectedNextPage.state).toMatchObject({
            assetDetail: {
                status: "ready",
                preview: {
                    status: "failed",
                    message: localizedText("library.file_preview_failed"),
                    diagnostics: [nextPageDiagnostic],
                },
            },
        });

        const interruptedNextRead = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete",
                value: { found: true, value: firstPage },
                diagnostics: [],
            })
            .mockRejectedValueOnce(new Error("closed"));
        const interruptedNextPage = createController(
            fakeCatalogClient({ ...largePreviewOverrides, readAssetVersionTextPage: interruptedNextRead }).client,
        );
        await interruptedNextPage.load();
        await interruptedNextPage.selectAsset(ASSET_ID);
        await interruptedNextPage.loadMoreAssetText();
        expect(interruptedNextPage.state).toMatchObject({
            assetDetail: {
                status: "ready",
                preview: {
                    status: "failed",
                    message: localizedText("library.file_preview_failed"),
                    diagnostics: [],
                },
            },
        });
    });

    it("reports failed, interrupted, missing and stale Asset projections without inventing detail", async () => {
        const failed = createController(
            fakeCatalogClient({
                listAssets: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [diagnostic("Asset catalog failed.")],
                })),
            }).client,
        );
        await failed.load();
        expect(failed.state).toEqual({
            status: "failed",
            message: localizedText("catalog.load.failed"),
            diagnostics: [diagnostic("Asset catalog failed.")],
        });

        const interrupted = createController(
            fakeCatalogClient({ listProjects: vi.fn(async () => Promise.reject(new Error("closed"))) }).client,
        );
        await interrupted.load();
        expect(interrupted.state).toEqual({
            status: "failed",
            message: localizedText("catalog.load.interrupted"),
            diagnostics: [],
        });

        const missing = createController(
            fakeCatalogClient({
                getAsset: vi.fn(async () => ({ status: "complete", value: { found: false }, diagnostics: [] })),
            }).client,
        );
        await missing.load();
        await missing.selectAsset("absent");
        await missing.selectAsset(ASSET_ID);
        expect(missing.state).toMatchObject({
            assetDetail: { status: "failed", message: localizedText("catalog.asset.missing") },
        });

        const brokenFake = fakeCatalogClient({
            getAssetVersion: vi.fn(async () => Promise.reject(new Error("closed"))),
        });
        const broken = createController(brokenFake.client);
        await broken.load();
        await broken.selectAsset(ASSET_ID);
        expect(broken.state).toMatchObject({
            assetDetail: { status: "failed", message: localizedText("catalog.asset.detail_interrupted") },
        });

        const rejectedFake = fakeCatalogClient({
            getAsset: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("Asset detail rejected.")],
            })),
        });
        const rejected = createController(rejectedFake.client);
        await rejected.load();
        await rejected.selectAsset(ASSET_ID);
        expect(rejected.state).toMatchObject({
            assetDetail: { status: "failed", message: localizedText("catalog.asset.detail_unavailable") },
            diagnostics: [diagnostic("Asset detail rejected.")],
        });

        const versionRejectedFake = fakeCatalogClient({
            getAssetVersion: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("Version detail rejected.")],
            })),
        });
        const versionRejected = createController(versionRejectedFake.client);
        await versionRejected.load();
        await versionRejected.selectAsset(ASSET_ID);
        expect(versionRejected.state).toMatchObject({
            assetDetail: { status: "failed", message: localizedText("catalog.asset.detail_unavailable") },
            diagnostics: [diagnostic("Version detail rejected.")],
        });
    });

    it("keeps empty catalog, immediate failure and interrupted mutation states distinct", async () => {
        const fake = fakeCatalogClient({
            listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [] }, diagnostics: [] })),
            registerProject: vi
                .fn()
                .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Registration denied.")] })
                .mockRejectedValueOnce(new Error("closed")),
            createDeployment: vi
                .fn()
                .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Deployment denied.")] })
                .mockRejectedValueOnce(new Error("closed")),
        });
        const controller = createController(fake.client);
        await controller.load();
        expect(controller.state).toMatchObject({
            status: "ready",
            message: localizedText("catalog.empty"),
        });

        await controller.registerProject("token", "  Named project  ");
        expect(fake.client.registerProject).toHaveBeenCalledWith({
            localPathSelectionToken: "token",
            displayName: "Named project",
        });
        expect(controller.state).toMatchObject({
            message: localizedText("catalog.project.registration_failed"),
            diagnostics: [diagnostic("Registration denied.")],
            requiresReconciliation: false,
        });
        await controller.registerProject("token");
        expect(controller.state).toMatchObject({
            message: localizedText("catalog.operation.interrupted", {
                operation: localizedText("catalog.activity.register"),
            }),
            requiresReconciliation: false,
        });

        const params: ProtocolOperationParams<"deployment.create"> = {
            probeToken: "probe",
            probeResultRowId: "result",
            targetRowId: "target",
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        };
        await controller.createDeployment(params);
        expect(controller.state).toMatchObject({
            message: localizedText("catalog.deployment.creation_failed"),
            diagnostics: expect.arrayContaining([diagnostic("Deployment denied.")]),
            requiresReconciliation: false,
        });
        await controller.createDeployment(params);
        expect(controller.state).toMatchObject({
            message: localizedText("catalog.operation.interrupted", {
                operation: localizedText("catalog.activity.create"),
            }),
            requiresReconciliation: false,
        });
    });

    it("registers projects and creates deployment intents while preserving concurrent invalidation", async () => {
        let resolveCreate: ((value: Awaited<ReturnType<DesktopApplicationClientApi["createDeployment"]>>) => void) | undefined;
        const fake = fakeCatalogClient({
            createDeployment: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveCreate = resolve;
                    }),
            ),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.registerProject(" ");
        expect(fake.client.registerProject).not.toHaveBeenCalled();
        await controller.registerProject("path-token", "  ");
        expect(fake.client.registerProject).toHaveBeenCalledWith({ localPathSelectionToken: "path-token" });
        const creating = controller.createDeployment({
            probeToken: "probe",
            probeResultRowId: "result",
            targetRowId: "target",
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        });
        expect(resolveCreate).toBeDefined();
        expect(controller.state).toMatchObject({ activity: { status: "starting", kind: "create_deployment" } });
        fake.invalidate({ resourceKind: "collection", collection: "deployments" });
        resolveCreate?.({ status: "complete", value: deployment("blocked"), diagnostics: [] });
        await creating;
        expect(controller.state).toMatchObject({
            status: "ready",
            stale: true,
            activity: { status: "idle" },
            deployments: [expect.objectContaining({ stage: "blocked" })],
        });
    });

    it("tracks long-operation progress, exact inspection evidence and repair", async () => {
        const fake = fakeCatalogClient({
            scanDeployment: vi.fn(async (_params, listener) => {
                emitLong("deployment.scan", listener);
                return {
                    status: "complete",
                    value: deployment("needs_repair"),
                    diagnostics: [diagnostic("Prior scan warning.", "warning")],
                };
            }),
            repairDeployment: vi.fn(async (_params, listener) => {
                emitLong("deployment.repair", listener);
                return {
                    status: "complete",
                    value: deployment("in_sync"),
                    diagnostics: [diagnostic("Current repair warning.", "warning")],
                };
            }),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({ analysis: { status: "ready", value: RENDER_ANALYSIS } });

        await controller.preview(DEPLOYMENT_ID, [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false }]);
        expect(controller.state).toMatchObject({ preview: { status: "ready", value: RENDER_PREVIEW } });
        expect(fake.client.previewDeployment).toHaveBeenCalledWith(
            {
                deploymentId: DEPLOYMENT_ID,
                selection: {
                    schemaVersion: 1,
                    renderInputFingerprint: SHA_A,
                    semanticOptions: [{ optionFingerprint: SHA_B, approval: { action: "none" } }],
                },
            },
            expect.any(Function),
        );
        await controller.deployPreview("apply");
        expect(fake.client.deploy).toHaveBeenCalledWith(
            { previewToken: "render-preview-token", deploymentAction: "apply" },
            expect.any(Function),
        );
        await controller.scan(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            deployments: [expect.objectContaining({ stage: "needs_repair" })],
            activity: { status: "idle" },
        });

        await controller.inspect(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            inspection: { status: "ready", value: INSPECTION, detail: { status: "none" } },
        });
        await controller.loadInspectionDetail("absent");
        expect(fake.client.getRenderedInspectionDetail).not.toHaveBeenCalled();
        await controller.loadInspectionDetail("semantic-1");
        expect(controller.state).toMatchObject({
            inspection: { status: "ready", detail: { status: "ready", value: INSPECTION_DETAIL } },
        });
        await controller.repair();
        expect(controller.state).toMatchObject({
            deployments: [expect.objectContaining({ stage: "in_sync" })],
            stale: false,
            diagnostics: [diagnostic("Current repair warning.", "warning")],
        });
        expect(controller.state.status === "ready" ? controller.state.diagnostics : []).not.toContainEqual(
            diagnostic("Prior scan warning.", "warning"),
        );
        expect(fake.client.repairDeployment).toHaveBeenCalledWith(
            {
                deploymentId: DEPLOYMENT_ID,
                inspectionToken: "inspection-token",
                expectedInspectionResultFingerprint: SHA_B,
                userActionId: "user-action",
            },
            expect.any(Function),
        );
    });

    it("distinguishes definitive failures, read-only interruption and uncertain mutation delivery", async () => {
        const uncertain = new ClientTransportError(
            "uncertain",
            "deployment.deploy",
            "request-1",
            "connection lost",
            new Error("closed"),
        );
        const analyzeDeployment = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Analysis rejected.")] })
            .mockResolvedValue({ status: "complete", value: RENDER_ANALYSIS, diagnostics: [] });
        const fake = fakeCatalogClient({
            analyzeDeployment,
            deploy: vi.fn(async () => Promise.reject(uncertain)),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            analysis: { status: "failed", message: localizedText("catalog.render.analysis_failed") },
            diagnostics: [diagnostic("Analysis rejected.")],
        });
        await controller.analyze(DEPLOYMENT_ID);
        await controller.preview(DEPLOYMENT_ID, [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false }]);
        await controller.deployPreview("apply");
        expect(controller.state).toMatchObject({
            stale: true,
            requiresReconciliation: true,
            message: localizedText("catalog.operation.lost_terminal", {
                operation: localizedText("catalog.activity.deploy"),
            }),
        });
        const inspectController = createController(
            fakeCatalogClient({
                listDeployments: vi.fn(async () => ({
                    status: "complete",
                    value: { deployments: [deployment("conflict")] },
                    diagnostics: [],
                })),
                inspectRenderedTarget: vi.fn(async () => Promise.reject(uncertain)),
            }).client,
        );
        await inspectController.load();
        await inspectController.inspect(DEPLOYMENT_ID);
        expect(inspectController.state).toMatchObject({
            inspection: { status: "failed", message: localizedText("catalog.inspection.lost_channel") },
            requiresReconciliation: false,
        });
        const recoveryController = createController(
            fakeCatalogClient({
                listDeployments: vi.fn(async () => ({
                    status: "complete",
                    value: { deployments: [deployment("blocked")] },
                    diagnostics: [],
                })),
                recoverDeployment: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [diagnostic("Recovery blocked.")],
                })),
            }).client,
        );
        await recoveryController.load();
        await recoveryController.recover(DEPLOYMENT_ID);
        expect(recoveryController.state).toMatchObject({
            message: localizedText("catalog.operation.failed", {
                operation: localizedText("catalog.activity.recover"),
            }),
            diagnostics: [diagnostic("Recovery blocked.")],
            requiresReconciliation: false,
        });
    });

    it("discards stale preview authority and stale render analysis instead of offering a blind retry", async () => {
        const deploy = vi
            .fn()
            .mockResolvedValueOnce({
                status: "failed",
                diagnostics: [{ ...diagnostic("Preview changed."), code: "render.preview_stale" }],
            })
            .mockResolvedValueOnce({
                status: "failed",
                diagnostics: [{ ...diagnostic("Context changed."), code: "render.action_time_context_changed" }],
            });
        const controller = createController(fakeCatalogClient({ deploy }).client);
        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        const selection = [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false }];
        await controller.preview(DEPLOYMENT_ID, selection);
        await controller.deployPreview("apply");
        expect(controller.state).toMatchObject({
            analysis: { status: "ready" },
            preview: { status: "none" },
            message: localizedText("catalog.operation.failed", {
                operation: localizedText("catalog.activity.deploy"),
            }),
            diagnostics: [
                {
                    ...diagnostic("Preview changed."),
                    code: "render.preview_stale",
                },
            ],
        });

        await controller.preview(DEPLOYMENT_ID, selection);
        await controller.deployPreview("apply");
        expect(controller.state).toMatchObject({
            analysis: { status: "none" },
            preview: { status: "none" },
            message: localizedText("catalog.operation.failed", {
                operation: localizedText("catalog.activity.deploy"),
            }),
            diagnostics: expect.arrayContaining([
                {
                    ...diagnostic("Context changed."),
                    code: "render.action_time_context_changed",
                },
            ]),
        });
    });

    it("reports ordinary analysis/inspection/detail interruptions and zero-conflict inspection truth", async () => {
        const fake = fakeCatalogClient({
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: { deployments: [deployment("conflict")] },
                diagnostics: [],
            })),
            analyzeDeployment: vi.fn(async () => Promise.reject(new Error("closed"))),
            inspectRenderedTarget: vi
                .fn()
                .mockResolvedValueOnce({
                    status: "failed",
                    diagnostics: [diagnostic("Inspection rejected.")],
                })
                .mockResolvedValueOnce({
                    status: "complete",
                    value: { ...INSPECTION, conflictCount: 0 },
                    diagnostics: [],
                }),
            getRenderedInspectionDetail: vi
                .fn()
                .mockResolvedValueOnce({
                    status: "failed",
                    diagnostics: [diagnostic("Detail rejected.")],
                })
                .mockRejectedValueOnce(new Error("closed")),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.analyze(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            analysis: { status: "failed", message: localizedText("catalog.render.interrupted") },
        });
        await controller.inspect(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            inspection: { status: "failed", message: localizedText("catalog.target.inspection_failed") },
            diagnostics: [diagnostic("Inspection rejected.")],
        });
        await controller.inspect(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            inspection: { status: "ready" },
            message: localizedText("catalog.inspection.current"),
        });
        await controller.loadInspectionDetail("semantic-1");
        expect(controller.state).toMatchObject({
            inspection: {
                status: "ready",
                detail: { status: "failed", message: localizedText("catalog.inspection.detail_unavailable") },
            },
            diagnostics: expect.arrayContaining([diagnostic("Detail rejected.")]),
        });
        await controller.loadInspectionDetail("semantic-1");
        expect(controller.state).toMatchObject({
            inspection: {
                status: "ready",
                detail: { status: "failed", message: localizedText("catalog.inspection.detail_interrupted") },
            },
        });
    });

    it("invalidates exact retained inspections and durable catalog authority", async () => {
        const fake = fakeCatalogClient({
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: { deployments: [deployment("conflict")] },
                diagnostics: [],
            })),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.inspect(DEPLOYMENT_ID);
        fake.invalidate({ resourceKind: "host_review_record", recordKind: "rendered_inspection", token: "other" });
        expect(controller.state).toMatchObject({ inspection: { status: "ready" } });
        fake.invalidate({
            resourceKind: "host_review_record",
            recordKind: "rendered_inspection",
            token: "inspection-token",
        });
        expect(controller.state).toMatchObject({
            inspection: { status: "none" },
            message: localizedText("catalog.inspection.retained_expired"),
        });
        await controller.selectAsset(ASSET_ID);
        fake.invalidate({ resourceKind: "asset", assetId: ASSET_ID });
        expect(controller.state).toMatchObject({
            stale: true,
            assetDetail: { status: "none" },
            analysis: { status: "none" },
            inspection: { status: "none" },
        });
    });
});

describe("Desktop catalog and deployment workspace", () => {
    it("requires explicit deployment choices and drives catalog, render, inspection and repair actions", async () => {
        const incompleteCreationAsset = { ...ASSET, currentVersionStatus: "incomplete" as const };
        const state = readyState({
            assets: [incompleteCreationAsset],
            assetUsage: ABSENT_DIRECT_ASSET_USAGE,
            analysis: {
                status: "ready",
                value: { ...RENDER_ANALYSIS, deploymentId: NEEDS_REPAIR_DEPLOYMENT_ID },
            },
            preview: {
                status: "ready",
                value: { ...RENDER_PREVIEW, deploymentId: NEEDS_REPAIR_DEPLOYMENT_ID },
            },
            inspection: {
                status: "ready",
                value: { ...INSPECTION, deploymentId: NEEDS_REPAIR_DEPLOYMENT_ID },
                detail: { status: "ready", value: INSPECTION_DETAIL },
            },
            diagnostics: [diagnostic("Review warning.", "warning")],
        });
        const createController = fakeController({ ...state, deployments: [] });
        const onDeploymentCreated = vi.fn();
        vi.mocked(createController.createDeployment).mockResolvedValue(DEPLOYMENT_ID);
        const createView = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: createController,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET_ID,
                assetImportSource: {
                    adapterId: "CLAUDECODE",
                    sourceSnapshotFingerprint: SHA_A,
                    roots: [
                        {
                            sourceRootId: "source-root",
                            rootRole: "project_actual",
                            sourceDomain: "project_root",
                            canonicalPath: "/workspace/source-project",
                        },
                    ],
                    files: [{ sourceRootId: "source-root", relativePath: "AGENTS.md", contentHash: SHA_B }],
                },
                onDeploymentCreated,
            }),
        );
        expect(
            screen.getByRole("button", { name: "Refresh catalog" }).querySelector("[data-oaam-icon='refresh']"),
        ).not.toBeNull();
        expect(screen.queryByText("Choose exact saved Versions")).toBeNull();
        const versionAction = screen.getByRole("button", { name: "View current Version" });
        expect(versionAction.querySelector("[data-oaam-icon='preview']")).not.toBeNull();
        reviewCatalogSourceTechnicalDisclosure(createView.container);
        fireEvent.click(versionAction);
        expect(createController.selectAsset).toHaveBeenCalledWith(ASSET_ID);

        fireEvent.click(screen.getByRole("checkbox", { name: "Explicitly allow this incomplete Version" }));
        const relationshipSummary = createView.container.querySelector<HTMLButtonElement>(
            '.asset-usage-group-summary[aria-expanded="true"]',
        );
        if (relationshipSummary === null) throw new Error("relationship summary is required");
        expect(relationshipSummary.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText("Not added yet")).toBeTruthy();
        expect(
            screen.getByText("The files for the current Version are not here yet. Preview the files OAAM would add."),
        ).toBeTruthy();
        expect(screen.queryByRole("combobox", { name: "Tool location" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Preview files to add" }));
        expect(createController.createDeployment).toHaveBeenCalledWith(
            expect.objectContaining({
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: true }],
            }),
        );
        await vi.waitFor(() => expect(onDeploymentCreated).toHaveBeenCalledWith(DEPLOYMENT_ID));
        createView.unmount();

        const controller = fakeController(state);
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );

        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        const analyze = screen.getByRole("button", { name: "Review file changes" });
        expect(analyze.getAttribute("data-oaam-deployment-action")).toBe("analyze");
        fireEvent.click(analyze);
        fireEvent.click(screen.getByRole("radio", { name: /Some managed files can be restored/u }));
        const scan = screen.getByRole("button", { name: "Check file status" });
        const inspect = screen.getByRole("button", { name: "Review outside changes" });
        expect(scan.getAttribute("data-oaam-deployment-action")).toBe("scan");
        expect(inspect.getAttribute("data-oaam-deployment-action")).toBe("inspect");
        fireEvent.click(scan);
        fireEvent.click(inspect);
        expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
        expect(controller.analyze).toHaveBeenCalled();
        expect(controller.scan).toHaveBeenCalled();
        expect(controller.inspect).toHaveBeenCalled();

        fireEvent.click(screen.getByRole("radio", { name: /Inline content/u }));
        fireEvent.click(screen.getByRole("radio", { name: /Native file/u }));
        fireEvent.click(screen.getByRole("radio", { name: /Inline content/u }));
        fireEvent.click(screen.getByLabelText("Approve this degraded render once"));
        expect(screen.getAllByText("bin/helper · binary · executable").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Managed directory: .claude/skills").length).toBeGreaterThan(0);
        const preview = screen.getByRole("button", { name: "Review files before applying" });
        expect(preview.getAttribute("data-oaam-deployment-action")).toBe("preview");
        fireEvent.click(preview);
        expect(controller.preview).toHaveBeenCalledWith(NEEDS_REPAIR_DEPLOYMENT_ID, expect.any(Array));
        expect(screen.getByText("Files and folders to be changed")).toBeTruthy();
        reviewCatalogPreviewFile(document);
        fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
        expect(controller.deployPreview).toHaveBeenCalledWith("apply");
        expect(screen.queryByRole("button", { name: "Apply the selected OAAM version" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Content change: Guidance content" }));
        const repair = screen.getByRole("button", { name: "Repair from this exact inspection" });
        expect(repair.getAttribute("data-oaam-deployment-action")).toBe("repair");
        fireEvent.click(repair);
        expect(controller.loadInspectionDetail).toHaveBeenCalledWith("semantic-1");
        expect(controller.repair).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("radio", { name: /Paused for safety/u }));
        const recover = screen.getByRole("button", { name: "Recover" });
        expect(recover.getAttribute("data-oaam-deployment-action")).toBe("recover");
        fireEvent.click(recover);
        expect(controller.recover).toHaveBeenCalled();
        expect(
            screen.getByText("This action conflicts with the current state. Review the latest result before continuing."),
        ).toBeTruthy();
        expect(screen.getByText(/Review warning/u)).toBeTruthy();
    });
});
