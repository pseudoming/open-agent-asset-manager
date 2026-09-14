import type { ProtocolDiagnosticsHealthV1 } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import { HostReviewRecordCapacityError } from "../src/review-record-store";
import { HostReviewRecords, HostReviewRecordUnavailableError } from "../src/review-records";
import { ProductionHostRuntime } from "../src/host-runtime";
import { createEphemeralOperationalDiagnosticsForTest, type OperationalDiagnostics } from "../src/operational-diagnostics";
import { dispatchSupportBundleLong } from "../src/support-bundle-dispatch";
import {
    buildAndVerifySupportBundle,
    type BuildSupportBundleInput,
    type OperationalSupportLogSnapshot,
    type PreparedSupportBundle,
} from "../src/support-bundle";
import { fakeCoreWith, provider, testStateResilienceIntegration } from "./support/host-test-fixtures";

const LOG_LINE = `${JSON.stringify({
    schemaVersion: 1,
    occurredAt: 1,
    source: "host",
    code: "host.lifecycle.ready",
})}\n`;

function health(): ProtocolDiagnosticsHealthV1 {
    return {
        schemaVersion: 1,
        overallStatus: "healthy",
        host: { lifecycleState: "ready", startupMode: "normal" },
        ordinaryLog: {
            state: "active",
            suspensionReason: "none",
            retainedBytes: LOG_LINE.length,
            maximumBytes: 50 * 1024 * 1024,
            segmentCount: 1,
        },
    };
}

function logSnapshot(): OperationalSupportLogSnapshot {
    const bytes = new TextEncoder().encode(LOG_LINE);
    return {
        bytes,
        retainedSegmentCount: 1,
        includedSegmentCount: 1,
        retainedBytes: bytes.byteLength,
        includedBytes: bytes.byteLength,
        truncated: false,
        locations: {
            oaamRoot: "/profile",
            ordinaryLogRoot: "/profile/logs/ordinary",
            settingsPath: "/profile/logs/ordinary-settings.json",
        },
    };
}

function buildInput(mode: BuildSupportBundleInput["mode"]): BuildSupportBundleInput {
    return {
        mode,
        createdAt: 10,
        product: {
            oaamHostVersion: "0.1.0",
            nodeVersion: "22.14.0",
            platform: "linux",
            architecture: "x64",
        },
        health: health(),
        providers: [provider],
        ordinaryLog: logSnapshot(),
    };
}

function reviewHarness() {
    let storedPayload: unknown;
    const store = {
        put: vi.fn((input: { payload: unknown }) => {
            storedPayload = input.payload;
            return "support-review";
        }),
        get: vi.fn((_token: string, _kind: string, validate: (value: unknown) => boolean) =>
            validate(storedPayload) ? storedPayload : null,
        ),
        remove: vi.fn(() => true),
    };
    return {
        records: new HostReviewRecords(store as never, () => "member"),
        store,
        setStoredPayload(value: unknown) {
            storedPayload = value;
        },
    };
}

function withEntry(prepared: PreparedSupportBundle, entry: unknown): unknown {
    return { ...prepared, entries: [entry, ...prepared.entries.slice(1)] };
}

function withLog(prepared: PreparedSupportBundle, ordinaryLog: unknown): unknown {
    return { ...prepared, ordinaryLog };
}

