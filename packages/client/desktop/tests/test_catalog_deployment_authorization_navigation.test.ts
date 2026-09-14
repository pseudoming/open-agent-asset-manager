import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { CatalogDeploymentAuthorizationFallback } from "../src/renderer/features/catalog-deployment/CatalogDeploymentAuthorizationFallback";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import type { RenderAnalysisView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, RENDER_ANALYSIS } from "./catalog-deployment-test-fixtures";
import {
    ASSET,
    ASSET_ID,
    deployment,
    DEPLOYMENT_ID,
    fakeController,
    PROJECT_ID,
    readyState,
    VERSION_ID,
} from "./catalog-deployment-test-support";
import { deploymentClient, WorkspacePageHarness } from "./deployment-page-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { clickSemanticAction } from "./semantic-action-test-harness";

const analysis: RenderAnalysisView = {
    ...RENDER_ANALYSIS,
    options: RENDER_ANALYSIS.options.slice(0, 1),
    promotionAuthorizationInspections: [
        {
            promotionAuthorizationState: "required",
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            target: { targetKind: "project", projectId: PROJECT_ID },
            versionOriginAuthorityFingerprint: RENDER_ANALYSIS.renderInputFingerprint,
        },
    ],
};

afterEach(cleanup);

function renderLibrary(client: DesktopApplicationClientApi, onNavigateReceipt = vi.fn()) {
    return renderWithPresentation(
        createElement(WorkspacePageHarness, {
            client,
            pickProjectRoot: async () => ({ status: "cancelled" }),
            authorizeRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
            revealRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
            pickAssetVersionExport: async () => ({ status: "cancelled" }),
            assetCount: 1,
            catalogWarningCount: 0,
            onNavigateReceipt,
            onOpenGuidedImport: vi.fn(),
            onOpenLibrary: vi.fn(),
            onOpenSources: vi.fn(),
            onOpenSettings: vi.fn(),
            onOpenSearch: vi.fn(),
        }),
    );
}

