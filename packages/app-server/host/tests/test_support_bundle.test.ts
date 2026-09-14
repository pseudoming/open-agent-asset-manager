import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProtocolDiagnosticsHealthV1 } from "@oaam/app-server-protocol";
import type { AdapterProviderSummary } from "@oaam/core";
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { Uint8ArrayReader, Uint8ArrayWriter, type FileEntry, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";
import {
    buildAndVerifySupportBundle,
    defaultSupportBundleProductFacts,
    publishPreparedSupportBundle,
    type BuildSupportBundleInput,
    type OperationalSupportLogSnapshot,
} from "../src/support-bundle";

const VALID_LOG_LINE = `${JSON.stringify({
    schemaVersion: 1,
    occurredAt: 1,
    source: "host",
    code: "host.lifecycle.ready",
})}\n`;
const DIAGNOSTIC_SECRET = "TOP-SECRET-CAPABILITY-DIAGNOSTIC";
const LOCAL_PATH = "/home/person/private/.oaam";
const IDENTITY: PhysicalPathIdentity = Object.freeze({ deviceId: "1", fileId: "2", entryKind: "file" });
const OTHER_IDENTITY: PhysicalPathIdentity = Object.freeze({ deviceId: "1", fileId: "3", entryKind: "file" });

function health(): ProtocolDiagnosticsHealthV1 {
    return {
        schemaVersion: 1,
        overallStatus: "healthy",
        host: { lifecycleState: "ready", startupMode: "normal" },
        ordinaryLog: {
            state: "active",
            suspensionReason: "none",
            retainedBytes: VALID_LOG_LINE.length,
            maximumBytes: 50 * 1024 * 1024,
            segmentCount: 1,
        },
    };
}

function provider(): AdapterProviderSummary {
    const diagnostic = {
        severity: "error",
        code: "fixture.secret",
        message: DIAGNOSTIC_SECRET,
        path: `${LOCAL_PATH}/credential.txt`,
        traceId: "secret-trace",
        operation: "read",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: DIAGNOSTIC_SECRET,
    };
    const source = {
        sourceCapabilityFingerprint: `sha256:${"a".repeat(64)}`,
        agentRuntimeId: "FIXTURE_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "known_default",
        rootRole: "config",
        sourceDomain: "agent_runtime_private",
        assetKind: "Skill",
        sourcePathMechanism: "known_default",
        evidenceLevel: "runtime_verified",
        readPolicy: "read_candidates",
        diagnostics: [diagnostic],
    };
    return {
        adapterId: "fixture-adapter",
        displayName: "Fixture Adapter",
        version: "9.1.0",
        enabled: true,
        agentRuntimes: [{ agentRuntimeId: "FIXTURE_CLI", displayName: "Fixture CLI", entryClass: "cli" }],
        targetContextSchemas: [],
        assetSourceCapabilities: [source, { ...source }],
        assetTargetCapabilities: [
            {
                agentRuntimeId: "FIXTURE_CLI",
                entrySupportStatus: "deferred",
                assetKind: "Skill",
                diagnostics: [diagnostic],
            },
        ],
        materializerCapabilities: [],
        renderContractDeclarations: [],
    } as unknown as AdapterProviderSummary;
}

function logSnapshot(overrides: Partial<OperationalSupportLogSnapshot> = {}): OperationalSupportLogSnapshot {
    const bytes = new TextEncoder().encode(VALID_LOG_LINE);
    return {
        bytes,
        retainedSegmentCount: 1,
        includedSegmentCount: 1,
        retainedBytes: bytes.byteLength,
        includedBytes: bytes.byteLength,
        truncated: false,
        locations: {
            oaamRoot: LOCAL_PATH,
            ordinaryLogRoot: `${LOCAL_PATH}/logs/ordinary`,
            settingsPath: `${LOCAL_PATH}/logs/ordinary-settings.json`,
        },
        ...overrides,
    };
}

function input(
    mode: BuildSupportBundleInput["mode"] = "standard",
    overrides: Partial<BuildSupportBundleInput> = {},
): BuildSupportBundleInput {
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
        providers: [provider()],
        ordinaryLog: logSnapshot(),
        ...overrides,
    };
}

async function extractTextEntries(bytes: Uint8Array): Promise<Map<string, string>> {
    const byteEntries = await extractByteEntries(bytes);
    return new Map([...byteEntries].map(([archivePath, contents]) => [archivePath, new TextDecoder().decode(contents)]));
}

