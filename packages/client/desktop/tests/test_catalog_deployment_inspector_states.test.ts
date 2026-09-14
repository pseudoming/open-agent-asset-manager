import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogAssetVersionInspector } from "../src/renderer/features/catalog-deployment/CatalogAssetVersionInspector";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import { deploymentTargetSemanticKey } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, INSPECTION, PROBE_REVIEW } from "./catalog-deployment-test-fixtures";
import {
    ASSET_DETAIL,
    ASSET_ID,
    DEPLOYMENT_ID,
    fakeController,
    PROJECT_ID,
    readyState,
    VERSION,
} from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

function projectUnreadyProbeReview(): typeof PROBE_REVIEW {
    return {
        ...PROBE_REVIEW,
        results: PROBE_REVIEW.results.map((result) => ({
            ...result,
            targets: result.targets
                .filter((target) => target.rowId === "unready-target")
                .map((target) => ({
                    ...target,
                    targetKind: "project" as const,
                    displayPath: "/workspace/oaam",
                    entryApplicabilities: [
                        {
                            agentRuntimeId: "CLAUDE_CODE_CLI" as const,
                            status: "invalid" as const,
                            diagnostics: [],
                        },
                    ],
                })),
        })),
    };
}

afterEach(() => {
    cleanup();
});

describe("Desktop catalog and deployment workspace detail states", () => {
    it("renders exact current-Version content in the native right inspector", () => {
        const resourceFile = {
            ...VERSION.files[0],
            fileId: "88888888-8888-4888-8888-888888888888",
            logicalPath: "docs/guide.md",
            role: "resource" as const,
        };
        const multiFileVersion = { ...VERSION, files: [...VERSION.files, resourceFile] };
        const detail = {
            status: "ready" as const,
            asset: ASSET_DETAIL,
            version: multiFileVersion,
            preview: {
                status: "ready" as const,
                logicalPath: "AGENTS.md",
                preview: {
                    previewKind: "text" as const,
                    file: VERSION.files[0],
                    text: "# Project guidance\n",
                    lineCount: 2,
                },
                textPages: [],
                hasMoreText: false,
            },
        };
        const controller = fakeController(readyState({ assetDetail: detail }));
        const view = renderWithPresentation(createElement(CatalogAssetVersionInspector, { controller, detail }));

        const inspector = screen.getByLabelText("Current Asset Version");
        expect(inspector.classList.contains("asset-inspector")).toBe(true);
        expect(screen.getByRole("heading", { name: "Project guidance" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "File source with line numbers" })).not.toBeNull();
        expect(view.container.querySelectorAll(".import-preview-line-number")).toHaveLength(2);
        expect(view.container.querySelector(".compact-list")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "docs/guide.md" }));
        expect(controller.selectAssetFile).toHaveBeenCalledWith("docs/guide.md");

        const pagedDetail = { ...detail, preview: { ...detail.preview, hasMoreText: true, nextTextCursor: "next-page" } };
        view.rerender(createElement(CatalogAssetVersionInspector, { controller, detail: pagedDetail }));
        fireEvent.click(screen.getByRole("button", { name: "Load the next text page" }));
        expect(controller.loadMoreAssetText).toHaveBeenCalledTimes(1);

        const waitingDetail = { ...detail, preview: { status: "none" as const } };
        view.rerender(createElement(CatalogAssetVersionInspector, { controller, detail: waitingDetail }));
        expect(screen.getByText("Reading the selected file safely…")).toBeTruthy();

        const emptyDetail = { ...detail, version: { ...VERSION, files: [] }, preview: { status: "none" as const } };
        view.rerender(createElement(CatalogAssetVersionInspector, { controller, detail: emptyDetail }));
        expect(screen.getByText("This Version contains no files.")).toBeTruthy();

        const loadingDetail = { status: "loading" as const, assetId: ASSET_ID };
        view.rerender(createElement(CatalogAssetVersionInspector, { controller, detail: loadingDetail }));
        expect(screen.getByText("Loading exact Version metadata…")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(controller.clearAssetSelection).toHaveBeenCalledTimes(1);
    });

    it("shows unready targets and loading inspection/detail states without enabling unsafe actions", () => {
        const controller = fakeController(
            readyState({
                assetDetail: { status: "loading", assetId: ASSET_ID },
                analysis: { status: "loading", deploymentId: DEPLOYMENT_ID },
                inspection: { status: "loading", deploymentId: DEPLOYMENT_ID },
            }),
        );
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                providers: DEPLOYMENT_PROVIDERS,
                probeReview: {
                    ...PROBE_REVIEW,
                    results: PROBE_REVIEW.results.map((result) => ({
                        ...result,
                        targets: result.targets.map((target) =>
                            target.rowId === "unready-target"
                                ? { ...target, targetKind: "project" as const, displayPath: "/workspace/oaam" }
                                : target,
                        ),
                    })),
                },
                subject: { subjectKind: "project", projectId: PROJECT_ID },
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        expect(screen.getByText("Waiting for render analysis…")).toBeTruthy();
        expect(screen.getByText("Inspecting deployed file changes…")).toBeTruthy();
        view.unmount();

        const readyTargetKey = deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate");
        const usageView = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: fakeController(
                    readyState({
                        assetUsage: {
                            status: "ready",
                            requestKey: "usage-ready",
                            targets: [
                                {
                                    targetKey: readyTargetKey,
                                    status: "ready",
                                    usage: {
                                        schemaVersion: 2,
                                        assetId: ASSET_ID,
                                        versionId: VERSION.versionId,
                                        relationships: [
                                            {
                                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                                capability: "direct",
                                                observedTargetState: "absent",
                                                managedState: "none",
                                                substitute: null,
                                                deploymentIds: [],
                                                appliedDeploymentIds: [],
                                                degradationKinds: [],
                                                reasonCodes: ["test_direct"],
                                                diagnostics: [],
                                                requiresReview: false,
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    }),
                ),
                providers: DEPLOYMENT_PROVIDERS,
                probeReview: projectUnreadyProbeReview(),
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                initialAssetId: ASSET_ID,
            }),
        );
        const unreadyRow = [...usageView.container.querySelectorAll(".asset-usage-row")].find((row) =>
            row.textContent?.includes("Unverified directory"),
        );
        expect(unreadyRow).toBeDefined();
        expect(unreadyRow?.textContent).toContain("Current check unavailable");
        expect(unreadyRow?.textContent).toContain("Check the tools again to refresh this result.");
        expect(
            [...(unreadyRow?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("data-oaam-action")),
        ).toEqual(["select_existing_usage"]);
        expect(within(unreadyRow as HTMLElement).getByRole("button", { name: "Review saved Version" })).toBeTruthy();
        cleanup();

        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: fakeController(
                    readyState({
                        inspection: {
                            status: "ready",
                            value: { ...INSPECTION, changeCount: 1, conflictCount: 0, detailsTruncated: false },
                            detail: { status: "loading", selector: "semantic-1" },
                        },
                    }),
                ),
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /First deployment available/u }));
        expect(screen.getByText("Loading bounded inspection detail…")).toBeTruthy();
        expect(screen.getByText(/1 change · 0 conflicts/u)).toBeTruthy();
    });
});