describe("Saved Deployment authorization navigation", () => {
    it("explains a required grant without a fresh probe and opens the same Asset without granting or previewing", async () => {
        const controller = fakeController(
            readyState({
                deployments: [deployment("in_sync", true)],
                analysis: { status: "ready", value: analysis },
            }),
        );
        const onOpenAssetUsage = vi.fn();
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                providers: DEPLOYMENT_PROVIDERS,
                probeReview: undefined,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                onOpenAssetUsage,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: /Project guidance/u }));
        expect(screen.getByText("Allow this Version for the current Project before previewing the files.")).toBeTruthy();
        expect(view.container.querySelector('[data-oaam-promotion-authorization="required"]')?.textContent).toContain(
            "Version 2",
        );
        expect(screen.queryByText(/This saved tool setup is available/u)).toBeNull();
        await clickSemanticAction("deployment.authorization.asset_usage", "deployment.open_asset_usage", {
            expected: onOpenAssetUsage,
            expectedArgs: [ASSET_ID],
            unrelated: [vi.mocked(controller.authorizeCurrentVersionForProject), vi.mocked(controller.preview)],
        });
        expect(onOpenAssetUsage).toHaveBeenCalledTimes(1);
        expect(onOpenAssetUsage).toHaveBeenCalledWith(ASSET_ID);
        expect(controller.authorizeCurrentVersionForProject).not.toHaveBeenCalled();
        expect(controller.preview).not.toHaveBeenCalled();
        expect(view.container.querySelector('[data-oaam-deployment-action="preview"]')).toBeNull();
        expect(view.container.querySelector('[data-oaam-action="save_promotion_grant"]')).toBeNull();
    });

    it("keeps unavailable inspection distinct from a missing grant and retries without a probe", () => {
        const onRetry = vi.fn();
        renderWithPresentation(
            createElement(CatalogDeploymentAuthorizationFallback, {
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                asset: ASSET,
                deployment: deployment(),
                analysis: {
                    ...analysis,
                    promotionAuthorizationInspections: [
                        {
                            promotionAuthorizationState: "unavailable",
                            assetId: ASSET_ID,
                            versionId: VERSION_ID,
                            target: { targetKind: "project", projectId: PROJECT_ID },
                            diagnosticCode: "render.promotion_authority_unavailable",
                        },
                    ],
                },
                disabled: false,
                onRetry,
                onOpenAssetUsage: vi.fn(),
            }),
        );
        expect(screen.getByRole("alert").textContent).toContain("could not check whether this Version is allowed");
        expect(screen.queryByRole("button", { name: "Check tools and review authorization" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it.each([
        "older Version",
        "multiple Assets",
        "different Project",
    ])("does not navigate %s to a different grant subject", async (mismatch) => {
        const onOpenAssetUsage = vi.fn(),
            onOpenLibrary = vi.fn();
        const saved = deployment();
        renderWithPresentation(
            createElement(CatalogDeploymentAuthorizationFallback, {
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                asset: mismatch === "older Version" ? { ...ASSET, currentVersionId: "new-current-version" } : ASSET,
                deployment:
                    mismatch === "multiple Assets"
                        ? {
                              ...saved,
                              assets: [
                                  ...saved.assets,
                                  { assetId: "second-asset", versionId: "second-version", allowIncomplete: false },
                              ],
                          }
                        : saved,
                analysis:
                    mismatch === "different Project"
                        ? {
                              ...analysis,
                              promotionAuthorizationInspections: analysis.promotionAuthorizationInspections.map((entry) => ({
                                  ...entry,
                                  target: { targetKind: "project", projectId: "other-project" },
                              })),
                          }
                        : analysis,
                disabled: false,
                onRetry: vi.fn(),
                onOpenAssetUsage,
                onOpenLibrary,
            }),
        );
        expect(screen.getByText(/saved Versions lack write authorization/u)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Check tools and review authorization" })).toBeNull();
        await clickSemanticAction("deployment.authorization.library", "deployment.open_library", {
            expected: onOpenLibrary,
            expectedArgs: [],
            unrelated: [onOpenAssetUsage],
        });
        expect(onOpenLibrary).toHaveBeenCalledTimes(1);
        expect(onOpenAssetUsage).not.toHaveBeenCalled();
    });

    it("does not borrow another Deployment's authorization inspection", () => {
        const view = renderWithPresentation(
            createElement(CatalogDeploymentAuthorizationFallback, {
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                asset: ASSET,
                deployment: deployment(),
                analysis: { ...analysis, deploymentId: "another-deployment" },
                disabled: false,
                onRetry: vi.fn(),
            }),
        );
        expect(view.container.textContent).toBe("");
    });

    it("routes the management notice into the existing same-Project Asset tool check without automatic authorization", async () => {
        const createPromotionGrant = vi.fn();
        const client = deploymentClient({
            supportsOperation: vi.fn(() => true),
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: { deployments: [deployment("in_sync", true)] },
                diagnostics: [],
            })),
            analyzeDeployment: vi.fn(async () => ({ status: "complete", value: analysis, diagnostics: [] })),
            createPromotionGrant,
        });
        const view = renderLibrary(client);
        fireEvent.click(await screen.findByRole("button", { name: "Manage tool locations" }));
        fireEvent.click(await screen.findByRole("radio", { name: /Project guidance/u }));
        const analyze = view.container.querySelector(`[data-oaam-deployment-action="analyze"]`);
        expect(analyze).not.toBeNull();
        fireEvent.click(analyze as HTMLElement);
        fireEvent.click(await screen.findByRole("button", { name: "Check tools and review authorization" }));
        await waitFor(() => {
            expect(
                view.container.querySelector("main[data-oaam-deployment-mode='create']")?.getAttribute("data-oaam-asset-id"),
            ).toBe(ASSET_ID);
            expect(view.container.querySelector(".deployment-target-discovery")).not.toBeNull();
        });
        expect(view.container.querySelector("main[data-oaam-route='deployment']")?.getAttribute("data-oaam-project-id")).toBe(
            PROJECT_ID,
        );
        expect(view.container.querySelector(".deployment-target-discovery")).not.toBeNull();
        expect(client.analyzeDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }, expect.anything());
        expect(client.probeProject).not.toHaveBeenCalled();
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect(createPromotionGrant).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
        await waitFor(() =>
            expect(view.container.querySelector("main[data-oaam-route='library']")?.getAttribute("data-oaam-project-id")).toBe(
                PROJECT_ID,
            ),
        );
    });

    it("returns an older saved Version to its Project library through an explicit route instead of navigation history", async () => {
        const previousVersionId = "55555555-5555-4555-8555-555555555555";
        const saved = {
            ...deployment("in_sync", true),
            assets: [{ assetId: ASSET_ID, versionId: previousVersionId, allowIncomplete: false }],
        };
        const createPromotionGrant = vi.fn(),
            onNavigateReceipt = vi.fn();
        const client = deploymentClient({
            supportsOperation: vi.fn(() => true),
            listDeployments: vi.fn(async () => ({ status: "complete", value: { deployments: [saved] }, diagnostics: [] })),
            analyzeDeployment: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...analysis,
                    promotionAuthorizationInspections: analysis.promotionAuthorizationInspections.map((inspection) => ({
                        ...inspection,
                        versionId: previousVersionId,
                    })),
                },
                diagnostics: [],
            })),
            createPromotionGrant,
        });
        const view = renderLibrary(client, onNavigateReceipt);
        fireEvent.click(await screen.findByRole("button", { name: "Manage tool locations" }));
        fireEvent.click(await screen.findByRole("radio", { name: /Project guidance/u }));
        fireEvent.click(view.container.querySelector('[data-oaam-deployment-action="analyze"]') as HTMLElement);
        await screen.findByText(/saved Versions lack write authorization/u);
        fireEvent.click(
            view.container.querySelector(
                '[data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_authorization_fallback.002"]',
            ) as HTMLElement,
        );
        await waitFor(() =>
            expect(view.container.querySelector("main[data-oaam-route='library']")?.getAttribute("data-oaam-project-id")).toBe(
                PROJECT_ID,
            ),
        );
        expect(onNavigateReceipt).toHaveBeenLastCalledWith({ surface: "library", subject: "projects", projectId: PROJECT_ID });
        expect(createPromotionGrant).not.toHaveBeenCalled();
        expect(client.probeProject).not.toHaveBeenCalled();
    });
});
