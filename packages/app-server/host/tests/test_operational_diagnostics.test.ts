import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type PhysicalPathIdentity, SafeFilesystemError } from "@oaam/shared/filesystem";
import { describe, expect, it, vi } from "vitest";
import {
    createEphemeralOperationalDiagnosticsForTest,
    DEFAULT_OPERATIONAL_LOG_MAXIMUM_BYTES,
    HostOperationalDiagnostics,
    type OperationalDiagnosticsDependencies,
} from "../src/operational-diagnostics";

const HEX_ID = "0123456789abcdef0123456789abcdef";
const FILE_IDENTITY: PhysicalPathIdentity = Object.freeze({
    deviceId: "1",
    fileId: "10",
    entryKind: "file",
});
const SECOND_FILE_IDENTITY: PhysicalPathIdentity = Object.freeze({
    deviceId: "1",
    fileId: "11",
    entryKind: "file",
});

function temporaryRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "oaam-operational-log-"));
}

function logFiles(root: string): string[] {
    return fs.readdirSync(path.join(root, "logs", "ordinary")).sort();
}

function recordLines(root: string): unknown[] {
    return logFiles(root).flatMap((name) => {
        const text = fs.readFileSync(path.join(root, "logs", "ordinary", name), "utf8");
        return text
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown);
    });
}

function fakeFilesystem(
    overrides: Partial<NonNullable<OperationalDiagnosticsDependencies["filesystem"]>> = {},
): NonNullable<OperationalDiagnosticsDependencies["filesystem"]> {
    return {
        durableEnsureDirectory: vi.fn(),
        inventoryDirectoryNoFollow: vi.fn(() => ({ entries: [] })),
        readRegularFileNoFollow: vi.fn((filePath) => {
            throw new SafeFilesystemError({
                failureKind: "not_found",
                operation: "read_regular_file",
                targetPath: filePath,
                message: "missing test fixture",
            });
        }),
        durableCreateFile: vi.fn(() => FILE_IDENTITY),
        durableReplaceFile: vi.fn(() => FILE_IDENTITY),
        permanentlyRemoveRegularFileIfIdentity: vi.fn(() => true),
        ...overrides,
    };
}

function segmentRead(bytes: Uint8Array, identity = FILE_IDENTITY) {
    return vi.fn((filePath: string) => {
        if (filePath.endsWith("ordinary-settings.json")) {
            throw new SafeFilesystemError({
                failureKind: "not_found",
                operation: "read_regular_file",
                targetPath: filePath,
                message: "settings are absent",
            });
        }
        return { bytes, identity };
    });
}

