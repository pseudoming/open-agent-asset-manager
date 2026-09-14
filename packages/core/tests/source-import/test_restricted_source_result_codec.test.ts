/** Wire grammar controls use a real read result; byte/kind variants do not claim Provider capability. */
import { beforeEach, describe, expect, it } from "vitest";
import {
    decodeRestrictedSourceReadResult,
    encodeRestrictedSourceReadResult,
} from "../../src/source-import/restricted-source-result-codec";
import type { AdapterReadResult, CoreResult } from "../../src/types";
import { failedResult } from "../../src/source-import/source-read-validation-helpers";
import { sourceWireFixture } from "./fixtures/restricted-source-wire-fixtures";
import { candidateReconciliationSemanticKey } from "../../src/orchestration/import-preview";

let baseline: CoreResult<AdapterReadResult>;
beforeEach(async () => {
    const fixture = sourceWireFixture({ partial: true });
    try {
        baseline = await fixture.channel.read(fixture.readRequest);
        expect(baseline.status).toBe("partial");
    } finally {
        await fixture.channel.close();
    }
});

function member(value: unknown, field: string): Record<string, unknown> {
    let current = value as Record<string, unknown>;
    for (const segment of field.split(".")) current = current[segment] as Record<string, unknown>;
    return current;
}
function set(value: unknown, field: string, replacement: unknown): void {
    const segments = field.split(".");
    const key = segments.pop()!;
    const owner = segments.length === 0 ? (value as Record<string, unknown>) : member(value, segments.join("."));
    owner[key] = replacement;
}
function wire(): Record<string, unknown> {
    return JSON.parse(encodeRestrictedSourceReadResult(baseline).toString("utf8")) as Record<string, unknown>;
}
function decode(value: unknown) {
    return decodeRestrictedSourceReadResult(Buffer.from(JSON.stringify(value)));
}
function nativeWire(): Record<string, unknown> {
    const value = wire();
    set(value, "candidates.0.nativeRepresentation", {
        representationSource: "separate_file_graph",
        dialectId: "transport-variant",
        directories: [],
        files: [{ relativePath: "native.md", contentKind: "text", mediaType: "text/plain", bytes: "AP8=", executable: false }],
    });
    return value;
}

