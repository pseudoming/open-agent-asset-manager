import { describe, expect, it } from "vitest";
import {
    isDesktopOperationalDiagnosticCode,
    isDesktopSimpleOperationalDiagnosticCode,
    MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
    MAXIMUM_ORDINARY_LOG_RETENTION_DAYS,
    MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
    MINIMUM_ORDINARY_LOG_RETENTION_DAYS,
    protocolDiagnosticsHealthSchema,
    protocolOperationalDiagnosticRecordSchema,
    protocolOrdinaryLogClearParamsSchema,
    protocolOrdinaryLogSettingsReplaceParamsSchema,
    protocolSupportBundleArtifactSchema,
    protocolSupportBundleExportParamsSchema,
    protocolSupportBundleInspectParamsSchema,
    protocolSupportBundleReviewSchema,
} from "../src";
import {
    protocolAdapterProbeOwnerTimingRecord,
    protocolAdapterProbeSummaryTimingRecordSchema,
} from "../src/operational-diagnostics";

describe("operational diagnostic Protocol models", () => {
    it("accepts only the closed privacy-bounded record branches", () => {
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            }),
        ).toMatchObject({ source: "host", code: "host.lifecycle.ready" });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 2,
                source: "protocol",
                code: "protocol.request.accepted",
                operation: "asset.list",
            }),
        ).toMatchObject({ source: "protocol", operation: "asset.list" });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 2,
                source: "protocol",
                code: "protocol.adapter_probe.owner_timing",
                operationId: "operation-1",
                stage: "provider_probe",
                adapterId: "CLAUDECODE",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                status: "partial",
                startedOffsetMilliseconds: 5,
                endedOffsetMilliseconds: 30,
                elapsedMilliseconds: 25,
            }),
        ).toMatchObject({ adapterId: "CLAUDECODE", status: "partial", elapsedMilliseconds: 25 });
        expect(
            protocolAdapterProbeOwnerTimingRecord.parse({
                schemaVersion: 1,
                occurredAt: 2,
                source: "protocol",
                code: "protocol.adapter_probe.owner_timing",
                operationId: "operation-direct-owner",
                stage: "provider_probe",
                adapterId: "CODEX",
                environment: { platform: "win32", platformInstanceId: "local" },
                status: "complete",
                startedOffsetMilliseconds: 0,
                endedOffsetMilliseconds: 8,
                elapsedMilliseconds: 8,
            }),
        ).toMatchObject({ adapterId: "CODEX", elapsedMilliseconds: 8 });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 2,
                source: "protocol",
                code: "protocol.adapter_probe.summary_timing",
                operationId: "operation-1",
                stage: "provider_probe",
                status: "partial",
                ownerCount: 3,
                elapsedMilliseconds: 60,
                maximumOwnerElapsedMilliseconds: 25,
                overheadMilliseconds: 35,
            }),
        ).toMatchObject({ ownerCount: 3, elapsedMilliseconds: 60, overheadMilliseconds: 35 });
        expect(
            protocolAdapterProbeSummaryTimingRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 2,
                source: "protocol",
                code: "protocol.adapter_probe.summary_timing",
                operationId: "operation-direct-summary",
                stage: "provider_probe",
                status: "complete",
                ownerCount: 1,
                elapsedMilliseconds: 8,
                maximumOwnerElapsedMilliseconds: 8,
                overheadMilliseconds: 0,
            }),
        ).toMatchObject({ ownerCount: 1, elapsedMilliseconds: 8 });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 3,
                source: "protocol",
                code: "protocol.invalid_params",
            }),
        ).toMatchObject({ source: "protocol", code: "protocol.invalid_params" });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 4,
                source: "desktop",
                code: "desktop.host.ready",
            }),
        ).toMatchObject({ source: "desktop", code: "desktop.host.ready" });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 5,
                source: "protocol",
                code: "protocol.request.terminal",
                operation: "asset.list",
                status: "partial",
                diagnosticCodes: ["asset.partial", "asset.warning"],
                operationId: "operation-1",
            }),
        ).toMatchObject({
            source: "protocol",
            status: "partial",
            diagnosticCodes: ["asset.partial", "asset.warning"],
            operationId: "operation-1",
        });
        expect(
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 6,
                source: "desktop",
                code: "desktop.renderer.event",
                event: "failure",
                failureKind: "render",
                surface: "library",
                componentTrail: ["AssetVersionPanel", "ProjectLibraryWorkspace"],
            }),
        ).toMatchObject({ source: "desktop", event: "failure", surface: "library" });

        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "desktop",
                code: "desktop.free_text",
            }),
        ).toThrow();
        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.adapter_probe.owner_timing",
                operationId: "operation-1",
                stage: "provider_probe",
                adapterId: "claudecode",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                status: "complete",
                startedOffsetMilliseconds: 0,
                endedOffsetMilliseconds: 10,
                elapsedMilliseconds: 10,
            }),
        ).toThrow(/bounded machine adapter identifier/u);
        for (const record of [
            {
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.adapter_probe.owner_timing",
                operationId: "operation-1",
                stage: "provider_probe",
                adapterId: "CLAUDECODE",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                status: "complete",
                startedOffsetMilliseconds: 10,
                endedOffsetMilliseconds: 20,
                elapsedMilliseconds: 9,
            },
            {
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.adapter_probe.summary_timing",
                operationId: "operation-1",
                stage: "provider_probe",
                status: "failed",
                ownerCount: 1,
                elapsedMilliseconds: 20,
                maximumOwnerElapsedMilliseconds: 15,
                overheadMilliseconds: 4,
            },
        ]) {
            expect(() => protocolOperationalDiagnosticRecordSchema.parse(record)).toThrow(/exact adapter-probe/u);
        }
        for (const extra of [{ path: "C:\\private" }, { argv: ["--version"] }, { stderr: "private" }, { message: "private" }]) {
            expect(() =>
                protocolOperationalDiagnosticRecordSchema.parse({
                    schemaVersion: 1,
                    occurredAt: 7,
                    source: "protocol",
                    code: "protocol.adapter_probe.owner_timing",
                    operationId: "operation-1",
                    stage: "provider_probe",
                    adapterId: "CLAUDECODE",
                    environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                    status: "failed",
                    startedOffsetMilliseconds: 0,
                    endedOffsetMilliseconds: 10,
                    elapsedMilliseconds: 10,
                    ...extra,
                }),
            ).toThrow(/unknown field/u);
        }
        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.request.accepted",
            }),
        ).toThrow();
        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.request.terminal",
                operation: "asset.list",
                status: "failed",
                diagnosticCodes: ["z.code", "a.code"],
            }),
        ).toThrow(/unique sorted/u);
        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.request.terminal",
                operation: "asset.list",
                status: "failed",
                diagnosticCodes: ["same.code", "same.code"],
            }),
        ).toThrow(/unique sorted/u);
        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "protocol",
                code: "protocol.request.terminal",
                operation: "asset.list",
                status: "failed",
                diagnosticCodes: Array.from({ length: 17 }, (_, index) => `code.${index.toString().padStart(2, "0")}`),
            }),
        ).toThrow(/no more than 16/u);
        expect(() =>
            protocolOperationalDiagnosticRecordSchema.parse({
                schemaVersion: 1,
                occurredAt: 7,
                source: "desktop",
                code: "desktop.renderer.event",
                event: "failure",
                failureKind: "render",
                surface: "library",
                componentTrail: ["AssetVersionPanel", "user/path"],
            }),
        ).toThrow(/component identifier/u);
        for (const component of [null, "", "a".repeat(81)]) {
            expect(() =>
                protocolOperationalDiagnosticRecordSchema.parse({
                    schemaVersion: 1,
                    occurredAt: 7,
                    source: "desktop",
                    code: "desktop.renderer.event",
                    event: "failure",
                    failureKind: "render",
                    surface: "library",
                    componentTrail: [component],
                }),
            ).toThrow(/component identifier/u);
        }
        for (const componentTrail of [["Repeated", "Repeated"], Array.from({ length: 9 }, (_, index) => `Component${index}`)]) {
            expect(() =>
                protocolOperationalDiagnosticRecordSchema.parse({
                    schemaVersion: 1,
                    occurredAt: 7,
                    source: "desktop",
                    code: "desktop.renderer.event",
                    event: "failure",
                    failureKind: "render",
                    surface: "library",
                    componentTrail,
                }),
            ).toThrow(/component identifiers/u);
        }
    });

    it("recognizes only allowlisted Desktop event codes", () => {
        expect(isDesktopOperationalDiagnosticCode("desktop.host.failed")).toBe(true);
        expect(isDesktopOperationalDiagnosticCode("host.startup_failed")).toBe(true);
        expect(isDesktopOperationalDiagnosticCode("desktop.renderer.event")).toBe(true);
        expect(isDesktopSimpleOperationalDiagnosticCode("desktop.host.failed")).toBe(true);
        expect(isDesktopSimpleOperationalDiagnosticCode("desktop.renderer.event")).toBe(false);
        expect(isDesktopOperationalDiagnosticCode("desktop.free_text")).toBe(false);
        expect(isDesktopOperationalDiagnosticCode(1)).toBe(false);
    });

    it("strictly validates finite health without a raw path or message field", () => {
        const value = {
            schemaVersion: 1,
            overallStatus: "unhealthy",
            host: { lifecycleState: "ready", startupMode: "normal" },
            ordinaryLog: {
                state: "suspended",
                suspensionReason: "write_failed",
                retainedBytes: 100,
                maximumBytes: 200,
                segmentCount: 1,
            },
        };
        expect(protocolDiagnosticsHealthSchema.parse(value)).toEqual(value);
        expect(() => protocolDiagnosticsHealthSchema.parse({ ...value, logPath: "/private/profile" })).toThrow(/unknown field/u);
        expect(() =>
            protocolDiagnosticsHealthSchema.parse({
                ...value,
                ordinaryLog: { ...value.ordinaryLog, state: "active" },
            }),
        ).toThrow();
        expect(() =>
            protocolDiagnosticsHealthSchema.parse({
                ...value,
                ordinaryLog: { ...value.ordinaryLog, maximumBytes: 0 },
            }),
        ).toThrow(/positive safe integer/u);
    });

    it("bounds ordinary-log settings and requires exact permanent-removal confirmation", () => {
        for (const value of [
            {
                enabled: false,
                retentionDays: MINIMUM_ORDINARY_LOG_RETENTION_DAYS,
                maximumBytes: MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
            },
            {
                enabled: true,
                retentionDays: MAXIMUM_ORDINARY_LOG_RETENTION_DAYS,
                maximumBytes: MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
            },
        ]) {
            expect(protocolOrdinaryLogSettingsReplaceParamsSchema.parse(value)).toEqual(value);
        }
        for (const value of [
            {
                enabled: true,
                retentionDays: MINIMUM_ORDINARY_LOG_RETENTION_DAYS - 1,
                maximumBytes: MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
            },
            {
                enabled: true,
                retentionDays: MAXIMUM_ORDINARY_LOG_RETENTION_DAYS + 1,
                maximumBytes: MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
            },
            {
                enabled: true,
                retentionDays: MINIMUM_ORDINARY_LOG_RETENTION_DAYS,
                maximumBytes: MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES - 1,
            },
            {
                enabled: true,
                retentionDays: MINIMUM_ORDINARY_LOG_RETENTION_DAYS,
                maximumBytes: MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES + 1,
            },
        ]) {
            expect(() => protocolOrdinaryLogSettingsReplaceParamsSchema.parse(value)).toThrow(
                /positive safe integer|ordinary-log/u,
            );
        }
        expect(protocolOrdinaryLogClearParamsSchema.parse({ confirmedPermanentRemoval: true })).toEqual({
            confirmedPermanentRemoval: true,
        });
        expect(() => protocolOrdinaryLogClearParamsSchema.parse({ confirmedPermanentRemoval: false })).toThrow();
        expect(() =>
            protocolOrdinaryLogClearParamsSchema.parse({
                confirmedPermanentRemoval: true,
                path: "/arbitrary",
            }),
        ).toThrow(/unknown field/u);
    });

    it("requires an explicit support detail mode and a bounded exact review inventory", () => {
        expect(protocolSupportBundleInspectParamsSchema.parse({ mode: "standard" })).toEqual({ mode: "standard" });
        expect(protocolSupportBundleInspectParamsSchema.parse({ mode: "extended" })).toEqual({ mode: "extended" });
        expect(() => protocolSupportBundleInspectParamsSchema.parse({})).toThrow();
        expect(() => protocolSupportBundleInspectParamsSchema.parse({ mode: "automatic" })).toThrow();

        const review = {
            schemaVersion: 1,
            supportBundleReviewToken: "review",
            mode: "standard",
            createdAt: 1,
            archiveByteLength: 2,
            archiveContentHash: "a".repeat(64),
            entries: [
                { archivePath: "README.txt", category: "documentation", byteLength: 1 },
                { archivePath: "diagnostics/adapters.json", category: "adapter_capabilities", byteLength: 1 },
                { archivePath: "diagnostics/health.json", category: "health", byteLength: 1 },
                { archivePath: "diagnostics/ordinary-log.jsonl", category: "ordinary_log", byteLength: 1 },
                { archivePath: "diagnostics/product.json", category: "product", byteLength: 1 },
                { archivePath: "manifest.json", category: "manifest", byteLength: 1 },
            ],
            ordinaryLog: {
                retainedSegmentCount: 1,
                includedSegmentCount: 1,
                retainedBytes: 1,
                includedBytes: 1,
                truncated: false,
            },
        };
        expect(protocolSupportBundleReviewSchema.parse(review)).toEqual(review);
        expect(() =>
            protocolSupportBundleReviewSchema.parse({
                ...review,
                entries: review.entries.slice(0, 5),
            }),
        ).toThrow(/exact standard/u);
        expect(() =>
            protocolSupportBundleReviewSchema.parse({
                ...review,
                entries: review.entries.map((entry, index) => (index === 0 ? { ...entry, archivePath: "duplicate.txt" } : entry)),
            }),
        ).toThrow(/exact standard/u);
        expect(() =>
            protocolSupportBundleReviewSchema.parse({
                ...review,
                entries: review.entries.map((entry, index) => (index === 0 ? { ...entry, category: "product" } : entry)),
            }),
        ).toThrow(/exact standard/u);
        expect(() =>
            protocolSupportBundleReviewSchema.parse({
                ...review,
                ordinaryLog: { ...review.ordinaryLog, includedSegmentCount: 2 },
            }),
        ).toThrow(/consistent/u);
        expect(() =>
            protocolSupportBundleReviewSchema.parse({
                ...review,
                ordinaryLog: { ...review.ordinaryLog, includedBytes: 2 },
            }),
        ).toThrow(/consistent/u);
        expect(() =>
            protocolSupportBundleReviewSchema.parse({
                ...review,
                ordinaryLog: { ...review.ordinaryLog, retainedBytes: 2 },
            }),
        ).toThrow(/consistent/u);
        const extended = {
            ...review,
            mode: "extended",
            entries: [
                ...review.entries.slice(0, 3),
                { archivePath: "diagnostics/locations.json", category: "local_paths", byteLength: 1 },
                ...review.entries.slice(3),
            ],
        };
        expect(protocolSupportBundleReviewSchema.parse(extended, "$.review")).toEqual(extended);
        expect(
            protocolSupportBundleExportParamsSchema.parse({
                supportBundleReviewToken: "review",
                localPathSelectionToken: "path",
                userActionId: "action",
            }),
        ).toMatchObject({ supportBundleReviewToken: "review" });
        expect(
            protocolSupportBundleArtifactSchema.parse({
                schemaVersion: 1,
                mode: "standard",
                createdAt: 1,
                archiveByteLength: 2,
                archiveContentHash: "a".repeat(64),
                entryCount: 6,
            }),
        ).toMatchObject({ entryCount: 6 });
        expect(
            protocolSupportBundleArtifactSchema.parse({
                schemaVersion: 1,
                mode: "extended",
                createdAt: 1,
                archiveByteLength: 2,
                archiveContentHash: "a".repeat(64),
                entryCount: 7,
            }),
        ).toMatchObject({ entryCount: 7 });
        expect(() =>
            protocolSupportBundleArtifactSchema.parse(
                {
                    schemaVersion: 1,
                    mode: "standard",
                    createdAt: 1,
                    archiveByteLength: 2,
                    archiveContentHash: "a".repeat(64),
                    entryCount: 7,
                },
                "$.artifact",
            ),
        ).toThrow(/expected 6/u);
    });
});
