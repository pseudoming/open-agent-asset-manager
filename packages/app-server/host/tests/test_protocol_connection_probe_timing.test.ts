import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { CoreService } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { ProductionHostRuntime } from "../src/host-runtime";
import { createEphemeralOperationalDiagnosticsForTest, type OperationalDiagnostics } from "../src/operational-diagnostics";
import {
    fakeCoreWith,
    flushHost,
    initializeRequest,
    recordingSink,
    testStateResilienceIntegration,
} from "./support/host-test-fixtures";

describe("Production Host adapter probe timing route", () => {
    it("records owner outcomes and exact concurrent wall overhead before terminal", async () => {
        const operational = recordingOperationalDiagnostics();
        const platformContext = { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: "/" };
        const probeAdapters = vi.fn(
            async (
                _input: Parameters<CoreService["probeAdapters"]>[0],
                observer?: Parameters<CoreService["probeAdapters"]>[1],
            ) => {
                observer?.({ stage: "provider_probe", completedUnits: 0, totalUnits: 3 });
                for (const [index, [adapterId, outcome, elapsedMilliseconds]] of (
                    [
                        ["CLAUDECODE", "complete", 25],
                        ["CODEX", "partial", 10],
                        ["CURSOR", "failed", 20],
                    ] as const
                ).entries()) {
                    observer?.({
                        stage: "provider_probe",
                        completedUnits: index + 1,
                        totalUnits: 3,
                        adapterId,
                        platformContext,
                        outcome,
                        elapsedMilliseconds,
                    });
                }
                return { status: "complete" as const, value: [], diagnostics: [] };
            },
        );
        const monotonicTimes = [100, 130, 135, 140, 160];
        const runtime = new ProductionHostRuntime(
            "host-probe-timing",
            fakeCoreWith({
                getAvailablePlatformContexts: () => ({ status: "complete", value: [platformContext], diagnostics: [] }),
                probeAdapters,
            }),
            testStateResilienceIntegration(),
            {
                createConnectionId: () => "connection-probe-timing",
                createOperationId: () => "operation-probe-timing",
                operationalDiagnostics: operational.diagnostics,
                monotonicNow: () => monotonicTimes.shift() ?? 160,
            },
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive(
            createProtocolRequest("probe", "adapter.probe", {
                adapterIds: ["CLAUDECODE", "CODEX", "CURSOR"],
                environments: [{ platform: "wsl", platformInstanceId: "Ubuntu" }],
                authorization: { scope: "global" },
            }),
        );
        await flushHost();
        await flushHost();

        const records = operational.record.mock.calls.map(([input]) => input);
        expect(records.filter((record) => record.code === "protocol.adapter_probe.owner_timing")).toEqual([
            expect.objectContaining({
                adapterId: "CLAUDECODE",
                status: "complete",
                startedOffsetMilliseconds: 5,
                endedOffsetMilliseconds: 30,
                elapsedMilliseconds: 25,
            }),
            expect.objectContaining({
                adapterId: "CODEX",
                status: "partial",
                startedOffsetMilliseconds: 25,
                endedOffsetMilliseconds: 35,
                elapsedMilliseconds: 10,
            }),
            expect.objectContaining({
                adapterId: "CURSOR",
                status: "failed",
                startedOffsetMilliseconds: 20,
                endedOffsetMilliseconds: 40,
                elapsedMilliseconds: 20,
            }),
        ]);
        expect(records).toContainEqual({
            source: "protocol",
            code: "protocol.adapter_probe.summary_timing",
            operationId: "operation-probe-timing",
            stage: "provider_probe",
            status: "complete",
            ownerCount: 3,
            elapsedMilliseconds: 60,
            maximumOwnerElapsedMilliseconds: 25,
            overheadMilliseconds: 35,
        });
        const summaryIndex = records.findIndex((record) => record.code === "protocol.adapter_probe.summary_timing");
        const terminalIndex = records.findIndex(
            (record) => record.code === "protocol.request.terminal" && record.operation === "adapter.probe",
        );
        expect(summaryIndex).toBeGreaterThan(-1);
        expect(terminalIndex).toBeGreaterThan(summaryIndex);
        await runtime.shutdown();
    });
});

function recordingOperationalDiagnostics(): {
    readonly diagnostics: OperationalDiagnostics;
    readonly record: ReturnType<typeof vi.fn>;
} {
    const base = createEphemeralOperationalDiagnosticsForTest();
    const record = vi.fn((input: Parameters<OperationalDiagnostics["record"]>[0]) => base.record(input));
    return {
        record,
        diagnostics: {
            record,
            health: (state, startupDisposition) => base.health(state, startupDisposition),
            settings: () => base.settings(),
            replaceSettings: (input) => base.replaceSettings(input),
            clearOrdinaryLog: () => base.clearOrdinaryLog(),
            captureSupportLogSnapshot: (maximumBytes) => base.captureSupportLogSnapshot(maximumBytes),
        },
    };
}
