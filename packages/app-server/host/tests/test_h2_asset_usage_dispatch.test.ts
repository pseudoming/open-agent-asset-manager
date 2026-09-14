import { createProtocolRequest, type ProtocolNotificationV1 } from "@oaam/app-server-protocol";
import type { CoreResult } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { projectAssetUsage } from "../src/render-projection";
import { h2Deployment as deployment, h2ProbeResult as probeResult } from "./support/h2-review-fixtures";
import {
    ASSET_ID,
    fakeCoreWith,
    flushHost,
    host,
    initializeRequest,
    PROJECT_ID,
    recordingSink,
    required,
    VERSION_ID,
} from "./support/host-test-fixtures";

function complete<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}

async function settle(): Promise<void> {
    await flushHost();
    await flushHost();
}

function terminal(sink: ReturnType<typeof recordingSink>, operation: string) {
    const notification = [...sink.messages]
        .reverse()
        .find(
            (message): message is ProtocolNotificationV1 =>
                "method" in message && message.method === "operation.terminal" && message.params.operation === operation,
        );
    expect(notification).toBeDefined();
    return (notification as Extract<ProtocolNotificationV1, { method: "operation.terminal" }>).params.outcome;
}

describe("H2 read-only Asset usage dispatch", () => {
    it("projects a structured substitute AssetKind without interpreting Provider reason codes", () => {
        const projected = projectAssetUsage(
            {
                schemaVersion: 2,
                assetId: ASSET_ID as never,
                versionId: VERSION_ID as never,
                relationships: [
                    {
                        agentRuntimeId: "CODEX_CLI" as never,
                        capability: "substitute",
                        observedTargetState: "absent",
                        managedState: "none",
                        substitute: { assetKind: "Skill" },
                        deploymentIds: [],
                        appliedDeploymentIds: [],
                        degradationKinds: ["target_runtime_missing_asset_kind"],
                        reasonCodes: ["provider_private_reason"],
                        diagnostics: [
                            {
                                severity: "warning",
                                code: "provider_private_reason",
                                operation: "render",
                                causeKind: "partial",
                                message: "Exact consumer conversion detail",
                                path: "",
                                traceId: "",
                                retryable: false,
                                suggestedActions: [],
                                rawSummary: "private internal detail",
                            },
                        ],
                        requiresReview: true,
                    },
                ],
            },
            { assetId: ASSET_ID, versionId: VERSION_ID, agentRuntimeIds: ["CODEX_CLI"] },
        );

        expect(projected.relationships[0]).toMatchObject({
            capability: "substitute",
            substitute: { assetKind: "Skill" },
            reasonCodes: ["provider_private_reason"],
            diagnostics: [
                {
                    severity: "warning",
                    code: "provider_private_reason",
                    operation: "render",
                    causeKind: "partial",
                    message: "Exact consumer conversion detail",
                    retryable: false,
                    suggestedActions: [],
                },
            ],
        });
        expect(projected.relationships[0]!.diagnostics[0]).not.toHaveProperty("rawSummary");
    });

    it("binds exact retained targets and rejects forged rows or mismatched Core projections", async () => {
        const probe = probeResult();
        const getAvailablePlatformContexts = vi.fn(() =>
            complete([{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/trusted" }]),
        );
        const probeAdapters = vi.fn(async () => complete([probe]));
        const analyzeAssetUsage = vi.fn(async () =>
            complete({
                schemaVersion: 2 as const,
                assetId: ASSET_ID as never,
                versionId: VERSION_ID as never,
                relationships: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI" as never,
                        capability: "direct" as const,
                        observedTargetState: "already_usable" as const,
                        managedState: "none" as const,
                        substitute: null,
                        deploymentIds: [],
                        appliedDeploymentIds: [],
                        degradationKinds: [],
                        reasonCodes: ["project_guidance_preserved_native_file"],
                        diagnostics: [],
                        requiresReview: false,
                    },
                ],
            }),
        );
        const createDeployment = vi.fn(() => complete(deployment()));
        const runtime = host(fakeCoreWith({ getAvailablePlatformContexts, probeAdapters, analyzeAssetUsage, createDeployment }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive(
            createProtocolRequest("probe", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "linux", platformInstanceId: "local" }],
                authorization: { scope: "global" },
            }),
        );
        await settle();
        const probeReview = (terminal(sink, "adapter.probe") as { value: unknown }).value as {
            probeToken: string;
            results: { rowId: string; targets: { rowId: string }[] }[];
        };
        const probeRow = required(probeReview.results[0], "probe result row");
        const targetRow = required(probeRow.targets[0], "target row");
        const params = {
            probeToken: probeReview.probeToken,
            probeResultRowId: probeRow.rowId,
            targetRowId: targetRow.rowId,
            subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        };

        connection.receive(createProtocolRequest("asset-usage", "asset_usage.analyze", params));
        await settle();
        expect(terminal(sink, "asset_usage.analyze")).toMatchObject({
            status: "complete",
            value: {
                relationships: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        capability: "direct",
                        observedTargetState: "already_usable",
                        managedState: "none",
                    },
                ],
            },
        });
        expect(analyzeAssetUsage).toHaveBeenCalledWith({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: "/project",
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
            currentProbeResults: [probe],
        });
        expect(createDeployment).not.toHaveBeenCalled();

        connection.receive(
            createProtocolRequest("asset-usage-forged", "asset_usage.analyze", {
                ...params,
                targetRowId: "not-a-retained-target",
            }),
        );
        await settle();
        expect(terminal(sink, "asset_usage.analyze")).toMatchObject({ status: "failed" });
        expect(analyzeAssetUsage).toHaveBeenCalledTimes(1);

        analyzeAssetUsage.mockResolvedValueOnce(
            complete({
                schemaVersion: 2 as const,
                assetId: ASSET_ID as never,
                versionId: VERSION_ID as never,
                relationships: [],
            }),
        );
        connection.receive(createProtocolRequest("asset-usage-mismatched", "asset_usage.analyze", params));
        await settle();
        expect(terminal(sink, "asset_usage.analyze")).toMatchObject({ status: "failed" });
        expect(analyzeAssetUsage).toHaveBeenCalledTimes(2);
        const firstOperationProbeResults = analyzeAssetUsage.mock.calls[0]?.[0].currentProbeResults;
        const secondOperationProbeResults = analyzeAssetUsage.mock.calls[1]?.[0].currentProbeResults;
        expect(firstOperationProbeResults).toBe(secondOperationProbeResults);
        expect(Object.isFrozen(firstOperationProbeResults)).toBe(true);

        const globalProbe = probeResult();
        const globalTarget = required(globalProbe.observation.targetCandidates[0], "global target");
        globalProbe.observation.targetCandidates[0] = { ...globalTarget, targetKind: "global" };
        probeAdapters.mockResolvedValueOnce(complete([globalProbe]));
        connection.receive(
            createProtocolRequest("global-probe", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "linux", platformInstanceId: "local" }],
                authorization: { scope: "global" },
            }),
        );
        await settle();
        const globalReview = (terminal(sink, "adapter.probe") as { value: unknown }).value as {
            probeToken: string;
            results: { rowId: string; targets: { rowId: string }[] }[];
        };
        const globalProbeRow = required(globalReview.results[0], "global probe result row");
        const globalTargetRow = required(globalProbeRow.targets[0], "global target row");
        connection.receive(
            createProtocolRequest("asset-usage-target-kind-mismatch", "asset_usage.analyze", {
                ...params,
                probeToken: globalReview.probeToken,
                probeResultRowId: globalProbeRow.rowId,
                targetRowId: globalTargetRow.rowId,
            }),
        );
        await settle();
        expect(terminal(sink, "asset_usage.analyze")).toMatchObject({ status: "failed" });
        expect(analyzeAssetUsage).toHaveBeenCalledTimes(2);

        connection.receive(
            createProtocolRequest("asset-usage-global", "asset_usage.analyze", {
                ...params,
                probeToken: globalReview.probeToken,
                probeResultRowId: globalProbeRow.rowId,
                targetRowId: globalTargetRow.rowId,
                subject: { subjectKind: "global" },
            }),
        );
        await settle();
        expect(terminal(sink, "asset_usage.analyze")).toMatchObject({ status: "complete" });
        expect(analyzeAssetUsage).toHaveBeenLastCalledWith({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: "/project",
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
            currentProbeResults: [globalProbe],
        });
        expect(analyzeAssetUsage.mock.calls.at(-1)?.[0].currentProbeResults).not.toBe(firstOperationProbeResults);
        await runtime.shutdown();
    });
});
