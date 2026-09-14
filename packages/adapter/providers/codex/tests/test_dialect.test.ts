import { describe, expect, it } from "vitest";
import type {
    AdapterExtractedAssetCandidate,
    NativeDialectValidationInputV1,
    PortableEntryDialectValidationInputV1,
    UuidV4,
} from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { codexProvider } from "../src/codex-provider";
import { validateCodexNativeDialect } from "../src/codex-source-read-native";
import { DIGEST, projectRoot, readGuidance, readSkill, skillRoot } from "./codex-source-test-fixtures";

describe("Codex native Guidance dialect", () => {
    it("re-parses the exact native source and rejects changed native or canonical content", async () => {
        const read = await readGuidance(projectRoot(), {
            "docs/AGENTS.md": "Native guidance\r\n",
        });
        const candidate = read.candidates[0];
        if (candidate?.kind !== "Guidance" || candidate.nativeRepresentation.representationSource !== "separate_files") {
            throw new Error("missing Codex Guidance candidate");
        }
        const native = candidate.nativeRepresentation.files[0];
        const canonical = candidate.files[0];
        if (native === undefined || canonical?.contentKind !== "text") throw new Error("missing fixture files");
        const input: NativeDialectValidationInputV1 = {
            canonical: { kind: "Guidance", typeData: candidate.typeData },
            canonicalFiles: [
                {
                    file: {
                        fileId: "00000000-0000-4000-8000-000000000001",
                        logicalPath: canonical.logicalPath,
                        role: canonical.role,
                        contentHash: DIGEST,
                        contentKind: "text",
                        mediaType: canonical.mediaType,
                        byteSize: Buffer.byteLength(canonical.text, "utf8"),
                        executable: canonical.executable,
                        references: canonical.references ?? [],
                    },
                    contentKind: "text",
                    text: canonical.text.replace(/\r\n/g, "\n"),
                },
            ],
            representation: {
                schemaVersion: 1,
                dialectId: candidate.nativeRepresentation.dialectId,
                dialectContractFingerprint: DIGEST,
                canonicalContentFingerprint: DIGEST,
                files: [
                    {
                        relativePath: native.relativePath,
                        contentKind: native.contentKind,
                        mediaType: native.mediaType,
                        contentHash: sha256SourceBytes(native.bytes),
                        byteSize: native.bytes.byteLength,
                        executable: native.executable,
                    },
                ],
                representationFingerprint: DIGEST,
            },
            nativeFiles: [{ relativePath: native.relativePath, bytes: new Uint8Array(native.bytes) }],
        };

        expect(validateCodexNativeDialect(input)).toBe(true);
        expect(codexProvider.dialectContracts.native[0]?.validateSameContent(input)).toBe(true);

        const wrongDialect = structuredClone(input);
        wrongDialect.representation.dialectId = "codex-guidance-markdown-v2";
        expect(validateCodexNativeDialect(wrongDialect)).toBe(false);

        const missingFile = structuredClone(input);
        missingFile.representation.files = [];
        expect(validateCodexNativeDialect(missingFile)).toBe(false);

        const changedNative = structuredClone(input);
        changedNative.nativeFiles[0] = { relativePath: native.relativePath, bytes: Buffer.from("Changed\n") };
        expect(validateCodexNativeDialect(changedNative)).toBe(false);

        const changedCanonical = structuredClone(input);
        const canonicalFile = changedCanonical.canonicalFiles[0];
        if (canonicalFile?.contentKind === "text") canonicalFile.text = "Changed\n";
        expect(validateCodexNativeDialect(changedCanonical)).toBe(false);

        const unsafePath = structuredClone(input);
        unsafePath.representation.files[0] = {
            ...firstRepresentationFile(unsafePath),
            relativePath: "../TEAM_GUIDE.md",
        };
        unsafePath.nativeFiles[0] = { relativePath: "../TEAM_GUIDE.md", bytes: new Uint8Array(native.bytes) };
        expect(validateCodexNativeDialect(unsafePath)).toBe(false);

        const oversizedPath = structuredClone(input);
        const oversizedName = `${"x".repeat(256)}.md`;
        oversizedPath.representation.files[0] = {
            ...firstRepresentationFile(oversizedPath),
            relativePath: oversizedName,
        };
        oversizedPath.nativeFiles[0] = { relativePath: oversizedName, bytes: new Uint8Array(native.bytes) };
        expect(validateCodexNativeDialect(oversizedPath)).toBe(false);

        const configuredFallbackPath = structuredClone(input);
        configuredFallbackPath.representation.files[0] = {
            ...firstRepresentationFile(configuredFallbackPath),
            relativePath: "TEAM_GUIDE.md",
        };
        configuredFallbackPath.nativeFiles[0] = { relativePath: "TEAM_GUIDE.md", bytes: new Uint8Array(native.bytes) };
        expect(validateCodexNativeDialect(configuredFallbackPath)).toBe(true);

        const bomAndParameters = structuredClone(input);
        const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Native guidance\r\n")]);
        bomAndParameters.representation.files[0] = {
            ...firstRepresentationFile(bomAndParameters),
            mediaType: "TEXT/MARKDOWN; charset=utf-8",
            contentHash: sha256SourceBytes(bomBytes),
            byteSize: bomBytes.byteLength,
        };
        bomAndParameters.nativeFiles[0] = { relativePath: native.relativePath, bytes: bomBytes };
        expect(validateCodexNativeDialect(bomAndParameters)).toBe(true);

        const binary = structuredClone(input);
        binary.representation.files[0] = { ...firstRepresentationFile(binary), contentKind: "binary" };
        expect(validateCodexNativeDialect(binary)).toBe(false);
    });

    it.each([1, 2] as const)("re-parses the Skill native v%s graph and preserves binary resources", async (schemaVersion) => {
        const read = await readSkill(skillRoot(), {
            "demo/SKILL.md": "---\nname: demo\ndescription: Demo skill\n---\nBody\r\n",
            "demo/assets/blob.bin": new Uint8Array([0xff, 0x00, 0x80]),
            "demo/agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
        });
        const candidate = read.candidates[0];
        if (candidate?.kind !== "Skill" || candidate.nativeRepresentation.representationSource !== "separate_file_graph") {
            throw new Error("missing Codex Skill candidate");
        }
        const input = nativeInput(candidate, schemaVersion);
        expect(input.representation.schemaVersion).toBe(schemaVersion);
        if (input.representation.schemaVersion === 2) {
            expect(input.representation.directories).toEqual(
                candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
            );
        }
        expect(validateCodexNativeDialect(input)).toBe(true);
        expect(codexProvider.dialectContracts.native[1]?.validateSameContent(input)).toBe(true);

        const changedResource = structuredClone(input);
        const resourceIndex = changedResource.nativeFiles.findIndex((file) => file.relativePath.endsWith("blob.bin"));
        changedResource.nativeFiles[resourceIndex] = {
            relativePath: changedResource.nativeFiles[resourceIndex]?.relativePath ?? "",
            bytes: new Uint8Array([0x01]),
        };
        expect(validateCodexNativeDialect(changedResource)).toBe(false);

        const missingEntry = structuredClone(input);
        missingEntry.representation.files = missingEntry.representation.files.filter(
            (file) => !file.relativePath.endsWith("SKILL.md"),
        );
        missingEntry.nativeFiles = missingEntry.nativeFiles.filter((file) => !file.relativePath.endsWith("SKILL.md"));
        expect(validateCodexNativeDialect(missingEntry)).toBe(false);

        const outsideFolder = structuredClone(input);
        const resource = outsideFolder.representation.files.find((file) => file.relativePath.endsWith("blob.bin"));
        const nativeResource = outsideFolder.nativeFiles.find((file) => file.relativePath.endsWith("blob.bin"));
        if (resource === undefined || nativeResource === undefined) throw new Error("missing binary Skill fixture");
        resource.relativePath = "other/blob.bin";
        nativeResource.relativePath = "other/blob.bin";
        expect(validateCodexNativeDialect(outsideFolder)).toBe(false);
    });

    it("accepts the Skill entry dialect only for exact Codex sources and canonical Skill entries", async () => {
        const read = await readSkill(skillRoot(), {
            "demo/SKILL.md": "---\nname: demo\ndescription: Demo skill\n---\nBody\n",
        });
        const candidate = read.candidates[0];
        if (candidate?.kind !== "Skill") throw new Error("missing Codex Skill candidate");
        const contract = codexProvider.dialectContracts.portableEntries[0];
        if (contract === undefined) throw new Error("missing Codex Skill entry dialect");
        const input: PortableEntryDialectValidationInputV1 = {
            use: { kind: "Skill", field: "skill_entry", dialectId: "codex-skill-markdown-v1", logicalPath: "SKILL.md" },
            versionStatus: "complete",
            canonical: { kind: "Skill", typeData: candidate.typeData },
            canonicalFiles: nativeInput(candidate).canonicalFiles,
        };
        expect(contract.validateCanonicalEntry(input)).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_CLI", versionText: "fixture" })).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_APP", versionText: "fixture" })).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "OPENCODE_CLI", versionText: "fixture" })).toBe(false);

        const missing = structuredClone(input);
        missing.canonicalFiles = [];
        expect(contract.validateCanonicalEntry(missing)).toBe(false);
        missing.versionStatus = "incomplete";
        expect(contract.validateCanonicalEntry(missing)).toBe(true);

        const wrongUse = structuredClone(input);
        wrongUse.use.kind = "Workflow";
        expect(contract.validateCanonicalEntry(wrongUse)).toBe(false);
        const wrongCanonical = structuredClone(input);
        wrongCanonical.canonical.kind = "Workflow";
        expect(contract.validateCanonicalEntry(wrongCanonical)).toBe(false);
        const wrongDialect = structuredClone(input);
        if (wrongDialect.canonical.kind !== "Skill") throw new Error("missing Skill typeData");
        wrongDialect.canonical.typeData.entryDialectId = "claude-skill-markdown-v1";
        expect(contract.validateCanonicalEntry(wrongDialect)).toBe(false);
    });
});

