import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogAssetVersionInspector } from "../src/renderer/features/catalog-deployment/CatalogAssetVersionInspector";
import { catalogDeploymentMutationIsCurrent } from "../src/renderer/features/catalog-deployment/CatalogDeploymentOutcomeSummary";
import { CatalogActivityTechnicalDetails } from "../src/renderer/features/catalog-deployment/CatalogDeploymentTechnicalDetails";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import { CatalogInspectionDetail } from "../src/renderer/features/catalog-deployment/CatalogInspectionDetail";
import type {
    CatalogDeploymentController,
    CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import type { DeploymentView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { localizedText, technicalText } from "../src/renderer/presentation";
import {
    DEPLOYMENT_PROVIDERS,
    INSPECTION,
    PROBE_REVIEW,
    RENDER_ANALYSIS,
    RENDER_PREVIEW,
} from "./catalog-deployment-test-fixtures";
import { ASSET } from "./catalog-deployment-test-support";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";

const DEPLOYMENT_ID = RENDER_PREVIEW.deploymentId;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPAIR_DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUPPORT_DEPLOYMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEW_DEPLOYMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function deployment(
    deploymentId: string,
    stage: DeploymentView["stage"],
    actionHints: DeploymentView["actionHints"],
    freshness: DeploymentView["freshness"],
): DeploymentView {
    return {
        deploymentId,
        subject: { subjectKind: "project", projectId: "11111111-1111-4111-8111-111111111111" },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        environment: { platform: "linux", platformInstanceId: "local" },
        targetRootPath: "/workspace/oaam",
        stage,
        reason: stage,
        actionHints,
        freshness,
        deleted: false,
        assets: [],
        createdAt: 1,
        updatedAt: 2,
    };
}

function readyState(
    overrides: Partial<Extract<CatalogDeploymentState, { readonly status: "ready" }>> = {},
): Extract<CatalogDeploymentState, { readonly status: "ready" }> {
    return {
        status: "ready",
        projects: [],
        assets: [],
        deployments: [
            deployment(DEPLOYMENT_ID, "in_sync", ["review_deployment"], { state: "never", attemptedAt: 0, lastCompleteAt: 0 }),
            deployment(REPAIR_DEPLOYMENT_ID, "needs_repair", ["review_repair", "check_now"], {
                state: "complete",
                attemptedAt: 2,
                lastCompleteAt: 2,
            }),
        ],
        assetUsage: { status: "none" },
        assetDetail: { status: "none" },
        analysis: { status: "none" },
        preview: { status: "none" },
        inspection: { status: "none" },
        reverse: { status: "none" },
        activity: { status: "idle" },
        stale: false,
        requiresReconciliation: false,
        message: undefined,
        diagnostics: [],
        ...overrides,
    };
}

function fakeController(state: CatalogDeploymentState): CatalogDeploymentController {
    return {
        state,
        subscribe: vi.fn((listener: (next: CatalogDeploymentState) => void) => {
            listener(state);
            return () => undefined;
        }),
        dispose: vi.fn(),
        load: vi.fn(async () => undefined),
        analyzeAssetUsage: vi.fn(async () => undefined),
        preview: vi.fn(async () => undefined),
        clearPreview: vi.fn(),
        overwritePreview: vi.fn(async () => undefined),
        prepareReverse: vi.fn(async () => undefined),
    } as unknown as CatalogDeploymentController;
}

afterEach(cleanup);

describe("Desktop Deployment projection boundaries", () => {
    it("does not present an earlier applied result as current during a new or failed check", () => {
        const current = deployment(DEPLOYMENT_ID, "in_sync", ["check_now"], {
            state: "complete",
            attemptedAt: 2,
            lastCompleteAt: 2,
        });
        const state = readyState({
            deployments: [current],
            completedMutation: { kind: "deploy", deploymentId: DEPLOYMENT_ID, reviewedFilePaths: ["CLAUDE.md"] },
        });
        expect(catalogDeploymentMutationIsCurrent(state, current)).toBe(true);
        expect(
            catalogDeploymentMutationIsCurrent(
                { ...state, activity: { status: "starting", kind: "scan", message: technicalText("Checking") } },
                current,
            ),
        ).toBe(false);
        for (const id of [
            "catalog.operation.failed",
            "catalog.operation.interrupted",
            "catalog.operation.lost_terminal",
        ] as const) {
            expect(catalogDeploymentMutationIsCurrent({ ...state, message: localizedText(id) }, current)).toBe(false);
        }
        expect(catalogDeploymentMutationIsCurrent({ ...state, stale: true }, current)).toBe(false);
        expect(catalogDeploymentMutationIsCurrent({ ...state, requiresReconciliation: true }, current)).toBe(false);
        expect(catalogDeploymentMutationIsCurrent(state, undefined)).toBe(false);
    });

    it("keeps operation identity and raw progress stage outside the ordinary surface", () => {
        const view = renderWithPresentation(
            createElement(CatalogActivityTechnicalDetails, {
                operationId: "operation-technical-id",
                progressStage: "deployment.scan.running",
            }),
        );

        const ordinary = ordinarySurfaceText(view.container);
        expect(ordinary).not.toContain("operation-technical-id");
        expect(ordinary).not.toContain("deployment.scan.running");
        expect(screen.getByText("Operation ID: operation-technical-id")).toBeTruthy();
        expect(screen.getByText("Internal progress stage: deployment.scan.running")).toBeTruthy();
    });

    it("renders file attribution as a human review while retaining exact evidence only in technical details", () => {
        const rawMessage = "Adapter attribution probe returned two owners.";
        const reasonCode = "ambiguous_native_and_shared";
        const view = renderWithPresentation(
            createElement(CatalogInspectionDetail, {
                detail: {
                    inspectionToken: "inspection-token",
                    selector: "file-1",
                    detailKind: "file_attribution",
                    relativePath: "AGENTS.md",
                    attributionState: "conflict",
                    reasonCode,
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "desktop.attribution.fixture",
                            operation: "deploy",
                            causeKind: "conflict",
                            retryable: false,
                            suggestedActions: ["choose_target"],
                            message: rawMessage,
                        },
                    ],
                },
            }),
        );

        const ordinary = ordinarySurfaceText(view.container);
        expect(ordinary).toContain("File: AGENTS.md");
        expect(ordinary).toContain("This file cannot be attributed safely");
        expect(ordinary).not.toContain(rawMessage);
        expect(ordinary).not.toContain(reasonCode);
        expect(ordinary).not.toContain("inspection-token");
        expect(ordinary).not.toContain("file-1");
        expect(screen.getByText(`Original detail: ${rawMessage}`)).toBeTruthy();
        expect(screen.getByText(`Internal reason: ${reasonCode}`)).toBeTruthy();
    });

    it("renders analysis and inspection state only for the selected Deployment", async () => {
        const initial = fakeController(
            readyState({
                analysis: {
                    status: "failed",
                    deploymentId: DEPLOYMENT_ID,
                    message: technicalText("Analysis unavailable."),
                },
                inspection: {
                    status: "failed",
                    deploymentId: DEPLOYMENT_ID,
                    message: technicalText("Inspection unavailable."),
                },
                stale: true,
                requiresReconciliation: true,
                message: technicalText("Refresh required."),
            }),
        );
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: initial,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /Some managed files can be restored/u }));
        expect(screen.queryByText("Analysis unavailable.")).toBeNull();
        expect(screen.queryByText("Inspection unavailable.")).toBeNull();
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        expect(screen.getByText("Analysis unavailable.")).toBeTruthy();
        expect(screen.getByText("Inspection unavailable.")).toBeTruthy();

        view.rerender(
            createElement(CatalogDeploymentWorkspace, {
                controller: fakeController(
                    readyState({
                        activity: {
                            status: "progress",
                            kind: "recover",
                            operationId: "operation-1",
                            completedUnits: 1,
                            totalUnits: 2,
                            message: technicalText("recovering"),
                        },
                        stale: true,
                        requiresReconciliation: true,
                        message: technicalText("Refresh required."),
                    }),
                ),
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        await waitFor(() => expect(screen.getByText("recovering (1/2)")).toBeTruthy());
        expect(screen.getByText(/lost the final result of a change/u)).toBeTruthy();
        expect(screen.getByText("Refresh required.")).toBeTruthy();
    });

    it("projects one physical output once and auto-selects only singleton strategies", async () => {
        const secondSemanticFingerprint = "d".repeat(64);
        const secondOptionFingerprint = "e".repeat(64);
        const firstSemantic = RENDER_ANALYSIS.semantics[0];
        const firstOption = RENDER_ANALYSIS.options[0];
        if (firstSemantic === undefined || firstOption === undefined) throw new Error("render fixtures are required");
        const analysis = {
            ...RENDER_ANALYSIS,
            semantics: [
                firstSemantic,
                {
                    ...firstSemantic,
                    semanticRefFingerprint: secondSemanticFingerprint,
                    semanticKind: "guidance.base_context" as const,
                },
            ],
            options: [
                firstOption,
                {
                    ...firstOption,
                    semanticRefFingerprint: secondSemanticFingerprint,
                    optionFingerprint: secondOptionFingerprint,
                },
            ],
        };
        const current = {
            ...deployment(DEPLOYMENT_ID, "in_sync", ["review_deployment"], {
                state: "never" as const,
                attemptedAt: 0,
                lastCompleteAt: 0,
            }),
            assets: [{ assetId: ASSET.assetId, versionId: ASSET.currentVersionId, allowIncomplete: false }],
        };
        const controller = fakeController(
            readyState({
                assets: [ASSET],
                deployments: [current],
                analysis: { status: "ready", value: analysis },
            }),
        );
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET.assetId,
            }),
        );

        await waitFor(() =>
            expect(view.container.querySelectorAll('[data-oaam-render-option-auto-selected="true"]')).toHaveLength(2),
        );
        expect(screen.queryByRole("radio", { name: "Native file" })).toBeNull();
        expect(screen.getAllByText("Future edit handling: Future edits can be attributed and reviewed")).toHaveLength(1);
        expect(view.container.querySelector("[data-oaam-render-passive-summary]")).not.toBeNull();
        expect(view.container.querySelector("[data-oaam-render-passive-summary] h4")).toBeNull();
        expect(
            screen.getByText("The file plan is ready. Review the current and proposed files before applying it."),
        ).toBeTruthy();
        expect(
            screen.queryByText(
                "Choose how each item should be added. OAAM will show the latest target files before writing anything.",
            ),
        ).toBeNull();
        expect(view.container.querySelectorAll("[data-oaam-passive-semantic-kind]")).toHaveLength(2);
        expect(screen.getByText("Instructions")).toBeTruthy();
        expect(screen.getByText("Project context")).toBeTruthy();
        expect(screen.getAllByText("CLAUDE.md · text")).toHaveLength(1);
        expect(screen.getAllByText("bin/helper · binary · executable")).toHaveLength(1);
        expect(screen.getAllByText("Managed directory: .claude/skills")).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: "Review files before applying" }));
        expect(controller.preview).toHaveBeenCalledWith(
            DEPLOYMENT_ID,
            expect.arrayContaining([
                expect.objectContaining({ semanticRefFingerprint: firstSemantic.semanticRefFingerprint }),
                expect.objectContaining({ semanticRefFingerprint: secondSemanticFingerprint }),
            ]),
        );
    });

    it.each([
        ["never", 0, false],
        ["partial", 2, false],
        ["complete", 2, true],
    ] as const)("uses result copy only for a complete applied observation, not %s", async (freshness, checkedAt, applied) => {
        const current = {
            ...deployment(DEPLOYMENT_ID, "in_sync", ["check_now"], {
                state: freshness,
                attemptedAt: checkedAt,
                lastCompleteAt: applied ? checkedAt : 0,
            }),
            assets: [{ assetId: ASSET.assetId, versionId: ASSET.currentVersionId, allowIncomplete: false }],
        };
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: fakeController(readyState({ assets: [ASSET], deployments: [current] })),
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET.assetId,
            }),
        );
        await waitFor(() => expect(view.container.querySelector(".deployment-create-target-summary")).not.toBeNull());
        expect(view.container.querySelector("#deployment-title")?.textContent).toBe(
            applied ? "Selected tool location" : "Review file changes",
        );
        const badge = view.container.querySelector(".deployment-create-target-summary [data-oaam-application-state]");
        expect(badge).toBeNull();
        expect(
            screen.queryByText(
                "Check the exact conversion and files for this one location. Nothing is written until you approve the preview.",
            ) !== null,
        ).toBe(!applied);
    });

    it("renders bounded Asset failure state truthfully", () => {
        const detail = {
            status: "failed" as const,
            assetId: "22222222-2222-4222-8222-222222222222",
            message: technicalText("Asset unavailable."),
        };
        renderWithPresentation(
            createElement(CatalogAssetVersionInspector, {
                controller: fakeController(readyState({ assetDetail: detail })),
                detail,
            }),
        );
        expect(screen.getByText("Asset unavailable.")).toBeTruthy();
    });

    it("projects Core-owned status and freshness while requiring exact conflict authorization", () => {
        const beforeInspection = fakeController(
            readyState({
                deployments: [
                    deployment(DEPLOYMENT_ID, "conflict", [], {
                        state: "complete",
                        attemptedAt: 4,
                        lastCompleteAt: 4,
                    }),
                ],
                preview: {
                    status: "ready",
                    value: { ...RENDER_PREVIEW, actionState: "blocked_managed_conflict" },
                },
            }),
        );
        const beforeView = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: beforeInspection,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /External changes found/u }));
        const withoutInspection = screen.getByRole("button", { name: "Apply the selected OAAM version" });
        expect((withoutInspection as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(withoutInspection);
        fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
        expect(beforeInspection.overwritePreview).toHaveBeenCalledOnce();
        expect(beforeInspection.state.inspection.status).toBe("none");
        beforeView.unmount();

        const controller = fakeController(
            readyState({
                deployments: [
                    deployment(DEPLOYMENT_ID, "conflict", ["review_external_changes", "check_now"], {
                        state: "failed",
                        attemptedAt: 4,
                        lastCompleteAt: 2,
                    }),
                    deployment(SUPPORT_DEPLOYMENT_ID, "blocked", ["contact_support"], {
                        state: "in_progress",
                        attemptedAt: 4,
                        lastCompleteAt: 0,
                    }),
                    deployment(REVIEW_DEPLOYMENT_ID, "blocked", [], { state: "partial", attemptedAt: 4, lastCompleteAt: 2 }),
                ],
                preview: {
                    status: "ready",
                    value: { ...RENDER_PREVIEW, actionState: "blocked_managed_conflict" },
                },
                inspection: {
                    status: "ready",
                    value: { ...INSPECTION, conflictCount: 0 },
                    detail: { status: "none" },
                },
                diagnostics: [
                    {
                        severity: "warning",
                        code: "desktop.deployment.fixture",
                        operation: "deploy",
                        causeKind: "conflict",
                        retryable: false,
                        suggestedActions: ["choose_target"],
                        message: "Raw deployment warning.",
                    },
                ],
            }),
        );
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );

        expect(screen.getByText(/Last check failed/u)).toBeTruthy();
        expect(screen.getByText(/Checking since/u)).toBeTruthy();
        expect(screen.getByText(/Last check was partial/u)).toBeTruthy();
        const deploymentEntries = view.container.querySelectorAll("[data-oaam-deployment-entry]");
        expect(deploymentEntries).toHaveLength(3);
        for (const entry of deploymentEntries) {
            expect(entry.querySelector(".deployment-list-metadata .deployment-list-freshness")).not.toBeNull();
        }
        const ordinary = ordinarySurfaceText(view.container);
        expect(ordinary).toContain("Claude Code CLI");
        expect(ordinary).toContain("Local Linux");
        expect(ordinary).not.toContain("CLAUDE_CODE_CLI");
        expect(ordinary).not.toContain(DEPLOYMENT_ID);
        expect(ordinary).not.toContain("Raw deployment warning.");
        expect(screen.getByText("Original detail: Raw deployment warning.")).toBeTruthy();

        fireEvent.click(screen.getByRole("radio", { name: /Support is required/u }));
        expect(screen.getByText(/Preserve the inspection result and contact support/u)).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: /This tool setup needs review/u }));
        fireEvent.click(screen.getByRole("radio", { name: /External changes found/u }));

        expect(
            screen.getByText("Managed content has changed. Review this version and confirm replacement to apply it."),
        ).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();

        const previewDecision = view.container.querySelector('[data-oaam-preview-decision="blocked_managed_conflict"]');
        const inspectionNavigation = view.container.querySelector(".inspection-detail-navigation");
        const inspectionDecisions = view.container.querySelector(".inspection-decision-group");
        expect(previewDecision).not.toBeNull();
        expect(inspectionNavigation?.querySelectorAll(".inspection-detail-actions button")).toHaveLength(
            INSPECTION.details.length,
        );
        expect(inspectionDecisions?.querySelector('[data-oaam-deployment-action="repair"]')).toBeNull();
        expect(inspectionDecisions?.querySelector('[data-oaam-deployment-action="reverse.prepare"]')).not.toBeNull();

        const overwrite = screen.getByRole("button", { name: "Apply the selected OAAM version" });
        expect((overwrite as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(overwrite);
        expect(controller.overwritePreview).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: "Restore the reviewed OAAM files?" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
        expect(controller.overwritePreview).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Review changes from the tool" }));
        expect(controller.prepareReverse).toHaveBeenCalled();

        fireEvent.click(overwrite);
        expect(screen.getByRole("dialog")).toBeTruthy();
        view.rerender(
            createElement(CatalogDeploymentWorkspace, {
                controller: fakeController(
                    readyState({
                        deployments: controller.state.deployments,
                        preview: {
                            status: "ready",
                            value: {
                                ...RENDER_PREVIEW,
                                actionState: "blocked_managed_conflict",
                                previewToken: "replacement-preview-token",
                            },
                        },
                        inspection: {
                            status: "ready",
                            value: { ...INSPECTION, inspectionToken: "replacement-inspection-token" },
                            detail: { status: "none" },
                        },
                    }),
                ),
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(controller.overwritePreview).toHaveBeenCalledTimes(1);
        expect((screen.getByRole("button", { name: "Apply the selected OAAM version" }) as HTMLButtonElement).disabled).toBe(
            false,
        );
    });
});
