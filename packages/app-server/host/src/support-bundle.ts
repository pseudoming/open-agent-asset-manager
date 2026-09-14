import * as crypto from "node:crypto";
import {
    type ProtocolDiagnosticsHealthV1,
    type ProtocolSupportBundleArtifactV1,
    type ProtocolSupportBundleMode,
    type ProtocolSupportBundleReviewV1,
    protocolOperationalDiagnosticRecordSchema,
    protocolSupportBundleReviewSchema,
} from "@oaam/app-server-protocol";
import type { AdapterProviderSummary } from "@oaam/core";
import { durableCreateFile, readRegularFileNoFollow, samePhysicalPathIdentity } from "@oaam/shared/filesystem";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";

export const STANDARD_SUPPORT_LOG_MAXIMUM_BYTES = 1024 * 1024;
export const EXTENDED_SUPPORT_LOG_MAXIMUM_BYTES = 8 * 1024 * 1024;
const MINIMUM_ZIP_DATE = Date.UTC(1980, 0, 1);
const MAXIMUM_SUPPORT_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SUPPORT_METADATA_ENTRY_BYTES = 2 * 1024 * 1024;
const HOST_PACKAGE_VERSION = "0.1.0";

export interface OperationalSupportLogSnapshot {
    readonly bytes: Uint8Array;
    readonly retainedSegmentCount: number;
    readonly includedSegmentCount: number;
    readonly retainedBytes: number;
    readonly includedBytes: number;
    readonly truncated: boolean;
    readonly locations: {
        readonly oaamRoot: string;
        readonly ordinaryLogRoot: string;
        readonly settingsPath: string;
    } | null;
}

export interface SupportBundleProductFacts {
    readonly oaamHostVersion: string;
    readonly nodeVersion: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
}

export interface BuildSupportBundleInput {
    readonly mode: ProtocolSupportBundleMode;
    readonly createdAt: number;
    readonly product: SupportBundleProductFacts;
    readonly health: ProtocolDiagnosticsHealthV1;
    readonly providers: readonly AdapterProviderSummary[] | null;
    readonly ordinaryLog: OperationalSupportLogSnapshot;
}

export interface PreparedSupportBundle {
    readonly recordKind: "support_bundle";
    readonly mode: ProtocolSupportBundleMode;
    readonly createdAt: number;
    readonly archiveBytes: Uint8Array;
    readonly archiveContentHash: string;
    readonly entries: ProtocolSupportBundleReviewV1["entries"];
    readonly ordinaryLog: ProtocolSupportBundleReviewV1["ordinaryLog"];
}

interface SupportArchiveEntry {
    readonly archivePath: string;
    readonly category: ProtocolSupportBundleReviewV1["entries"][number]["category"];
    readonly bytes: Uint8Array;
}

interface SupportManifestEntry {
    readonly archivePath: string;
    readonly category: SupportArchiveEntry["category"];
    readonly byteLength: number;
    readonly contentHash: string;
}

interface SupportArchiveWriter {
    add(filename: string, reader: Uint8ArrayReader, options: { level: number; lastModDate: Date }): Promise<unknown>;
    close(): Promise<Uint8Array>;
}

export interface SupportBundleFilesystem {
    durableCreateFile(filePath: string, data: Uint8Array): ReturnType<typeof durableCreateFile>;
    readRegularFileNoFollow(filePath: string, maximumBytes: number): ReturnType<typeof readRegularFileNoFollow>;
}

const physicalSupportBundleFilesystem: SupportBundleFilesystem = Object.freeze({
    durableCreateFile,
    readRegularFileNoFollow,
});

export function defaultSupportBundleProductFacts(): SupportBundleProductFacts {
    return {
        oaamHostVersion: HOST_PACKAGE_VERSION,
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
    };
}