async function extractByteEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, strictness: "strict" });
    try {
        const result = new Map<string, Uint8Array>();
        for (const entry of await reader.getEntries({ strictness: "strict" })) {
            if (entry.directory || !("getData" in entry)) throw new TypeError("fixture archive contains a directory");
            const contents = await (entry as FileEntry).getData(new Uint8ArrayWriter(), {
                useWebWorkers: false,
                strictness: "strict",
            });
            result.set(entry.filename, contents);
        }
        return result;
    } finally {
        await reader.close();
    }
}

async function createFixtureZip(
    entries: readonly {
        readonly archivePath: string;
        readonly bytes: Uint8Array;
        readonly directory?: boolean;
    }[],
): Promise<Uint8Array> {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    for (const entry of entries) {
        await writer.add(
            entry.archivePath,
            new Uint8ArrayReader(entry.bytes),
            entry.directory === true ? ({ directory: true } as never) : undefined,
        );
    }
    return writer.close();
}

describe("Host support bundle", () => {
    it("builds an independently inspectable standard ZIP with redacted provider facts and no free-text diagnostics", async () => {
        const prepared = await buildAndVerifySupportBundle(input());
        const entries = await extractTextEntries(prepared.archiveBytes);
        const allText = [...entries.values()].join("\n");

        expect(prepared).toMatchObject({
            recordKind: "support_bundle",
            mode: "standard",
            createdAt: 10,
            ordinaryLog: { retainedSegmentCount: 1, includedSegmentCount: 1, truncated: false },
        });
        expect(prepared.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ archivePath: "manifest.json", category: "manifest" }),
                expect.objectContaining({
                    archivePath: "diagnostics/ordinary-log.jsonl",
                    category: "ordinary_log",
                }),
            ]),
        );
        expect(prepared.entries).toHaveLength(6);
        expect(entries.get("README.txt")).toContain("not a backup");
        expect(JSON.parse(entries.get("manifest.json") as string)).toMatchObject({
            archiveFormat: "oaam_support_bundle",
            mode: "standard",
            restorationSupported: false,
        });
        expect(JSON.parse(entries.get("diagnostics/adapters.json") as string)).toMatchObject({
            availability: "available",
            providers: [
                {
                    providerRef: "provider-001",
                    sourceCapabilities: [{ assetKind: "Skill", entrySupportStatus: "supported", count: 2 }],
                },
            ],
        });
        expect(entries.get("diagnostics/locations.json")).toBeUndefined();
        expect(allText).not.toContain("fixture-adapter");
        expect(allText).not.toContain("FIXTURE_CLI");
        expect(allText).not.toContain(LOCAL_PATH);
        expect(allText).not.toContain(DIAGNOSTIC_SECRET);
    });

    it("adds only the reviewed local-detail facts in extended mode and reports unavailable Core provider facts honestly", async () => {
        const extended = await buildAndVerifySupportBundle(input("extended"));
        const extendedEntries = await extractTextEntries(extended.archiveBytes);
        const extendedText = [...extendedEntries.values()].join("\n");
        expect(extended.entries).toHaveLength(7);
        expect(extendedText).toContain("fixture-adapter");
        expect(extendedText).toContain("FIXTURE_CLI");
        expect(extendedText).toContain(LOCAL_PATH);
        expect(extendedText).not.toContain(DIAGNOSTIC_SECRET);

        const unavailable = await buildAndVerifySupportBundle(input("standard", { providers: null }));
        expect(
            JSON.parse((await extractTextEntries(unavailable.archiveBytes)).get("diagnostics/adapters.json") as string),
        ).toEqual({
            schemaVersion: 1,
            availability: "unavailable",
            providers: [],
        });
    });

    it("orders provider and capability facts deterministically instead of inheriting registry iteration order", async () => {
        const base = provider();
        const firstCapability = base.assetSourceCapabilities[0] as (typeof base.assetSourceCapabilities)[number];
        const secondCapability = {
            ...firstCapability,
            assetKind: "Guidance",
            entrySupportStatus: "deferred",
        } as (typeof base.assetSourceCapabilities)[number];
        const alpha = {
            ...base,
            adapterId: "alpha-adapter",
            assetSourceCapabilities: [firstCapability, secondCapability],
        } as AdapterProviderSummary;
        const zeta = {
            ...base,
            adapterId: "zeta-adapter",
            assetSourceCapabilities: [secondCapability, firstCapability],
        } as AdapterProviderSummary;
        const forward = await buildAndVerifySupportBundle(input("extended", { providers: [alpha, zeta] }));
        const reverse = await buildAndVerifySupportBundle(input("extended", { providers: [zeta, alpha] }));
        const forwardAdapters = (await extractTextEntries(forward.archiveBytes)).get("diagnostics/adapters.json");
        const reverseAdapters = (await extractTextEntries(reverse.archiveBytes)).get("diagnostics/adapters.json");

        expect(reverseAdapters).toBe(forwardAdapters);
        expect(JSON.parse(forwardAdapters as string).providers.map((entry: { adapterId: string }) => entry.adapterId)).toEqual([
            "alpha-adapter",
            "zeta-adapter",
        ]);
    });

    it("rejects inconsistent log snapshots, malformed records, missing extended locations and oversized metadata", async () => {
        await expect(buildAndVerifySupportBundle(input("standard", { createdAt: -1 }))).rejects.toThrow(/timestamp/u);
        await expect(
            buildAndVerifySupportBundle(input("extended", { ordinaryLog: logSnapshot({ locations: null }) })),
        ).rejects.toThrow(/location/u);
        await expect(
            buildAndVerifySupportBundle(
                input("standard", {
                    ordinaryLog: logSnapshot({ includedBytes: 1 }),
                }),
            ),
        ).rejects.toThrow(/inconsistent/u);
        await expect(
            buildAndVerifySupportBundle(
                input("standard", {
                    ordinaryLog: logSnapshot({ retainedBytes: 1 }),
                }),
            ),
        ).rejects.toThrow(/inconsistent/u);
        await expect(
            buildAndVerifySupportBundle(
                input("standard", {
                    ordinaryLog: logSnapshot({ retainedSegmentCount: 0 }),
                }),
            ),
        ).rejects.toThrow(/inconsistent/u);
        await expect(
            buildAndVerifySupportBundle(
                input("standard", {
                    ordinaryLog: logSnapshot({ truncated: true }),
                }),
            ),
        ).rejects.toThrow(/inconsistent/u);

        for (const bytes of [
            new TextEncoder().encode(VALID_LOG_LINE.trimEnd()),
            new TextEncoder().encode(`${VALID_LOG_LINE}\n`),
            new TextEncoder().encode('{"schemaVersion":1,"occurredAt":1,"source":"host","code":"host.secret"}\n'),
            new Uint8Array([0xff]),
        ]) {
            await expect(
                buildAndVerifySupportBundle(
                    input("standard", {
                        ordinaryLog: logSnapshot({
                            bytes,
                            retainedBytes: bytes.byteLength,
                            includedBytes: bytes.byteLength,
                        }),
                    }),
                ),
            ).rejects.toThrow();
        }

        const hugeProvider = { ...provider(), displayName: "x".repeat(2 * 1024 * 1024) };
        await expect(buildAndVerifySupportBundle(input("extended", { providers: [hugeProvider] }))).rejects.toThrow(
            /bounded size/u,
        );
    });

    it("closes an incomplete writer, rejects invalid generated bytes and enforces the final archive bound", async () => {
        const close = vi.fn(async () => {
            throw new Error("close failed");
        });
        await expect(
            buildAndVerifySupportBundle(input(), () => ({
                add: async () => {
                    throw new Error("add failed");
                },
                close,
            })),
        ).rejects.toThrow(/add failed/u);
        expect(close).toHaveBeenCalledTimes(1);

        await expect(
            buildAndVerifySupportBundle(input(), () => ({
                add: async () => undefined,
                close: async () => new Uint8Array(),
            })),
        ).rejects.toThrow(/bounded size/u);
        await expect(
            buildAndVerifySupportBundle(input(), () => ({
                add: async () => undefined,
                close: async () => new Uint8Array(16 * 1024 * 1024 + 1),
            })),
        ).rejects.toThrow(/bounded size/u);
        await expect(
            buildAndVerifySupportBundle(input(), () => ({
                add: async () => undefined,
                close: async () => new Uint8Array([1]),
            })),
        ).rejects.toThrow();
        await expect(buildAndVerifySupportBundle(input("standard", { createdAt: Number.MAX_SAFE_INTEGER }))).rejects.toThrow(
            /ZIP date range/u,
        );
    });

    it("creates a new exact destination once, verifies readback and never treats a pre-existing file as success", async () => {
        const prepared = await buildAndVerifySupportBundle(input());
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-support-export-"));
        const destination = path.join(root, "support.zip");
        const artifact = publishPreparedSupportBundle(prepared, destination, "desktop-save-dialog");
        expect(artifact).toMatchObject({
            mode: "standard",
            archiveByteLength: prepared.archiveBytes.byteLength,
            archiveContentHash: prepared.archiveContentHash,
            entryCount: 6,
        });
        expect(fs.readFileSync(destination)).toEqual(Buffer.from(prepared.archiveBytes));
        expect(() => publishPreparedSupportBundle(prepared, destination, "desktop-save-dialog")).toThrow();

        expect(() => publishPreparedSupportBundle(prepared, "", "action")).toThrow(/exact destination/u);
        expect(() => publishPreparedSupportBundle(prepared, destination, "")).toThrow(/explicit user action/u);
        expect(() =>
            publishPreparedSupportBundle(
                { ...prepared, archiveBytes: new Uint8Array([1]) },
                path.join(root, "tampered.zip"),
                "action",
            ),
        ).toThrow(/content hash/u);
    });

    it("fails exact publication when physical identity or committed bytes differ", async () => {
        const prepared = await buildAndVerifySupportBundle(input());
        const filesystem = {
            durableCreateFile: vi.fn(() => IDENTITY),
            readRegularFileNoFollow: vi.fn(() => ({ bytes: prepared.archiveBytes, identity: OTHER_IDENTITY })),
        };
        expect(() => publishPreparedSupportBundle(prepared, "/support.zip", "action", filesystem)).toThrow(/did not preserve/u);
        filesystem.readRegularFileNoFollow.mockReturnValue({
            bytes: new Uint8Array(prepared.archiveBytes.byteLength),
            identity: IDENTITY,
        });
        expect(() => publishPreparedSupportBundle(prepared, "/support.zip", "action", filesystem)).toThrow(/did not preserve/u);
    });

    it("derives finite process-owned product facts without reading a user directory", () => {
        expect(defaultSupportBundleProductFacts()).toEqual({
            oaamHostVersion: "0.1.0",
            nodeVersion: process.versions.node,
            platform: process.platform,
            architecture: process.arch,
        });
    });

    it("rejects a valid ZIP whose generated inventory does not match the fixed allowlist", async () => {
        const wrongWriter = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
        await wrongWriter.add("wrong.txt", new Uint8ArrayReader(new TextEncoder().encode("wrong")));
        const wrongBytes = await wrongWriter.close();
        await expect(
            buildAndVerifySupportBundle(input(), () => ({
                add: async () => undefined,
                close: async () => wrongBytes,
            })),
        ).rejects.toThrow(/inventory/u);
    });

    it("rejects same-count ZIPs with a foreign path, directory, changed size or changed bytes", async () => {
        const prepared = await buildAndVerifySupportBundle(input());
        const exact = [...(await extractByteEntries(prepared.archiveBytes))].map(([archivePath, bytes]) => ({
            archivePath,
            bytes,
        }));
        const first = exact[0] as { archivePath: string; bytes: Uint8Array };

        const foreign = exact.map((entry, index) => (index === 0 ? { ...entry, archivePath: "foreign.txt" } : entry));
        const directory = exact.map((entry, index) => (index === 0 ? { ...entry, directory: true } : entry));
        const changedSize = exact.map((entry, index) =>
            index === 0 ? { ...entry, bytes: new Uint8Array([...entry.bytes, 0]) } : entry,
        );
        const changedBytes = exact.map((entry, index) => {
            if (index !== 0) return entry;
            const bytes = new Uint8Array(entry.bytes);
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            return { ...entry, bytes };
        });

        for (const entries of [foreign, directory, changedSize, changedBytes]) {
            const bytes = await createFixtureZip(entries);
            await expect(
                buildAndVerifySupportBundle(input(), () => ({
                    add: async () => undefined,
                    close: async () => bytes,
                })),
            ).rejects.toThrow(/unexpected ZIP entry|changed during creation/u);
        }
        expect(first.bytes.byteLength).toBeGreaterThan(0);
    });
});
