import { ClientTransportError } from "@oaam/client-framework";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import { CatalogDeploymentVersionUpdate } from "../src/renderer/features/catalog-deployment/CatalogDeploymentVersionUpdate";
import { catalogDeploymentMutationIsCurrent } from "../src/renderer/features/catalog-deployment/CatalogDeploymentOutcomeSummary";
import {
    deploymentStatusMessage,
    type DeploymentView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { DEPLOYMENT_PROVIDERS, PROBE_REVIEW } from "./catalog-deployment-test-fixtures";
import {
    ASSET,
    ASSET_ID,
    createController,
    completeAssetUsage,
    DEPLOYMENT_ID,
    deployment,
    diagnostic,
    fakeCatalogClient,
    PROJECT_ID,
    readyState,
    VERSION_ID,
} from "./catalog-deployment-test-support";

afterEach(cleanup);
const OLD_VERSION = "99999999-9999-4999-8999-999999999999";
const update = {
    deploymentId: DEPLOYMENT_ID,
    assetId: ASSET_ID,
    previousVersionId: OLD_VERSION,
    versionId: VERSION_ID,
    allowIncomplete: false,
};

function fixture(overrides: Partial<DesktopApplicationClientApi> = {}, initial = deployment("in_sync")) {
    let saved: DeploymentView = {
        ...initial,
        assets: [
            { assetId: ASSET_ID, versionId: OLD_VERSION, allowIncomplete: false },
            ...initial.assets.filter((asset) => asset.assetId !== ASSET_ID),
        ],
    };
    const getDeployment = vi.fn<DesktopApplicationClientApi["getDeployment"]>(async () => ({
        status: "complete",
        value: { found: true, value: saved },
        diagnostics: [],
    }));
    const updateDeploymentInputs = vi.fn<DesktopApplicationClientApi["updateDeploymentInputs"]>(async (params) => {
        saved = { ...saved, assets: [...(params.assets ?? saved.assets)], actionHints: ["check_now", "review_deployment"] };
        return { status: "complete", value: saved, diagnostics: [] };
    });
    const fake = fakeCatalogClient({
        getDeployment,
        updateDeploymentInputs,
        listDeployments: vi.fn(async () => ({ status: "complete", value: { deployments: [saved] }, diagnostics: [] })),
        ...overrides,
    });
    return { ...fake, controller: createController(fake.client), saved: () => saved };
}

describe("Controlled Version updates for an existing location", () => {
    it("reveals current applied usage on explicit selection instead of hiding its result as already settled", async () => {
        const fake = fakeCatalogClient({
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: { deployments: [deployment("in_sync")] },
                diagnostics: [],
            })),
            analyzeAssetUsage: vi.fn(async (params) => {
                const result = completeAssetUsage(params);
                return {
                    ...result,
                    value: {
                        ...result.value,
                        relationships: result.value.relationships.map((relationship) => ({
                            ...relationship,
                            observedTargetState: "already_usable" as const,
                            managedState: "applied" as const,
                            deploymentIds: [DEPLOYMENT_ID],
                            appliedDeploymentIds: [DEPLOYMENT_ID],
                        })),
                    },
                };
            }),
        });
        const controller = createController(fake.client);
        await controller.load();
        const view = renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                initialAssetId: ASSET_ID,
                probeReview: PROBE_REVIEW,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        await waitFor(() => {
            expect(controller.state).toMatchObject({ assetUsage: { status: "ready" } });
            expect(view.container.querySelector('[data-oaam-deployment-step="review"]')).toBeNull();
        });
        fireEvent.click(view.container.querySelector<HTMLButtonElement>(".asset-usage-group-summary")!);
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: "View usage" })));
        expect(view.container.querySelector('[data-oaam-deployment-step="review"]')).not.toBeNull();
        expect(view.container.querySelector('[data-oaam-deployment-action="scan"]')).not.toBeNull();
        expect(fake.client.createDeployment).not.toHaveBeenCalled();
        expect(fake.client.deploy).not.toHaveBeenCalled();
        controller.dispose();
    });

    it("opens the older saved configuration from current-Version usage and updates that same Deployment", async () => {
        const f = fixture();
        await f.controller.load();
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: f.controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                initialAssetId: ASSET_ID,
                probeReview: PROBE_REVIEW,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        const saved = await screen.findByRole("button", { name: "Review saved Version" });
        expect(f.client.createDeployment).not.toHaveBeenCalled();
        await act(async () => fireEvent.click(saved));
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Select revision 2 and review" })));
        await vi.waitFor(() => expect(f.client.updateDeploymentInputs).toHaveBeenCalledOnce());
        expect(f.client.updateDeploymentInputs).toHaveBeenCalledWith(
            expect.objectContaining({
                deploymentId: DEPLOYMENT_ID,
                assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
                expectedInputs: expect.objectContaining({
                    assets: [{ assetId: ASSET_ID, versionId: OLD_VERSION, allowIncomplete: false }],
                }),
            }),
        );
        expect(f.client.createDeployment).not.toHaveBeenCalled();
        expect(f.client.deploy).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it("changes only the selected Asset in the same Deployment and requires the normal analysis before any write", async () => {
        const other = {
            assetId: "77777777-7777-4777-8777-777777777777",
            versionId: "88888888-8888-4888-8888-888888888888",
            allowIncomplete: true,
        };
        const f = fixture({}, { ...deployment("in_sync"), assets: [deployment().assets[0]!, other] });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.client.getDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID });
        expect(f.client.updateDeploymentInputs).toHaveBeenCalledWith({
            deploymentId: DEPLOYMENT_ID,
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }, other],
            expectedInputs: {
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                assets: [{ assetId: ASSET_ID, versionId: OLD_VERSION, allowIncomplete: false }, other],
            },
        });
        expect(f.saved().consumerAgentRuntimeIds).toEqual(["CLAUDE_CODE_CLI"]);
        expect(f.saved().targetRootPath).toBe("/workspace/oaam");
        expect(f.client.createDeployment).not.toHaveBeenCalled();
        expect(f.client.analyzeDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }, expect.any(Function));
        expect(f.client.previewDeployment).not.toHaveBeenCalled();
        expect(f.client.deploy).not.toHaveBeenCalled();
        expect(f.controller.state).toMatchObject({
            status: "ready",
            analysis: { status: "ready" },
        });
        expect(readyState(f.controller).completedMutation).toBeUndefined();
        f.controller.dispose();
    });

    it("exposes an explicit update on the Asset journey, then resumes pending review after reloading the manager", async () => {
        const f = fixture();
        await f.controller.load();
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: f.controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                initialAssetId: ASSET_ID,
                probeReview: undefined,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        const button = await screen.findByRole("button", { name: "Select revision 2 and review" });
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        expect(
            document.querySelector('[data-oaam-create-target-review] [data-oaam-application-version-state="current"]'),
        ).toBeNull();
        await act(async () => fireEvent.click(button));
        await vi.waitFor(() => expect(f.client.analyzeDeployment).toHaveBeenCalledOnce());
        expect(screen.queryByRole("button", { name: "Select revision 2 and review" })).toBeNull();
        expect(f.client.deploy).not.toHaveBeenCalled();
        cleanup();
        f.controller.dispose();
        const reopened = createController(f.client);
        await reopened.load();
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller: reopened,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                probeReview: undefined,
                providers: DEPLOYMENT_PROVIDERS,
            }),
        );
        fireEvent.click(await screen.findByRole("radio"));
        expect(screen.getByText("Selected inputs need review")).not.toBeNull();
        const review = document.querySelector<HTMLButtonElement>('[data-oaam-deployment-action="analyze"]');
        expect(review?.disabled).toBe(false);
        expect(review?.classList.contains("library-secondary-button")).toBe(false);
        await act(async () => review?.click());
        expect(f.client.analyzeDeployment).toHaveBeenCalledTimes(2);
        expect(f.client.updateDeploymentInputs).toHaveBeenCalledOnce();
        reopened.dispose();
    });

    it("requires explicit incomplete-Version consent and does not inherit consent from a different Version", async () => {
        const f = fixture({
            listAssets: vi.fn(async () => ({
                status: "complete",
                value: { assets: [{ ...ASSET, currentVersionStatus: "incomplete" }] },
                diagnostics: [],
            })),
        });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        await f.controller.updateVersion({ ...update, allowIncomplete: true });
        expect(f.client.updateDeploymentInputs).toHaveBeenCalledWith({
            deploymentId: DEPLOYMENT_ID,
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: true }],
            expectedInputs: {
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                assets: [{ assetId: ASSET_ID, versionId: OLD_VERSION, allowIncomplete: false }],
            },
        });
        f.controller.dispose();
    });

    it("asks for incomplete-Version consent in the manager and resets it when the current Version changes", async () => {
        const f = fixture();
        await f.controller.load();
        const dispatch = vi.spyOn(f.controller, "updateVersion").mockResolvedValue(undefined);
        const state = {
            ...readyState(f.controller),
            assets: [{ ...ASSET, currentVersionStatus: "incomplete" as const }],
        };
        const props = { controller: f.controller, state, deployment: f.saved(), disabled: false };
        const rendered = renderWithPresentation(createElement(CatalogDeploymentVersionUpdate, props));
        const choose = () => screen.getByRole<HTMLButtonElement>("button", { name: /Select revision .* and review/u });
        expect(choose().disabled).toBe(true);
        fireEvent.click(screen.getByRole("checkbox"));
        expect(choose().disabled).toBe(false);
        fireEvent.click(choose());
        expect(dispatch).toHaveBeenCalledWith({ ...update, allowIncomplete: true });
        rendered.rerender(
            createElement(CatalogDeploymentVersionUpdate, {
                ...props,
                state: {
                    ...state,
                    assets: [{ ...state.assets[0]!, currentRevision: 3, currentVersionId: "new-current-version" }],
                },
            }),
        );
        expect(choose().disabled).toBe(true);
        fireEvent.click(choose());
        expect(dispatch).toHaveBeenCalledOnce();
        f.controller.dispose();
    });

    it.each(["invalidated", "disposed"] as const)("does not submit an update after the fresh read is %s", async (change) => {
        let resolveRead: ((value: Awaited<ReturnType<DesktopApplicationClientApi["getDeployment"]>>) => void) | undefined;
        const f = fixture({
            getDeployment: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveRead = resolve;
                    }),
            ),
        });
        await f.controller.load();
        const pending = f.controller.updateVersion(update);
        await f.controller.updateVersion(update);
        expect(f.client.getDeployment).toHaveBeenCalledOnce();
        if (change === "invalidated") f.invalidate({ resourceKind: "deployment", deploymentId: DEPLOYMENT_ID });
        else f.controller.dispose();
        resolveRead?.({ status: "complete", value: { found: true, value: f.saved() }, diagnostics: [] });
        await pending;
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        expect(f.client.deploy).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it.each(["recover", "contact_support"] as const)("leaves %s as the required action", async (hint) => {
        const f = fixture({}, { ...deployment("blocked"), actionHints: [hint] });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.client.getDeployment).not.toHaveBeenCalled();
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it("rejects stale selections and unsupported Hosts before dispatch", async () => {
        const f = fixture();
        await f.controller.load();
        await f.controller.updateVersion({ ...update, previousVersionId: VERSION_ID });
        await f.controller.updateVersion({ ...update, versionId: OLD_VERSION });
        expect(f.client.getDeployment).not.toHaveBeenCalled();
        f.invalidate({ resourceKind: "asset", assetId: ASSET_ID });
        await f.controller.updateVersion(update);
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        f.controller.dispose();
        const unavailable = fixture({ supportsOperation: vi.fn(() => false) });
        await unavailable.controller.load();
        await unavailable.controller.updateVersion(update);
        expect(unavailable.controller.supportsVersionUpdate).toBe(false);
        expect(unavailable.client.updateDeploymentInputs).not.toHaveBeenCalled();
        unavailable.controller.dispose();
    });

    it("does not construct a conditional update for a location with no consumer identity", async () => {
        const f = fixture({}, { ...deployment("in_sync"), consumerAgentRuntimeIds: [] });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.client.getDeployment).not.toHaveBeenCalled();
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it("does not overwrite a location whose selected Version changed during the fresh read", async () => {
        const f = fixture({
            getDeployment: vi.fn(async () => ({
                status: "complete",
                value: { found: true, value: deployment("in_sync") },
                diagnostics: [],
            })),
        });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.client.updateDeploymentInputs).not.toHaveBeenCalled();
        expect(f.controller.state).toMatchObject({ status: "ready", stale: true, activity: { status: "idle" } });
        f.controller.dispose();
    });

    it("retains a failed update without starting analysis or Apply", async () => {
        const f = fixture({
            updateDeploymentInputs: vi.fn(async () => ({ status: "failed", diagnostics: [diagnostic("Update rejected")] })),
        });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.controller.state).toMatchObject({
            status: "ready",
            activity: { status: "idle" },
            message: { id: "catalog.version_update.failed" },
        });
        expect(f.client.analyzeDeployment).not.toHaveBeenCalled();
        expect(f.client.deploy).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it("requires a catalog refresh when the atomic input check rejects a concurrent update", async () => {
        const f = fixture({
            updateDeploymentInputs: vi.fn(async () => ({
                status: "failed",
                diagnostics: [{ ...diagnostic("Another selection was saved"), code: "deploy.inputs_changed" }],
            })),
        });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.controller.state).toMatchObject({
            status: "ready",
            stale: true,
            message: { id: "catalog.version_update.changed" },
        });
        await f.controller.updateVersion(update);
        expect(f.client.updateDeploymentInputs).toHaveBeenCalledOnce();
        expect(f.client.analyzeDeployment).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it.each(["read", "mutation"] as const)("keeps %s transport uncertainty at its actual boundary", async (boundary) => {
        const interrupted = vi.fn(async () => {
            throw new ClientTransportError(
                "uncertain",
                boundary === "read" ? "deployment.get" : "deployment.update_inputs",
                "request",
                "lost",
                new Error("closed"),
            );
        });
        const f = fixture(boundary === "read" ? { getDeployment: interrupted } : { updateDeploymentInputs: interrupted });
        await f.controller.load();
        await f.controller.updateVersion(update);
        expect(f.controller.state).toMatchObject({
            status: "ready",
            requiresReconciliation: boundary === "mutation",
            activity: { status: "idle" },
        });
        expect(f.client.analyzeDeployment).not.toHaveBeenCalled();
        expect(f.client.deploy).not.toHaveBeenCalled();
        f.controller.dispose();
    });

    it("does not present a pending selection as the previously completed application", () => {
        const pending = { ...deployment("in_sync"), actionHints: ["check_now", "review_deployment"] as const };
        const state = readyState({
            completedMutation: { kind: "deploy", deploymentId: DEPLOYMENT_ID, reviewedFilePaths: ["AGENTS.md"] },
        });
        expect(catalogDeploymentMutationIsCurrent(state, pending)).toBe(false);
        expect(deploymentStatusMessage(pending)).toBe("catalog.version_update.pending");
        expect(deploymentStatusMessage({ ...pending, stage: "conflict" })).toBe("catalog.ui.status.external_changes");
        expect(deploymentStatusMessage(deployment("blocked"))).toBe("catalog.ui.status.paused_for_safety");
        expect(deploymentStatusMessage(deployment("in_sync", true))).toBe("catalog.ui.status.first_deployment");
    });
});
