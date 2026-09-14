import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import type {
    CatalogDeploymentController,
    CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import {
    buildAssetUsageAnalysisRequests,
    collectDeploymentTargets,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, PROBE_REVIEW } from "./catalog-deployment-test-fixtures";
import { ASSET, completeAssetUsage, deployment, PROJECT, VERSION_ID } from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
afterEach(cleanup);
function readyState(
    overrides: Partial<Extract<CatalogDeploymentState, { readonly status: "ready" }>> = {},
): Extract<CatalogDeploymentState, { readonly status: "ready" }> {
    return {
        status: "ready",
        projects: [],
        assets: [],
        deployments: [],
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

function stateController(state: CatalogDeploymentState): CatalogDeploymentController {
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
        registerProject: vi.fn(async () => undefined),
        createDeployment: vi.fn(async () => undefined),
        authorizeCurrentVersionForProject: vi.fn(async () => undefined),
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

describe("Current usage and saved deployment review", () => {
    it.each(["in_sync", "conflict"] as const)("keeps saved %s out of the location card across fresh observations", (stage) => {
        for (const targetState of ["different", "unknown", "absent", "already_usable"] as const) {
            const subject = { subjectKind: "project" as const, projectId: PROJECT.projectId };
            const targets = collectDeploymentTargets(PROBE_REVIEW),
                target = targets[0];
            if (target === undefined) throw new Error("Exact Claude target required");
            const applied = deployment(stage);
            const requests = buildAssetUsageAnalysisRequests(subject, targets, {
                assetId: ASSET.assetId,
                versionId: VERSION_ID,
                allowIncomplete: false,
            });
            const requestKey = JSON.stringify(
                requests.map((request) => [
                    request.targetKey,
                    request.params.probeToken,
                    request.params.probeResultRowId,
                    request.params.targetRowId,
                    request.params.consumerAgentRuntimeIds,
                    request.params.asset,
                ]),
            );
            const request = requests.find((item) => item.targetKey === target.key);
            if (request === undefined) throw new Error("Exact usage request required");
            const usage = completeAssetUsage(request.params).value,
                relationship = usage.relationships[0];
            if (relationship === undefined) throw new Error("Exact runtime relationship required");
            const controller = stateController(
                readyState({
                    assets: [ASSET],
                    projects: [PROJECT],
                    deployments: [applied],
                    assetUsage: {
                        status: "ready",
                        requestKey,
                        targets: [
                            {
                                targetKey: target.key,
                                status: "ready",
                                usage: {
                                    ...usage,
                                    relationships: [
                                        {
                                            ...relationship,
                                            observedTargetState: targetState,
                                            managedState: "applied",
                                            deploymentIds: [applied.deploymentId],
                                            appliedDeploymentIds: [applied.deploymentId],
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                }),
            );
            const { container } = renderWithPresentation(
                createElement(CatalogDeploymentWorkspace, {
                    controller,
                    probeReview: PROBE_REVIEW,
                    subject,
                    providers: DEPLOYMENT_PROVIDERS,
                    initialAssetId: ASSET.assetId,
                }),
            );
            const summary = container.querySelector<HTMLButtonElement>(
                '[data-oaam-group-collapsed-summary="true"] .asset-usage-group-summary',
            );
            if (summary !== null) fireEvent.click(summary);
            const open = screen.queryByRole("button", { name: "View usage" });
            if (open !== null) fireEvent.click(open);
            const review = container.querySelector("[data-oaam-create-target-review]");
            expect(review).not.toBeNull();
            expect(review?.querySelector('[data-oaam-application-version-state="current"]')).toBeNull();
            expect(review?.textContent).not.toContain("Matches the current Version. OAAM manages the files here.");
            expect(review?.querySelector("[data-oaam-application-state]")).toBeNull();
            expect(review?.textContent).toContain("Claude Code CLI 2.1.220");
            expect(review?.textContent).toContain("/workspace/oaam");
            expect(controller.deployPreview).not.toHaveBeenCalled();
            cleanup();
        }
    });
});
