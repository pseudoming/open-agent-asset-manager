import type { ProtocolDiagnosticV1, ProtocolInvalidationV1 } from "@oaam/app-server-protocol";
import { ClientTransportError } from "@oaam/client-framework";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import { CatalogDeploymentPreviewFiles } from "../src/renderer/features/catalog-deployment/CatalogDeploymentPreviewFiles";
import {
    CatalogDeploymentController,
    type CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import type { DeploymentView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { localizedText } from "../src/renderer/presentation";
import { DEPLOYMENT_PROVIDERS, INSPECTION, RENDER_ANALYSIS, RENDER_PREVIEW } from "./catalog-deployment-test-fixtures";
import { deployment as fixtureDeployment } from "./catalog-deployment-test-support";
import { toggleInteractionDisclosure } from "./desktop-interaction-test-harness";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = RENDER_PREVIEW.deploymentId;
const SHA_A = RENDER_ANALYSIS.renderInputFingerprint;
const SHA_B = RENDER_ANALYSIS.options[0]?.optionFingerprint as string;

function deployment(stage: DeploymentView["stage"] = "in_sync"): DeploymentView {
    return {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project", projectId: PROJECT_ID },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        environment: { platform: "linux", platformInstanceId: "local" },
        targetRootPath: "/workspace/oaam",
        stage,
        reason: stage,
        actionHints: stage === "conflict" ? ["review_external_changes", "check_now"] : ["review_deployment"],
        freshness:
            stage === "conflict"
                ? { state: "complete", attemptedAt: 2, lastCompleteAt: 2 }
                : { state: "never", attemptedAt: 0, lastCompleteAt: 0 },
        deleted: false,
        assets: [],
        createdAt: 1,
        updatedAt: 2,
    };
}

function diagnostic(message: string): ProtocolDiagnosticV1 {
    return {
        severity: "error",
        code: "desktop.test",
        operation: "deploy",
        causeKind: "conflict",
        retryable: true,
        suggestedActions: ["retry"],
        message,
    };
}

function previewClient(previewDeployment: ReturnType<typeof vi.fn>): {
    client: DesktopApplicationClientApi;
    invalidate(invalidation: ProtocolInvalidationV1): void;
} {
    let listener: ((invalidation: ProtocolInvalidationV1) => void) | undefined;
    const client = {
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [] }, diagnostics: [] })),
        listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [] }, diagnostics: [] })),
        listDeployments: vi.fn(async () => ({
            status: "complete",
            value: { deployments: [deployment()] },
            diagnostics: [],
        })),
        analyzeDeployment: vi.fn(async () => ({ status: "complete", value: RENDER_ANALYSIS, diagnostics: [] })),
        previewDeployment,
        deploy: vi.fn(async () => ({ status: "complete", value: deployment("in_sync"), diagnostics: [] })),
        subscribeInvalidation: vi.fn((next) => {
            listener = next;
            return () => {
                listener = undefined;
            };
        }),
    } as unknown as DesktopApplicationClientApi;
    return { client, invalidate: (invalidation) => listener?.(invalidation) };
}

function readyState(
    preview: Extract<CatalogDeploymentState, { status: "ready" }>["preview"],
): Extract<CatalogDeploymentState, { status: "ready" }> {
    return {
        status: "ready",
        projects: [],
        assets: [],
        deployments: [deployment()],
        assetUsage: { status: "none" },
        assetDetail: { status: "none" },
        analysis: { status: "none" },
        preview,
        inspection: { status: "none" },
        reverse: { status: "none" },
        activity: { status: "idle" },
        stale: false,
        requiresReconciliation: false,
        message: undefined,
        diagnostics: [],
    };
}