export async function buildAndVerifySupportBundle(
    input: BuildSupportBundleInput,
    createWriter: () => SupportArchiveWriter = () =>
        new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false }) as SupportArchiveWriter,
): Promise<PreparedSupportBundle> {
    validateBuildInput(input);
    const payloadEntries = buildPayloadEntries(input);
    const manifestEntry = buildManifestEntry(input, payloadEntries);
    const sourceEntries = [...payloadEntries, manifestEntry].sort(compareArchiveEntries);
    assertEntryBounds(sourceEntries);
    const archiveBytes = await writeArchive(sourceEntries, input.createdAt, createWriter);
    if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAXIMUM_SUPPORT_ARCHIVE_BYTES) {
        throw new TypeError("support bundle archive is outside its bounded size");
    }
    await verifyArchive(archiveBytes, sourceEntries);
    return {
        recordKind: "support_bundle",
        mode: input.mode,
        createdAt: input.createdAt,
        archiveBytes,
        archiveContentHash: sha256(archiveBytes),
        entries: sourceEntries.map(({ archivePath, category, bytes }) => ({
            archivePath,
            category,
            byteLength: bytes.byteLength,
        })),
        ordinaryLog: {
            retainedSegmentCount: input.ordinaryLog.retainedSegmentCount,
            includedSegmentCount: input.ordinaryLog.includedSegmentCount,
            retainedBytes: input.ordinaryLog.retainedBytes,
            includedBytes: input.ordinaryLog.includedBytes,
            truncated: input.ordinaryLog.truncated,
        },
    };
}

export function projectPreparedSupportBundle(token: string, prepared: PreparedSupportBundle): ProtocolSupportBundleReviewV1 {
    return {
        schemaVersion: 1,
        supportBundleReviewToken: token,
        mode: prepared.mode,
        createdAt: prepared.createdAt,
        archiveByteLength: prepared.archiveBytes.byteLength,
        archiveContentHash: prepared.archiveContentHash,
        entries: prepared.entries,
        ordinaryLog: prepared.ordinaryLog,
    };
}

export function isPreparedSupportBundle(value: unknown): value is PreparedSupportBundle {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, [
            "recordKind",
            "mode",
            "createdAt",
            "archiveBytes",
            "archiveContentHash",
            "entries",
            "ordinaryLog",
        ]) ||
        value.recordKind !== "support_bundle" ||
        (value.mode !== "standard" && value.mode !== "extended") ||
        !Number.isSafeInteger(value.createdAt) ||
        (value.createdAt as number) < 0 ||
        !(value.archiveBytes instanceof Uint8Array) ||
        value.archiveBytes.byteLength === 0 ||
        value.archiveBytes.byteLength > MAXIMUM_SUPPORT_ARCHIVE_BYTES ||
        typeof value.archiveContentHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.archiveContentHash) ||
        sha256(value.archiveBytes) !== value.archiveContentHash ||
        !Array.isArray(value.entries) ||
        !isRecord(value.ordinaryLog)
    ) {
        return false;
    }
    try {
        protocolSupportBundleReviewSchema.parse({
            schemaVersion: 1,
            supportBundleReviewToken: "internal-review-validation",
            mode: value.mode,
            createdAt: value.createdAt,
            archiveByteLength: value.archiveBytes.byteLength,
            archiveContentHash: value.archiveContentHash,
            entries: value.entries,
            ordinaryLog: value.ordinaryLog,
        });
    } catch {
        return false;
    }
    return true;
}

export function publishPreparedSupportBundle(
    prepared: PreparedSupportBundle,
    destinationPath: string,
    userActionId: string,
    filesystem: SupportBundleFilesystem = physicalSupportBundleFilesystem,
): ProtocolSupportBundleArtifactV1 {
    if (
        destinationPath.length === 0 ||
        destinationPath.trim() !== destinationPath ||
        destinationPath.includes("\0") ||
        userActionId.length === 0 ||
        userActionId.trim() !== userActionId ||
        userActionId.includes("\0")
    ) {
        throw new TypeError("support-bundle export requires an exact destination and explicit user action");
    }
    if (sha256(prepared.archiveBytes) !== prepared.archiveContentHash) {
        throw new TypeError("reviewed support-bundle bytes no longer match their content hash");
    }
    const created = filesystem.durableCreateFile(destinationPath, prepared.archiveBytes);
    const observed = filesystem.readRegularFileNoFollow(destinationPath, prepared.archiveBytes.byteLength);
    if (
        !samePhysicalPathIdentity(created, observed.identity) ||
        observed.bytes.byteLength !== prepared.archiveBytes.byteLength ||
        sha256(observed.bytes) !== prepared.archiveContentHash
    ) {
        throw new TypeError("support-bundle destination did not preserve the reviewed archive");
    }
    return {
        schemaVersion: 1,
        mode: prepared.mode,
        createdAt: prepared.createdAt,
        archiveByteLength: prepared.archiveBytes.byteLength,
        archiveContentHash: prepared.archiveContentHash,
        entryCount: prepared.entries.length,
    };
}

