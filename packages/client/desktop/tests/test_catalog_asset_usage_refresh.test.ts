import type { ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDeploymentWorkspace } from "../src/renderer/features/catalog-deployment/CatalogDeploymentWorkspace";
import type {
    AssetUsageAnalysisRequest,
    ProbeReviewView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, PROBE_REVIEW } from "./catalog-deployment-test-fixtures";
import {
    ASSET_ID,
    completeAssetUsage,
    createController,
    deployment,
    DEPLOYMENT_ID,
    fakeCatalogClient,
    PROJECT_ID,
    VERSION_ID,
} from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(cleanup);

function request(targetKey: string, agentRuntimeId: "CLAUDE_CODE_CLI" | "OPENCODE_CLI"): AssetUsageAnalysisRequest {
    return {
        targetKey,
        params: {
            probeToken: "probe-token",
            probeResultRowId: `${targetKey}-result`,
            targetRowId: `${targetKey}-row`,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            consumerAgentRuntimeIds: [agentRuntimeId],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        },
    };
}

describe("Asset relationship refresh after an exact Deployment change", () => {
    it("refreshes only requested targets and retains unrelated results without promoting a failed refresh", async () => {
        const fake = fakeCatalogClient();
        const controller = createController(fake.client);
        await controller.load();
        const claude = request("claude", "CLAUDE_CODE_CLI");
        const opencode = request("opencode", "OPENCODE_CLI");
        await controller.analyzeAssetUsage("wave", [claude, opencode]);
        const before = controller.state;
        if (before.status !== "ready" || before.assetUsage.status !== "ready") throw new Error("missing initial relationships");
        const retained = before.assetUsage.targets[1];
        vi.mocked(fake.client.analyzeAssetUsage).mockClear().mockResolvedValueOnce({ status: "failed", diagnostics: [] });
        await controller.refreshAssetUsageTargets("old-wave", [claude]);
        expect(fake.client.analyzeAssetUsage).not.toHaveBeenCalled();
        await controller.refreshAssetUsageTargets("wave", [claude]);
        expect(fake.client.analyzeAssetUsage).toHaveBeenCalledTimes(1);
        expect(fake.client.analyzeAssetUsage).toHaveBeenCalledWith(claude.params);
        const after = controller.state;
        if (after.status !== "ready" || after.assetUsage.status !== "ready") throw new Error("missing refreshed relationships");
        expect(after.assetUsage.targets.find((target) => target.targetKey === "opencode")).toBe(retained);
        expect(after.assetUsage.targets.find((target) => target.targetKey === "claude")).toEqual({
            targetKey: "claude",
            status: "failed",
            failureKind: "verification_failed",
            diagnostics: [],
        });
        expect(fake.client.createDeployment).not.toHaveBeenCalled();
        expect(fake.client.deploy).not.toHaveBeenCalled();
        controller.dispose();
    });

    it.each(["reset", "reload", "dispose"] as const)("rejects late relationship results after %s", async (retirement) => {
        let resolve!: (outcome: ProtocolOperationTerminal<"asset_usage.analyze">) => void;
        const pending = new Promise<ProtocolOperationTerminal<"asset_usage.analyze">>((complete) => {
            resolve = complete;
        });
        const fake = fakeCatalogClient({ analyzeAssetUsage: vi.fn(() => pending) });
        const controller = createController(fake.client);
        await controller.load();
        const target = request("claude", "CLAUDE_CODE_CLI");
        const running = controller.analyzeAssetUsage("old-wave", [target]);
        if (retirement === "reset") await controller.analyzeAssetUsage("reset", []);
        else if (retirement === "reload") await controller.load();
        else controller.dispose();
        const retired = controller.state;
        resolve(completeAssetUsage(target.params));
        await running;
        expect(controller.state).toBe(retired);
        controller.dispose();
    });

    it("updates the rendered changed target from a fresh read and does not recheck a sibling Provider", async () => {
        const source = PROBE_REVIEW.results[0];
        const runtime = source?.runtimes[0];
        const target = source?.targets[0];
        if (source === undefined || runtime === undefined || target === undefined) throw new Error("missing probe fixture");
        const probe: ProbeReviewView = {
            ...PROBE_REVIEW,
            results: [
                ...PROBE_REVIEW.results,
                {
                    ...source,
                    rowId: "opencode-row",
                    adapterId: "OPENCODE",
                    runtimes: [{ ...runtime, rowId: "opencode-cli", agentRuntimeId: "OPENCODE_CLI" }],
                    targets: [
                        {
                            ...target,
                            rowId: "opencode-target",
                            targetCandidateId: "opencode-candidate",
                            entryApplicabilities: [{ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan", diagnostics: [] }],
                        },
                    ],
                },
            ],
        };
        let checked = false;
        const fake = fakeCatalogClient({
            listDeployments: vi.fn(async () => ({ status: "complete", value: { deployments: [deployment()] }, diagnostics: [] })),
            scanDeployment: vi.fn(async () => {
                checked = true;
                return {
                    status: "complete",
                    value: { ...deployment(), updatedAt: 3, freshness: { state: "complete", attemptedAt: 3, lastCompleteAt: 3 } },
                    diagnostics: [],
                };
            }),
            analyzeAssetUsage: vi.fn(async (params) => {
                const result = completeAssetUsage(params);
                return {
                    ...result,
                    value: {
                        ...result.value,
                        relationships: result.value.relationships.map((relationship) => ({
                            ...relationship,
                            observedTargetState:
                                checked && relationship.agentRuntimeId === "CLAUDE_CODE_CLI" ? "already_usable" : "different",
                            managedState: checked && relationship.agentRuntimeId === "CLAUDE_CODE_CLI" ? "applied" : "none",
                        })),
                    },
                };
            }),
        });
        const controller = createController(fake.client);
        renderWithPresentation(
            createElement(CatalogDeploymentWorkspace, {
                controller,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                probeReview: probe,
                providers: [
                    ...DEPLOYMENT_PROVIDERS,
                    {
                        ...DEPLOYMENT_PROVIDERS[0],
                        adapterId: "OPENCODE",
                        displayName: "OpenCode",
                        agentRuntimes: [{ agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" }],
                        targetCapabilities: [
                            { ...DEPLOYMENT_PROVIDERS[0].targetCapabilities[0], agentRuntimeId: "OPENCODE_CLI" },
                        ],
                    },
                ],
                initialAssetId: ASSET_ID,
            }),
        );
        // The controller can settle before React commits its view. Expand only the rendered ready phase.
        await waitFor(() => {
            expect(fake.client.analyzeAssetUsage).toHaveBeenCalledTimes(2);
            expect(document.querySelector(".asset-usage-relationships")?.getAttribute("data-oaam-asset-usage-state")).toBe(
                "ready",
            );
        });
        for (const toggle of document.querySelectorAll<HTMLButtonElement>(
            'button.asset-usage-group-summary[aria-expanded="false"]',
        ))
            fireEvent.click(toggle);
        const row = (runtime: string) => document.querySelector(`.asset-usage-row[data-oaam-agent-runtime-id="${runtime}"]`);
        expect(row("CLAUDE_CODE_CLI")?.getAttribute("data-oaam-asset-usage-target-state")).toBe("different");
        vi.mocked(fake.client.analyzeAssetUsage).mockClear();

        await act(async () => controller.scan(DEPLOYMENT_ID));

        await waitFor(() =>
            expect(row("CLAUDE_CODE_CLI")?.getAttribute("data-oaam-asset-usage-target-state")).toBe("already_usable"),
        );
        expect(row("CLAUDE_CODE_CLI")?.getAttribute("data-oaam-asset-usage-managed")).toBe("applied");
        expect(row("OPENCODE_CLI")?.getAttribute("data-oaam-asset-usage-target-state")).toBe("different");
        expect(fake.client.analyzeAssetUsage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fake.client.analyzeAssetUsage).mock.calls[0]?.[0].consumerAgentRuntimeIds).toEqual(["CLAUDE_CODE_CLI"]);
        expect(fake.client.createDeployment).not.toHaveBeenCalled();
        expect(fake.client.deploy).not.toHaveBeenCalled();
    });
});