function firstRepresentationFile(input: NativeDialectValidationInputV1) {
    const file = input.representation.files[0];
    if (file === undefined) throw new Error("missing native representation fixture file");
    return file;
}

function nativeInput(
    candidate: Extract<AdapterExtractedAssetCandidate, { kind: "Skill" }>,
    schemaVersion: 1 | 2 = 2,
): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_file_graph") {
        throw new Error("Codex Skill fixture must preserve a separate native graph");
    }
    return {
        canonical: { kind: "Skill", typeData: candidate.typeData },
        canonicalFiles: candidate.files.map((file, index) => {
            const manifest = {
                fileId: uuidFor(index),
                logicalPath: file.logicalPath,
                role: file.role,
                contentHash: DIGEST,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                byteSize: file.contentKind === "text" ? Buffer.byteLength(file.text, "utf8") : file.bytes.byteLength,
                executable: file.executable,
                references: file.references ?? [],
            };
            return file.contentKind === "text"
                ? { file: manifest, contentKind: "text" as const, text: file.text.replace(/\r\n/g, "\n") }
                : { file: manifest, contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
        }),
        representation: {
            ...(schemaVersion === 2
                ? {
                      schemaVersion: 2,
                      directories: candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                  }
                : { schemaVersion: 1 }),
            dialectId: candidate.nativeRepresentation.dialectId,
            dialectContractFingerprint: DIGEST,
            canonicalContentFingerprint: DIGEST,
            files: candidate.nativeRepresentation.files.map((file) => ({
                relativePath: file.relativePath,
                contentKind: file.contentKind,
                mediaType: file.mediaType,
                contentHash: sha256SourceBytes(file.bytes),
                byteSize: file.bytes.byteLength,
                executable: file.executable,
            })),
            representationFingerprint: DIGEST,
        },
        nativeFiles: candidate.nativeRepresentation.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: new Uint8Array(file.bytes),
        })),
    };
}

function uuidFor(index: number): UuidV4 {
    return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` as UuidV4;
}
