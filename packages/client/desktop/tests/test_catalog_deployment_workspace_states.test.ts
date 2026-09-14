import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDeploymentCreateReview } from "../src/renderer/features/catalog-deployment/CatalogAssetUsageRelationships";
import { CatalogDeploymentTargetEmptyState } from "../src/renderer/features/catalog-deployment/CatalogDeploymentTargetEmptyState";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import type {
    CatalogDeploymentController,
    CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import {
    type AssetSummaryView,
    buildAssetUsageAnalysisRequests,
    collectDeploymentTargets,
    type DeploymentView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { localizedText, technicalText } from "../src/renderer/presentation";
import {
    COMMITTED_REVERSE,
    DEPLOYMENT_PROVIDERS,
    PROBE_REVIEW,
    RENDER_ANALYSIS,
    RENDER_PREVIEW,
} from "./catalog-deployment-test-fixtures";
import {
    ASSET,
    completeAssetUsage,
    createController,
    deployment,
    diagnostic,
    fakeCatalogClient,
    PROJECT,
    PROMOTION_GRANT,
    VERSION_ID,
} from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { currentDeployment, readyState, stateController } from "./catalog-deployment-workspace-test-support";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REQUIRED_ANALYSIS = {
    ...RENDER_ANALYSIS,
    promotionAuthorizationInspections: [
        {
            promotionAuthorizationState: "required" as const,
            assetId: ASSET.assetId,
            versionId: VERSION_ID,
            target: { targetKind: "project" as const, projectId: PROJECT_ID },
            versionOriginAuthorityFingerprint: RENDER_ANALYSIS.renderInputFingerprint,
        },
    ],
};
const AUTHORIZED_ANALYSIS = {
    ...RENDER_ANALYSIS,
    promotionAuthorizationInspections: [
        {
            promotionAuthorizationState: "authorized" as const,
            assetId: ASSET.assetId,
            versionId: VERSION_ID,
            target: { targetKind: "project" as const, projectId: PROJECT_ID },
            versionOriginAuthorityFingerprint: RENDER_ANALYSIS.renderInputFingerprint,
            authorizationSource: "version_target_grant" as const,
            authorityId: PROMOTION_GRANT.promotionGrantId,
            authorityRevision: PROMOTION_GRANT.revision,
            authorityFingerprint: PROMOTION_GRANT.grantFingerprint,
        },
    ],
};
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const AUTHORIZATION_IDENTITY = { assetId: ASSET.assetId, versionId: VERSION_ID, projectId: PROJECT_ID } as const;

function claudeTarget() {
    const target = collectDeploymentTargets(PROBE_REVIEW)[0];
    if (target === undefined) throw new Error("Claude target is required");
    return target;
}

async function preparedAuthorizationController(overrides: NonNullable<Parameters<typeof fakeCatalogClient>[0]> = {}) {
    const controller = createController(
        fakeCatalogClient({
            analyzeDeployment: vi.fn(async () => ({ status: "complete", value: REQUIRED_ANALYSIS, diagnostics: [] })),
            ...overrides,
        }).client,
    );
    await controller.load();
    await controller.analyze(RENDER_ANALYSIS.deploymentId);
    return controller;
}

async function authorize(controller: CatalogDeploymentController, target = claudeTarget()) {
    await controller.authorizeCurrentVersionForProject(AUTHORIZATION_IDENTITY, RENDER_ANALYSIS.deploymentId, target);
}

function denseAssetChoices(): readonly AssetSummaryView[] {
    return Array.from({ length: 15 }, (_, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        return {
            assetId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
            kind: index % 2 === 0 ? "Guidance" : "Skill",
            scope: index % 3 === 0 ? "project" : "global",
            ...(index % 3 === 0 ? { projectId: PROJECT_ID } : {}),
            scopePath: "",
            displayName: index === 4 || index === 5 ? "Repeated display name" : `Asset ${String(index + 1)}`,
            displayDescription: "Selection fixture",
            currentVersionId: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
            currentRevision: 1,
            currentFingerprint: "a".repeat(64),
            currentVersionStatus: "complete",
            deleted: false,
            createdAt: index + 1,
            updatedAt: index + 2,
        } satisfies AssetSummaryView;
    });
}

afterEach(cleanup);

describe("Desktop catalog and deployment workspace terminal states", () => {
    it.each(["asset", "manage"])("keeps Project permission ahead of preview and current diagnostics in %s", (entry) => {
        const requiredAnalysis = { ...REQUIRED_ANALYSIS, options: REQUIRED_ANALYSIS.options.slice(0, 1) };
        const authorizedAnalysis = { ...AUTHORIZED_ANALYSIS, options: AUTHORIZED_ANALYSIS.options.slice(0, 1) };
        const initial = readyState({
            assets: [ASSET],
            projects: [PROJECT],
            deployments: [deployment("in_sync", true)],
            analysis: { status: "ready", value: requiredAnalysis },
        });
        const controller = stateController(initial);
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: entry === "asset" ? ASSET.assetId : undefined,
            }),
        );
        if (entry === "manage") fireEvent.click(screen.getByRole("radio", { name: /Project guidance/u }));
        fireEvent.click(screen.getByRole("button", { name: "Allow this Version for the current Project" }));
        expect(controller.authorizeCurrentVersionForProject).toHaveBeenCalledWith(
            AUTHORIZATION_IDENTITY,
            RENDER_ANALYSIS.deploymentId,
            claudeTarget(),
        );
        expect(view.container.querySelector('[data-oaam-deployment-action="preview"]')).toBeNull();
        const publish = vi.mocked(controller.subscribe).mock.calls[0]?.[0];
        if (publish === undefined) throw new Error("workspace subscription is required");
        act(() =>
            publish({
                ...initial,
                analysis: {
                    status: "ready",
                    value: {
                        ...requiredAnalysis,
                        promotionAuthorizationInspections: requiredAnalysis.promotionAuthorizationInspections.map(
                            (inspection) => ({
                                ...inspection,
                                promotionAuthorizationState: "unavailable",
                            }),
                        ),
                    },
                },
            }),
        );
        expect(
            screen.getByText("OAAM could not check whether this Version is allowed. Try again before continuing."),
        ).toBeTruthy();
        expect(view.container.querySelector('[data-oaam-deployment-action="preview"]')).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(controller.analyze).toHaveBeenCalledWith(RENDER_ANALYSIS.deploymentId);
        act(() => publish({ ...initial, analysis: { status: "ready", value: authorizedAnalysis } }));
        const preview = view.container.querySelector<HTMLButtonElement>('[data-oaam-deployment-action="preview"]');
        if (preview === null) throw new Error("authorized preview is required");
        fireEvent.click(preview);
        expect(controller.preview).toHaveBeenCalled();
        act(() =>
            publish({
                ...initial,
                analysis: { status: "ready", value: authorizedAnalysis },
                preview: {
                    status: "failed",
                    deploymentId: RENDER_ANALYSIS.deploymentId,
                    failureKind: "preview.operation_failed",
                    message: technicalText("Could not prepare this location"),
                },
                diagnostics: [diagnostic("The selected Project permission changed")],
            }),
        );
        expect(screen.getByText("Could not prepare this location")).toBeTruthy();
        expect(view.container.querySelector('[data-oaam-operation-state="preview_failed"]')?.textContent).toContain(
            "The selected Project permission changed",
        );
    });

    it("continues from an applied result to the same managed deployment after checking outside changes", () => {
        const applied = currentDeployment();
        const state = readyState({
            assets: [ASSET],
            projects: [PROJECT],
            deployments: [applied],
            completedMutation: { kind: "deploy", deploymentId: applied.deploymentId, reviewedFilePaths: ["guide/SKILL.md"] },
        });
        const controller = stateController(state);
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET.assetId,
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Check file status" }));
        expect(controller.scan).toHaveBeenCalledWith(applied.deploymentId);
        const publish = vi.mocked(controller.subscribe).mock.calls[0]?.[0];
        if (publish === undefined) throw new Error("workspace subscription is required");
        const changed: DeploymentView = {
            ...applied,
            stage: "conflict",
            reason: "external_changes",
            actionHints: ["review_external_changes"],
        };
        act(() => publish({ ...state, completedMutation: undefined, deployments: [changed] }));
        fireEvent.click(screen.getByRole("button", { name: "Review outside changes" }));
        expect(controller.inspect).toHaveBeenCalledWith(applied.deploymentId);
        expect(controller.createDeployment).not.toHaveBeenCalled();
    });

    it("shows the applied result and restores preparation for another tool, stale or failed results and a changed target", () => {
        const deployment = currentDeployment();
        const completedMutation = {
            kind: "deploy" as const,
            deploymentId: deployment.deploymentId,
            reviewedFilePaths: ["guide/SKILL.md", "guide/resources/example.txt"],
        };
        const appliedState = readyState({
            assets: [ASSET],
            projects: [PROJECT],
            deployments: [deployment],
            completedMutation,
        });
        const controller = stateController(appliedState);
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET.assetId,
            }),
        );
        expect(screen.queryByRole("heading", { name: "Selected Asset" })).toBeNull();
        const outcome = view.container.querySelector("[data-oaam-deployment-result='deploy']");
        expect(outcome?.textContent).toContain("Location: /workspace/oaam");
        expect(outcome?.textContent).toContain("Files match the Version selected for this tool.");
        const fileList = outcome?.querySelector("[data-oaam-result-files]");
        const files = fileList?.closest("details");
        expect(files?.open).toBe(false);
        const fileSummary = files?.querySelector("summary");
        if (fileSummary === undefined || fileSummary === null) throw new Error("file summary is required");
        expect(fileSummary.textContent).toBe("2 files");
        fireEvent.click(fileSummary);
        expect(files?.open).toBe(true);
        expect(fileList?.querySelectorAll("li")).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "Check file status" }));
        expect(controller.scan).toHaveBeenCalledWith(deployment.deploymentId);
        fireEvent.click(screen.getByRole("button", { name: "Use with another tool" }));
        expect(screen.getByRole("heading", { name: "Selected Asset" })).toBeTruthy();
        expect(controller.createDeployment).not.toHaveBeenCalled();

        const publish = vi.mocked(controller.subscribe).mock.calls[0]?.[0];
        if (publish === undefined) throw new Error("workspace subscription is required");
        act(() => publish({ ...appliedState, completedMutation: { ...completedMutation } }));
        expect(screen.queryByRole("heading", { name: "Selected Asset" })).toBeNull();
        act(() => publish({ ...appliedState, stale: true }));
        expect(screen.getByRole("heading", { name: "Selected Asset" })).toBeTruthy();
        expect(view.container.querySelector("[data-oaam-deployment-result='deploy']")).toBeNull();
        act(() => publish({ ...appliedState, message: localizedText("catalog.operation.failed") }));
        expect(screen.getByRole("heading", { name: "Selected Asset" })).toBeTruthy();
        expect(view.container.querySelector("[data-oaam-deployment-result='deploy']")).toBeNull();
        act(() =>
            publish({ ...appliedState, deployments: [{ ...deployment, deploymentId: "99999999-9999-4999-8999-999999999999" }] }),
        );
        expect(screen.getByRole("heading", { name: "Selected Asset" })).toBeTruthy();
        expect(view.container.querySelector("[data-oaam-deployment-result='deploy']")).toBeNull();
    });

    it("offers an exact per-tool installation-folder recovery from a truthful target empty state", () => {
        const environment = { platform: "linux" as const, platformInstanceId: "local" };
        const probeReview = {
            probeToken: "manual-location-probe",
            results: [
                {
                    rowId: "manual-location-result",
                    adapterId: "CLAUDECODE",
                    environment,
                    status: "complete" as const,
                    runtimes: [
                        {
                            rowId: "manual-location-runtime",
                            agentRuntimeId: "CLAUDE_CODE_CLI",
                            versionText: "",
                            installationStatus: "not_found" as const,
                            projectDiscoveryStatus: "not_found" as const,
                            sourceRootRowIds: [],
                            diagnostics: [],
                        },
                    ],
                    sources: [],
                    projects: [],
                    targets: [],
                    diagnostics: [],
                },
            ],
        };
        const chooseInstallationRoot = vi.fn();
        renderWithPresentation(
            createElement(CatalogDeploymentTargetEmptyState, {
                probeReview,
                providers: DEPLOYMENT_PROVIDERS,
                subjectKind: "project",
                installationRootFailureKey: "linux\0local\0CLAUDECODE",
                onChooseInstallationRoot: chooseInstallationRoot,
            }),
        );

        const choose = screen.getByRole("button", { name: "Choose installation folder" });
        fireEvent.click(choose);
        expect(chooseInstallationRoot).toHaveBeenCalledWith("CLAUDECODE", environment);
        expect(screen.getByRole("alert").textContent).toContain("could not verify");
    });

    it("renders loading/failure and supports explicit retry", () => {
        const loading = stateController({ status: "loading", message: technicalText("Loading.") });
        const first = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: loading,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByText("Loading OAAM catalog")).toBeTruthy();
        first.unmount();

        const failed = stateController({ status: "failed", message: technicalText("Unavailable."), diagnostics: [] });
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: failed,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByRole("alert").getAttribute("data-oaam-tone")).toBe("danger");
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(failed.load).toHaveBeenCalled();
    });

    it("renders empty truth for the exact Project subject without registering or scanning anything", () => {
        const controller = stateController(readyState());
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByText(/No tool setup has been saved yet/u).getAttribute("data-oaam-tone")).toBe("empty");
        expect(screen.queryByText(/No Assets are saved yet/u)).toBeNull();
        expect(controller.registerProject).not.toHaveBeenCalled();
    });

    it("shows the committed result and pending read without requiring a long-operation id or recovery", () => {
        const current = currentDeployment();
        const controller = stateController(
            readyState({
                deployments: [current],
                assets: [ASSET],
                projects: [PROJECT],
                stale: true,
                activity: {
                    status: "starting",
                    kind: "reverse_commit",
                    message: localizedText("catalog.activity.reverse_refresh"),
                },
                reverse: {
                    status: "result",
                    deploymentId: current.deploymentId,
                    value: COMMITTED_REVERSE,
                    reviewedFilePaths: ["CLAUDE.md"],
                },
            }),
        );
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        expect(screen.getByText("Refreshing the saved Version and managed location")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
        expect(document.querySelector(".catalog-deployment-workspace")?.getAttribute("aria-busy")).toBe("true");
    });

    it.each([false, true])("keeps saved reverse success visible without Recover when display stale=%s", (stale) => {
        const current = currentDeployment();
        const controller = stateController(
            readyState({
                deployments: [current],
                assets: [ASSET],
                projects: [PROJECT],
                stale,
                reverse: {
                    status: "result",
                    deploymentId: current.deploymentId,
                    value: COMMITTED_REVERSE,
                    reviewedFilePaths: ["CLAUDE.md"],
                },
            }),
        );
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /Up to date/u }));
        expect(document.querySelector("[data-oaam-deployment-result='reverse_committed']")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Reload saved state" }));
        expect(controller.load).toHaveBeenCalledTimes(2);
        expect(controller.recover).not.toHaveBeenCalled();
    });

    it.each([true, false])("shows a partial recovery retry only for its exact location: matching=%s", (matching) => {
        const current = currentDeployment();
        const controller = stateController(
            readyState({
                deployments: [current],
                assets: [ASSET],
                projects: [PROJECT],
                stale: true,
                requiresReconciliation: true,
                pendingRecoveryDeploymentId: matching ? current.deploymentId : "11111111-1111-4111-8111-111111111111",
            }),
        );
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /Up to date/u }));
        const recover = screen.queryByRole("button", { name: "Recover" });
        expect(recover !== null).toBe(matching);
        if (recover) {
            fireEvent.click(recover);
            expect(controller.recover).toHaveBeenCalledWith(current.deploymentId);
        }
    });

    it("keeps terminal reverse retirement reachable when the current Core stage is already in sync", () => {
        const deployment = currentDeployment();
        const controller = stateController(
            readyState({
                deployments: [deployment],
                reverse: {
                    status: "result",
                    deploymentId: deployment.deploymentId,
                    value: COMMITTED_REVERSE,
                    reviewedFilePaths: ["CLAUDE.md"],
                },
                preview: {
                    status: "ready",
                    value: { ...RENDER_PREVIEW, actionState: "blocked_managed_conflict" },
                },
                analysis: { status: "ready", value: RENDER_ANALYSIS },
                assets: [ASSET],
                projects: [PROJECT],
                stale: true,
                requiresReconciliation: true,
            }),
        );
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: PROBE_REVIEW,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );

        fireEvent.click(screen.getByRole("radio", { name: /Up to date/u }));
        const outcome = document.querySelector<HTMLElement>("[data-oaam-deployment-result='reverse_committed']");
        expect(outcome?.getAttribute("data-oaam-result-deployment-id")).toBe(deployment.deploymentId);
        expect(outcome?.getAttribute("data-oaam-result-target-key")).not.toBeNull();
        expect(outcome?.getAttribute("data-oaam-result-runtime-ids")).toBe('["CLAUDE_CODE_CLI"]');
        expect(outcome?.getAttribute("data-oaam-result-runtime-versions")).toBe('["2.1.220"]');
        expect(outcome?.getAttribute("data-oaam-result-version-ids")).toBe(JSON.stringify([COMMITTED_REVERSE.version.versionId]));
        expect(outcome?.textContent).toContain("New Version");
        expect(outcome?.textContent).not.toContain("Version 2");
        expect(outcome?.getAttribute("data-oaam-result-file-paths")).toBe('["CLAUDE.md"]');
        expect(screen.getByRole("region", { name: "Project guidance" })).toBe(outcome);
        expect(screen.getByText("Files: CLAUDE.md")).toBeTruthy();
        expect(screen.queryByText(/Inspect the managed file change/u)).toBeNull();
        expect(document.querySelector("[data-oaam-deployment-preview='none']")).not.toBeNull();
        expect(screen.queryByText("Next: Recover")).toBeNull();
        expect(screen.getByText("Last check: Project guidance · Version 2")).toBeTruthy();
        const recover = screen.getByRole("button", { name: "Recover" });
        expect(recover.getAttribute("data-oaam-deployment-action")).toBe("recover");
        expect(recover.classList.contains("library-secondary-button")).toBe(false);
        expect((recover as HTMLButtonElement).disabled).toBe(false);
        expect(screen.getByRole("button", { name: "Check file status" }).classList.contains("library-secondary-button")).toBe(
            true,
        );
        expect(
            screen
                .getByText(/To finish this operation, choose Recover/u)
                .closest("[role='alert']")
                ?.getAttribute("data-oaam-tone"),
        ).toBe("warning");
        expect(screen.queryByText(/lost the final result of a change/u)).toBeNull();
        expect(screen.queryByText(/The library changed while this page was open/u)).toBeNull();
        expect(screen.getAllByText("The new Asset Version was published and selected by this tool setup.")).toHaveLength(1);
        expect(document.querySelector(".render-analysis")).toBeNull();
        const reverseDetails = outcome?.querySelector(".reverse-result-details");
        expect(reverseDetails?.textContent).toContain(COMMITTED_REVERSE.version.versionId);
        expect(reverseDetails?.querySelector(".workbench-technical-fact-owner")?.textContent).toContain(
            "The new Asset Version was published and selected by this tool setup.",
        );
        const disclosure = reverseDetails?.querySelector("details");
        const trigger = disclosure?.querySelector("summary");
        if (disclosure === undefined || disclosure === null || trigger === undefined || trigger === null) {
            throw new Error("reverse result disclosure is missing from its outcome");
        }
        fireEvent.click(trigger);
        expect(disclosure.open).toBe(true);
        expect(document.querySelectorAll(".reverse-result-details")).toHaveLength(1);
        const refresh = screen.getByRole("button", { name: "Reload saved state" });
        expect(refresh.querySelector("[data-oaam-icon='refresh']")).not.toBeNull();
        fireEvent.click(refresh);
        expect(controller.load).toHaveBeenCalledTimes(2);
        fireEvent.click(recover);
        expect(controller.recover).toHaveBeenCalledWith(deployment.deploymentId);
    });

    it("explains durable recovery beside its action and preserves the known location after completion", () => {
        const paused = { ...currentDeployment(), stage: "blocked" as const, actionHints: ["recover"] as const };
        const state = readyState({ deployments: [paused], assets: [ASSET], projects: [PROJECT] });
        const controller = stateController(state);
        const { container } = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /Paused for safety/u }));
        expect(container.querySelector(".deployment-list-metadata")?.textContent).toContain("Location: /workspace/oaam");
        expect(container.querySelector("[data-oaam-recovery-explanation]")?.textContent).toContain(
            "A previous file operation needs recovery.",
        );
        const recover = screen.getByRole("button", { name: "Recover" });
        fireEvent.click(recover);
        expect(controller.recover).toHaveBeenCalledWith(paused.deploymentId);
        expect(controller.analyze).not.toHaveBeenCalled();
        expect(controller.scan).not.toHaveBeenCalled();
        const publish = vi.mocked(controller.subscribe).mock.calls[0]?.[0];
        if (publish === undefined) throw new Error("workspace subscription is required");
        act(() =>
            publish({
                ...state,
                deployments: [currentDeployment()],
                completedMutation: {
                    kind: "recover",
                    deploymentId: paused.deploymentId,
                    reviewedFilePaths: [],
                },
            }),
        );
        const outcome = container.querySelector("[data-oaam-deployment-result='recover']");
        expect(outcome?.textContent).toContain("Recovery complete");
        expect(outcome?.textContent).toContain("Location: /workspace/oaam");
        expect(outcome?.getAttribute("data-oaam-result-files-available")).toBe("false");
        expect(outcome?.querySelector("[data-oaam-result-files]")).toBeNull();
        expect(container.querySelector("[data-oaam-recovery-explanation]")).toBeNull();
        expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
    });

    it("binds an Asset route to one exact current Version without repeating the catalog", async () => {
        const assets = denseAssetChoices();
        const selected = assets[5];
        if (selected === undefined) throw new Error("selected dense fixture Asset is missing");
        const controller = stateController(readyState({ assets }));
        const rendered = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: selected.assetId,
                targetDiscovery: createElement("section", { "data-testid": "target-discovery" }, "Target discovery"),
            }),
        );
        expect(screen.getByRole("heading", { name: `Apply ${selected.displayName} to a tool` })).toBeTruthy();
        expect(screen.getByText("Target discovery")).toBeTruthy();
        expect(screen.getByText(selected.displayName)).toBeTruthy();
        expect(screen.queryByText("Asset 1")).toBeNull();
        expect(screen.queryByRole("checkbox")).toBeNull();
        const preview = screen.getByRole("button", { name: "View current Version" });
        expect(preview.querySelector("[data-oaam-icon='preview']")).not.toBeNull();
        fireEvent.click(preview);
        expect(controller.selectAsset).toHaveBeenCalledWith(selected.assetId);

        const missingController = stateController(readyState());
        rendered.rerender(
            createElement(CatalogDeploymentWorkspace, {
                controller: missingController,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: selected.assetId,
                targetDiscovery: createElement("section", { "data-testid": "target-discovery" }, "Target discovery"),
            }),
        );
        await waitFor(() => expect(screen.queryByText(selected.displayName)).toBeNull());
    });

    it("opens one applied relationship against its exact target and refreshes reviewable state", () => {
        const target = collectDeploymentTargets(PROBE_REVIEW)[0];
        if (target === undefined) throw new Error("Claude target is required");
        const applied = deployment("in_sync", true);
        const usage = completeAssetUsage({
            probeToken: target.probeToken,
            probeResultRowId: target.probeResultRowId,
            targetRowId: target.targetRowId,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            asset: { assetId: ASSET.assetId, versionId: VERSION_ID, allowIncomplete: false },
        }).value;
        const relationship = usage.relationships[0];
        if (relationship === undefined) throw new Error("Claude relationship is required");
        const controller = stateController(
            readyState({
                assets: [ASSET],
                projects: [PROJECT],
                deployments: [applied],
                assetUsage: {
                    status: "ready",
                    requestKey: "applied-relationship",
                    targets: [
                        {
                            targetKey: target.key,
                            status: "ready",
                            usage: {
                                ...usage,
                                relationships: [
                                    {
                                        ...relationship,
                                        observedTargetState: "already_usable",
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
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET.assetId,
            }),
        );
        const relationshipSummary = container.querySelector<HTMLButtonElement>(
            '[data-oaam-group-collapsed-summary="true"] .asset-usage-group-summary',
        );
        if (relationshipSummary === null) throw new Error("relationship summary is required");
        fireEvent.click(relationshipSummary);
        fireEvent.click(screen.getByRole("button", { name: "View usage" }));
        expect(controller.analyze).toHaveBeenCalledWith(applied.deploymentId);
    });

    it("opens an exact in-sync relationship without publishing a contradictory state or write", () => {
        const target = collectDeploymentTargets(PROBE_REVIEW)[0];
        if (target === undefined) throw new Error("Claude target is required");
        const applied = deployment("in_sync");
        const usage = completeAssetUsage({
            probeToken: target.probeToken,
            probeResultRowId: target.probeResultRowId,
            targetRowId: target.targetRowId,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            asset: { assetId: ASSET.assetId, versionId: VERSION_ID, allowIncomplete: false },
        }).value;
        const relationship = usage.relationships[0];
        if (relationship === undefined) throw new Error("Claude relationship is required");
        const controller = stateController(
            readyState({
                assets: [ASSET],
                projects: [PROJECT],
                deployments: [applied],
                assetUsage: {
                    status: "ready",
                    requestKey: JSON.stringify(
                        buildAssetUsageAnalysisRequests(
                            { subjectKind: "project", projectId: PROJECT_ID },
                            collectDeploymentTargets(PROBE_REVIEW),
                            { assetId: ASSET.assetId, versionId: VERSION_ID, allowIncomplete: false },
                        ).map(({ targetKey, params }) => [
                            targetKey,
                            params.probeToken,
                            params.probeResultRowId,
                            params.targetRowId,
                            params.consumerAgentRuntimeIds,
                            params.asset,
                        ]),
                    ),
                    targets: [
                        {
                            targetKey: target.key,
                            status: "ready",
                            usage: {
                                ...usage,
                                relationships: [
                                    {
                                        ...relationship,
                                        observedTargetState: "already_usable",
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
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                providers: DEPLOYMENT_PROVIDERS,
                initialAssetId: ASSET.assetId,
            }),
        );
        const relationshipSummary = container.querySelector<HTMLButtonElement>(
            '[data-oaam-group-collapsed-summary="true"] .asset-usage-group-summary',
        );
        if (relationshipSummary === null) throw new Error("relationship summary is required");
        fireEvent.click(relationshipSummary);
        expect(container.querySelector('[data-oaam-selected-deployment-stage="in_sync"]')).not.toBeNull();
        expect(container.querySelector('[data-oaam-application-state="applied"]')).not.toBeNull();
        expect(screen.queryByText("Managed files changed")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "View usage" }));
        expect(screen.getAllByText("Matches the current Version. OAAM manages the files here.")).toHaveLength(1);
        expect(controller.analyze).not.toHaveBeenCalled();
        expect(controller.createDeployment).not.toHaveBeenCalled();
        expect(controller.deployPreview).not.toHaveBeenCalled();
        expect(controller.repair).not.toHaveBeenCalled();
        expect(controller.commitReverse).not.toHaveBeenCalled();
    });

    it("creates one exact current-Project permission and rechecks without applying files", async () => {
        const target = claudeTarget();
        const createPromotionGrant = vi.fn(async () => ({
            status: "complete" as const,
            value: PROMOTION_GRANT,
            diagnostics: [],
        }));
        const analyzeDeployment = vi
            .fn()
            .mockResolvedValueOnce({ status: "complete", value: REQUIRED_ANALYSIS, diagnostics: [] })
            .mockResolvedValueOnce({ status: "complete", value: AUTHORIZED_ANALYSIS, diagnostics: [] });
        const controller = await preparedAuthorizationController({ createPromotionGrant, analyzeDeployment });
        await authorize(controller, target);

        expect(createPromotionGrant).toHaveBeenCalledWith({
            promotionAction: "grant_current_version_current_target",
            assetId: ASSET.assetId,
            versionId: VERSION_ID,
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionId: "user-action",
        });
        expect(analyzeDeployment).toHaveBeenCalledTimes(2);
        expect(controller.state).toMatchObject({
            analysis: { status: "ready", value: AUTHORIZED_ANALYSIS },
            preview: { status: "none" },
        });

        const mismatchAnalysis = vi.fn(async () => ({
            status: "complete" as const,
            value: REQUIRED_ANALYSIS,
            diagnostics: [],
        }));
        const mismatch = await preparedAuthorizationController({
            createPromotionGrant: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...PROMOTION_GRANT,
                    target: { targetKind: "project", projectId: "99999999-9999-4999-8999-999999999999" },
                },
                diagnostics: [],
            })),
            analyzeDeployment: mismatchAnalysis,
        });
        await authorize(mismatch, target);
        expect(mismatch.state).toMatchObject({ message: { id: "catalog.authorization.create_failed" } });
        expect(mismatchAnalysis).toHaveBeenCalledOnce();

        const changedTargetGrant = vi.fn();
        const changedTarget = await preparedAuthorizationController({ createPromotionGrant: changedTargetGrant });
        await authorize(changedTarget, { ...target, displayPath: "/workspace/changed" });
        expect(changedTargetGrant).not.toHaveBeenCalled();
        expect(changedTarget.state).toMatchObject({ message: { id: "catalog.authorization.target_changed" } });

        const interrupted = await preparedAuthorizationController({
            createPromotionGrant: vi.fn(async () => Promise.reject(new Error("offline"))),
        });
        await authorize(interrupted, target);
        expect(interrupted.state).toMatchObject({
            activity: { status: "idle" },
            message: { id: "catalog.operation.interrupted" },
        });
    });

    it("shows exact Claude CLI build, permission, and pending or applied Version state", () => {
        const target = claudeTarget();
        const selectedDeployment: DeploymentView = {
            ...deployment("in_sync", true),
            stage: "blocked",
            reason: "promotion_authorization_required",
            actionHints: ["review_deployment"],
        };
        const analysis = {
            ...REQUIRED_ANALYSIS,
            diagnostics: [
                {
                    ...diagnostic("newer compatible build", "warning"),
                    code: "claudecode_target_build_compatibility_inferred",
                },
            ],
        };
        const controller = stateController(readyState());
        const props = {
            controller,
            subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
            asset: ASSET,
            deployment: selectedDeployment,
            target,
            providers: DEPLOYMENT_PROVIDERS,
            analysis,
            targetObservationComplete: true,
            disabled: false,
        };
        const review = (overrides = {}) => createElement(CatalogDeploymentCreateReview, { ...props, ...overrides });
        const rendered = renderWithPresentation(review());

        expect(screen.getByText("Claude Code CLI 2.1.220")).toBeTruthy();
        expect(screen.getByText(/newer than the build OAAM directly verified/u)).toBeTruthy();
        const allow = screen.getByRole("button", { name: "Allow this Version for the current Project" });
        const targetReview = rendered.container.querySelector("[data-oaam-create-target-review]");
        expect(targetReview?.querySelector("[data-oaam-deployment-id]")).not.toBeNull();
        expect(targetReview?.contains(allow)).toBe(true);
        fireEvent.click(allow);
        expect(controller.authorizeCurrentVersionForProject).toHaveBeenCalledWith(
            { assetId: ASSET.assetId, versionId: VERSION_ID, projectId: PROJECT_ID },
            selectedDeployment.deploymentId,
            target,
        );

        rendered.rerender(review({ analysis: AUTHORIZED_ANALYSIS }));
        expect(targetReview?.getAttribute("data-oaam-promotion-authorization")).toBe("allowed");
        expect(screen.queryByText("This Version is allowed for the current Project.")).toBeNull();
        expect(screen.queryByRole("button", { name: "Allow this Version for the current Project" })).toBeNull();

        rendered.rerender(
            review({
                analysis: {
                    ...REQUIRED_ANALYSIS,
                    promotionAuthorizationInspections: [
                        {
                            promotionAuthorizationState: "unavailable",
                            assetId: ASSET.assetId,
                            versionId: VERSION_ID,
                            target: { targetKind: "project", projectId: PROJECT_ID },
                            diagnosticCode: "render.promotion_authority_unavailable",
                        },
                    ],
                },
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(controller.analyze).toHaveBeenCalledWith(selectedDeployment.deploymentId);

        const observedDeployment: DeploymentView = {
            ...selectedDeployment,
            stage: "in_sync",
            reason: "in_sync",
            freshness: { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
        };
        rendered.rerender(review({ deployment: observedDeployment, analysis: AUTHORIZED_ANALYSIS }));
        expect(targetReview?.querySelector("[data-oaam-application-state]")).toBeNull();
        expect(screen.queryByText("Applied")).toBeNull();
        expect(screen.queryByText(/Matches the current Version/u)).toBeNull();

        rendered.rerender(
            review({
                deployment: { ...observedDeployment, actionHints: ["check_now"] },
                analysis: AUTHORIZED_ANALYSIS,
            }),
        );
        expect(targetReview?.querySelector("[data-oaam-application-state]")).toBeNull();
        expect(screen.queryByText(/Matches the current Version/u)).toBeNull();

        rendered.rerender(review({ target: undefined, analysis: undefined, targetObservationComplete: false }));
        expect(
            screen.getByText(
                "This saved tool setup is available. Check the current tool location before changing or writing files.",
            ),
        ).toBeTruthy();
        expect(screen.queryByText(/selected tool location changed/u)).toBeNull();

        rendered.rerender(review({ target: undefined, analysis: undefined, targetObservationComplete: true }));
        expect(screen.getByText(/selected tool location changed/u).getAttribute("data-oaam-tone")).toBe("danger");
    });

    it("refuses to bind an exact build when a target has duplicate runtime observations", () => {
        const review = structuredClone(PROBE_REVIEW);
        const result = review.results[0];
        const runtime = result?.runtimes[0];
        if (result === undefined || runtime === undefined) throw new Error("Claude runtime fixture is required");
        result.runtimes = [...result.runtimes, { ...runtime, rowId: "duplicate-claude-cli-runtime" }];
        const target = collectDeploymentTargets(review)[0];
        expect(target).toMatchObject({ runtimeIdentities: [], readyAgentRuntimeIds: [] });
    });
});
