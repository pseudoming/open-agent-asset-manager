import { describe, expect, it } from "vitest";
import type {
    AssetVersionFileContentV2,
    CandidateNativeRepresentationFileInput,
    FileReferenceV2,
    NativeDialectValidationInputV1,
    VersionFileInput,
} from "@oaam/core";
import {
    buildNativeAncestorDirectories,
    buildSeparateNativeRepresentation,
    comparableCandidateNativeFiles,
    comparablePersistedNativeFiles,
    hydrateValidatedNativeSourceFiles,
    projectCandidateVersionFiles,
    projectPersistedVersionFiles,
    sha256SourceBytes,
    stableSourceValueEqual,
    zeroSha256Digest,
} from "../src";
import type { NativeVersionFileProjectionPolicy, SourceDirectoryRecord, SourceFileRecord } from "../src";

describe("runtime-neutral native representation mechanics", () => {
    it("is permutation-invariant while preserving bytes, media, and executable attributes", () => {
        const text = sourceFile("z.md", "text", true, [116, 101, 120, 116]);
        const binary = sourceFile("a.bin", null, false, [0, 255]);
        const forward = buildSeparateNativeRepresentation("family-skill-v1", [text, binary]);
        const reverse = buildSeparateNativeRepresentation("family-skill-v1", [binary, text]);

        expect(forward).toEqual(reverse);
        expect(forward.files).toEqual([
            expect.objectContaining({
                relativePath: "a.bin",
                contentKind: "binary",
                mediaType: "application/octet-stream",
                executable: false,
                bytes: new Uint8Array([0, 255]),
            }),
            expect.objectContaining({
                relativePath: "z.md",
                contentKind: "text",
                mediaType: "text/markdown",
                executable: true,
                bytes: new Uint8Array([116, 101, 120, 116]),
            }),
        ]);
        binary.bytes[0] = 9;
        expect(forward.files[0]?.bytes).toEqual(new Uint8Array([0, 255]));

        const graph = buildSeparateNativeRepresentation(
            "family-skill-v2",
            [sourceFile("bundle/SKILL.md", "skill", false, [115])],
            [sourceDirectory("bundle/empty"), sourceDirectory("bundle")],
        );
        expect(graph).toMatchObject({
            representationSource: "separate_file_graph",
            directories: [
                { relativePath: "bundle", observedReadEntryIds: ["entry:bundle"] },
                { relativePath: "bundle/empty", observedReadEntryIds: ["entry:bundle/empty"] },
            ],
        });
    });

    it("projects candidate and persisted native payloads into the same sorted byte form", () => {
        const candidate: CandidateNativeRepresentationFileInput[] = [
            candidateFile("z.md", "TEXT/MARKDOWN; charset=UTF-8", [122], true),
            candidateFile("a.bin", "APPLICATION/OCTET-STREAM", [0, 255], false, "binary"),
        ];
        const input = validationInput(candidate);
        const normalizeMediaType = (value: string) => value.split(";", 1)[0]?.toLowerCase() ?? "";

        expect(comparableCandidateNativeFiles(candidate, normalizeMediaType)).toEqual(
            comparablePersistedNativeFiles(input, normalizeMediaType),
        );

        const missing = structuredClone(input);
        missing.nativeFiles = missing.nativeFiles.filter((file) => file.relativePath !== "a.bin");
        expect(comparablePersistedNativeFiles(missing, normalizeMediaType)[0]?.bytes).toEqual([]);
    });

    it("compares recursive values deterministically while retaining array and byte order", () => {
        expect(
            stableSourceValueEqual(
                { b: 2, a: { bytes: new Uint8Array([0, 1]), rows: ["x", "y"] } },
                { a: { rows: ["x", "y"], bytes: new Uint8Array([0, 1]) }, b: 2 },
            ),
        ).toBe(true);
        expect(stableSourceValueEqual(["x", "y"], ["y", "x"])).toBe(false);
        expect(stableSourceValueEqual(new Uint8Array([0, 1]), new Uint8Array([1, 0]))).toBe(false);
        expect(stableSourceValueEqual(null, null)).toBe(true);
    });

    it("computes the canonical empty and content SHA-256 digests", () => {
        expect(zeroSha256Digest()).toBe(`sha256:${"0".repeat(64)}`);
        expect(sha256SourceBytes(new TextEncoder().encode("abc"))).toBe(
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });

    it("hydrates a one-to-one descriptor graph and clones every validated payload", () => {
        const input = validationInput([
            candidateFile("nested/a.md", "text/markdown", [97], false),
            candidateFile("b.bin", "application/octet-stream", [0, 255], true, "binary"),
        ]);
        const hydrated = hydrateValidatedNativeSourceFiles(input, (file) =>
            sourceFile(
                file.relativePath,
                file.contentKind === "text" ? new TextDecoder().decode(file.bytes) : null,
                file.executable,
                [...file.bytes],
            ),
        );

        expect(hydrated).toEqual([
            expect.objectContaining({ relativePath: "nested/a.md", text: "a", executable: false }),
            expect.objectContaining({ relativePath: "b.bin", text: null, executable: true }),
        ]);
        first(input.nativeFiles).bytes[0] = 122;
        expect(hydrated?.[0]?.bytes).toEqual(new Uint8Array([97]));
    });

    it("rejects every malformed native descriptor-to-payload relationship", () => {
        const source = validationInput([candidateFile("a.md", "text/markdown", [97], false)]);
        const hydrate = (input: NativeDialectValidationInputV1) =>
            hydrateValidatedNativeSourceFiles(input, (file) =>
                sourceFile(file.relativePath, "a", file.executable, [...file.bytes]),
            );

        const wrongSchema = structuredClone(source);
        (wrongSchema.representation as { schemaVersion: number }).schemaVersion = 3;
        expect(hydrate(wrongSchema)).toBeNull();

        const malformedV2 = structuredClone(source);
        (malformedV2.representation as { schemaVersion: number }).schemaVersion = 2;
        expect(hydrate(malformedV2)).toBeNull();

        const duplicateDescriptor = structuredClone(source);
        duplicateDescriptor.representation.files.push(structuredClone(first(duplicateDescriptor.representation.files)));
        expect(hydrate(duplicateDescriptor)).toBeNull();

        const duplicatePayload = structuredClone(source);
        duplicatePayload.nativeFiles.push(structuredClone(first(duplicatePayload.nativeFiles)));
        expect(hydrate(duplicatePayload)).toBeNull();

        const countMismatch = structuredClone(source);
        countMismatch.representation.files.push({
            ...structuredClone(first(countMismatch.representation.files)),
            relativePath: "b.md",
        });
        expect(hydrate(countMismatch)).toBeNull();

        const missingSameCountPath = structuredClone(source);
        first(missingSameCountPath.nativeFiles).relativePath = "other.md";
        expect(hydrate(missingSameCountPath)).toBeNull();

        const wrongSize = structuredClone(source);
        first(wrongSize.representation.files).byteSize = 2;
        expect(hydrate(wrongSize)).toBeNull();

        const wrongHash = structuredClone(source);
        first(wrongHash.representation.files).contentHash = zeroSha256Digest();
        expect(hydrate(wrongHash)).toBeNull();
    });

    it("builds each portable ancestor once in canonical order", () => {
        expect(
            buildNativeAncestorDirectories(["z/a.md", "a/b/c.md", "a/d.md", "root.md"], (relativePath) => ({ relativePath })),
        ).toEqual([{ relativePath: "a" }, { relativePath: "a/b" }, { relativePath: "z" }]);
        expect(buildNativeAncestorDirectories([], (relativePath) => relativePath)).toEqual([]);
    });

    it("shares projection mechanics without erasing provider text and reference policy", () => {
        const resolvedReference = resolvedAssetReference();
        const candidates: VersionFileInput[] = [
            binaryVersionFile("z.bin", [0, 255]),
            textVersionFile("a.md", "\ufeffline\r\n", [resolvedReference]),
            textVersionFile("empty.md", "plain", undefined, ""),
        ];
        const claudePersisted = [
            persistedTextFile("a.md", "line\n", [resolvedReference]),
            persistedTextFile("empty.md", "plain", [], ""),
            persistedBinaryFile("z.bin", [0, 255]),
        ];
        const opencodePersisted = [
            persistedTextFile("a.md", "\ufeffline\r\n", [resolvedReference]),
            persistedTextFile("empty.md", "plain", [], ""),
            persistedBinaryFile("z.bin", [0, 255]),
        ];

        const claudeCandidate = projectCandidateVersionFiles(candidates, CLAUDE_POLICY);
        const claudeCanonical = projectPersistedVersionFiles(claudePersisted, CLAUDE_POLICY);
        const opencodeCandidate = projectCandidateVersionFiles(candidates, OPENCODE_POLICY);
        const opencodeCanonical = projectPersistedVersionFiles(opencodePersisted, OPENCODE_POLICY);

        expect(claudeCandidate).toEqual(claudeCanonical);
        expect(opencodeCandidate).toEqual(opencodeCanonical);
        expect(claudeCandidate.map((file) => file.logicalPath)).toEqual(["a.md", "empty.md", "z.bin"]);
        expect(claudeCandidate[0]).toMatchObject({
            content: "line\n",
            references: [expect.objectContaining({ resolution: "unresolved" })],
        });
        expect(opencodeCandidate[0]).toMatchObject({
            content: "\ufeffline\n",
            references: [
                expect.objectContaining({
                    resolution: "resolved_asset_version",
                    targetAssetVersionId: TEST_VERSION_ID,
                }),
            ],
        });
        expect(claudeCandidate[1]?.mediaType).toBe("application/octet-stream");
        expect(opencodeCandidate[1]?.mediaType).toBe("");
        expect(claudeCandidate[2]?.content).toBe("AP8=");
        expect(opencodeCandidate[2]?.content).toEqual([0, 255]);
    });
});

const TEST_FILE_ID = "11111111-1111-4111-8111-111111111111";
const TEST_VERSION_ID = "22222222-2222-4222-8222-222222222222";

const CLAUDE_POLICY: NativeVersionFileProjectionPolicy = {
    normalizeMediaType: canonicalMediaTypeWithFallback,
    projectCandidateText: normalizeTextWithoutBom,
    projectPersistedText: (text) => text,
    normalizeBinary: (bytes) => Buffer.from(bytes).toString("base64"),
    projectReferences: (references) =>
        references.map((entry) => ({
            kind: entry.kind,
            rawTarget: entry.rawTarget,
            required: entry.required,
            diagnostics: entry.diagnostics,
            resolution: entry.resolution === "resolved_asset_version" ? "unresolved" : entry.resolution,
            ...(entry.resolution === "resolved_version_file" ? { targetLogicalPath: entry.targetLogicalPath } : {}),
        })),
};

const OPENCODE_POLICY: NativeVersionFileProjectionPolicy = {
    normalizeMediaType: (mediaType) => mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "",
    projectCandidateText: normalizeNewlines,
    projectPersistedText: normalizeNewlines,
    normalizeBinary: (bytes) => [...bytes],
    projectReferences: (references) => references.map((entry) => structuredClone(entry)),
};

function textVersionFile(
    logicalPath: string,
    text: string,
    references?: FileReferenceV2[],
    mediaType = "text/markdown; charset=UTF-8",
): VersionFileInput {
    return {
        logicalPath,
        role: "entry",
        contentKind: "text",
        mediaType,
        text,
        executable: false,
        ...(references === undefined ? {} : { references }),
    };
}

function binaryVersionFile(logicalPath: string, bytes: number[]): VersionFileInput {
    return {
        logicalPath,
        role: "resource",
        contentKind: "binary",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(bytes),
        executable: true,
        references: [],
    };
}

function persistedTextFile(
    logicalPath: string,
    text: string,
    references: FileReferenceV2[],
    mediaType = "text/markdown; charset=UTF-8",
): AssetVersionFileContentV2 {
    return {
        file: persistedFile(logicalPath, "entry", "text", mediaType, references, false),
        contentKind: "text",
        text,
    };
}

function persistedBinaryFile(logicalPath: string, bytes: number[]): AssetVersionFileContentV2 {
    return {
        file: persistedFile(logicalPath, "resource", "binary", "application/octet-stream", [], true),
        contentKind: "binary",
        bytes: new Uint8Array(bytes),
    };
}

function persistedFile(
    logicalPath: string,
    role: "entry" | "resource",
    contentKind: "text" | "binary",
    mediaType: string,
    references: FileReferenceV2[],
    executable: boolean,
): AssetVersionFileContentV2["file"] {
    return {
        fileId: TEST_FILE_ID,
        logicalPath,
        role,
        contentHash: sha256SourceBytes(new Uint8Array()),
        contentKind,
        mediaType,
        byteSize: 0,
        executable,
        references,
    };
}

function resolvedAssetReference(): FileReferenceV2 {
    return {
        kind: "include",
        rawTarget: "asset://shared",
        required: false,
        diagnostics: [],
        resolution: "resolved_asset_version",
        targetAssetVersionId: TEST_VERSION_ID,
    };
}

function normalizeTextWithoutBom(text: string): string {
    const withoutBom = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
    return normalizeNewlines(withoutBom);
}

function normalizeNewlines(text: string): string {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function canonicalMediaTypeWithFallback(mediaType: string): string {
    const trimmed = mediaType.trim().toLowerCase();
    if (trimmed === "") return "application/octet-stream";
    const separator = trimmed.indexOf(";");
    const base = separator < 0 ? trimmed : trimmed.slice(0, separator).trim();
    return base === "" ? "application/octet-stream" : base;
}

function first<T>(values: readonly T[]): T {
    const value = values[0];
    if (value === undefined) throw new Error("test fixture must contain one value");
    return value;
}

function sourceFile(relativePath: string, text: string | null, executable: boolean, bytes: number[]): SourceFileRecord {
    return {
        handle: {
            readEntryHandleId: `handle:${relativePath}`,
            sourceReadObligationId: "obligation",
            sourceRootId: "root",
            relativePath,
            entryKind: "file",
        },
        observedReadEntryId: `entry:${relativePath}`,
        relativePath,
        bytes: new Uint8Array(bytes),
        executable,
        text,
    };
}

function sourceDirectory(relativePath: string): SourceDirectoryRecord {
    return {
        handle: {
            readEntryHandleId: `handle:${relativePath}`,
            sourceReadObligationId: "obligation",
            sourceRootId: "root",
            relativePath,
            entryKind: "directory",
        },
        observedReadEntryId: `entry:${relativePath}`,
        relativePath,
    };
}

function candidateFile(
    relativePath: string,
    mediaType: string,
    bytes: number[],
    executable: boolean,
    contentKind: "text" | "binary" = "text",
): CandidateNativeRepresentationFileInput {
    return {
        relativePath,
        contentKind,
        mediaType,
        bytes: new Uint8Array(bytes),
        executable,
    };
}

function validationInput(files: CandidateNativeRepresentationFileInput[]): NativeDialectValidationInputV1 {
    return {
        canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
        canonicalFiles: [],
        representation: {
            schemaVersion: 1,
            dialectId: "family-skill-v1",
            dialectContractFingerprint: `sha256:${"1".repeat(64)}`,
            canonicalContentFingerprint: `sha256:${"2".repeat(64)}`,
            files: files.map((file) => ({
                relativePath: file.relativePath,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                contentHash: sha256SourceBytes(file.bytes),
                byteSize: file.bytes.byteLength,
                executable: file.executable,
            })),
            representationFingerprint: `sha256:${"3".repeat(64)}`,
        },
        nativeFiles: [...files].reverse().map((file) => ({ relativePath: file.relativePath, bytes: new Uint8Array(file.bytes) })),
    };
}