function encodedSettings(input: {
    readonly enabled: boolean;
    readonly retentionDays: number;
    readonly maximumBytes: number;
}): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify({ schemaVersion: 1, ...input })}\n`);
}

describe("Host operational diagnostics", () => {
    it("writes only closed records to one durable bounded segment and reopens it as retained evidence", () => {
        const root = temporaryRoot();
        const logger = new HostOperationalDiagnostics(root, {
            now: () => 10,
            createSegmentId: () => HEX_ID,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        logger.record({ source: "protocol", code: "protocol.request.accepted", operation: "asset.list" });
        logger.record({ source: "protocol", code: "protocol.invalid_params" });
        logger.record({ source: "desktop", code: "desktop.host.ready" });

        expect(logFiles(root)).toEqual([`ordinary-10-${HEX_ID}.jsonl`]);
        expect(recordLines(root)).toEqual([
            { schemaVersion: 1, occurredAt: 10, source: "host", code: "host.lifecycle.ready" },
            {
                schemaVersion: 1,
                occurredAt: 10,
                source: "protocol",
                code: "protocol.request.accepted",
                operation: "asset.list",
            },
            { schemaVersion: 1, occurredAt: 10, source: "protocol", code: "protocol.invalid_params" },
            { schemaVersion: 1, occurredAt: 10, source: "desktop", code: "desktop.host.ready" },
        ]);
        const health = logger.health("ready", { mode: "normal" });
        expect(health).toMatchObject({
            overallStatus: "healthy",
            ordinaryLog: { state: "active", segmentCount: 1 },
        });

        const reopened = new HostOperationalDiagnostics(root, {
            now: () => 11,
            createSegmentId: () => "fedcba9876543210fedcba9876543210",
        });
        expect(reopened.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "active",
            retainedBytes: health.ordinaryLog.retainedBytes,
            segmentCount: 1,
        });
        reopened.record({ source: "host", code: "host.connection.opened" });
        expect(logFiles(root)).toHaveLength(2);
    });

    it("captures the newest complete segments within an exact support bound and reports only Host-owned locations", () => {
        const root = temporaryRoot();
        let now = 10;
        let id = 0;
        const logger = new HostOperationalDiagnostics(root, {
            now: () => now++,
            createSegmentId: () => (++id).toString(16).padStart(32, "0"),
            maximumSegmentBytes: 120,
            maximumBytes: 1_000,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        logger.record({ source: "protocol", code: "protocol.invalid_params" });
        logger.record({ source: "desktop", code: "desktop.host.ready" });

        const health = logger.health("ready", { mode: "normal" });
        const names = logFiles(root);
        const newestSegmentBytes = fs.statSync(path.join(root, "logs", "ordinary", names[names.length - 1] as string)).size;
        const snapshot = logger.captureSupportLogSnapshot(newestSegmentBytes);

        expect(snapshot).toMatchObject({
            retainedSegmentCount: health.ordinaryLog.segmentCount,
            includedSegmentCount: 1,
            retainedBytes: health.ordinaryLog.retainedBytes,
            includedBytes: newestSegmentBytes,
            truncated: true,
            locations: {
                oaamRoot: root,
                ordinaryLogRoot: path.join(root, "logs", "ordinary"),
                settingsPath: path.join(root, "logs", "ordinary-settings.json"),
            },
        });
        expect(new TextDecoder().decode(snapshot.bytes)).toContain("desktop.host.ready");
        expect(() => logger.captureSupportLogSnapshot(0)).toThrow(/positive safe integer/u);
    });

    it("fails support capture closed when action-time inventory becomes unsafe", () => {
        const inventory = vi
            .fn()
            .mockReturnValueOnce({ entries: [] })
            .mockImplementationOnce(() => {
                throw new TypeError("unsafe inventory");
            });
        const logger = new HostOperationalDiagnostics("/profile", {
            filesystem: fakeFilesystem({ inventoryDirectoryNoFollow: inventory }),
        });
        expect(() => logger.captureSupportLogSnapshot(1_024)).toThrow(/unsafe inventory/u);
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "suspended",
            suspensionReason: "unsafe_storage",
        });
    });

    it("rotates before a segment bound and removes oldest segments before exceeding the aggregate budget", () => {
        const root = temporaryRoot();
        let id = 0;
        const logger = new HostOperationalDiagnostics(root, {
            now: () => 20 + id,
            createSegmentId: () => `${String(id++).padStart(32, "0")}`,
            maximumSegmentBytes: 160,
            maximumBytes: 360,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        logger.record({ source: "host", code: "host.connection.opened" });
        logger.record({ source: "host", code: "host.connection.closed" });
        logger.record({ source: "host", code: "host.lifecycle.draining" });
        logger.record({ source: "host", code: "host.lifecycle.stopped" });
        const health = logger.health("ready", { mode: "normal" });
        expect(health.ordinaryLog).toMatchObject({ state: "active", suspensionReason: "none" });
        expect(health.ordinaryLog.retainedBytes).toBeLessThanOrEqual(360);
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "active",
            suspensionReason: "none",
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.retainedBytes).toBeLessThanOrEqual(360);
    });

    it("reports recovery and non-ready lifecycle without turning those states into logging failures", () => {
        const root = temporaryRoot();
        const logger = new HostOperationalDiagnostics(root);
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        expect(logger.health("ready", { mode: "state_recovery", reason: "missing_database" }).overallStatus).toBe("degraded");
        expect(logger.health("draining", { mode: "normal" }).overallStatus).toBe("degraded");
        expect(logger.health("stopped", { mode: "normal" }).overallStatus).toBe("unhealthy");
        expect(logger.health("failed", { mode: "normal" }).overallStatus).toBe("unhealthy");

        const ephemeral = createEphemeralOperationalDiagnosticsForTest();
        ephemeral.record({ source: "host", code: "host.lifecycle.ready" });
        expect(ephemeral.health("ready", { mode: "normal" })).toMatchObject({
            overallStatus: "healthy",
            ordinaryLog: {
                state: "disabled",
                suspensionReason: "user_disabled",
                maximumBytes: DEFAULT_OPERATIONAL_LOG_MAXIMUM_BYTES,
            },
        });
        expect(ephemeral.settings()).toMatchObject({ status: "failed" });
        expect(
            ephemeral.replaceSettings({
                enabled: true,
                retentionDays: 14,
                maximumBytes: 50 * 1024 * 1024,
            }),
        ).toMatchObject({ status: "failed" });
        expect(ephemeral.clearOrdinaryLog()).toMatchObject({ status: "failed" });
        expect(ephemeral.captureSupportLogSnapshot(1_024)).toEqual({
            bytes: new Uint8Array(),
            retainedSegmentCount: 0,
            includedSegmentCount: 0,
            retainedBytes: 0,
            includedBytes: 0,
            truncated: false,
            locations: null,
        });
    });

    it("persists exact settings, disables writes, and re-enables them after a whole-setting replacement", () => {
        const root = temporaryRoot();
        const logger = new HostOperationalDiagnostics(root, {
            now: () => 100,
            createSegmentId: () => HEX_ID,
        });
        expect(logger.settings()).toMatchObject({
            status: "complete",
            value: {
                schemaVersion: 1,
                enabled: true,
                retentionDays: 14,
                maximumBytes: 50 * 1024 * 1024,
            },
        });

        expect(
            logger.replaceSettings({
                enabled: false,
                retentionDays: 7,
                maximumBytes: 1024 * 1024,
            }),
        ).toMatchObject({
            status: "complete",
            value: { enabled: false, retentionDays: 7, maximumBytes: 1024 * 1024 },
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        expect(logFiles(root)).toEqual([]);
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "disabled",
            suspensionReason: "user_disabled",
        });
        expect(JSON.parse(fs.readFileSync(path.join(root, "logs", "ordinary-settings.json"), "utf8"))).toEqual({
            schemaVersion: 1,
            enabled: false,
            retentionDays: 7,
            maximumBytes: 1024 * 1024,
        });

        const reopened = new HostOperationalDiagnostics(root, {
            now: () => 101,
            createSegmentId: () => HEX_ID,
        });
        expect(reopened.health("ready", { mode: "normal" }).ordinaryLog.state).toBe("disabled");
        expect(
            reopened.replaceSettings({
                enabled: true,
                retentionDays: 7,
                maximumBytes: 1024 * 1024,
            }),
        ).toMatchObject({ status: "complete", value: { enabled: true } });
        reopened.record({ source: "host", code: "host.lifecycle.ready" });
        expect(logFiles(root)).toEqual([`ordinary-101-${HEX_ID}.jsonl`]);
    });

    it("permanently clears every retained owned segment and reports exact removed counts", () => {
        const root = temporaryRoot();
        let timestamp = 200;
        let segment = 0;
        const logger = new HostOperationalDiagnostics(root, {
            now: () => timestamp++,
            createSegmentId: () => `${String(segment++).padStart(32, "0")}`,
            maximumSegmentBytes: 100,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        logger.record({ source: "host", code: "host.connection.opened" });
        const before = logger.health("ready", { mode: "normal" }).ordinaryLog;
        expect(before.segmentCount).toBeGreaterThan(0);

        expect(logger.clearOrdinaryLog()).toEqual({
            status: "complete",
            value: {
                removedSegmentCount: before.segmentCount,
                removedBytes: before.retainedBytes,
                settings: {
                    schemaVersion: 1,
                    enabled: true,
                    retentionDays: 14,
                    maximumBytes: 50 * 1024 * 1024,
                },
            },
            diagnostics: [],
        });
        expect(logFiles(root)).toEqual([]);
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "active",
            retainedBytes: 0,
            segmentCount: 0,
        });
    });

    it("removes segments older than the configured retention ceiling when the Host reopens", () => {
        const root = temporaryRoot();
        const logger = new HostOperationalDiagnostics(root, {
            now: () => 0,
            createSegmentId: () => HEX_ID,
        });
        expect(
            logger.replaceSettings({
                enabled: true,
                retentionDays: 1,
                maximumBytes: 1024 * 1024,
            }),
        ).toMatchObject({ status: "complete" });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        expect(logFiles(root)).toHaveLength(1);

        const reopened = new HostOperationalDiagnostics(root, {
            now: () => 86_400_001,
        });
        expect(logFiles(root)).toEqual([]);
        expect(reopened.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "active",
            retainedBytes: 0,
            segmentCount: 0,
        });
    });

    it("fails a clear operation without widening deletion when exact identity-bound removal is not proven", () => {
        const line = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        const remove = vi.fn(() => false);
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity: FILE_IDENTITY }],
            })),
            readRegularFileNoFollow: segmentRead(line),
            permanentlyRemoveRegularFileIfIdentity: remove,
        });
        const logger = new HostOperationalDiagnostics("/profile", {
            now: () => 1,
            filesystem,
        });

        expect(logger.clearOrdinaryLog()).toMatchObject({
            status: "partial",
            value: { removedSegmentCount: 0, removedBytes: 0 },
            diagnostics: [{ code: "host.ordinary_log_cleanup_failed" }],
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "suspended",
            suspensionReason: "cleanup_failed",
            segmentCount: 1,
        });
        expect(remove).toHaveBeenCalledWith(
            path.join("/profile", "logs", "ordinary", `ordinary-1-${HEX_ID}.jsonl`),
            FILE_IDENTITY,
        );
    });

    it("treats malformed persisted settings as unsafe instead of falling back to defaults", () => {
        const root = temporaryRoot();
        fs.mkdirSync(path.join(root, "logs"), { recursive: true });
        fs.writeFileSync(path.join(root, "logs", "ordinary-settings.json"), '{"enabled":true}\n');
        const logger = new HostOperationalDiagnostics(root);

        expect(logger.settings()).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.ordinary_log_settings_unavailable" }],
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "suspended",
            suspensionReason: "unsafe_storage",
        });
        expect(logger.clearOrdinaryLog()).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.ordinary_log_settings_unavailable" }],
        });
        expect(() => logger.captureSupportLogSnapshot(1_024)).toThrow(/storage is unavailable/u);
    });

    it.each([
        ["missing final newline", '{"schemaVersion":1,"enabled":true,"retentionDays":14,"maximumBytes":65536}'],
        ["multiple lines", '{"schemaVersion":1,"enabled":true,"retentionDays":14,"maximumBytes":65536}\n{}\n'],
    ])("rejects persisted settings with %s", (_label, contents) => {
        const root = temporaryRoot();
        fs.mkdirSync(path.join(root, "logs"), { recursive: true });
        fs.writeFileSync(path.join(root, "logs", "ordinary-settings.json"), contents);
        const logger = new HostOperationalDiagnostics(root);
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");
    });

    it.each([
        ["enabled", { enabled: false, retentionDays: 7, maximumBytes: 1024 * 1024 }],
        ["retention days", { enabled: true, retentionDays: 6, maximumBytes: 1024 * 1024 }],
        ["maximum bytes", { enabled: true, retentionDays: 7, maximumBytes: 2 * 1024 * 1024 }],
    ] as const)("rejects a settings write whose readback changes %s", (_label, observed) => {
        let writeAttempted = false;
        const filesystem = fakeFilesystem({
            durableCreateFile: vi.fn(() => {
                writeAttempted = true;
                return FILE_IDENTITY;
            }),
            readRegularFileNoFollow: vi.fn((filePath) => {
                if (!writeAttempted) {
                    throw new SafeFilesystemError({
                        failureKind: "not_found",
                        operation: "read_regular_file",
                        targetPath: filePath,
                        message: "settings are initially absent",
                    });
                }
                return { bytes: encodedSettings(observed), identity: FILE_IDENTITY };
            }),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(
            logger.replaceSettings({
                enabled: true,
                retentionDays: 7,
                maximumBytes: 1024 * 1024,
            }),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.ordinary_log_settings_write_failed" }],
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");
    });

    it("accepts may-have-applied settings only when exact readback proves the requested whole value", () => {
        const requested = { enabled: true, retentionDays: 7, maximumBytes: 1024 * 1024 };
        let persisted: Uint8Array | undefined;
        const filesystem = fakeFilesystem({
            durableCreateFile: vi.fn((_filePath, bytes) => {
                persisted = new Uint8Array(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
                throw new Error("uncertain write");
            }),
            readRegularFileNoFollow: vi.fn((filePath) => {
                if (persisted === undefined) {
                    throw new SafeFilesystemError({
                        failureKind: "not_found",
                        operation: "read_regular_file",
                        targetPath: filePath,
                        message: "settings are initially absent",
                    });
                }
                return { bytes: persisted, identity: FILE_IDENTITY };
            }),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(logger.replaceSettings(requested)).toMatchObject({
            status: "complete",
            value: requested,
        });
    });

    it("fails a settings write when neither the mutation nor exact readback can prove it", () => {
        const filesystem = fakeFilesystem({
            durableCreateFile: vi.fn(() => {
                throw new Error("not applied");
            }),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(
            logger.replaceSettings({
                enabled: true,
                retentionDays: 7,
                maximumBytes: 1024 * 1024,
            }),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.ordinary_log_settings_write_failed" }],
        });
    });

    it("returns a partial settings result when post-commit inventory is no longer safe", () => {
        const requested = { enabled: true, retentionDays: 7, maximumBytes: 1024 * 1024 };
        let persisted: Uint8Array | undefined;
        const filesystem = fakeFilesystem({
            durableCreateFile: vi.fn((_filePath, bytes) => {
                persisted = new Uint8Array(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
                return FILE_IDENTITY;
            }),
            readRegularFileNoFollow: vi.fn((filePath) => {
                if (persisted === undefined) {
                    throw new SafeFilesystemError({
                        failureKind: "not_found",
                        operation: "read_regular_file",
                        targetPath: filePath,
                        message: "settings are initially absent",
                    });
                }
                return { bytes: persisted, identity: FILE_IDENTITY };
            }),
            inventoryDirectoryNoFollow: vi.fn(() => {
                if (persisted !== undefined) throw new Error("unsafe inventory");
                return { entries: [] };
            }),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(logger.replaceSettings(requested)).toMatchObject({
            status: "partial",
            value: requested,
            diagnostics: [{ code: "host.ordinary_log_cleanup_failed" }],
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");
    });

    it("fails a clear operation when its action-time inventory cannot be revalidated", () => {
        let inventoryCount = 0;
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => {
                inventoryCount += 1;
                if (inventoryCount > 1) throw new Error("inventory changed");
                return { entries: [] };
            }),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(logger.clearOrdinaryLog()).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.ordinary_log_cleanup_failed" }],
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");
    });

    it("rejects invalid configured bounds before touching storage", () => {
        const root = temporaryRoot();
        expect(() => new HostOperationalDiagnostics(root, { maximumBytes: 0 })).toThrow(/positive safe integer/u);
        expect(() => new HostOperationalDiagnostics(root, { maximumSegmentBytes: 0 })).toThrow(/positive safe integer/u);
        expect(() => new HostOperationalDiagnostics(root, { maximumBytes: Number.NaN })).toThrow(/positive safe integer/u);
        expect(() => new HostOperationalDiagnostics(root, { maximumBytes: 10, maximumSegmentBytes: 11 })).toThrow(
            /cannot exceed/u,
        );
    });

    it.each([
        ["foreign file", "foreign.txt", "file"],
        ["directory entry", `ordinary-1-${HEX_ID}.jsonl`, "directory"],
        ["wrong prefix", `other-1-${HEX_ID}.jsonl`, "file"],
        ["wrong suffix", `ordinary-1-${HEX_ID}.txt`, "file"],
        ["missing separator", `ordinary-1${HEX_ID}.jsonl`, "file"],
        ["extra separator", `ordinary-1-${HEX_ID}-x.jsonl`, "file"],
        ["noncanonical timestamp", `ordinary-01-${HEX_ID}.jsonl`, "file"],
        ["negative timestamp", `ordinary--1-${HEX_ID}.jsonl`, "file"],
        ["short segment id", "ordinary-1-a.jsonl", "file"],
        ["uppercase segment id", `ordinary-1-${HEX_ID.toUpperCase()}.jsonl`, "file"],
        ["nonhex segment id", `ordinary-1-${"g".repeat(32)}.jsonl`, "file"],
    ] as const)("suspends an unsafe owned root with a %s", (_label, relativeName, entryKind) => {
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName, identity: { entryKind } }],
            })),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "suspended",
            suspensionReason: "unsafe_storage",
        });
    });

    it.each([
        ["empty device identity", { deviceId: "", fileId: "10", entryKind: "file" }],
        ["empty file identity", { deviceId: "1", fileId: "", entryKind: "file" }],
    ] as const)("suspends an owned segment with an %s", (_label, identity) => {
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity }],
            })),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");
    });

    it.each([
        ["empty", new Uint8Array()],
        ["missing newline", new TextEncoder().encode("{}")],
        ["empty record", new TextEncoder().encode("\n")],
        ["invalid JSON", new TextEncoder().encode("{\n")],
        ["invalid record", new TextEncoder().encode('{"schemaVersion":1}\n')],
        ["invalid UTF-8", new Uint8Array([0xff, 0x0a])],
        [
            "inconsistent first-record timestamp",
            new TextEncoder().encode(
                `${JSON.stringify({
                    schemaVersion: 1,
                    occurredAt: 2,
                    source: "host",
                    code: "host.lifecycle.ready",
                })}\n`,
            ),
        ],
    ] as const)("suspends when an existing owned segment is %s", (_label, bytes) => {
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity: FILE_IDENTITY }],
            })),
            readRegularFileNoFollow: segmentRead(bytes),
        });
        const logger = new HostOperationalDiagnostics("/profile", { filesystem });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");
    });

    it("orders same-timestamp retained segments deterministically in either inventory order", () => {
        const firstName = `ordinary-1-${"0".repeat(32)}.jsonl`;
        const secondName = `ordinary-1-${"f".repeat(32)}.jsonl`;
        const line = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        for (const names of [
            [firstName, secondName],
            [secondName, firstName],
        ]) {
            const firstInventoryName = names[0];
            if (firstInventoryName === undefined) throw new TypeError("fixture must contain one first inventory name");
            const filesystem = fakeFilesystem({
                inventoryDirectoryNoFollow: vi.fn(() => ({
                    entries: names.map((relativeName, index) => ({
                        relativeName,
                        identity: index === 0 ? FILE_IDENTITY : SECOND_FILE_IDENTITY,
                    })),
                })),
                readRegularFileNoFollow: vi.fn((filePath) => {
                    if (filePath.endsWith("ordinary-settings.json")) {
                        throw new SafeFilesystemError({
                            failureKind: "not_found",
                            operation: "read_regular_file",
                            targetPath: filePath,
                            message: "settings are absent",
                        });
                    }
                    return {
                        bytes: line,
                        identity: filePath.endsWith(firstInventoryName) ? FILE_IDENTITY : SECOND_FILE_IDENTITY,
                    };
                }),
            });
            const logger = new HostOperationalDiagnostics("/profile", { now: () => 1, filesystem });
            expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
                state: "active",
                segmentCount: 2,
            });
        }
    });

    it.each([
        ["device", { ...SECOND_FILE_IDENTITY, deviceId: "2" }],
        ["file", { ...SECOND_FILE_IDENTITY, fileId: "12" }],
        ["entry kind", { ...SECOND_FILE_IDENTITY, entryKind: "directory" }],
    ] as const)("rejects a segment whose readback changes its %s identity", (_label, observedIdentity) => {
        const line = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity: SECOND_FILE_IDENTITY }],
            })),
            readRegularFileNoFollow: segmentRead(line, observedIdentity),
        });
        const logger = new HostOperationalDiagnostics("/profile", { now: () => 1, filesystem });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");
    });

    it("suspends when storage setup fails and prunes retained valid evidence over the current budget", () => {
        const setupFailure = new HostOperationalDiagnostics("/profile", {
            filesystem: fakeFilesystem({
                durableEnsureDirectory: vi.fn(() => {
                    throw new Error("denied");
                }),
            }),
        });
        expect(setupFailure.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("unsafe_storage");

        const firstLine = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        const secondLine = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 2,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        const overBudget = new HostOperationalDiagnostics("/profile", {
            now: () => 2,
            maximumBytes: firstLine.byteLength,
            maximumSegmentBytes: Math.max(firstLine.byteLength, secondLine.byteLength),
            filesystem: fakeFilesystem({
                inventoryDirectoryNoFollow: vi.fn(() => ({
                    entries: [
                        { relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity: FILE_IDENTITY },
                        {
                            relativeName: `ordinary-2-${"fedcba9876543210fedcba9876543210"}.jsonl`,
                            identity: SECOND_FILE_IDENTITY,
                        },
                    ],
                })),
                readRegularFileNoFollow: vi.fn((filePath) => {
                    if (filePath.endsWith("ordinary-settings.json")) {
                        throw new SafeFilesystemError({
                            failureKind: "not_found",
                            operation: "read_regular_file",
                            targetPath: filePath,
                            message: "settings are absent",
                        });
                    }
                    return {
                        bytes: filePath.includes(`ordinary-1-${HEX_ID}`) ? firstLine : secondLine,
                        identity: filePath.includes(`ordinary-1-${HEX_ID}`) ? FILE_IDENTITY : SECOND_FILE_IDENTITY,
                    };
                }),
            }),
        });
        expect(overBudget.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "active",
            suspensionReason: "none",
            retainedBytes: secondLine.byteLength,
            segmentCount: 1,
        });
    });

    it("suspends when age- or byte-based retention cannot prove exact cleanup", () => {
        const line = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        const segmentFixture = {
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity: FILE_IDENTITY }],
            })),
            readRegularFileNoFollow: segmentRead(line),
            permanentlyRemoveRegularFileIfIdentity: vi.fn(() => false),
        };
        const expired = new HostOperationalDiagnostics("/profile", {
            now: () => 15 * 86_400_000,
            filesystem: fakeFilesystem(segmentFixture),
        });
        expect(expired.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("cleanup_failed");

        const overBudget = new HostOperationalDiagnostics("/profile", {
            now: () => 1,
            maximumBytes: line.byteLength - 1,
            maximumSegmentBytes: line.byteLength - 1,
            filesystem: fakeFilesystem(segmentFixture),
        });
        expect(overBudget.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("cleanup_failed");
    });

    it("drops a record and suspends when record-time retention cannot prove cleanup", () => {
        let now = 1;
        const filesystem = fakeFilesystem({
            permanentlyRemoveRegularFileIfIdentity: vi.fn(() => false),
        });
        const logger = new HostOperationalDiagnostics("/profile", {
            now: () => now,
            createSegmentId: () => HEX_ID,
            filesystem,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        now = 15 * 86_400_000;
        logger.record({ source: "host", code: "host.connection.opened" });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "suspended",
            suspensionReason: "cleanup_failed",
            segmentCount: 1,
        });
    });

    it("forgets a removed current segment before creating its bounded replacement", () => {
        const root = temporaryRoot();
        let timestamp = 1;
        let id = 0;
        const logger = new HostOperationalDiagnostics(root, {
            now: () => timestamp++,
            createSegmentId: () => `${String(id++).padStart(32, "0")}`,
            maximumBytes: 100,
            maximumSegmentBytes: 100,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        const firstFile = logFiles(root)[0];
        logger.record({ source: "host", code: "host.connection.opened" });
        expect(logFiles(root)).toHaveLength(1);
        expect(logFiles(root)[0]).not.toBe(firstFile);
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.state).toBe("active");
    });

    it("returns a partial settings result when a newly shortened retention window cannot clean an old segment", () => {
        const line = new TextEncoder().encode(
            `${JSON.stringify({
                schemaVersion: 1,
                occurredAt: 1,
                source: "host",
                code: "host.lifecycle.ready",
            })}\n`,
        );
        const requested = { enabled: true, retentionDays: 1, maximumBytes: 1024 * 1024 };
        let persisted: Uint8Array | undefined;
        const filesystem = fakeFilesystem({
            inventoryDirectoryNoFollow: vi.fn(() => ({
                entries: [{ relativeName: `ordinary-1-${HEX_ID}.jsonl`, identity: FILE_IDENTITY }],
            })),
            durableCreateFile: vi.fn((_filePath, bytes) => {
                persisted = new Uint8Array(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
                return FILE_IDENTITY;
            }),
            readRegularFileNoFollow: vi.fn((filePath) => {
                if (filePath.endsWith("ordinary-settings.json")) {
                    if (persisted === undefined) {
                        throw new SafeFilesystemError({
                            failureKind: "not_found",
                            operation: "read_regular_file",
                            targetPath: filePath,
                            message: "settings are initially absent",
                        });
                    }
                    return { bytes: persisted, identity: FILE_IDENTITY };
                }
                return { bytes: line, identity: FILE_IDENTITY };
            }),
            permanentlyRemoveRegularFileIfIdentity: vi.fn(() => false),
        });
        const logger = new HostOperationalDiagnostics("/profile", {
            now: () => 2 * 86_400_000,
            filesystem,
        });
        expect(logger.replaceSettings(requested)).toMatchObject({
            status: "partial",
            value: requested,
            diagnostics: [{ code: "host.ordinary_log_cleanup_failed" }],
        });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("cleanup_failed");
    });

    it("fails closed for invalid timestamps, segment ids, oversized records, and uncertain writes", () => {
        let timestamp = 0;
        const invalidTimestamp = new HostOperationalDiagnostics("/profile", {
            now: () => timestamp,
            filesystem: fakeFilesystem(),
        });
        timestamp = -1;
        invalidTimestamp.record({ source: "host", code: "host.lifecycle.ready" });
        expect(invalidTimestamp.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");

        timestamp = 0;
        const nonIntegerTimestamp = new HostOperationalDiagnostics("/profile", {
            now: () => timestamp,
            filesystem: fakeFilesystem(),
        });
        timestamp = Number.NaN;
        nonIntegerTimestamp.record({ source: "host", code: "host.lifecycle.ready" });
        expect(nonIntegerTimestamp.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");

        const invalidId = new HostOperationalDiagnostics("/profile", {
            now: () => 1,
            createSegmentId: () => "bad",
            filesystem: fakeFilesystem(),
        });
        invalidId.record({ source: "host", code: "host.lifecycle.ready" });
        expect(invalidId.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");

        const oversized = new HostOperationalDiagnostics("/profile", {
            maximumBytes: 200,
            maximumSegmentBytes: 1,
            filesystem: fakeFilesystem(),
        });
        oversized.record({ source: "host", code: "host.lifecycle.ready" });
        expect(oversized.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");

        for (const failingOperation of ["durableCreateFile", "durableReplaceFile"] as const) {
            const filesystem = fakeFilesystem({
                [failingOperation]: vi.fn(() => {
                    throw new Error("uncertain");
                }),
            });
            const logger = new HostOperationalDiagnostics("/profile", {
                now: () => 1,
                createSegmentId: () => HEX_ID,
                maximumSegmentBytes: 1_000,
                filesystem,
            });
            logger.record({ source: "host", code: "host.lifecycle.ready" });
            if (failingOperation === "durableReplaceFile") {
                logger.record({ source: "host", code: "host.connection.opened" });
            }
            expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");
        }
    });

    it("fails closed if a reentrant filesystem seam removes the current segment during replacement", () => {
        let logger: HostOperationalDiagnostics;
        const filesystem = fakeFilesystem({
            durableReplaceFile: vi.fn(() => {
                expect(logger.clearOrdinaryLog()).toMatchObject({ status: "complete" });
                return FILE_IDENTITY;
            }),
        });
        logger = new HostOperationalDiagnostics("/profile", {
            now: () => 1,
            createSegmentId: () => HEX_ID,
            maximumSegmentBytes: 1_000,
            filesystem,
        });
        logger.record({ source: "host", code: "host.lifecycle.ready" });
        logger.record({ source: "host", code: "host.connection.opened" });
        expect(logger.health("ready", { mode: "normal" }).ordinaryLog.suspensionReason).toBe("write_failed");
    });
});
