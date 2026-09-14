import { createProtocolRequest, type ProtocolNotificationV1 } from "@oaam/app-server-protocol";
import type { CoreResult } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import {
    ASSET_ID,
    PROJECT_ID,
    VERSION_ID,
    fakeCoreWith,
    flushHost,
    host,
    initializeRequest,
    recordingSink,
    required,
} from "./support/host-test-fixtures";
import { h2Deployment, h2ProbeResult } from "./support/h2-review-fixtures";

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

describe("H2 directory-target Protocol dispatch", () => {
    it("preserves Project and Global ownership while forwarding an explicit directory target to Core", async () => {
        const probe = h2ProbeResult();
        const target = required(probe.observation.targetCandidates[0], "directory target candidate");
        target.targetKind = "directory";
        target.targetRootPath = "/runtime-owned-target";
        const getAvailablePlatformContexts = vi.fn(() =>
            complete([{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/trusted" }]),
        );
        const probeAdapters = vi.fn(async () => complete([probe]));
        const createDeployment = vi.fn(() => complete(h2Deployment()));
        const runtime = host(fakeCoreWith({ getAvailablePlatformContexts, probeAdapters, createDeployment }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive(
            createProtocolRequest("probe-directory", "adapter.probe", {
                adapterIds: ["CLAUDECODE"],
                environments: [{ platform: "linux", platformInstanceId: "local" }],
                authorization: { scope: "global" },
            }),
        );
        await settle();
        const review = (terminal(sink, "adapter.probe") as { value: unknown }).value as {
            probeToken: string;
            results: { rowId: string; targets: { rowId: string }[] }[];
        };
        const resultRow = required(review.results[0], "directory probe result row");
        const targetRow = required(resultRow.targets[0], "directory target row");
        const base = {
            probeToken: review.probeToken,
            probeResultRowId: resultRow.rowId,
            targetRowId: targetRow.rowId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        };

        connection.receive(
            createProtocolRequest("directory-project", "deployment.create", {
                ...base,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
            }),
        );
        connection.receive(
            createProtocolRequest("directory-global", "deployment.create", {
                ...base,
                subject: { subjectKind: "global" },
            }),
        );
        await settle();
        expect(createDeployment.mock.calls).toEqual([
            [
                {
                    projectId: PROJECT_ID,
                    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    platform: "linux",
                    platformInstanceId: "local",
                    targetRootPath: "/runtime-owned-target",
                    assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
                },
            ],
            [
                {
                    projectId: "",
                    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    platform: "linux",
                    platformInstanceId: "local",
                    targetRootPath: "/runtime-owned-target",
                    assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
                },
            ],
        ]);
        await runtime.shutdown();
    });
});
