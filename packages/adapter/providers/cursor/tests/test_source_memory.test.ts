import { sha256SourceBytes } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AdapterProviderReadInput,
    NativeDialectValidationInputV1,
    ReadEntryHandle,
    Sha256Digest,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    fixturePlatformContext,
    fixtureSourceRoot,
    readAccessFailed,
    readAccessSucceeded,
    requireAdapterCapability,
} from "../../../test-support";
import { cursorProvider } from "../src/cursor-provider";
import { resolveCursorSourceContext } from "../src/cursor-source-read";
import {
    CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH,
    createCursorMemoryReadonlySnapshot,
    parseCursorMemoryReadonlySnapshot,
} from "../src/cursor-source-read-memory";
import { CURSOR_NATIVE_DIALECTS } from "../src/cursor-source-read-model";
import { validateCursorNativeDialect } from "../src/cursor-source-read-native";
import { CURSOR_ASSET_READER_REGISTRY } from "../src/cursor-source-read-registry";

const DIGEST = `sha256:${"9".repeat(64)}` as Sha256Digest;
const PROJECT_ROOT = "/fixture/cursor-memory-project";
const ROOT = fixtureSourceRoot({
    sourceRootId: "cursor-memory-snapshot",
    path: "/fixture/cursor-memory-readonly-snapshot.json",
    rootRole: "source",
    sourceDomain: "external_managed",
    locatorKind: "user_provided_path",
    locatorKey: "cursor_memory_readonly_snapshot",
    evidenceLevel: "user_provided",
});
const ITEM = {
    id: "kb_oaam_exact_item",
    title: "OAAM exact Cursor Memory",
    knowledge: "Use the exact project-bound readonly Memory snapshot.\n",
    createdAt: "2026-08-10T00:00:00.000Z",
    isGenerated: false,
} as const;

