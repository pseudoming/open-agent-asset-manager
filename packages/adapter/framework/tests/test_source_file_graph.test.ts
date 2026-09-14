import { describe, expect, it } from "vitest";
import type { FileReferenceV2 } from "@oaam/core";
import type { SourceFileRecord } from "../src";
import { buildSourceFileGraph } from "../src";

describe("canonical source file graph assembly", () => {
    it("assembles sorted entry, text resource, binary resource, references, and origins", () => {
        const entry = file("root/SKILL.md", "frontmatter plus body", true, "entry-id");
        const textResource = file("root/z.md", "[entry](SKILL.md)", true, "text-id");
        const binaryResource = file("root/a.bin", null, false, "binary-id", [0, 255]);
        const referenceCalls: string[] = [];
        const result = buildSourceFileGraph({
            sourceFiles: [textResource, entry, binaryResource],
            entry,
            entryText: "body only",
            preserveEntryExecutable: true,
            logicalPathFor: (source) => source.relativePath.slice("root/".length),
            referencesFor: (text, logicalPaths, logicalPath) => {
                referenceCalls.push(`${logicalPath}:${text}:${[...logicalPaths].sort().join(",")}`);
                return logicalPath === "z.md" ? [reference("SKILL.md")] : [];
            },
        });

        expect(result.files.map((item) => item.logicalPath)).toEqual(["SKILL.md", "a.bin", "z.md"]);
        expect(result.files[0]).toMatchObject({
            role: "entry",
            contentKind: "text",
            mediaType: "text/markdown",
            text: "body only",
            executable: true,
            references: [],
        });
        expect(result.files[1]).toMatchObject({
            role: "resource",
            contentKind: "binary",
            mediaType: "application/octet-stream",
            executable: false,
            references: [],
        });
        expect((result.files[1] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([0, 255]));
        expect(result.files[2]).toMatchObject({
            role: "resource",
            contentKind: "text",
            text: "[entry](SKILL.md)",
            executable: true,
            references: [expect.objectContaining({ rawTarget: "SKILL.md" })],
        });
        expect(result.sourceFileOrigins).toEqual([
            { logicalPath: "SKILL.md", observedReadEntryIds: ["entry-id"] },
            { logicalPath: "a.bin", observedReadEntryIds: ["binary-id"] },
            { logicalPath: "z.md", observedReadEntryIds: ["text-id"] },
        ]);
        expect(referenceCalls).toHaveLength(2);
    });

    it("can deliberately clear the executable bit on a canonical entry", () => {
        const entry = file("SKILL.md", "source", true, "entry-id");
        const result = buildSourceFileGraph({
            sourceFiles: [entry],
            entry,
            entryText: "body",
            preserveEntryExecutable: false,
            logicalPathFor: (source) => source.relativePath,
            referencesFor: () => [],
        });
        expect(result.files[0]).toMatchObject({ executable: false, text: "body" });
    });

    it("resolves an equivalent entry record by stable identity instead of object identity", () => {
        const sourceEntry = file("root/SKILL.md", "source", false, "entry-id");
        const equivalentEntry = file("root/SKILL.md", "source", false, "entry-id");
        const result = buildSourceFileGraph({
            sourceFiles: [sourceEntry],
            entry: equivalentEntry,
            entryText: "canonical body",
            preserveEntryExecutable: false,
            logicalPathFor: () => "SKILL.md",
            referencesFor: () => [],
        });
        expect(result.files).toEqual([expect.objectContaining({ role: "entry", text: "canonical body" })]);
    });

    it("fails closed when stable entry identity is absent or duplicated", () => {
        const entry = file("root/SKILL.md", "source", false, "entry-id");
        const build = (sourceFiles: SourceFileRecord[]) =>
            buildSourceFileGraph({
                sourceFiles,
                entry,
                entryText: "canonical body",
                preserveEntryExecutable: false,
                logicalPathFor: (source) => source.relativePath,
                referencesFor: () => [],
            });
        expect(() => build([])).toThrow("requires exactly one stable entry record");
        expect(() => build([entry, { ...entry }])).toThrow("requires exactly one stable entry record");
    });
});

function file(
    relativePath: string,
    text: string | null,
    executable: boolean,
    observedReadEntryId: string,
    bytes = [...new TextEncoder().encode(text ?? "")],
): SourceFileRecord {
    return {
        handle: {
            readEntryHandleId: `handle:${observedReadEntryId}`,
            sourceReadObligationId: "obligation",
            sourceRootId: "root",
            relativePath,
            entryKind: "file",
        },
        observedReadEntryId,
        relativePath,
        bytes: new Uint8Array(bytes),
        executable,
        text,
    };
}

function reference(rawTarget: string): FileReferenceV2 {
    return {
        kind: "link",
        rawTarget,
        required: false,
        diagnostics: [],
        resolution: "resolved_version_file",
        targetLogicalPath: rawTarget,
    };
}