describe("Host support-bundle dispatch and review authority", () => {
    it("stores, validates, resolves and accepts standard and extended exact prepared archives", async () => {
        const harness = reviewHarness();
        const standard = await buildAndVerifySupportBundle(buildInput("standard"));
        const extended = await buildAndVerifySupportBundle(buildInput("extended"));

        expect(harness.records.recordSupportBundle("connection", standard)).toBe("support-review");
        expect(harness.records.resolveSupportBundle("support-review")).toEqual(standard);
        expect(harness.records.acceptSupportBundle("support-review")).toBe(true);
        expect(harness.store.put).toHaveBeenLastCalledWith({
            kind: "support_bundle",
            ownerConnectionId: "connection",
            replacementKey: "support_bundle",
            payload: standard,
        });

        harness.setStoredPayload(extended);
        expect(harness.records.resolveSupportBundle("support-review")).toEqual(extended);
    });

    it("rejects every malformed top-level prepared-archive boundary", async () => {
        const harness = reviewHarness();
        const prepared = await buildAndVerifySupportBundle(buildInput("standard"));
        const invalidValues: unknown[] = [
            null,
            { ...prepared, extra: true },
            { ...prepared, recordKind: "other" },
            { ...prepared, mode: "other" },
            { ...prepared, createdAt: 1.5 },
            { ...prepared, createdAt: -1 },
            { ...prepared, archiveBytes: [] },
            { ...prepared, archiveBytes: new Uint8Array(16 * 1024 * 1024 + 1) },
            { ...prepared, archiveContentHash: 1 },
            { ...prepared, archiveContentHash: "not-a-hash" },
            { ...prepared, archiveContentHash: "0".repeat(64) },
            { ...prepared, entries: null },
            { ...prepared, entries: prepared.entries.slice(0, 5) },
            { ...prepared, entries: [...prepared.entries, prepared.entries[0], prepared.entries[1]] },
            { ...prepared, ordinaryLog: null },
        ];

        for (const invalid of invalidValues) {
            harness.setStoredPayload(invalid);
            expect(() => harness.records.resolveSupportBundle("support-review")).toThrow(HostReviewRecordUnavailableError);
        }
    });

    it("rejects malformed entry and ordinary-log members instead of accepting partial review state", async () => {
        const harness = reviewHarness();
        const prepared = await buildAndVerifySupportBundle(buildInput("standard"));
        const entry = prepared.entries[0] as PreparedSupportBundle["entries"][number];
        const invalidEntries: unknown[] = [
            null,
            { ...entry, extra: true },
            { ...entry, archivePath: 1 },
            { ...entry, archivePath: "" },
            { ...entry, archivePath: "foreign.txt" },
            { ...entry, category: 1 },
            { ...entry, category: "unknown" },
            { ...entry, category: "product" },
            { ...entry, byteLength: 1.5 },
            { ...entry, byteLength: -1 },
        ];
        for (const invalidEntry of invalidEntries) {
            harness.setStoredPayload(withEntry(prepared, invalidEntry));
            expect(() => harness.records.resolveSupportBundle("support-review")).toThrow(HostReviewRecordUnavailableError);
        }

        const log = prepared.ordinaryLog;
        const invalidLogs: unknown[] = [
            { ...log, extra: true },
            { ...log, retainedSegmentCount: 1.5 },
            { ...log, retainedSegmentCount: -1 },
            { ...log, includedSegmentCount: 1.5 },
            { ...log, includedSegmentCount: -1 },
            { ...log, retainedBytes: 1.5 },
            { ...log, retainedBytes: -1 },
            { ...log, includedBytes: 1.5 },
            { ...log, includedBytes: -1 },
            { ...log, truncated: "false" },
            { ...log, includedSegmentCount: log.retainedSegmentCount + 1 },
            { ...log, includedBytes: log.retainedBytes + 1 },
            { ...log, retainedBytes: log.includedBytes + 1, truncated: false },
        ];
        for (const invalidLog of invalidLogs) {
            harness.setStoredPayload(withLog(prepared, invalidLog));
            expect(() => harness.records.resolveSupportBundle("support-review")).toThrow(HostReviewRecordUnavailableError);
        }
    });

    it("returns the bounded review-capacity failure without exposing the underlying exception", async () => {
        const prepared = await buildAndVerifySupportBundle(buildInput("standard"));
        const result = await dispatchSupportBundleLong(
            {
                id: "inspect",
                method: "diagnostics.support_bundle.inspect",
                params: { mode: "standard" },
            },
            {
                connectionId: "connection",
                pathSelections: { consume: vi.fn() } as never,
                reviews: {
                    recordSupportBundle() {
                        throw new HostReviewRecordCapacityError();
                    },
                } as never,
                integration: {
                    prepareSupportBundle: vi.fn(async () => prepared),
                    publishSupportBundle: vi.fn(),
                },
            },
        );

        expect(result).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.review_record_capacity_exceeded" }],
        });
    });

    it("projects unavailable provider facts for recovery and failed-Core branches while honoring the selected mode", async () => {
        const ephemeral = createEphemeralOperationalDiagnosticsForTest();
        const diagnostics: OperationalDiagnostics = {
            record: vi.fn(),
            health: () => health(),
            settings: () => ephemeral.settings(),
            replaceSettings: (input) => ephemeral.replaceSettings(input),
            clearOrdinaryLog: () => ephemeral.clearOrdinaryLog(),
            captureSupportLogSnapshot: () => logSnapshot(),
        };
        const dependencies = {
            now: () => 10,
            operationalDiagnostics: diagnostics,
            supportProductFacts: buildInput("standard").product,
        };
        const recovery = new ProductionHostRuntime("recovery-host", undefined, testStateResilienceIntegration(), dependencies);
        const failedCore = new ProductionHostRuntime(
            "failed-core-host",
            fakeCoreWith({
                listAdapterProviders: () => ({ status: "failed", diagnostics: [] }),
            }),
            testStateResilienceIntegration(),
            dependencies,
        );
        try {
            const extended = await recovery.prepareSupportBundle("extended");
            const standard = await failedCore.prepareSupportBundle("standard");
            expect(extended.entries).toHaveLength(7);
            expect(standard.entries).toHaveLength(6);
        } finally {
            await recovery.shutdown();
            await failedCore.shutdown();
        }
    });
});
