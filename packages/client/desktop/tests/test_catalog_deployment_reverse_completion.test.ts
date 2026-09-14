import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi, DesktopLongOperationListener } from "../src/renderer/client";
import { localizedText } from "../src/renderer/presentation";
import { COMMITTED_REVERSE, RENDER_ANALYSIS } from "./catalog-deployment-test-fixtures";
import {
    ASSET,
    createController,
    DEPLOYMENT_ID,
    deployment,
    diagnostic,
    fakeCatalogClient,
} from "./catalog-deployment-test-support";

type AssetList = Awaited<ReturnType<DesktopApplicationClientApi["listAssets"]>>;
type DeploymentList = Awaited<ReturnType<DesktopApplicationClientApi["listDeployments"]>>;
const committed = COMMITTED_REVERSE as Extract<typeof COMMITTED_REVERSE, { commitState: "committed" }>;
const nextAsset = { ...ASSET, currentVersionId: committed.version.versionId, currentRevision: ASSET.currentRevision + 1 };
const freshAssets: AssetList = { status: "complete", value: { assets: [nextAsset] }, diagnostics: [] };
const freshDeployment = { ...deployment(), assets: [{ ...committed.version, allowIncomplete: false }] };
const freshDeployments: DeploymentList = { status: "complete", value: { deployments: [freshDeployment] }, diagnostics: [] };
const selections = [
    {
        semanticRefFingerprint: RENDER_ANALYSIS.renderInputFingerprint,
        optionFingerprint: RENDER_ANALYSIS.options[0]?.optionFingerprint as string,
        approved: false,
    },
];

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function setup(overrides: Partial<DesktopApplicationClientApi> = {}) {
    const fake = fakeCatalogClient({
        listAssets: vi
            .fn()
            .mockResolvedValueOnce({ status: "complete", value: { assets: [ASSET] }, diagnostics: [] })
            .mockResolvedValue(freshAssets),
        listDeployments: vi
            .fn()
            .mockResolvedValueOnce({ status: "complete", value: { deployments: [deployment("conflict")] }, diagnostics: [] })
            .mockResolvedValue(freshDeployments),
        recoverDeployment: vi.fn(async () => ({ status: "complete", value: freshDeployment, diagnostics: [] })),
        ...overrides,
    });
    const controller = createController(fake.client);
    await controller.load();
    await controller.inspect(DEPLOYMENT_ID);
    await controller.prepareReverse();
    expect(controller.state).toMatchObject({ reverse: { status: "prepared" } });
    return { ...fake, controller, commit: () => controller.commitReverse(selections, true) };
}