function presentationController(state: CatalogDeploymentState): CatalogDeploymentController {
    return {
        state,
        subscribe: vi.fn((listener: (next: CatalogDeploymentState) => void) => {
            listener(state);
            return () => undefined;
        }),
        dispose: vi.fn(),
        load: vi.fn(async () => undefined),
        analyzeAssetUsage: vi.fn(async () => undefined),
        selectAsset: vi.fn(async () => undefined),
        clearAssetSelection: vi.fn(),
        registerProject: vi.fn(async () => undefined),
        createDeployment: vi.fn(async () => undefined),
        analyze: vi.fn(async () => undefined),
        clearPreview: vi.fn(),
        preview: vi.fn(async () => undefined),
        deployPreview: vi.fn(async () => undefined),
        overwritePreview: vi.fn(async () => undefined),
        scan: vi.fn(async () => undefined),
        inspect: vi.fn(async () => undefined),
        loadInspectionDetail: vi.fn(async () => undefined),
        repair: vi.fn(async () => undefined),
        recover: vi.fn(async () => undefined),
        prepareReverse: vi.fn(async () => undefined),
        commitReverse: vi.fn(async () => undefined),
        cancelReverse: vi.fn(async () => undefined),
    } as unknown as CatalogDeploymentController;
}

afterEach(cleanup);

