/** Cursor App remote Memory frozen-read snapshot parser and candidate mapping. */

import { sha256SourceBytes } from "@oaam/adapter-framework";
import type { AdapterExtractedAssetCandidate, MemoryUnitTypeDataV2, Sha256Digest } from "@oaam/core";
import {
    cursorCandidateBase,
    cursorCandidateId,
    cursorSourceEvidence,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    textEntry,
} from "./cursor-source-read-foundation";
import {
    CURSOR_NATIVE_DIALECTS,
    type CursorCandidateBuildResult,
    type CursorScanResult,
    type CursorSourceContext,
} from "./cursor-source-read-model";

export const CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH = "cursor-memory-readonly-snapshot.json";
export const CURSOR_APP_MEMORY_RUNTIME_VERSION = "3.12.30";
export const CURSOR_APP_MEMORY_RUNTIME_BUILD_IDENTITY =
    "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e" as Sha256Digest;

export interface CursorMemoryReadonlySnapshotItemV1 {
    id: string;
    title: string;
    knowledge: string;
    knowledgeSha256: Sha256Digest;
    createdAt: string | null;
    isGenerated: boolean;
}

export interface CursorMemoryReadonlySnapshotV1 {
    schemaVersion: 1;
    snapshotKind: "cursor_app_remote_memory_readonly";
    agentRuntimeId: "CURSOR_APP";
    runtimeVersion: typeof CURSOR_APP_MEMORY_RUNTIME_VERSION;
    runtimeBuildIdentity: typeof CURSOR_APP_MEMORY_RUNTIME_BUILD_IDENTITY;
    projectGitOrigin: string;
    capturedAt: string;
    listObservationCount: 2;
    itemFingerprint: Sha256Digest;
    item: CursorMemoryReadonlySnapshotItemV1;
}

export function createCursorMemoryReadonlySnapshot(input: {
    projectGitOrigin: string;
    capturedAt: string;
    item: Omit<CursorMemoryReadonlySnapshotItemV1, "knowledgeSha256">;
}): CursorMemoryReadonlySnapshotV1 {
    const item = {
        ...input.item,
        knowledgeSha256: sha256SourceBytes(new TextEncoder().encode(input.item.knowledge)),
    };
    return {
        schemaVersion: 1,
        snapshotKind: "cursor_app_remote_memory_readonly",
        agentRuntimeId: "CURSOR_APP",
        runtimeVersion: CURSOR_APP_MEMORY_RUNTIME_VERSION,
        runtimeBuildIdentity: CURSOR_APP_MEMORY_RUNTIME_BUILD_IDENTITY,
        projectGitOrigin: input.projectGitOrigin,
        capturedAt: input.capturedAt,
        listObservationCount: 2,
        itemFingerprint: cursorMemorySnapshotItemFingerprint(item),
        item,
    };
}

export function parseCursorMemoryReadonlySnapshot(text: string): CursorMemoryReadonlySnapshotV1 | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;
    if (
        value.schemaVersion !== 1 ||
        value.snapshotKind !== "cursor_app_remote_memory_readonly" ||
        value.agentRuntimeId !== "CURSOR_APP" ||
        value.runtimeVersion !== CURSOR_APP_MEMORY_RUNTIME_VERSION ||
        value.runtimeBuildIdentity !== CURSOR_APP_MEMORY_RUNTIME_BUILD_IDENTITY ||
        value.listObservationCount !== 2 ||
        !boundedString(value.projectGitOrigin, 1, 4_096) ||
        !validIsoTimestamp(value.capturedAt) ||
        !isSha256(value.itemFingerprint) ||
        !isRecord(value.item) ||
        !hasExactKeys(value.item, ITEM_KEYS)
    ) {
        return null;
    }
    const item = value.item;
    if (
        !boundedString(item.id, 1, 512) ||
        !boundedString(item.title, 1, 4_096) ||
        !boundedString(item.knowledge, 1, 2_000_000) ||
        !isSha256(item.knowledgeSha256) ||
        (item.createdAt !== null && (!boundedString(item.createdAt, 1, 128) || !validIsoTimestamp(item.createdAt))) ||
        typeof item.isGenerated !== "boolean"
    ) {
        return null;
    }
    const parsedItem: CursorMemoryReadonlySnapshotItemV1 = {
        id: item.id,
        title: item.title,
        knowledge: item.knowledge,
        knowledgeSha256: item.knowledgeSha256,
        createdAt: item.createdAt,
        isGenerated: item.isGenerated,
    };
    if (
        parsedItem.knowledgeSha256 !== sha256SourceBytes(new TextEncoder().encode(parsedItem.knowledge)) ||
        value.itemFingerprint !== cursorMemorySnapshotItemFingerprint(parsedItem)
    ) {
        return null;
    }
    return {
        schemaVersion: 1,
        snapshotKind: "cursor_app_remote_memory_readonly",
        agentRuntimeId: "CURSOR_APP",
        runtimeVersion: CURSOR_APP_MEMORY_RUNTIME_VERSION,
        runtimeBuildIdentity: CURSOR_APP_MEMORY_RUNTIME_BUILD_IDENTITY,
        projectGitOrigin: value.projectGitOrigin,
        capturedAt: value.capturedAt,
        listObservationCount: 2,
        itemFingerprint: value.itemFingerprint,
        item: parsedItem,
    };
}