describe("Desktop completion of a committed reverse acceptance", () => {
    it("keeps an exact recovery retry after restart when the retired Deployment has a partial index refresh", async () => {
        const warning = diagnostic("Index refresh failed", "warning");
        const fake = fakeCatalogClient({
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: { deployments: [deployment("blocked")] },
                diagnostics: [],
            })),
            recoverDeployment: vi
                .fn()
                .mockResolvedValueOnce({ status: "partial", value: freshDeployment, diagnostics: [warning] })
                .mockResolvedValue({ status: "complete", value: freshDeployment, diagnostics: [] }),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.recover(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            reverse: { status: "none" },
            deployments: [freshDeployment],
            requiresReconciliation: true,
            pendingRecoveryDeploymentId: DEPLOYMENT_ID,
        });
        vi.mocked(fake.client.listDeployments).mockResolvedValue(freshDeployments);
        await controller.load();
        expect(controller.state).toMatchObject({
            reverse: { status: "none" },
            deployments: [freshDeployment],
            pendingRecoveryDeploymentId: DEPLOYMENT_ID,
            requiresReconciliation: true,
        });
        vi.mocked(fake.client.listAssets).mockRejectedValueOnce(new Error("display unavailable"));
        await controller.load();
        expect(controller.state).toMatchObject({
            status: "ready",
            pendingRecoveryDeploymentId: DEPLOYMENT_ID,
            requiresReconciliation: true,
        });
        await controller.recover("11111111-1111-4111-8111-111111111111");
        expect(fake.client.recoverDeployment).toHaveBeenCalledTimes(1);
        await controller.recover(DEPLOYMENT_ID);
        expect(fake.client.recoverDeployment).toHaveBeenCalledTimes(2);
        expect(controller.state).toMatchObject({ requiresReconciliation: false, pendingRecoveryDeploymentId: undefined });
        controller.dispose();
    });

    it("retains the saved Version while reads are pending, then exposes the fresh relationship and revision", async () => {
        let progress: DesktopLongOperationListener<"reverse_accept.commit">;
        const fake = await setup({
            commitReverseAccept: vi.fn(async (_input, listener) => {
                progress = listener;
                fake.invalidate({ resourceKind: "collection", collection: "assets" });
                return { status: "complete", value: committed, diagnostics: [] };
            }),
        });
        const pending = deferred<AssetList>();
        vi.mocked(fake.client.listAssets).mockReturnValueOnce(pending.promise);
        const operation = fake.commit();
        await waitFor(() => expect(fake.client.listAssets).toHaveBeenCalledTimes(2));
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed, reviewedFilePaths: ["CLAUDE.md", "bin/helper"] },
            activity: { status: "starting", kind: "reverse_commit", message: localizedText("catalog.activity.reverse_refresh") },
            assets: [ASSET],
            stale: true,
            requiresReconciliation: false,
        });
        progress?.({ status: "accepted", operation: "reverse_accept.commit", operationId: "late-progress" });
        await fake.commit();
        await fake.controller.recover(DEPLOYMENT_ID);
        expect(fake.client.commitReverseAccept).toHaveBeenCalledTimes(1);
        expect(fake.client.recoverDeployment).not.toHaveBeenCalled();
        pending.resolve(freshAssets);
        await operation;
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            assets: [nextAsset],
            deployments: [freshDeployment],
            activity: { status: "idle" },
            stale: false,
            requiresReconciliation: false,
            message: undefined,
        });
        progress?.({ status: "accepted", operation: "reverse_accept.commit", operationId: "after-completion" });
        expect(fake.controller.state.activity).toEqual({ status: "idle" });
        await fake.controller.recover(DEPLOYMENT_ID);
        expect(fake.client.recoverDeployment).not.toHaveBeenCalled();
        fake.controller.dispose();
    });

    it.each([
        "reverse_accept.completion_pending",
        "reverse_accept.index_refresh_pending",
    ])("keeps the saved Version and an explicit retry after Core reports %s", async (code) => {
        const warning = { ...diagnostic("Completion pending", "warning"), code };
        const fake = await setup({
            commitReverseAccept: vi.fn(async () => ({ status: "complete", value: committed, diagnostics: [warning] })),
        });
        await fake.commit();
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            activity: { status: "idle" },
            requiresReconciliation: true,
            diagnostics: [warning],
        });
        expect(fake.client.recoverDeployment).not.toHaveBeenCalled();
        const pendingRead = deferred<AssetList>();
        vi.mocked(fake.client.listAssets).mockReturnValueOnce(pendingRead.promise);
        const refresh = fake.controller.load();
        await waitFor(() => expect(fake.client.listAssets).toHaveBeenCalledTimes(3));
        const duringRefresh = fake.controller.state;
        await fake.controller.load();
        expect(fake.controller.state).toBe(duringRefresh);
        pendingRead.resolve(freshAssets);
        await refresh;
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            requiresReconciliation: true,
            pendingRecoveryDeploymentId: DEPLOYMENT_ID,
        });
        await fake.controller.recover(DEPLOYMENT_ID);
        expect(fake.client.recoverDeployment).toHaveBeenCalledTimes(1);
        expect(fake.controller.state).toMatchObject({ requiresReconciliation: false, assets: [nextAsset] });
        fake.controller.dispose();
    });

    it.each([
        "partial",
        "failed",
        "throw",
    ] as const)("preserves a committed outcome when an Asset display read is %s", async (failure) => {
        const fake = await setup();
        const warning = diagnostic("Asset list unavailable");
        vi.mocked(fake.client.listAssets).mockImplementationOnce(async () => {
            if (failure === "throw") throw new Error("read connection closed");
            if (failure === "failed") return { status: "failed", diagnostics: [warning] };
            return { status: "partial", value: { assets: [] }, diagnostics: [warning] };
        });
        await fake.commit();
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            activity: { status: "idle" },
            assets: [ASSET],
            requiresReconciliation: false,
            stale: true,
        });
        if (failure !== "throw") expect(fake.controller.state).toMatchObject({ diagnostics: [warning] });
        expect(fake.client.commitReverseAccept).toHaveBeenCalledTimes(1);
        expect(fake.client.recoverDeployment).not.toHaveBeenCalled();
        fake.controller.dispose();
    });

    it.each([
        "failed",
        "throw",
        "missing",
        "blocked",
        "later_conflict",
    ] as const)("uses the actual Deployment projection after %s instead of inventing in_sync", async (outcome) => {
        const fake = await setup();
        vi.mocked(fake.client.listDeployments).mockImplementationOnce(async () => {
            if (outcome === "throw") throw new Error("projection read lost");
            if (outcome === "failed") return { status: "failed", diagnostics: [diagnostic("Deployment list unavailable")] };
            return {
                status: "complete",
                value: { deployments: outcome === "missing" ? [] : [deployment(outcome === "blocked" ? "blocked" : "conflict")] },
                diagnostics: [],
            };
        });
        await fake.commit();
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            activity: { status: "idle" },
            requiresReconciliation: outcome === "blocked",
        });
        if (outcome === "blocked" || outcome === "later_conflict")
            expect(fake.controller.state).toMatchObject({
                deployments: [{ stage: outcome === "blocked" ? "blocked" : "conflict" }],
            });
        expect(fake.client.recoverDeployment).not.toHaveBeenCalled();
        fake.controller.dispose();
    });

    it("does not clear a new authority invalidation with an earlier in-flight read", async () => {
        const fake = await setup();
        const pending = deferred<AssetList>();
        vi.mocked(fake.client.listAssets).mockReturnValueOnce(pending.promise);
        const operation = fake.commit();
        await waitFor(() => expect(fake.client.listAssets).toHaveBeenCalledTimes(2));
        fake.invalidate({ resourceKind: "collection", collection: "assets" });
        expect(fake.controller.state).toMatchObject({ reverse: { status: "result", value: committed } });
        pending.resolve(freshAssets);
        await operation;
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            assets: [ASSET],
            activity: { status: "idle" },
            stale: true,
            requiresReconciliation: false,
        });
        fake.controller.dispose();
    });

    it.each(["dispose", "reload"])("ignores old projection callbacks after %s", async (action) => {
        const fake = await setup();
        const pending = deferred<AssetList>();
        vi.mocked(fake.client.listAssets).mockReturnValueOnce(pending.promise);
        const operation = fake.commit();
        await waitFor(() => expect(fake.client.listAssets).toHaveBeenCalledTimes(2));
        if (action === "dispose") fake.controller.dispose();
        else await fake.controller.load();
        const state = fake.controller.state;
        pending.resolve(freshAssets);
        await operation;
        expect(fake.controller.state).toBe(state);
        fake.controller.dispose();
    });

    it("retains the saved result and retry when explicit recovery only partially refreshes the index", async () => {
        const warning = { ...diagnostic("Index unavailable", "warning"), code: "reverse_accept.index_refresh_pending" };
        const fake = await setup({
            commitReverseAccept: vi.fn(async () => ({ status: "complete", value: committed, diagnostics: [warning] })),
            recoverDeployment: vi.fn(async () => {
                fake.invalidate({ resourceKind: "deployment", deploymentId: DEPLOYMENT_ID });
                return { status: "partial", value: freshDeployment, diagnostics: [warning] };
            }),
        });
        await fake.commit();
        await fake.controller.recover(DEPLOYMENT_ID);
        expect(fake.controller.state).toMatchObject({
            reverse: { status: "result", value: committed },
            activity: { status: "idle" },
            requiresReconciliation: true,
            stale: true,
            diagnostics: [warning],
        });
        expect(fake.client.commitReverseAccept).toHaveBeenCalledTimes(1);
        fake.controller.dispose();
    });
});
