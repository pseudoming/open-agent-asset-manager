import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { localizedText } from "../src/renderer/presentation";
import { ASSET, createController, deployment, DEPLOYMENT_ID, fakeCatalogClient } from "./catalog-deployment-test-support";

type AssetListResult = Awaited<ReturnType<DesktopApplicationClientApi["listAssets"]>>;
const nextVersionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const nextAsset = { ...ASSET, currentVersionId: nextVersionId, currentRevision: ASSET.currentRevision + 1 };
const savedAssets: AssetListResult = { status: "complete", value: { assets: [ASSET] }, diagnostics: [] };
const refreshedAssets: AssetListResult = { status: "complete", value: { assets: [nextAsset] }, diagnostics: [] };
const recovered = {
    ...deployment("in_sync"),
    assets: [{ assetId: ASSET.assetId, versionId: nextVersionId, allowIncomplete: false }],
};

function pendingAssets() {
    let resolve!: (result: AssetListResult) => void;
    const promise = new Promise<AssetListResult>((done) => {
        resolve = done;
    });
    return { promise, resolve: (result: AssetListResult) => resolve(result) };
}

function setup(listAssets: DesktopApplicationClientApi["listAssets"]) {
    const fake = fakeCatalogClient({
        listAssets,
        listDeployments: vi.fn(async () => ({
            status: "complete",
            value: { deployments: [deployment("blocked")] },
            diagnostics: [],
        })),
        recoverDeployment: vi.fn(async () => ({ status: "complete", value: recovered, diagnostics: [] })),
    });
    return { ...fake, controller: createController(fake.client) };
}

describe("Recovery outcome and asset summary freshness", () => {
    it("refreshes the exact revision after recovery without requiring management re-entry", async () => {
        const pending = pendingAssets();
        const listAssets = vi
            .fn<DesktopApplicationClientApi["listAssets"]>()
            .mockResolvedValueOnce(savedAssets)
            .mockImplementationOnce(() => pending.promise);
        const { controller, client } = setup(listAssets);
        await controller.load();
        const recovery = controller.recover(DEPLOYMENT_ID);
        await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(2));
        expect(controller.state).toMatchObject({
            completedMutation: { kind: "recover", deploymentId: DEPLOYMENT_ID },
            deployments: [recovered],
            assets: [ASSET],
            stale: false,
            requiresReconciliation: false,
        });
        pending.resolve(refreshedAssets);
        await recovery;
        expect(controller.state).toMatchObject({ assets: [nextAsset], deployments: [recovered] });
        expect(client.recoverDeployment).toHaveBeenCalledTimes(1);
        expect(client.analyzeDeployment).not.toHaveBeenCalled();
        expect(client.scanDeployment).not.toHaveBeenCalled();
        controller.dispose();
    });

    it.each([
        "failed",
        "partial",
        "interrupted",
    ] as const)("retains a trusted recovery when summary refresh is %s", async (failure) => {
        const listAssets = vi
            .fn<DesktopApplicationClientApi["listAssets"]>()
            .mockResolvedValueOnce(savedAssets)
            .mockImplementationOnce(async () => {
                if (failure === "interrupted") throw new Error("metadata connection interrupted");
                return failure === "failed"
                    ? { status: "failed", diagnostics: [] }
                    : { status: "partial", value: { assets: [] }, diagnostics: [] };
            });
        const { controller, client } = setup(listAssets);
        await controller.load();
        await controller.recover(DEPLOYMENT_ID);
        expect(controller.state).toMatchObject({
            assets: [ASSET],
            deployments: [recovered],
            completedMutation: { kind: "recover" },
            stale: false,
            requiresReconciliation: false,
            message: localizedText("catalog.operation.finished", {
                operation: localizedText("catalog.activity.recover"),
                stage: localizedText("catalog.ui.status.up_to_date"),
            }),
        });
        expect(client.recoverDeployment).toHaveBeenCalledTimes(1);
        controller.dispose();
    });

    it.each(["dispose", "invalidate", "reload"] as const)("drops a late summary after %s", async (change) => {
        const pending = pendingAssets();
        const laterAsset = { ...ASSET, displayName: "A later catalog load" };
        const listAssets = vi
            .fn<DesktopApplicationClientApi["listAssets"]>()
            .mockResolvedValueOnce(savedAssets)
            .mockImplementationOnce(() => pending.promise)
            .mockResolvedValueOnce({ status: "complete", value: { assets: [laterAsset] }, diagnostics: [] });
        const { controller, invalidate } = setup(listAssets);
        await controller.load();
        const recovery = controller.recover(DEPLOYMENT_ID);
        await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(2));
        if (change === "dispose") controller.dispose();
        else if (change === "reload") await controller.load();
        else invalidate({ resourceKind: "collection", collection: "assets" });
        const before = controller.state;
        pending.resolve(refreshedAssets);
        await recovery;
        expect(controller.state).toBe(before);
        if (change === "invalidate") expect(controller.state).toMatchObject({ stale: true });
        if (change === "reload") expect(controller.state).toMatchObject({ assets: [laterAsset] });
        controller.dispose();
    });

    it("does not request a new summary after a failed recovery", async () => {
        const listAssets = vi.fn<DesktopApplicationClientApi["listAssets"]>().mockResolvedValue(savedAssets);
        const fake = fakeCatalogClient({
            listAssets,
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: { deployments: [deployment("blocked")] },
                diagnostics: [],
            })),
            recoverDeployment: vi.fn(async () => ({ status: "failed", diagnostics: [] })),
        });
        const controller = createController(fake.client);
        await controller.load();
        await controller.recover(DEPLOYMENT_ID);
        expect(listAssets).toHaveBeenCalledTimes(1);
        expect(controller.state).toMatchObject({ assets: [ASSET] });
        expect("completedMutation" in controller.state).toBe(false);
        controller.dispose();
    });
});