function validateBuildInput(input: BuildSupportBundleInput): void {
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
        throw new TypeError("support bundle timestamp must be a non-negative safe integer");
    }
    if (input.mode === "extended" && input.ordinaryLog.locations === null) {
        throw new TypeError("extended support bundle requires exact Host-owned location facts");
    }
    const maximumBytes = input.mode === "standard" ? STANDARD_SUPPORT_LOG_MAXIMUM_BYTES : EXTENDED_SUPPORT_LOG_MAXIMUM_BYTES;
    if (
        input.ordinaryLog.bytes.byteLength !== input.ordinaryLog.includedBytes ||
        input.ordinaryLog.includedBytes > maximumBytes ||
        input.ordinaryLog.includedBytes > input.ordinaryLog.retainedBytes ||
        input.ordinaryLog.includedSegmentCount > input.ordinaryLog.retainedSegmentCount ||
        input.ordinaryLog.truncated !== input.ordinaryLog.includedBytes < input.ordinaryLog.retainedBytes
    ) {
        throw new TypeError("support-bundle ordinary-log snapshot is inconsistent");
    }
    validateStructuredLog(input.ordinaryLog.bytes);
}

function validateStructuredLog(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new TypeError("support-bundle ordinary log is incomplete");
    for (const line of text.slice(0, -1).split("\n")) {
        if (line.length === 0) throw new TypeError("support-bundle ordinary log contains an empty record");
        protocolOperationalDiagnosticRecordSchema.parse(JSON.parse(line) as unknown);
    }
}

function buildPayloadEntries(input: BuildSupportBundleInput): SupportArchiveEntry[] {
    const entries: SupportArchiveEntry[] = [
        textEntry("README.txt", "documentation", supportReadme()),
        jsonEntry("diagnostics/product.json", "product", { schemaVersion: 1, ...input.product }),
        jsonEntry("diagnostics/health.json", "health", input.health),
        jsonEntry("diagnostics/adapters.json", "adapter_capabilities", projectProviderFacts(input.providers, input.mode)),
        {
            archivePath: "diagnostics/ordinary-log.jsonl",
            category: "ordinary_log",
            bytes: new Uint8Array(input.ordinaryLog.bytes),
        },
    ];
    if (input.mode === "extended") {
        entries.push(
            jsonEntry("diagnostics/locations.json", "local_paths", {
                schemaVersion: 1,
                locations: input.ordinaryLog.locations,
            }),
        );
    }
    return entries;
}

function buildManifestEntry(input: BuildSupportBundleInput, entries: SupportArchiveEntry[]): SupportArchiveEntry {
    const manifestEntries: SupportManifestEntry[] = entries.map(({ archivePath, category, bytes }) => ({
        archivePath,
        category,
        byteLength: bytes.byteLength,
        contentHash: sha256(bytes),
    }));
    return jsonEntry("manifest.json", "manifest", {
        schemaVersion: 1,
        archiveFormat: "oaam_support_bundle",
        mode: input.mode,
        createdAt: input.createdAt,
        restorationSupported: false,
        entries: manifestEntries,
        ordinaryLog: {
            retainedSegmentCount: input.ordinaryLog.retainedSegmentCount,
            includedSegmentCount: input.ordinaryLog.includedSegmentCount,
            retainedBytes: input.ordinaryLog.retainedBytes,
            includedBytes: input.ordinaryLog.includedBytes,
            truncated: input.ordinaryLog.truncated,
        },
    });
}

function projectProviderFacts(providers: readonly AdapterProviderSummary[] | null, mode: ProtocolSupportBundleMode) {
    if (providers === null) return { schemaVersion: 1, availability: "unavailable" as const, providers: [] };
    const sorted = [...providers].sort((left, right) => (left.adapterId < right.adapterId ? -1 : 1));
    return {
        schemaVersion: 1,
        availability: "available" as const,
        providers: sorted.map((provider, index) => ({
            providerRef: `provider-${String(index + 1).padStart(3, "0")}`,
            enabled: provider.enabled,
            agentRuntimeCount: provider.agentRuntimes.length,
            sourceCapabilities: capabilityCounts(provider.assetSourceCapabilities),
            targetCapabilities: capabilityCounts(provider.assetTargetCapabilities),
            materializerCapabilityCount: provider.materializerCapabilities.length,
            renderContractDeclarationCount: provider.renderContractDeclarations.length,
            ...(mode === "standard"
                ? {}
                : {
                      adapterId: provider.adapterId,
                      displayName: provider.displayName,
                      version: provider.version,
                      agentRuntimes: provider.agentRuntimes.map(({ agentRuntimeId, displayName, entryClass }) => ({
                          agentRuntimeId,
                          displayName,
                          entryClass,
                      })),
                  }),
        })),
    };
}

