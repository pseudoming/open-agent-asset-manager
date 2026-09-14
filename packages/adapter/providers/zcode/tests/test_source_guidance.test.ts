import { describe, expect, it } from "vitest";
import type { NativeDialectValidationInputV1 } from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { nonDirectoryRootReadAccess } from "../../../test-support";
import { validateZcodeNativeDialect } from "../src/zcode-source-read-native";
import { resolveZcodeSourceContext, scanZcodeReadObligation } from "../src/zcode-source-read";
import { zcodeProvider } from "../src/zcode-provider";
import {
    configRoot,
    DIGEST,
    externalRoot,
    guidanceCapability,
    projectRoot,
    rawReadInput,
    readGuidance,
    userSelectedReadInput,
} from "./zcode-source-test-fixtures";

describe("ZCode Guidance source read", () => {
    it("reads only the direct global AGENTS.md and preserves exact native bytes", async () => {
        const result = await readGuidance(configRoot(), {
            "AGENTS.md": "Global guidance\r\n",
            "nested/AGENTS.md": "Nested must not load\n",
            "README.md": "Unrelated\n",
        });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                scope: "global",
                scopePath: "",
                projectRootPath: "",
                files: [expect.objectContaining({ logicalPath: "GUIDANCE.md", text: "Global guidance\r\n" })],
                nativeRepresentation: expect.objectContaining({
                    representationSource: "separate_files",
                    dialectId: "zcode-guidance-markdown-v1",
                    files: [expect.objectContaining({ relativePath: "AGENTS.md", bytes: Buffer.from("Global guidance\r\n") })],
                }),
            }),
        ]);
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" }),
                expect.objectContaining({ disposition: "parsed", candidateIds: [expect.any(String)] }),
            ]),
        );
    });

    it("keeps registered project and user-selected scopes exact", async () => {
        const project = await readGuidance(projectRoot(), { "AGENTS.md": "Project guidance\n" });
        expect(project.candidates).toEqual([
            expect.objectContaining({ scope: "project", projectRootPath: "/fixture/project", scopePath: "" }),
        ]);

        const root = externalRoot();
        const explicit = await zcodeProvider.read(
            userSelectedReadInput(root, guidanceCapability(root), "project", "/fixture/external", {
                "AGENTS.md": "Explicit guidance\n",
            }),
        );
        expect(explicit.candidates).toEqual([
            expect.objectContaining({ scope: "project", projectRootPath: "/fixture/external" }),
        ]);
    });

    it("rejects executable, non-UTF-8, and empty Guidance without fake candidates", async () => {
        for (const [value, code] of [
            [{ text: "Executable\n", executable: true }, "zcode.guidance_executable_rejected"],
            [new Uint8Array([0xff]), "zcode.guidance_not_utf8"],
        ] as const) {
            const result = await readGuidance(configRoot(), { "AGENTS.md": value });
            expect(result.candidates).toEqual([]);
            expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
        }
        const empty = await readGuidance(configRoot(), { "AGENTS.md": " \n" });
        expect(empty.candidates).toEqual([]);
        expect(empty.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "empty_guidance" }),
        );
    });

    it("fails closed for a wrong root kind, mechanism, or source layout", async () => {
        const root = configRoot();
        const capability = guidanceCapability(root);
        const wrongRoot = rawReadInput(root, [capability], { "AGENTS.md": "Body\n" });
        wrongRoot.readAccess = nonDirectoryRootReadAccess(root);
        const result = await zcodeProvider.read(wrongRoot);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.source_root_not_directory" }));

        const context = resolveZcodeSourceContext(rawReadInput(root, [capability], {}), root, capability);
        if (context === null) throw new Error("missing ZCode Guidance context");
        const scan = await scanZcodeReadObligation(
            rawReadInput(root, [capability], {}),
            {
                sourceReadObligationId: "fixture-non-callable",
                sourceRootId: root.sourceRootId,
                sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
            },
            { ...capability, sourcePathMechanism: "unknown" },
            context,
        );
        expect(scan.diagnostics).toEqual([expect.objectContaining({ code: "zcode.source_path_mechanism_not_callable" })]);
        expect(
            resolveZcodeSourceContext(
                rawReadInput(root, [capability], {}),
                { ...root, sourceDomain: "family_shared" },
                capability,
            ),
        ).toBeNull();
    });

    it("revalidates the exact native graph and rejects native or canonical drift", async () => {
        const result = await readGuidance(projectRoot(), { "AGENTS.md": "Native guidance\r\n" });
        const candidate = result.candidates[0];
        if (candidate?.kind !== "Guidance" || candidate.nativeRepresentation.representationSource !== "separate_files") {
            throw new Error("missing ZCode Guidance candidate");
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
                        byteSize: Buffer.byteLength(canonical.text),
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
        expect(validateZcodeNativeDialect(input)).toBe(true);
        expect(zcodeProvider.dialectContracts.native[0]?.validateSameContent(input)).toBe(true);

        const wrongDialect = structuredClone(input);
        wrongDialect.representation.dialectId = "zcode-guidance-markdown-v2";
        expect(validateZcodeNativeDialect(wrongDialect)).toBe(false);
        const wrongKind = structuredClone(input);
        wrongKind.canonical = { kind: "Rule", typeData: { schemaVersion: 1, trigger: { mode: "always" } } };
        expect(validateZcodeNativeDialect(wrongKind)).toBe(false);
        const missingNative = structuredClone(input);
        missingNative.representation.files = [];
        missingNative.nativeFiles = [];
        expect(validateZcodeNativeDialect(missingNative)).toBe(false);

        const binaryNative = structuredClone(input);
        binaryNative.representation.files[0] = { ...requiredNativeFile(binaryNative), contentKind: "binary" };
        expect(validateZcodeNativeDialect(binaryNative)).toBe(false);

        const bomBytes = Buffer.from("\ufeffNative guidance\r\n");
        const bomNative = structuredClone(input);
        bomNative.representation.files[0] = {
            ...requiredNativeFile(bomNative),
            contentHash: sha256SourceBytes(bomBytes),
            byteSize: bomBytes.byteLength,
        };
        bomNative.nativeFiles[0] = { relativePath: "AGENTS.md", bytes: bomBytes };
        expect(validateZcodeNativeDialect(bomNative)).toBe(true);

        for (const mediaType of ["", " ; charset=utf-8"]) {
            const changedMediaType = structuredClone(input);
            const canonicalFile = changedMediaType.canonicalFiles[0];
            if (canonicalFile !== undefined) canonicalFile.file.mediaType = mediaType;
            expect(validateZcodeNativeDialect(changedMediaType)).toBe(false);
        }

        const wrongPath = structuredClone(input);
        wrongPath.representation.files[0] = { ...requiredNativeFile(wrongPath), relativePath: "nested/AGENTS.md" };
        wrongPath.nativeFiles[0] = { relativePath: "nested/AGENTS.md", bytes: new Uint8Array(native.bytes) };
        expect(validateZcodeNativeDialect(wrongPath)).toBe(false);
        const changedNative = structuredClone(input);
        changedNative.nativeFiles[0] = { relativePath: "AGENTS.md", bytes: Buffer.from("Changed\n") };
        expect(validateZcodeNativeDialect(changedNative)).toBe(false);
        const changedCanonical = structuredClone(input);
        const file = changedCanonical.canonicalFiles[0];
        if (file?.contentKind === "text") file.text = "Changed\n";
        expect(validateZcodeNativeDialect(changedCanonical)).toBe(false);
    });
});

function requiredNativeFile(input: NativeDialectValidationInputV1) {
    const file = input.representation.files[0];
    if (file === undefined) throw new Error("missing native representation file");
    return file;
}