export function buildCursorMemoryCandidates(context: CursorSourceContext, scan: CursorScanResult): CursorCandidateBuildResult {
    const source = scan.files[0];
    if (source === undefined) return { candidates: [], diagnostics: [], ignoredSource: false };
    if (source.text === null || source.executable || scan.files.length !== 1) {
        scan.ignoreRecord(source, "cursor_memory_snapshot_not_plain_utf8_file");
        return {
            candidates: [],
            diagnostics: [
                readDiagnostic(
                    "cursor.memory_snapshot_not_plain_utf8_file",
                    "Cursor Memory snapshot must be one non-executable UTF-8 file",
                    "invalid_schema",
                    "error",
                    source.relativePath,
                ),
            ],
            ignoredSource: true,
        };
    }
    const snapshot = parseCursorMemoryReadonlySnapshot(source.text);
    if (snapshot === null) {
        scan.ignoreRecord(source, "cursor_memory_snapshot_invalid");
        return {
            candidates: [],
            diagnostics: [
                readDiagnostic(
                    "cursor.memory_snapshot_invalid",
                    "Cursor Memory read-only snapshot failed its exact schema, build, bounds, timestamp, or hash checks",
                    "invalid_schema",
                    "error",
                    source.relativePath,
                ),
            ],
            ignoredSource: true,
        };
    }
    const nativeSource = { ...source, relativePath: CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH };
    const candidateId = cursorCandidateId("Memory", scan, CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH);
    const typeData = cursorMemoryTypeData(snapshot);
    const candidate: AdapterExtractedAssetCandidate = {
        ...cursorCandidateBase(context, scan, candidateId, CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH, source.observedReadEntryId),
        displayName: snapshot.item.title,
        displayDescription: "Read-only Cursor project Memory snapshot",
        files: [textEntry("memory.md", snapshot.item.knowledge)],
        nativeRepresentation: separateNative(CURSOR_NATIVE_DIALECTS.memorySnapshot, [nativeSource]),
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "requires_user_confirmation",
        sourceFileOrigins: [{ logicalPath: "memory.md", observedReadEntryIds: [source.observedReadEntryId] }],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: metadataOrigins(source.observedReadEntryId, true),
        sourceEvidence: cursorSourceEvidence(
            scan,
            source,
            `cursor_remote_memory_snapshot:${snapshot.projectGitOrigin}:${snapshot.item.id}`,
        ),
        diagnostics: [],
        kind: "Memory",
        typeData,
    };
    scan.attachCandidate(candidateId, [source]);
    return { candidates: [candidate], diagnostics: [], ignoredSource: false };
}

export function cursorMemoryTypeData(snapshot: CursorMemoryReadonlySnapshotV1): MemoryUnitTypeDataV2 {
    return {
        schemaVersion: 2,
        entityRole: "unit",
        card: { name: snapshot.item.title, description: "Read-only Cursor project Memory snapshot" },
        loading: { card: "high", body: "low" },
        applicabilityRule: "",
    };
}

function cursorMemorySnapshotItemFingerprint(item: CursorMemoryReadonlySnapshotItemV1): Sha256Digest {
    return sha256SourceBytes(
        new TextEncoder().encode(
            JSON.stringify([item.id, item.title, item.knowledge, item.knowledgeSha256, item.createdAt, item.isGenerated]),
        ),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
    return typeof value === "string" && value.length >= minimum && value.length <= maximum && !value.includes("\0");
}

function validIsoTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 128) return false;
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isSha256(value: unknown): value is Sha256Digest {
    return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

const SNAPSHOT_KEYS = [
    "agentRuntimeId",
    "capturedAt",
    "item",
    "itemFingerprint",
    "listObservationCount",
    "projectGitOrigin",
    "runtimeBuildIdentity",
    "runtimeVersion",
    "schemaVersion",
    "snapshotKind",
].sort();
const ITEM_KEYS = ["createdAt", "id", "isGenerated", "knowledge", "knowledgeSha256", "title"].sort();
