/** Real captured file/directory identities seed the private byte and declaration grammar controls. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { buildDeployEntries } from "../../src/deployment/deployment-target-entries";
import {
    captureDeploymentPreWritePreview,
    type DeploymentPreWritePreviewInput,
} from "../../src/deployment/deployment-prewrite-preview";
import {
    decodeRestrictedGraphPreparation,
    encodeRestrictedGraphPreparation,
    decodeRestrictedReplacementAuthority,
    encodeRestrictedReplacementAuthority,
} from "../../src/deployment/restricted-target-graph-codec";
import {
    decodeRestrictedPreview,
    encodeRestrictedPreview,
    decodeRestrictedTargetContent,
    encodeRestrictedTargetContent,
} from "../../src/deployment/restricted-target-preview-codec";
import {
    decodeRestrictedContainerPatches,
    encodeRestrictedContainerPatches,
    decodeRestrictedContainerCapture,
    encodeRestrictedContainerCapture,
    isRestrictedContainerFailure,
} from "../../src/deployment/restricted-target-container-codec";

const roots: string[] = [];
const fingerprint = sha256Bytes(Buffer.from("target codec control"));
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function set(value: unknown, field: string, replacement: unknown) {
    const segments = field.split(".");
    const key = segments.pop()!;
    let owner = value as Record<string, unknown>;
    for (const segment of segments) owner = owner[segment] as Record<string, unknown>;
    owner[key] = replacement;
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-target-codec-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "leaf"));
    fs.writeFileSync(path.join(root, "leaf/first.bin"), Buffer.from([0, 255, 128, 10]), { mode: 0o744 });
    const input: DeploymentPreWritePreviewInput = {
        deploymentId: randomUUID(),
        targetRootPath: root,
        renderInputFingerprint: fingerprint,
        selectionFingerprint: fingerprint,
        compilationFingerprint: fingerprint,
        targetPlan: {
            schemaVersion: 1,
            targetFiles: ["leaf/first.bin", "leaf/second.bin"].map((relativePath) => ({
                relativePath,
                executable: false,
                content: { contentKind: "binary", bytes: new Uint8Array([1, 0, 255]) },
                outputUnitFingerprint: fingerprint,
                materializationFingerprint: fingerprint,
                semanticRefFingerprints: [fingerprint],
                sectionBindings: [],
            })),
            managedDirectoryBoundaries: [
                { relativePath: "leaf", outputUnitFingerprint: fingerprint, desiredDirectoryPaths: ["leaf", "leaf/empty"] },
            ],
        },
        baseline: [
            {
                relativePath: "leaf/first.bin",
                managedDirectoryBoundaryPaths: ["leaf"],
                baselineState: {
                    appliedPayload: { contentHash: sha256Bytes(Buffer.from([0, 255, 128, 10])) },
                    appliedExecutable: true,
                },
            },
        ],
    };
    const authority = captureDeploymentPreWritePreview(input).runtimeReplacementAuthority;
    const authorityWire = encodeRestrictedReplacementAuthority(authority);
    expect(decodeRestrictedReplacementAuthority(authorityWire)).toEqual(authority);
    expect(authorityWire.files.map((file) => file.expectedState)).toEqual(["present", "missing"]);
    expect(authorityWire.directories.map((directory) => directory.expectedState)).toEqual(["present", "missing"]);
    const preview = encodeRestrictedPreview(input);
    const { targetRootPath: _root, ...projected } = input;
    expect(decodeRestrictedPreview(preview)).toEqual(projected);
    const graph = {
        compilationFingerprint: fingerprint,
        entries: buildDeployEntries(input.targetPlan, new Map()).map((entry) => ({
            ...entry,
            newProvenanceFingerprint: fingerprint,
            newMaterializationFingerprint: fingerprint,
        })),
        managedDirectoryBoundaries: ["leaf"],
        desiredDirectoryPaths: ["leaf", "leaf/empty"],
        runtimeReplacementAuthority: authority,
    };
    const graphWire = encodeRestrictedGraphPreparation(graph);
    expect(decodeRestrictedGraphPreparation(graphWire)).not.toBeNull();
    return { input, authority, authorityWire, preview, graph, graphWire };
}

describe("restricted target content and replacement bytes", () => {
    it.each([
        new Uint8Array(),
        new Uint8Array([91, 0, 255, 92]).subarray(1, 3),
    ])("round-trips exact binary bytes including an empty buffer and a view", (bytes) => {
        const source = { contentKind: "binary" as const, bytes };
        expect(decodeRestrictedTargetContent(encodeRestrictedTargetContent(source))).toEqual(source);
        expect(
            decodeRestrictedTargetContent(encodeRestrictedTargetContent({ contentKind: "text", text: "\uFEFFa\r\n" })),
        ).toEqual({ contentKind: "text", text: "\uFEFFa\r\n" });
    });
    it.each([
        null,
        "text",
        {},
        { contentKind: "text", text: 1 },
        { contentKind: "text", text: "ok", extra: true },
        { contentKind: "binary", bytesBase64: 1 },
        { contentKind: "binary", bytesBase64: "AB==" },
        { contentKind: "binary", bytesBase64: "?" },
        { contentKind: "other", bytesBase64: "" },
    ])("rejects malformed target content %j", (value) => {
        expect(decodeRestrictedTargetContent(value)).toBeNull();
    });

    it.each<[string, unknown]>([
        ["files", null],
        ["directories", null],
        ["directories", Array(4097).fill(null)],
        ["managedDirectoryBoundaryPaths", ["leaf", "leaf/sub"]],
        ["desiredManagedDirectoryBoundaryPaths", ["../escape"]],
        ["unmanagedRemovalPaths", ["a", "a"]],
        ["directoryRemovalPaths", ["../escape"]],
        ["replacementScope", null],
        ["replacementScope", { filePaths: [], directoryPaths: [], force: true }],
        ["replacementScope", { filePaths: ["../escape"], directoryPaths: [] }],
        ["replacementScope", { filePaths: [], directoryPaths: ["leaf", "leaf"] }],
        ["files.0", null],
        ["files.0", "file"],
        ["files.0.relativePath", "../escape"],
        ["files.0.expectedState", "unknown"],
        ["files.0.expectedExecutable", 1],
        ["files.0.expectedBytesBase64", null],
        ["files.0.expectedBytesBase64", "AB=="],
        ["files.0.expectedIdentity", null],
        ["files.0.expectedIdentity", "bad"],
        ["files.0.expectedIdentity.entryKind", "directory"],
        ["files.0.extra", true],
        ["files.1.extra", true],
        ["directories.0", null],
        ["directories.0", "directory"],
        ["directories.0.relativePath", "../escape"],
        ["directories.0.expectedState", "unknown"],
        ["directories.0.expectedIdentity", null],
        ["directories.0.expectedIdentity.entryKind", "file"],
        ["directories.1.extra", true],
    ])("rejects replacement authority damage to %s", (field, replacement) => {
        const h = fixture();
        set(h.authorityWire, field, replacement);
        expect(decodeRestrictedReplacementAuthority(h.authorityWire)).toBeNull();
    });
    it("preserves optional file identity absence while rejecting duplicate declarations and unknown envelope fields", () => {
        const h = fixture();
        const present = h.authorityWire.files[0]!;
        if (present.expectedState !== "present") throw new Error("expected captured file");
        delete present.expectedIdentity;
        const decoded = decodeRestrictedReplacementAuthority(h.authorityWire);
        expect(decoded?.files[0]).not.toHaveProperty("expectedIdentity");
        expect(decoded?.files[0]).toMatchObject({ expectedBytes: new Uint8Array([0, 255, 128, 10]), expectedExecutable: true });
        expect(decodeRestrictedReplacementAuthority({ ...h.authorityWire, files: [present, present] })).toBeNull();
        expect(
            decodeRestrictedReplacementAuthority({
                ...h.authorityWire,
                directories: [h.authorityWire.directories[0], h.authorityWire.directories[0]],
            }),
        ).toBeNull();
        expect(decodeRestrictedReplacementAuthority({ ...h.authorityWire, extra: true })).toBeNull();
    });
});

describe("restricted graph preparation declarations", () => {
    it("round-trips the exact transaction and project staging anchor and rejects unbound or noncanonical anchors", () => {
        const h = fixture();
        const publicationTransactionId = randomUUID();
        const input = { ...h.graph, publicationTransactionId, publicationProjectRootPath: h.input.targetRootPath };
        const encoded = encodeRestrictedGraphPreparation(input);
        expect(decodeRestrictedGraphPreparation(encoded)).toMatchObject(input);
        expect(decodeRestrictedGraphPreparation({ ...encoded, publicationTransactionId: "invalid" })).toBeNull();
        expect(decodeRestrictedGraphPreparation({ ...encoded, publicationProjectRootPath: "../escape" })).toBeNull();
        const { publicationTransactionId: _transaction, ...unbound } = encoded;
        expect(decodeRestrictedGraphPreparation(unbound)).toBeNull();
    });

    it("preserves absent replacement authority and fills only the original managed-baseline default", () => {
        const h = fixture();
        const { runtimeReplacementAuthority: _authority, ...input } = h.graph;
        const encoded = encodeRestrictedGraphPreparation(input);
        expect(encoded).not.toHaveProperty("runtimeReplacementAuthority");
        expect(decodeRestrictedGraphPreparation(encoded)).toEqual({
            ...input,
            entries: input.entries.map((entry) => ({ ...entry, entryAuthority: "managed_baseline" })),
        });
    });
    it.each<[string, unknown]>([
        ["compilationFingerprint", "invalid"],
        ["entries", null],
        ["entries.0.oldHash", "invalid"],
        ["managedDirectoryBoundaries", ["leaf", "leaf"]],
        ["desiredDirectoryPaths", ["leaf", "leaf"]],
        ["desiredDirectoryPaths", ["../escape"]],
        ["desiredDirectoryPaths", Array.from({ length: 4097 }, (_, i) => `d${i}`)],
        ["runtimeReplacementAuthority", null],
        ["extra", true],
    ])("rejects invalid graph preparation %s", (field, replacement) => {
        const h = fixture();
        set(h.graphWire, field, replacement);
        expect(decodeRestrictedGraphPreparation(h.graphWire)).toBeNull();
    });
    it("rejects primitive preparations, repeated entries and an invalid typed encoder input", () => {
        expect(decodeRestrictedGraphPreparation(null)).toBeNull();
        expect(decodeRestrictedGraphPreparation("input")).toBeNull();
        const h = fixture();
        h.graphWire.entries.push(h.graphWire.entries[0]!);
        expect(decodeRestrictedGraphPreparation(h.graphWire)).toBeNull();
        expect(() => encodeRestrictedGraphPreparation({ ...h.graph, desiredDirectoryPaths: ["../escape"] })).toThrow();
    });
});

describe("restricted target preview contract", () => {
    it.each([null, fingerprint])("preserves the confirmed shared-container preimage %s", (containerPatchPreimageHash) => {
        const h = fixture();
        h.input.targetPlan.targetFiles[0]!.relativePath = "config.json";
        h.input.targetPlan.targetFiles[0]!.content = { contentKind: "text", text: "{}" };
        h.input.targetPlan.targetFiles[0]!.containerPatchPreimageHash = containerPatchPreimageHash;
        const decoded = decodeRestrictedPreview(encodeRestrictedPreview(h.input));
        expect(decoded).not.toBeNull();
        expect(decoded!.targetPlan.targetFiles[0]!.containerPatchPreimageHash).toBe(containerPatchPreimageHash);
    });

    it.each<[string, unknown]>([
        ["extra", true],
        ["deploymentId", "invalid"],
        ["selectionFingerprint", "invalid"],
        ["targetPlan.schemaVersion", 2],
        ["targetPlan.targetFiles", Array(257).fill(null)],
        ["targetPlan.managedDirectoryBoundaries", Array(4097).fill(null)],
        ["targetPlan.targetFiles.0.relativePath", "../escape"],
        ["targetPlan.targetFiles.0.executable", 1],
        ["targetPlan.targetFiles.0.outputUnitFingerprint", "invalid"],
        ["targetPlan.targetFiles.0.semanticRefFingerprints", ["invalid"]],
        ["targetPlan.targetFiles.0.sectionBindings", [{}]],
        ["targetPlan.targetFiles.0.content", null],
        ["targetPlan.managedDirectoryBoundaries.0.outputUnitFingerprint", "invalid"],
        ["targetPlan.managedDirectoryBoundaries.0.desiredDirectoryPaths", ["leaf", "leaf"]],
        ["targetPlan.managedDirectoryBoundaries.0.relativePath", "leaf/first.bin"],
        ["baseline", Array(257).fill(null)],
        ["baseline.0.relativePath", "../escape"],
        ["baseline.0.managedDirectoryBoundaryPaths", ["other"]],
        ["baseline.0.baselineState.appliedPayload.contentHash", "invalid"],
        ["baseline.0.baselineState.appliedExecutable", 1],
    ])("rejects invalid preview %s", (field, replacement) => {
        const h = fixture();
        set(h.preview, field, replacement);
        expect(decodeRestrictedPreview(h.preview)).toBeNull();
    });
    it("retains optional directory-path absence, rejects duplicate baseline paths, and validates encoder input", () => {
        const h = fixture();
        delete h.preview.targetPlan.managedDirectoryBoundaries[0]!.desiredDirectoryPaths;
        expect(decodeRestrictedPreview(h.preview)?.targetPlan.managedDirectoryBoundaries[0]).not.toHaveProperty(
            "desiredDirectoryPaths",
        );
        h.preview.baseline.push(h.preview.baseline[0]!);
        expect(decodeRestrictedPreview(h.preview)).toBeNull();
        expect(() => encodeRestrictedPreview({ ...h.input, deploymentId: "invalid" })).toThrow();
    });
});

describe("restricted JSONC container bytes and exact failure taxonomy", () => {
    const valid = () => ({
        relativePath: "config.json",
        propertyName: "memory",
        fragment: new Uint8Array(Buffer.from('["./memory.md"]')),
    });
    it("round-trips missing and existing containers plus original JSONC patch fragments", () => {
        const intent = valid();
        expect(decodeRestrictedContainerPatches(encodeRestrictedContainerPatches([intent]))).toEqual([intent]);
        const captures = [
            { relativePath: "missing.json", currentBytes: null },
            { relativePath: "present.json", currentBytes: new Uint8Array(Buffer.from('{/* note */ "other":true}')) },
        ];
        expect(decodeRestrictedContainerCapture(encodeRestrictedContainerCapture(captures))).toEqual(captures);
    });
    it.each<[string, unknown]>([
        ["relativePath", "../escape"],
        ["propertyName", null],
        ["fragmentBase64", "?"],
        ["fragmentBase64", Buffer.from("not JSON").toString("base64")],
        ["extra", true],
    ])("rejects malformed patch %s", (field, value) => {
        const wire = encodeRestrictedContainerPatches([valid()]);
        set(wire[0], field, value);
        expect(decodeRestrictedContainerPatches(wire)).toBeNull();
    });
    it("rejects wrong-sized collections, invalid encoder intents, duplicate captures and noncanonical bytes", () => {
        for (const value of [null, [], Array(257).fill(null)]) expect(decodeRestrictedContainerPatches(value)).toBeNull();
        expect(() => encodeRestrictedContainerPatches([{ ...valid(), relativePath: "../escape" }])).toThrow();
        for (const value of [
            null,
            Array(257).fill(null),
            [{ relativePath: "../escape", currentBase64: null }],
            [{ relativePath: "a", currentBase64: "?" }],
            [
                { relativePath: "a", currentBase64: null },
                { relativePath: "a", currentBase64: null },
            ],
        ])
            expect(decodeRestrictedContainerCapture(value)).toBeNull();
    });
    it.each([
        ["render.materialization_container_patch_target_unavailable", "unavailable", true],
        ["render.materialization_container_patch_limit", "unsupported", false],
        ["render.materialization_container_patch_rejected", "unsupported", false],
        ["render.materialization_container_patch_internal_error", "internal_error", false],
    ])("binds %s to its original cause and retry semantics", (code, causeKind, retryable) => {
        const failure = { code, causeKind, retryable, message: "original failure" };
        expect(isRestrictedContainerFailure(failure)).toBe(true);
        expect(isRestrictedContainerFailure({ ...failure, retryable: !retryable })).toBe(false);
        expect(isRestrictedContainerFailure({ ...failure, causeKind: "other" })).toBe(false);
        expect(isRestrictedContainerFailure({ ...failure, message: 1 })).toBe(false);
        expect(isRestrictedContainerFailure({ ...failure, extra: true })).toBe(false);
    });
    it.each([
        null,
        { code: "toString", causeKind: "internal_error", message: "bad", retryable: false },
        { code: 1, causeKind: "unsupported", message: "bad", retryable: false },
    ])("rejects unrelated failure metadata %j", (failure) => {
        expect(isRestrictedContainerFailure(failure)).toBe(false);
    });
});