describe("Cursor App remote Memory read-only snapshot source", () => {
    it("declares one explicit selected-file App ingress while leaving CLI report-only", () => {
        const app = memoryCapability("CURSOR_APP");
        const cli = memoryCapability("CURSOR_AGENT_CLI");
        expect(app).toMatchObject({
            entrySupportStatus: "supported",
            rootLocatorKind: "user_provided_path",
            rootRole: "source",
            sourceDomain: "external_managed",
            sourcePathMechanism: "fixed_file",
            readPolicy: "user_selected_root_only",
        });
        expect(cli).toMatchObject({ entrySupportStatus: "deferred", readPolicy: "report_only" });
        expect(CURSOR_ASSET_READER_REGISTRY.Memory.disposition).toBe("reader");
        expect(resolveCursorSourceContext(readInput(JSON.stringify(snapshot())), ROOT, app)).toMatchObject({
            scope: "project",
            projectRootPath: PROJECT_ROOT,
            layout: "memory_snapshot",
            agentRuntimeId: "CURSOR_APP",
        });
        expect(resolveCursorSourceContext(readInput(JSON.stringify(snapshot()), { assetScope: "global" }), ROOT, app)).toBeNull();
    });

    it("maps one exact project item and reopens the full frozen native bytes", async () => {
        const text = `${JSON.stringify(snapshot(), null, 2)}\n`;
        const result = await cursorProvider.read(readInput(text));
        expect(result.diagnostics).toEqual([]);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Memory",
                scope: "project",
                projectRootPath: PROJECT_ROOT,
                displayName: ITEM.title,
                status: "complete",
                assetCandidateStatus: "importable",
                promotionSafety: "requires_user_confirmation",
                files: [expect.objectContaining({ logicalPath: "memory.md", text: ITEM.knowledge })],
                nativeRepresentation: expect.objectContaining({
                    dialectId: CURSOR_NATIVE_DIALECTS.memorySnapshot,
                    files: [expect.objectContaining({ relativePath: CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH })],
                }),
            }),
        ]);
        const candidate = required(result.candidates[0]);
        expect(Buffer.from(required(candidate.nativeRepresentation.files[0]).bytes)).toEqual(Buffer.from(text));
        expect(validateCursorNativeDialect(nativeInput(candidate))).toBe(true);
        expect(JSON.stringify(candidate.sourceEvidence)).not.toContain(ITEM.knowledge);
        expect(JSON.stringify(candidate.sourceEvidence)).toContain(ITEM.id);
    });

    it("fails closed on unknown fields, wrong build, stale hashes, bounds, executable input and wrong authority", async () => {
        const valid = snapshot() as unknown as Record<string, unknown>;
        const mutations: Array<(value: Record<string, unknown>) => void> = [
            (value) => Object.assign(value, { unknown: true }),
            (value) => Object.assign(value, { runtimeVersion: "3.12.31" }),
            (value) => Object.assign(value, { listObservationCount: 1 }),
            (value) => Object.assign(value, { capturedAt: "not-a-time" }),
            (value) => Object.assign(value.item as object, { knowledgeSha256: DIGEST }),
            (value) => Object.assign(value.item as object, { knowledge: "" }),
        ];
        for (const mutate of mutations) {
            const changed = structuredClone(valid);
            mutate(changed);
            expect(parseCursorMemoryReadonlySnapshot(JSON.stringify(changed))).toBeNull();
            const result = await cursorProvider.read(readInput(JSON.stringify(changed)));
            expect(result.candidates).toEqual([]);
            expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor.memory_snapshot_invalid" }));
        }
        const executable = await cursorProvider.read(readInput(JSON.stringify(snapshot()), { executable: true }));
        expect(executable.candidates).toEqual([]);
        expect(executable.diagnostics).toContainEqual(
            expect.objectContaining({ code: "cursor.memory_snapshot_not_plain_utf8_file" }),
        );
        const wrongRoot = { ...ROOT, rootRole: "project_actual" as const, sourceDomain: "project_root" as const };
        const unresolved = readInput(JSON.stringify(snapshot()), { root: wrongRoot });
        expect(resolveCursorSourceContext(unresolved, wrongRoot, memoryCapability("CURSOR_APP"))).toBeNull();
    });

    it("rejects changed canonical body, type data, native path, payload and graph", async () => {
        const candidate = required((await cursorProvider.read(readInput(JSON.stringify(snapshot())))).candidates[0]);
        for (const mutate of [
            (input: NativeDialectValidationInputV1) => {
                required(input.canonicalFiles[0]).text = "changed";
            },
            (input: NativeDialectValidationInputV1) => {
                if (input.canonical.kind === "Memory" && input.canonical.typeData.entityRole === "unit") {
                    input.canonical.typeData.card.name = "changed";
                }
            },
            (input: NativeDialectValidationInputV1) => {
                required(input.representation.files[0]).relativePath = "other.json";
                required(input.nativeFiles[0]).relativePath = "other.json";
            },
            (input: NativeDialectValidationInputV1) => {
                const changedSnapshot = createCursorMemoryReadonlySnapshot({
                    projectGitOrigin: snapshot().projectGitOrigin,
                    capturedAt: snapshot().capturedAt,
                    item: { ...ITEM, title: "changed" },
                });
                const changed = Buffer.from(JSON.stringify(changedSnapshot));
                required(input.representation.files[0]).contentHash = sha256SourceBytes(changed);
                required(input.representation.files[0]).byteSize = changed.byteLength;
                required(input.nativeFiles[0]).bytes = changed;
            },
            (input: NativeDialectValidationInputV1) => {
                input.nativeFiles.push({ relativePath: "extra.json", bytes: Buffer.from("{}") });
            },
        ]) {
            const changed = nativeInput(candidate);
            mutate(changed);
            expect(validateCursorNativeDialect(changed)).toBe(false);
        }
    });
});

function snapshot() {
    return createCursorMemoryReadonlySnapshot({
        projectGitOrigin: "https://example.invalid/oaam-phase59-memory.git",
        capturedAt: "2026-08-10T00:00:01.000Z",
        item: ITEM,
    });
}

