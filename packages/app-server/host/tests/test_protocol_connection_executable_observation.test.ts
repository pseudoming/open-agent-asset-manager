import type { OperationalDiagnostics } from "../src/operational-diagnostics";
import { describe, expect, it, vi } from "vitest";
import { projectDiagnostic, projectedOutcomeOperationalDiagnosticCodes } from "../src/core-outcome";
import { ProductionHostRuntime } from "../src/host-runtime";
import { createEphemeralOperationalDiagnosticsForTest } from "../src/operational-diagnostics";
import {
    fakeCoreWith,
    flushHost,
    initializeRequest,
    recordingSink,
    testStateResilienceIntegration,
} from "./support/host-test-fixtures";

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

describe("Protocol executable-observation evidence", () => {
    it("projects schema 3 timing and bounded output hashes while rejecting malformed evidence", () => {
        const rawSummary = JSON.stringify({
            schemaVersion: 3,
            stage: "runtime_observation",
            failure: "other",
            ownerCode: "runtime_observation_protocol_failed",
            exitKind: "zero",
            identity: "stable",
            timeout: "within_bound",
            cleanup: "complete",
            elapsedMilliseconds: 13,
            stdoutByteCount: 6,
            stdoutSha256: `sha256:${"a".repeat(64)}`,
            stderrByteCount: 0,
            stderrSha256: `sha256:${"b".repeat(64)}`,
        });
        const projected = projectDiagnostic({
            severity: "warning",
            code: "antigravity_cli_version_observation_failed",
            message: "bounded failure",
            path: "",
            traceId: "",
            operation: "probe",
            causeKind: "partial",
            retryable: true,
            suggestedActions: ["retry"],
            rawSummary,
        });
        expect(projectedOutcomeOperationalDiagnosticCodes({ diagnostics: [projected] })).toEqual([
            `provider.executable_observation.v3:stage=runtime_observation:owner=runtime_observation_protocol_failed:failure=other:exit=zero:identity=stable:timeout=within_bound:cleanup=complete:elapsed_ms=13:stdout=6@sha256:${"a".repeat(64)}:stderr=0@sha256:${"b".repeat(64)}`,
        ]);

        const unavailableOutput = projectDiagnostic({
            severity: "warning",
            code: "unavailable-output",
            message: "bounded failure",
            path: "",
            traceId: "",
            operation: "probe",
            causeKind: "partial",
            retryable: false,
            suggestedActions: [],
            rawSummary: JSON.stringify({
                ...JSON.parse(rawSummary),
                stdoutByteCount: null,
                stdoutSha256: null,
                stderrByteCount: null,
                stderrSha256: null,
            }),
        });
        expect(projectedOutcomeOperationalDiagnosticCodes({ diagnostics: [unavailableOutput] })).toEqual([
            "provider.executable_observation.v3:stage=runtime_observation:owner=runtime_observation_protocol_failed:failure=other:exit=zero:identity=stable:timeout=within_bound:cleanup=complete:elapsed_ms=13:stdout=unavailable:stderr=unavailable",
        ]);

        const malformed = projectDiagnostic({
            severity: "warning",
            code: "malformed",
            message: "bounded failure",
            path: "",
            traceId: "",
            operation: "probe",
            causeKind: "partial",
            retryable: false,
            suggestedActions: [],
            rawSummary: rawSummary.replace(`sha256:${"a".repeat(64)}`, "private-output"),
        });
        expect(projectedOutcomeOperationalDiagnosticCodes({ diagnostics: [malformed] })).toEqual([]);
        const halfUnavailable = projectDiagnostic({
            ...malformed,
            code: "half-unavailable",
            rawSummary: JSON.stringify({ ...JSON.parse(rawSummary), stdoutByteCount: null }),
        });
        expect(projectedOutcomeOperationalDiagnosticCodes({ diagnostics: [halfUnavailable] })).toEqual([]);
    });

    it("retains bounded facts only in the ordinary terminal receipt", async () => {
        const rawSummary = JSON.stringify({
            schemaVersion: 2,
            stage: "host_invocation",
            failure: "timed_out",
            ownerCode: "host_timeout",
            exitKind: "unavailable",
            identity: "unverified",
            timeout: "expired",
            cleanup: "unverified",
        });
        const operational = recordingOperationalDiagnostics();
        const runtime = new ProductionHostRuntime(
            "host-observation-receipt",
            fakeCoreWith({
                reindexAssets: () => ({
                    status: "partial",
                    value: { scannedAssets: 0, indexedAssets: 0, skippedAssets: 0, diagnostics: [] },
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "claudecode_cli_version_observation_timed_out",
                            message: "The exact CLI version check did not finish within its bounded time",
                            path: "",
                            traceId: "",
                            operation: "probe",
                            causeKind: "partial",
                            retryable: true,
                            suggestedActions: ["retry"],
                            rawSummary,
                        },
                    ],
                }),
            }),
            testStateResilienceIntegration(),
            {
                createConnectionId: () => "connection-observation-receipt",
                createOperationId: () => "operation-observation-receipt",
                operationalDiagnostics: operational.diagnostics,
            },
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "observation-receipt", method: "asset.reindex", params: {} });
        await flushHost();
        await flushHost();

        expect(JSON.stringify(sink.messages)).not.toContain(rawSummary);
        expect(operational.record.mock.calls.map(([input]) => input)).toContainEqual({
            source: "protocol",
            code: "protocol.request.terminal",
            operation: "asset.reindex",
            status: "partial",
            diagnosticCodes: [
                "claudecode_cli_version_observation_timed_out",
                "provider.executable_observation.v2:stage=host_invocation:owner=host_timeout:failure=timed_out:exit=unavailable:identity=unverified:timeout=expired:cleanup=unverified",
            ],
            operationId: "operation-observation-receipt",
        });
        await runtime.shutdown();
    });
});