describe("Desktop exact Deployment preview", () => {
    it.each([
        "stale",
        "preview_changed",
        "deployment_changed",
    ] as const)("binds managed replacement to its preview and cancels without a write before %s", (change) => {
        const initial = {
            ...readyState({ status: "ready", value: { ...RENDER_PREVIEW, actionState: "blocked_managed_conflict" as const } }),
            deployments: [deployment("conflict")],
            inspection: { status: "ready" as const, value: INSPECTION, detail: { status: "none" as const } },
        };
        const controller = presentationController(initial);
        const props = {
            controller,
            probeReview: undefined,
            subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
            providers: DEPLOYMENT_PROVIDERS,
        };
        const view = renderWithPresentation(createElement(CatalogDeploymentWorkspace, props));
        fireEvent.click(screen.getByRole("radio", { name: /External changes found/u }));
        const choices = view.container.querySelector(".inspection-decision-list");
        const overwrite = view.container.querySelector<HTMLButtonElement>(
            '[data-oaam-preview-decision="blocked_managed_conflict"] [data-oaam-replacement-action="review"]',
        );
        if (!overwrite) throw new Error("managed overwrite review missing");
        expect(choices?.querySelector('[data-oaam-deployment-action="reverse.prepare"]')).not.toBeNull();
        expect(screen.queryByText(/Inspect the managed file change/u)).toBeNull();
        expect(screen.getByText(/Managed content has changed/u)).toBeTruthy();
        overwrite.focus();
        fireEvent.click(overwrite);
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(document.activeElement).toBe(overwrite);
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(overwrite);
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1) as HTMLElement);
        expect(document.activeElement).toBe(overwrite);
        fireEvent.click(overwrite);
        const changed = presentationController({
            ...initial,
            ...(change === "stale" ? { stale: true } : {}),
            ...(change === "preview_changed"
                ? {
                      preview: {
                          status: "ready" as const,
                          value: {
                              ...RENDER_PREVIEW,
                              actionState: "blocked_managed_conflict" as const,
                              previewToken: "fresh-preview",
                          },
                      },
                  }
                : {}),
            ...(change === "deployment_changed"
                ? { deployments: [{ ...deployment("conflict"), deploymentId: "55555555-5555-4555-8555-555555555555" }] }
                : {}),
        });
        view.rerender(createElement(CatalogDeploymentWorkspace, { ...props, controller: changed }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(controller.overwritePreview).not.toHaveBeenCalled();
        expect(changed.overwritePreview).not.toHaveBeenCalled();
        expect(controller.prepareReverse).not.toHaveBeenCalled();
        expect(changed.prepareReverse).not.toHaveBeenCalled();
    });

    it("moves emphasis from analysis to preview to Apply and restores the exact failed or expired review action", async () => {
        const previewDeployment = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Preview denied.")] })
            .mockResolvedValue({ status: "complete", value: RENDER_PREVIEW, diagnostics: [] });
        const fake = previewClient(previewDeployment);
        const analyzeDeployment = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Analysis denied.")] })
            .mockResolvedValue({
                status: "complete",
                value: { ...RENDER_ANALYSIS, options: RENDER_ANALYSIS.options.slice(0, 1) },
                diagnostics: [],
            });
        const controller = new CatalogDeploymentController(
            { ...fake.client, analyzeDeployment },
            { createUserActionId: () => "review-action" },
        );
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(await screen.findByRole("radio", { name: /First deployment available/u }));
        let analyze = screen.getByRole("button", { name: "Review file changes" });
        expect(analyze.classList.contains("library-secondary-button")).toBe(false);
        fireEvent.click(analyze);
        await waitFor(() => expect(controller.state).toMatchObject({ analysis: { status: "failed" } }));
        expect(analyze.classList.contains("library-secondary-button")).toBe(false);
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();

        fireEvent.click(analyze);
        const preview = await screen.findByRole("button", { name: "Review files before applying" });
        expect(screen.queryByRole("button", { name: "Review file changes" })).toBeNull();
        expect(preview.classList.contains("library-secondary-button")).toBe(false);
        fireEvent.click(preview);
        await waitFor(() => expect(controller.state).toMatchObject({ preview: { status: "failed" } }));
        await waitFor(() => expect(document.activeElement).toBe(view.container.querySelector("[data-oaam-preview-result]")));
        expect(preview.classList.contains("library-secondary-button")).toBe(false);
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();

        fireEvent.click(preview);
        const apply = await screen.findByRole("button", { name: "Apply changes" });
        await waitFor(() => expect(document.activeElement).toBe(view.container.querySelector("[data-oaam-preview-result]")));
        expect(screen.queryByRole("button", { name: "Review file changes" })).toBeNull();
        expect(preview.classList.contains("library-secondary-button")).toBe(true);
        expect(apply.classList.contains("library-secondary-button")).toBe(false);
        expect((apply as HTMLButtonElement).disabled).toBe(false);
        expect(fake.client.deploy).not.toHaveBeenCalled();

        await act(async () => {
            fake.invalidate({
                resourceKind: "host_review_record",
                recordKind: "render_preview",
                token: RENDER_PREVIEW.previewToken,
            });
        });
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Review file changes" })).toBeNull();
        expect(preview.classList.contains("library-secondary-button")).toBe(false);
        fireEvent.click(preview);
        await screen.findByRole("button", { name: "Apply changes" });
        expect(previewDeployment).toHaveBeenCalledTimes(3);

        await act(async () => {
            fake.invalidate({ resourceKind: "deployment", deploymentId: DEPLOYMENT_ID });
        });
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Review files before applying" })).toBeNull();
        analyze = screen.getByRole("button", { name: "Review file changes" });
        expect(analyze.classList.contains("library-secondary-button")).toBe(false);
        expect((analyze as HTMLButtonElement).disabled).toBe(true);
        const refresh = screen.getByRole("button", { name: "Reload saved state" });
        expect((refresh as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(refresh);
        await waitFor(() => expect(controller.state).toMatchObject({ stale: false }));
        expect((screen.getByRole("button", { name: "Review file changes" }) as HTMLButtonElement).disabled).toBe(false);
        expect(analyzeDeployment).toHaveBeenCalledTimes(2);
        expect(fake.client.deploy).not.toHaveBeenCalled();
    });

    it("retires preview actions before promoting Check for an applied baseline and keeps conflict inspection primary", async () => {
        const fake = previewClient(vi.fn(async () => ({ status: "complete", value: RENDER_PREVIEW, diagnostics: [] })));
        const deploy = vi.fn(async () => ({ status: "complete" as const, value: fixtureDeployment(), diagnostics: [] }));
        const scanDeployment = vi.fn(async () => ({
            status: "complete" as const,
            value: fixtureDeployment("conflict"),
            diagnostics: [],
        }));
        const controller = new CatalogDeploymentController(
            {
                ...fake.client,
                listDeployments: vi.fn(async () => ({
                    status: "complete" as const,
                    value: { deployments: [fixtureDeployment("in_sync", true)] },
                    diagnostics: [],
                })),
                analyzeDeployment: vi.fn(async () => ({
                    status: "complete" as const,
                    value: { ...RENDER_ANALYSIS, options: RENDER_ANALYSIS.options.slice(0, 1) },
                    diagnostics: [],
                })),
                deploy,
                scanDeployment,
            },
            { createUserActionId: () => "review-action" },
        );
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(await screen.findByRole("radio", { name: /First deployment available/u }));
        fireEvent.click(screen.getByRole("button", { name: "Review file changes" }));
        fireEvent.click(await screen.findByRole("button", { name: "Review files before applying" }));
        expect(screen.queryByRole("button", { name: "Check file status" })).toBeNull();
        fireEvent.click(await screen.findByRole("button", { name: "Apply changes" }));
        const check = await screen.findByRole("button", { name: "Check file status" });
        expect(check.classList.contains("library-secondary-button")).toBe(false);
        expect(controller.state).toMatchObject({
            deployments: [{ actionHints: ["check_now"] }],
            analysis: { status: "none" },
            preview: { status: "none" },
        });
        expect(screen.queryByRole("button", { name: "Review file changes" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Review files before applying" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
        expect(deploy).toHaveBeenCalledTimes(1);
        expect(deploy).toHaveBeenCalledWith(
            { previewToken: RENDER_PREVIEW.previewToken, deploymentAction: "apply" },
            expect.any(Function),
        );

        fireEvent.click(check);
        await waitFor(() => expect(controller.state).toMatchObject({ deployments: [{ stage: "conflict" }] }));
        expect(controller.state).toMatchObject({ deployments: [{ actionHints: ["review_external_changes", "check_now"] }] });
        expect(check.classList.contains("library-secondary-button")).toBe(true);
        const inspect = document.querySelector<HTMLButtonElement>('[data-oaam-deployment-action="inspect"]');
        expect(inspect).not.toBeNull();
        expect(inspect?.classList.contains("library-secondary-button")).toBe(false);
        expect(inspect?.disabled).toBe(false);
        expect(scanDeployment).toHaveBeenCalledTimes(1);
        expect(scanDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }, expect.any(Function));
        expect(deploy).toHaveBeenCalledTimes(1);
    });

    it("keeps required degradation approval explicit before promoting the preview action", () => {
        const degraded = RENDER_ANALYSIS.options[1];
        if (degraded === undefined) throw new Error("the degraded option fixture is required");
        const controller = presentationController({
            ...readyState({ status: "none" }),
            analysis: { status: "ready", value: { ...RENDER_ANALYSIS, options: [degraded] } },
        });
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        expect(screen.queryByRole("button", { name: "Review files before applying" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
        const approval = screen.getByRole("checkbox") as HTMLInputElement;
        expect(approval.checked).toBe(false);
        expect(controller.preview).not.toHaveBeenCalled();
        fireEvent.click(approval);
        const preview = screen.getByRole("button", { name: "Review files before applying" });
        expect(preview.classList.contains("library-secondary-button")).toBe(false);
        fireEvent.click(preview);
        expect(controller.preview).toHaveBeenCalledWith(DEPLOYMENT_ID, [
            { semanticRefFingerprint: SHA_A, optionFingerprint: degraded.optionFingerprint, approved: true },
        ]);
        expect(controller.preview).toHaveBeenCalledTimes(1);
        expect(controller.deployPreview).not.toHaveBeenCalled();
        fireEvent.click(approval);
        expect(screen.queryByRole("button", { name: "Review files before applying" })).toBeNull();
    });

    it.each(["busy", "stale"] as const)("does not enable retained preview actions when %s", (stateKind) => {
        const initial = {
            ...readyState({ status: "ready", value: RENDER_PREVIEW }),
            analysis: {
                status: "ready" as const,
                value: { ...RENDER_ANALYSIS, options: RENDER_ANALYSIS.options.slice(0, 1) },
            },
        };
        const controller = presentationController(initial);
        const props = {
            controller,
            probeReview: undefined,
            subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
            providers: DEPLOYMENT_PROVIDERS,
        };
        const view = renderWithPresentation(createElement(CatalogDeploymentWorkspace, props));
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        const changed = presentationController({
            ...initial,
            ...(stateKind === "stale"
                ? { stale: true }
                : {
                      activity: {
                          status: "starting" as const,
                          kind: "deploy" as const,
                          message: localizedText("catalog.activity.deploy"),
                      },
                  }),
        });
        view.rerender(createElement(CatalogDeploymentWorkspace, { ...props, controller: changed }));
        const analyze = screen.queryByRole("button", { name: "Review file changes" }) as HTMLButtonElement | null;
        if (stateKind === "busy") expect(analyze).toBeNull();
        else expect(analyze?.disabled).toBe(true);
        for (const name of ["Review files before applying", "Apply changes"]) {
            const button = screen.getByRole("button", { name }) as HTMLButtonElement;
            expect(button.disabled).toBe(true);
            fireEvent.click(button);
        }
        expect(changed.analyze).not.toHaveBeenCalled();
        expect(changed.preview).not.toHaveBeenCalled();
        expect(changed.deployPreview).not.toHaveBeenCalled();
        expect((screen.getByRole("button", { name: "Reload saved state" }) as HTMLButtonElement).disabled).toBe(
            stateKind === "busy",
        );
    });

    it("keeps preview failures distinct, invalidates exact retained authority, and forwards one-time unmanaged replacement", async () => {
        const uncertain = new ClientTransportError(
            "uncertain",
            "deployment.render_preview",
            "preview-request",
            "connection lost",
            new Error("closed"),
        );
        const previewDeployment = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [diagnostic("Preview denied.")] })
            .mockRejectedValueOnce(new Error("closed"))
            .mockRejectedValueOnce(uncertain)
            .mockResolvedValue({
                status: "complete",
                value: { ...RENDER_PREVIEW, actionState: "requires_unmanaged_replacement" },
                diagnostics: [],
            });
        const fake = previewClient(previewDeployment);
        const controller = new CatalogDeploymentController(fake.client, { createUserActionId: () => "user-action" });
        await controller.load();
        await controller.preview(DEPLOYMENT_ID, []);
        expect(previewDeployment).not.toHaveBeenCalled();
        await controller.analyze(DEPLOYMENT_ID);

        await controller.preview(DEPLOYMENT_ID, []);
        expect(controller.state).toMatchObject({
            preview: { status: "failed", failureKind: "preview.selection_invalid" },
        });
        controller.clearPreview();
        const selection = [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false }];
        await controller.preview(DEPLOYMENT_ID, selection);
        expect(controller.state).toMatchObject({
            preview: {
                status: "failed",
                failureKind: "preview.operation_failed",
                message: localizedText("catalog.preview.failed"),
            },
            diagnostics: [diagnostic("Preview denied.")],
        });
        await controller.preview(DEPLOYMENT_ID, selection);
        expect(controller.state).toMatchObject({
            preview: {
                status: "failed",
                failureKind: "preview.interrupted",
                message: localizedText("catalog.preview.interrupted"),
            },
            diagnostics: [],
        });
        await controller.preview(DEPLOYMENT_ID, selection);
        expect(controller.state).toMatchObject({
            preview: {
                status: "failed",
                failureKind: "preview.outcome_unavailable",
                message: localizedText("catalog.preview.lost_channel"),
            },
        });
        await controller.preview(DEPLOYMENT_ID, selection);
        expect(controller.state).toMatchObject({ preview: { status: "ready" } });

        fake.invalidate({ resourceKind: "host_review_record", recordKind: "render_preview", token: "other" });
        expect(controller.state).toMatchObject({ preview: { status: "ready" } });
        fake.invalidate({
            resourceKind: "host_review_record",
            recordKind: "render_preview",
            token: "render-preview-token",
        });
        expect(controller.state).toMatchObject({
            preview: { status: "none" },
            message: localizedText("catalog.preview.retained_expired"),
        });

        await controller.preview(DEPLOYMENT_ID, selection);
        await controller.deployPreview("replace_unmanaged");
        expect(fake.client.deploy).toHaveBeenCalledWith(
            {
                previewToken: "render-preview-token",
                deploymentAction: "replace_unmanaged",
                userActionId: "user-action",
            },
            expect.any(Function),
        );
    });

    it("shows the changed file first and lets users inspect retained baseline files and empty directories", () => {
        const retained = {
            state: "present",
            contentKind: "text",
            contentHash: SHA_A,
            byteSize: 9,
            executable: false,
            text: "retained\n",
        } as const;
        const unchangedFile = {
            relativePath: "skill/retained.md",
            baselineState: "unmanaged",
            changeKind: "establish_baseline",
            current: retained,
            desired: retained,
        } as const;
        const openReview = vi.fn();
        const { container } = renderWithPresentation(
            createElement(CatalogDeploymentPreviewFiles, {
                files: [
                    unchangedFile,
                    { ...unchangedFile, relativePath: "skill/unchanged.md", baselineState: "managed", changeKind: "unchanged" },
                    {
                        ...unchangedFile,
                        relativePath: "skill/changed.md",
                        changeKind: "replace_unmanaged",
                        current: { ...retained, contentHash: SHA_B, text: "external\n" },
                    },
                ],
                directories: ["skill", "skill/empty"].map((relativePath) => ({
                    managedBoundaryRelativePath: "skill",
                    relativePath,
                    baselineState: "unmanaged",
                    changeKind: "unchanged",
                    currentState: "present",
                    desiredState: "present",
                })),
                onOpenReview: openReview,
            }),
        );
        const graph = container.querySelector('[data-oaam-preview-graph="complete"]')!;
        const unchanged = graph.querySelector<HTMLDetailsElement>("[data-oaam-preview-graph-unchanged]")!;
        expect(graph.querySelector("[data-oaam-preview-path]")?.getAttribute("data-oaam-preview-path")).toBe("skill/changed.md");
        expect(unchanged.open).toBe(false);
        expect(unchanged.querySelectorAll("[data-oaam-preview-entry-kind]")).toHaveLength(4);
        expect(graph.querySelector('[data-oaam-preview-review-path="skill/retained.md"]')?.closest("details")).toBe(unchanged);
        fireEvent.click(unchanged.querySelector("summary")!);
        expect(unchanged.open).toBe(true);
        const viewRetained = screen.getByRole("button", { name: "View retained.md" });
        fireEvent.click(viewRetained);
        expect(openReview).toHaveBeenCalledOnce();
        expect(screen.getByRole("complementary", { name: "Files and folders to be changed" }).textContent).toContain("retained");
        fireEvent.click(screen.getByRole("button", { name: "Close side preview" }));
        expect(document.activeElement).toBe(viewRetained);
        fireEvent.click(unchanged.querySelector("summary")!);
        expect(unchanged.open).toBe(false);
        expect(graph.querySelector('[data-oaam-preview-path="skill/empty"]')).not.toBeNull();
        expect(graph.querySelectorAll("[data-oaam-preview-entry-kind]")).toHaveLength(5);
    });

    it("requires explicit dialog confirmation for unmanaged replacement and blocks writes for uninspected conflicts", () => {
        const unmanaged = presentationController(
            readyState({
                status: "ready",
                value: {
                    ...RENDER_PREVIEW,
                    actionState: "requires_unmanaged_replacement",
                    files: [
                        {
                            relativePath: "CLAUDE.md",
                            baselineState: "unmanaged",
                            changeKind: "replace_unmanaged",
                            current: {
                                state: "present",
                                contentKind: "text",
                                contentHash: SHA_B,
                                byteSize: 14,
                                executable: false,
                                text: "# Existing\n",
                            },
                            desired: {
                                state: "present",
                                contentKind: "text",
                                contentHash: SHA_A,
                                byteSize: 18,
                                executable: false,
                                text: "# Project guidance\n",
                            },
                        },
                        {
                            relativePath: "scratch.txt",
                            baselineState: "unmanaged",
                            changeKind: "replace_unmanaged",
                            current: {
                                state: "present",
                                contentKind: "text",
                                contentHash: SHA_B,
                                byteSize: 4,
                                executable: false,
                                text: "old\n",
                            },
                            desired: { state: "missing" },
                        },
                        {
                            relativePath: "old.bin",
                            baselineState: "managed",
                            changeKind: "remove_managed",
                            current: {
                                state: "present",
                                contentKind: "binary",
                                contentHash: SHA_B,
                                byteSize: 4,
                                executable: true,
                            },
                            desired: { state: "missing" },
                        },
                    ],
                    directories: [
                        {
                            managedBoundaryRelativePath: ".claude/skills/demo",
                            relativePath: ".claude/skills/demo/retained",
                            baselineState: "unmanaged",
                            changeKind: "unchanged",
                            currentState: "present",
                            desiredState: "present",
                        },
                        {
                            managedBoundaryRelativePath: ".claude/skills/demo",
                            relativePath: ".claude/skills/demo/resources",
                            baselineState: "managed",
                            changeKind: "remove_managed",
                            currentState: "present",
                            desiredState: "missing",
                        },
                        {
                            managedBoundaryRelativePath: ".claude/skills/demo",
                            relativePath: ".claude/skills/demo/scratch",
                            baselineState: "unmanaged",
                            changeKind: "remove_unmanaged",
                            currentState: "present",
                            desiredState: "missing",
                        },
                    ],
                },
            }),
        );
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: unmanaged,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        expect(screen.getAllByText("Folders in this managed item")).toHaveLength(2);
        expect(screen.getByText("Remove this OAAM-managed folder")).toBeTruthy();
        expect(screen.getByText("Remove this reviewed existing folder")).toBeTruthy();
        const previewGraph = view.container.querySelector('[data-oaam-preview-graph="complete"]');
        expect(previewGraph?.classList.contains("catalog-preview-graph")).toBe(true);
        const changedGraph = previewGraph?.querySelector("[data-oaam-preview-graph-changes]");
        expect(changedGraph?.querySelector("[data-oaam-preview-path]")?.getAttribute("data-oaam-preview-path")).toBe("CLAUDE.md");
        expect(changedGraph?.querySelector('[data-oaam-preview-path=".claude/skills/demo/retained"]')).toBeNull();
        const unchangedGraph = previewGraph?.querySelector<HTMLDetailsElement>("[data-oaam-preview-graph-unchanged]");
        if (unchangedGraph === undefined || unchangedGraph === null) throw new Error("unchanged graph disclosure is missing");
        expect(unchangedGraph.open).toBe(false);
        expect(unchangedGraph.querySelectorAll("[data-oaam-preview-entry-kind]")).toHaveLength(1);
        fireEvent.click(unchangedGraph.querySelector("summary")!);
        expect(unchangedGraph.open).toBe(true);
        expect(unchangedGraph.querySelector('[data-oaam-preview-path=".claude/skills/demo/retained"]')).not.toBeNull();
        expect(previewGraph?.querySelectorAll("[data-oaam-preview-entry-kind]")).toHaveLength(6);
        expect(previewGraph?.querySelector(".preview-detail")).toBeNull();
        expect(
            previewGraph
                ?.querySelector(
                    '[data-oaam-preview-entry-kind="directory"]' +
                        '[data-oaam-preview-boundary=".claude/skills/demo"]' +
                        '[data-oaam-preview-path=".claude/skills/demo/scratch"]' +
                        '[data-oaam-preview-baseline-state="unmanaged"]' +
                        '[data-oaam-preview-change-kind="remove_unmanaged"]',
                )
                ?.classList.contains("catalog-preview-directory-row"),
        ).toBe(true);
        expect(screen.getByText("Replace different existing content")).toBeTruthy();
        expect(screen.getByText("Remove an OAAM-managed file")).toBeTruthy();
        expect(screen.getByText("Remove this reviewed existing file")).toBeTruthy();
        expect(previewGraph?.querySelector(".catalog-preview-text-reviews")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "View CLAUDE.md" }));
        expect(unmanaged.clearAssetSelection).toHaveBeenCalledOnce();
        expect(screen.getByRole("complementary", { name: "Files and folders to be changed" })).toBeTruthy();
        expect(screen.getByText("# Existing")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Open current file in a tab" }));
        expect(view.container.querySelector('[data-oaam-preview-text-kind="current"]')?.textContent).toContain("# Existing");
        fireEvent.click(screen.getByRole("button", { name: "Open desired file in a tab" }));
        expect(view.container.querySelector('[data-oaam-preview-text-kind="desired"]')?.textContent).toContain(
            "# Project guidance",
        );
        fireEvent.click(screen.getByRole("button", { name: "Close side preview" }));
        const removedManagedFile = view.container.querySelector(
            '[data-oaam-preview-entry-kind="file"]' +
                '[data-oaam-preview-path="old.bin"]' +
                '[data-oaam-preview-baseline-state="managed"]' +
                '[data-oaam-preview-change-kind="remove_managed"]',
        );
        expect(removedManagedFile?.classList.contains("catalog-preview-file-row")).toBe(true);
        expect(removedManagedFile?.textContent).toMatch(/Desired: missing/u);
        const replace = screen.getByRole("button", { name: "Replace existing files" }) as HTMLButtonElement;
        const replacementDecision = view.container.querySelector('[data-oaam-preview-decision="requires_unmanaged_replacement"]');
        expect(replacementDecision?.contains(replace)).toBe(true);
        expect(replacementDecision?.querySelector('input[type="checkbox"]')).toBeNull();
        expect(replace.disabled).toBe(false);
        replace.focus();
        fireEvent.click(replace);
        expect(unmanaged.deployPreview).not.toHaveBeenCalled();
        const graphDialog = screen.getByRole("dialog", { name: "Apply these file and folder changes?" });
        expect(graphDialog.textContent).toContain("/workspace/oaam");
        expect(graphDialog.querySelector('[data-oaam-reviewed-relative-path="scratch.txt"]')?.textContent).toContain(
            "Remove this reviewed existing file",
        );
        expect(graphDialog.querySelector(".catalog-replacement-subject")?.textContent).toContain("/workspace/oaam");
        expect(graphDialog.querySelector(".catalog-replacement-review .catalog-replacement-subject")).toBeNull();
        expect(graphDialog.querySelector(".catalog-replacement-paths li")?.getAttribute("data-oaam-reviewed-relative-path")).toBe(
            "CLAUDE.md",
        );
        const unchanged = graphDialog.querySelector<HTMLDetailsElement>(".catalog-replacement-unchanged")!;
        expect(unchanged.open).toBe(false);
        fireEvent.click(unchanged.querySelector("summary")!);
        expect(unchanged.open).toBe(true);
        expect(unchanged.querySelector('[data-oaam-reviewed-relative-path=".claude/skills/demo/retained"]')).not.toBeNull();
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1) as HTMLElement);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(replace);
        expect(unmanaged.deployPreview).not.toHaveBeenCalled();
        fireEvent.click(replace);
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(unmanaged.deployPreview).not.toHaveBeenCalled();
        fireEvent.click(replace);
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0] as HTMLElement);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(unmanaged.deployPreview).not.toHaveBeenCalled();
        fireEvent.click(replace);
        fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
        expect(unmanaged.deployPreview).toHaveBeenCalledWith("replace_unmanaged");
        expect(unmanaged.deployPreview).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("dialog")).toBeNull();
        view.unmount();

        const blocked = presentationController(
            readyState({
                status: "ready",
                value: {
                    ...RENDER_PREVIEW,
                    actionState: "blocked_managed_conflict",
                    files: [
                        {
                            ...RENDER_PREVIEW.files[0],
                            baselineState: "managed",
                            changeKind: "managed_conflict",
                        },
                    ],
                },
            }),
        );
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: blocked,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        expect(screen.getByText(/Managed content has changed/u)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Apply the selected OAAM version" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Replace existing files" })).toBeNull();
    });

    it.each([
        "stale",
        "reconciliation",
        "new_preview",
        "preview_failed",
    ] as const)("dismisses replacement confirmation without mutation when the review becomes %s", (change) => {
        const initial = readyState({
            status: "ready",
            value: { ...RENDER_PREVIEW, actionState: "requires_unmanaged_replacement" },
        });
        const controller = presentationController(initial);
        const props = {
            controller,
            probeReview: undefined,
            subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
            providers: DEPLOYMENT_PROVIDERS,
        };
        const view = renderWithPresentation(createElement(CatalogDeploymentWorkspace, props));
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        fireEvent.click(screen.getByRole("button", { name: "Replace existing files" }));
        expect(screen.getByRole("dialog")).toBeTruthy();
        const changed = presentationController({
            ...initial,
            ...(change === "stale" ? { stale: true } : {}),
            ...(change === "reconciliation" ? { requiresReconciliation: true } : {}),
            ...(change === "new_preview"
                ? {
                      preview: {
                          status: "ready" as const,
                          value: {
                              ...RENDER_PREVIEW,
                              actionState: "requires_unmanaged_replacement" as const,
                              previewToken: "new-exact-preview",
                          },
                      },
                  }
                : {}),
            ...(change === "preview_failed"
                ? {
                      preview: {
                          status: "failed" as const,
                          deploymentId: DEPLOYMENT_ID,
                          failureKind: "preview.operation_failed" as const,
                          message: localizedText("catalog.preview.failed"),
                      },
                  }
                : {}),
        } as CatalogDeploymentState);
        view.rerender(createElement(CatalogDeploymentWorkspace, { ...props, controller: changed }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(controller.deployPreview).not.toHaveBeenCalled();
        expect(changed.deployPreview).not.toHaveBeenCalled();
        if (change === "stale" || change === "reconciliation") {
            expect((screen.getByRole("button", { name: "Replace existing files" }) as HTMLButtonElement).disabled).toBe(true);
        }
    });
});