function capabilityCounts(capabilities: readonly { readonly assetKind: string; readonly entrySupportStatus: string }[]) {
    const counts = new Map<string, number>();
    for (const capability of capabilities) {
        const key = `${capability.assetKind}:${capability.entrySupportStatus}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, count]) => {
            const separator = key.indexOf(":");
            return {
                assetKind: key.slice(0, separator),
                entrySupportStatus: key.slice(separator + 1),
                count,
            };
        });
}

function supportReadme(): string {
    return [
        "Open Agent Asset Manager support bundle",
        "",
        "This archive contains bounded diagnostics selected for local inspection.",
        "It is not a backup and cannot restore OAAM state.",
        "It intentionally excludes Asset/runtime contents, State DB bytes, recovery payloads and credentials.",
        "",
    ].join("\n");
}

function textEntry(archivePath: string, category: SupportArchiveEntry["category"], text: string): SupportArchiveEntry {
    return { archivePath, category, bytes: new TextEncoder().encode(text) };
}

function jsonEntry(archivePath: string, category: SupportArchiveEntry["category"], value: unknown): SupportArchiveEntry {
    return textEntry(archivePath, category, `${JSON.stringify(value, null, 2)}\n`);
}

function compareArchiveEntries(left: SupportArchiveEntry, right: SupportArchiveEntry): number {
    return left.archivePath < right.archivePath ? -1 : 1;
}

function assertEntryBounds(entries: SupportArchiveEntry[]): void {
    for (const entry of entries) {
        const maximum =
            entry.category === "ordinary_log" ? EXTENDED_SUPPORT_LOG_MAXIMUM_BYTES : MAXIMUM_SUPPORT_METADATA_ENTRY_BYTES;
        if (entry.bytes.byteLength > maximum) throw new TypeError("support bundle metadata exceeds its bounded size");
    }
}

async function writeArchive(
    entries: SupportArchiveEntry[],
    createdAt: number,
    createWriter: () => SupportArchiveWriter,
): Promise<Uint8Array> {
    const zip = createWriter();
    try {
        const lastModDate = new Date(Math.max(createdAt, MINIMUM_ZIP_DATE));
        if (Number.isNaN(lastModDate.getTime())) throw new TypeError("support bundle timestamp is outside the ZIP date range");
        const options = { level: 6, lastModDate };
        for (const entry of entries) {
            await zip.add(entry.archivePath, new Uint8ArrayReader(entry.bytes), options);
        }
        return await zip.close();
    } catch (error) {
        try {
            await zip.close();
        } catch {
            // Preserve the original archive-construction error.
        }
        throw error;
    }
}

async function verifyArchive(archiveBytes: Uint8Array, expected: SupportArchiveEntry[]): Promise<void> {
    const reader = new ZipReader(new Uint8ArrayReader(archiveBytes), { useWebWorkers: false, strictness: "strict" });
    try {
        const entries = await reader.getEntries({ strictness: "strict" });
        if (entries.length !== expected.length) throw new TypeError("support bundle inventory differs after ZIP creation");
        const expectedByPath = new Map(expected.map((entry) => [entry.archivePath, entry]));
        for (const entry of entries) {
            const source = expectedByPath.get(entry.filename);
            if (source === undefined || entry.directory || entry.uncompressedSize !== source.bytes.byteLength) {
                throw new TypeError("support bundle contains an unexpected ZIP entry");
            }
            const bytes = await entry.getData(new Uint8ArrayWriter(), {
                useWebWorkers: false,
                strictness: "strict",
            });
            if (!bytesEqual(bytes, source.bytes)) throw new TypeError("support bundle ZIP entry changed during creation");
            expectedByPath.delete(entry.filename);
        }
    } finally {
        await reader.close();
    }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