describe("restricted source result wire grammar", () => {
    it.each([
        "path",
        "bytes",
        "executable",
    ])("ignores only directory observation IDs during reconciliation and preserves %s", (kind) => {
        const candidate = structuredClone(baseline.value.candidates[0]!);
        candidate.nativeRepresentation = {
            representationSource: "separate_file_graph",
            dialectId: "transport-variant",
            directories: [{ relativePath: "empty", observedReadEntryIds: ["first-observation"] }],
            files: [
                {
                    relativePath: "native.bin",
                    contentKind: "binary",
                    mediaType: "application/octet-stream",
                    bytes: new Uint8Array([0, 255]),
                    executable: false,
                },
            ],
        };
        const before = candidateReconciliationSemanticKey(candidate);
        const changed = structuredClone(candidate);
        if (changed.nativeRepresentation.representationSource !== "separate_file_graph")
            throw new Error("expected complete graph");
        changed.nativeRepresentation.directories[0]!.observedReadEntryIds = ["second-observation"];
        expect(candidateReconciliationSemanticKey(changed)).toBe(before);
        if (kind === "path") changed.nativeRepresentation.directories[0]!.relativePath = "different-empty";
        else if (kind === "bytes") changed.nativeRepresentation.files[0]!.bytes = new Uint8Array([0, 254]);
        else changed.nativeRepresentation.files[0]!.executable = true;
        expect(candidateReconciliationSemanticKey(changed)).not.toBe(before);
        expect(candidate.nativeRepresentation.directories[0]!.observedReadEntryIds).toEqual(["first-observation"]);
    });

    it.each([
        "separate_files",
        "separate_file_graph",
    ] as const)("round-trips binary, native and restoration bytes with %s", (representationSource) => {
        const read = structuredClone(baseline);
        const candidate = read.value!.candidates[0]!;
        const bytes = new Uint8Array([0, 10, 128, 255]);
        candidate.files.push({
            logicalPath: "raw.bin",
            role: "resource",
            contentKind: "binary",
            mediaType: "application/octet-stream",
            bytes,
            executable: true,
            references: [],
        });
        const files = [
            {
                relativePath: "native.md",
                contentKind: "text" as const,
                mediaType: "text/plain",
                bytes,
                executable: false,
                fragmentOrigin: {
                    fragmentKind: "jsonc_top_level_property_value" as const,
                    observedReadEntryId: "observed",
                    propertyName: "prompt",
                },
            },
        ];
        candidate.nativeRepresentation =
            representationSource === "separate_files"
                ? { representationSource, dialectId: "transport-variant", files }
                : {
                      representationSource,
                      dialectId: "transport-variant",
                      files,
                      directories: [{ relativePath: "empty", observedReadEntryIds: ["observed-directory"] }],
                  };
        candidate.dialectRestorationTransition = { action: "replace", bytes };
        expect(decodeRestrictedSourceReadResult(encodeRestrictedSourceReadResult(read))).toEqual(read);
    });

    it("retains a diagnosed failure without inventing a read result", () => {
        const failure = failedResult<AdapterReadResult>(baseline.diagnostics);
        expect(failure.diagnostics.length).toBeGreaterThan(0);
        expect(decodeRestrictedSourceReadResult(encodeRestrictedSourceReadResult(failure))).toEqual(failure);
    });

    it.each([
        new Uint8Array(0),
        new Uint8Array([91, 0, 255, 92]).subarray(1, 3),
    ])("preserves exact empty or offset byte views at every declared position: %s", (bytes) => {
        const read = structuredClone(baseline);
        const candidate = read.value!.candidates[0]!;
        candidate.files.push({
            logicalPath: "raw.bin",
            role: "resource",
            contentKind: "binary",
            mediaType: "application/octet-stream",
            bytes,
            executable: false,
        });
        candidate.nativeRepresentation = {
            representationSource: "separate_files",
            dialectId: "transport-variant",
            files: [
                {
                    relativePath: "raw.bin",
                    contentKind: "binary",
                    mediaType: "application/octet-stream",
                    bytes,
                    executable: false,
                },
            ],
        };
        candidate.dialectRestorationTransition = { action: "replace", bytes };
        expect(decodeRestrictedSourceReadResult(encodeRestrictedSourceReadResult(read))).toEqual(read);
    });

    it.each([
        { status: "complete", diagnostics: [] },
        { status: "failed", diagnostics: [] },
        { status: "failed", diagnostics: null },
    ])("rejects an undiagnosed absent read result: %j", (value) => {
        expect(() => encodeRestrictedSourceReadResult(value as unknown as CoreResult<AdapterReadResult>)).toThrow(
            /diagnosed failure/,
        );
    });
    it.each([[], null, [{}]])("rejects invalid wire failure diagnostics: %j", (failure) => {
        expect(() => decode({ failure })).toThrow(/failure diagnostics/);
    });
    it("rejects malformed UTF-8 and JSON instead of decoding replacement text", () => {
        expect(() => decodeRestrictedSourceReadResult(new Uint8Array([0xff]))).toThrow();
        expect(() => decodeRestrictedSourceReadResult(Buffer.from("{"))).toThrow();
    });

    it.each<[string, unknown, string]>([
        ["unexpected", true, "result fields"],
        ["status", "ready", "result shape"],
        ["readAuthorityFingerprint", "invalid", "result shape"],
        ["readSnapshotFingerprint", "invalid", "result shape"],
        ...[
            "sourceRoots",
            "sourceReadObligations",
            "readAccessOutcomes",
            "observedReadEntries",
            "externalAttestationReceipts",
            "sourceParseReports",
            "candidates",
            "sourceReports",
            "diagnostics",
        ].map((field): [string, unknown, string] => [field, null, "result shape"]),
        ["sourceRoots.0", null, "result diagnostics"],
        ["sourceRoots.0", "invalid", "result diagnostics"],
        ["sourceParseReports.0.status", "ready", "report status"],
        ["sourceReports.0.status", "ready", "report status"],
        ["observedReadEntries.0.entryKind", "symlink", "entry kind"],
        ["observedReadEntries.0.extra", true, "observed entry"],
        ["observedReadEntries.0.observedReadEntryId", 1, "observed entry"],
        ["observedReadEntries.0.sourceRootId", 1, "observed entry"],
        ["observedReadEntries.0.relativePath", "../escaped", "observed entry"],
        ["observedReadEntries.0.physicalIdentityFingerprint", "invalid", "observed entry"],
        ["observedReadEntries.0.contentHash", "invalid", "observed entry"],
        ["observedReadEntries.0.executable", 1, "observed entry"],
        ["candidates.0.extra", true, "candidate shape"],
        ["candidates.0.kind", "Other", "candidate shape"],
        ["candidates.0.displayDescription", 1, "candidate shape"],
        ["candidates.0.files", {}, "candidate shape"],
        ["candidates.0.sourceRootIds", {}, "candidate shape"],
        ["candidates.0.files.0.contentKind", "symlink", "content kind"],
        ["candidates.0.files.0.extra", true, "candidate file"],
        ["candidates.0.files.0.logicalPath", "../escaped", "candidate file"],
        ["candidates.0.files.0.executable", 1, "candidate file"],
        ["candidates.0.files.0.mediaType", 1, "candidate file"],
        ["candidates.0.files.0.role", "unknown", "candidate file"],
        ["candidates.0.files.0.references", {}, "candidate file"],
        ["candidates.0.files.0.text", 1, "candidate text"],
        ["candidates.0.nativeRepresentation.representationSource", "unknown", "native representation"],
        ["candidates.0.nativeRepresentation.extra", true, "native fields"],
        ["candidates.0.nativeRepresentation.dialectId", 1, "native fields"],
        ["candidates.0.dialectRestorationTransition.action", "unknown", "restoration action"],
        ["candidates.0.dialectRestorationTransition.extra", true, "restoration action"],
    ])("rejects %s corruption", (field, replacement, error) => {
        const value = wire();
        set(value, field as string, replacement);
        expect(() => decode(value)).toThrow(error as string);
    });

    it("accepts a declared directory observation and rejects its missing fingerprint", () => {
        const value = wire();
        const entry = member(value, "observedReadEntries.0");
        entry.entryKind = "directory";
        entry.directoryInventoryFingerprint = entry.contentHash;
        delete entry.contentHash;
        delete entry.executable;
        expect(decode(value).value!.observedReadEntries[0]!.entryKind).toBe("directory");
        entry.directoryInventoryFingerprint = "invalid";
        expect(() => decode(value)).toThrow(/observed entry/);
    });

    it.each([
        ["files", {}, "native graph"],
        ["directories", {}, "native graph"],
        ["files.0.extra", true, "native file"],
        ["files.0.relativePath", "../escaped", "native file"],
        ["files.0.contentKind", "link", "native file"],
        ["files.0.mediaType", 1, "native file"],
        ["files.0.executable", 1, "native file"],
        ["files.0.bytes", 1, "explicit base64"],
        ["files.0.bytes", "AP8", "not canonical"],
    ])("rejects native %s corruption", (field, replacement, error) => {
        const value = nativeWire();
        set(value, `candidates.0.nativeRepresentation.${field}`, replacement);
        expect(() => decode(value)).toThrow(error as string);
    });

    it.each([
        { action: "replace", bytes: "AP8=", extra: true },
        { action: "replace", bytes: 1 },
        { action: "replace", bytes: "AP8" },
    ])("rejects malformed restoration bytes: %j", (restoration) => {
        const value = wire();
        set(value, "candidates.0.dialectRestorationTransition", restoration);
        expect(() => decode(value)).toThrow();
    });

    it("leaves the Workflow and optional Memory handoffs for full source-contract validation", () => {
        for (const kind of ["Workflow", "Memory"] as const) {
            const value = wire();
            const candidate = member(value, "candidates.0");
            candidate.kind = kind;
            if (kind === "Workflow") candidate.workflowExecutionAgentBindingInput = { bindingInputKind: "none" };
            else candidate.memoryCatalogMemberBindingInputs = [];
            const decoded = decode(value).value!.candidates[0]!;
            expect(decoded.kind).toBe(kind);
            if (kind === "Workflow") {
                expect(decoded).toHaveProperty(
                    "workflowExecutionAgentBindingInput",
                    candidate.workflowExecutionAgentBindingInput,
                );
            } else {
                expect(decoded).toHaveProperty("memoryCatalogMemberBindingInputs", candidate.memoryCatalogMemberBindingInputs);
            }
            if (kind === "Memory") {
                delete candidate.memoryCatalogMemberBindingInputs;
                const withoutBinding = decode(value).value!.candidates[0]!;
                expect(withoutBinding.kind).toBe(kind);
                expect(withoutBinding).not.toHaveProperty("memoryCatalogMemberBindingInputs");
            }
        }
    });

    it("rejects non-byte values at a declared binary position", () => {
        const read = structuredClone(baseline);
        const file = member(read.value, "candidates.0.files.0");
        file.contentKind = "binary";
        file.bytes = "AP8=";
        delete file.text;
        expect(() => encodeRestrictedSourceReadResult(read)).toThrow(/not a byte array/);
    });

    it.each([
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1n,
        undefined,
        new Date(0),
        new Uint8Array([1]),
    ])("rejects undeclared non-JSON private values: %s", (value) => {
        const read = structuredClone(baseline);
        set(read.value, "candidates.0.typeData.transportVariant", value);
        expect(() => encodeRestrictedSourceReadResult(read)).toThrow(/undeclared non-JSON value/);
    });
    it("preserves null-prototype plain private data without reviving undeclared values", () => {
        const read = structuredClone(baseline);
        set(
            read.value,
            "candidates.0.typeData.transportVariant",
            Object.assign(Object.create(null), { number: 2, absent: null, flag: true }),
        );
        expect(decodeRestrictedSourceReadResult(encodeRestrictedSourceReadResult(read))).toEqual(read);
    });
});