function memoryCapability(agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP"): AdapterAssetSourceCapability {
    return requireAdapterCapability(
        cursorProvider,
        (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === "Memory",
        `Cursor ${agentRuntimeId} Memory capability missing`,
    );
}

function readInput(
    text: string,
    options: {
        assetScope?: "global" | "project";
        executable?: boolean;
        root?: typeof ROOT;
    } = {},
): AdapterProviderReadInput {
    const root = options.root ?? ROOT;
    const capability = memoryCapability("CURSOR_APP");
    const bytes = Buffer.from(text);
    const handle: ReadEntryHandle = {
        readEntryHandleId: "cursor-memory-snapshot-handle",
        sourceReadObligationId: "cursor-memory-snapshot-obligation",
        sourceRootId: root.sourceRootId,
        relativePath: "",
        entryKind: "file",
    };
    return {
        target: {
            sourceSelector: {
                selectorKind: "user_selected_root",
                platformContext: fixturePlatformContext(),
                binding: {
                    sourceRoot: root,
                    assetScope: options.assetScope ?? "project",
                    projectRootPath: PROJECT_ROOT,
                },
            },
        },
        sourceReadObligations: [
            {
                sourceReadObligationId: handle.sourceReadObligationId,
                sourceRootId: root.sourceRootId,
                sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
            },
        ],
        managedTargetGuards: [],
        readAuthorityFingerprint: DIGEST,
        readAccess: {
            async resolveRootEntry() {
                return readAccessSucceeded("resolve-root", handle);
            },
            async resolveEntry() {
                return readAccessFailed("resolve-entry", "not_found");
            },
            async listDirectory() {
                return readAccessFailed("list-directory", "not_directory");
            },
            async readFile(readEntryHandleId) {
                if (readEntryHandleId !== handle.readEntryHandleId) return readAccessFailed("read-file", "not_found");
                return readAccessSucceeded("read-file", {
                    entry: {
                        observedReadEntryId: "cursor-memory-observed-entry",
                        sourceRootId: root.sourceRootId,
                        relativePath: "",
                        entryKind: "file" as const,
                        contentHash: sha256SourceBytes(bytes),
                        executable: options.executable ?? false,
                        physicalIdentityFingerprint: DIGEST,
                    },
                    bytes,
                });
            },
            async verifyExternalAttestation() {
                return { state: "failed" as const, failureStatus: "unsupported_verifier" as const, diagnostics: [] };
            },
        },
    };
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") throw new Error("native files missing");
    return {
        canonical: {
            kind: candidate.kind,
            typeData: structuredClone(candidate.typeData),
        } as NativeDialectValidationInputV1["canonical"],
        canonicalFiles: candidate.files.map((file, index) => ({
            file: {
                fileId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                logicalPath: file.logicalPath,
                role: file.role,
                contentHash: DIGEST,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                byteSize: file.contentKind === "text" ? Buffer.byteLength(file.text) : file.bytes.byteLength,
                executable: file.executable,
                references: file.references ?? [],
            },
            ...(file.contentKind === "text"
                ? { contentKind: "text" as const, text: file.text }
                : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) }),
        })),
        representation: {
            schemaVersion: 1,
            dialectId: candidate.nativeRepresentation.dialectId,
            dialectContractFingerprint: DIGEST,
            canonicalContentFingerprint: DIGEST,
            representationFingerprint: DIGEST,
            files: candidate.nativeRepresentation.files.map((file) => ({
                relativePath: file.relativePath,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                contentHash: sha256SourceBytes(file.bytes),
                byteSize: file.bytes.byteLength,
                executable: file.executable,
            })),
        },
        nativeFiles: candidate.nativeRepresentation.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: new Uint8Array(file.bytes),
        })),
    };
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("required Cursor Memory test value missing");
    return value;
}
