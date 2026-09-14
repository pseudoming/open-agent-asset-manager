import { sha256SourceBytes } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AssetKind,
    NativeDialectValidationInputV1,
    Sha256Digest,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindRequiredAdapterCapability,
    bindUserSelectedReadInput,
    fixtureFrontmatter,
    fixtureSourceRoot,
} from "../../../test-support";
import { parseCursorFrontmatter } from "../src/cursor-frontmatter";
import { cursorProvider } from "../src/cursor-provider";
import { CURSOR_SOURCE_READ, resolveCursorSourceContext } from "../src/cursor-source-read";
import { parseCursorRule } from "../src/cursor-source-read-guidance-rule";
import { validateCursorNativeDialect } from "../src/cursor-source-read-native";
import { CURSOR_ASSET_READER_REGISTRY, getCursorAssetReader } from "../src/cursor-source-read-registry";
import { CURSOR_SOURCE_TRAVERSAL } from "../src/cursor-source-read-scan";

const DIGEST = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ROOT = fixtureSourceRoot({
    sourceRootId: "cursor-project-root",
    path: "/fixture/project",
    rootRole: "project_actual",
    sourceDomain: "project_root",
    locatorKind: "user_provided_path",
    locatorKey: "cursor_invocation_project",
    evidenceLevel: "user_provided",
});
const observation = bindFixtureProbeObservation({
    adapterId: "CURSOR",
    agentRuntimeId: "CURSOR_AGENT_CLI",
    versionText: "2026.07.23-e383d2b",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const readInput = bindFixtureProviderReadInput({
    digest: DIGEST,
    observation,
    resolveEntries: false,
    obligationId: (capability, index) => `cursor-${capability.assetKind}-${index}`,
});
const requiredCapability = bindRequiredAdapterCapability(cursorProvider, "missing Cursor source capability");
const userSelectedReadInput = bindUserSelectedReadInput(readInput);

describe("Cursor Guidance and Rule source lifecycle", () => {
    it("registers every AssetKind while exposing callable readers only for the accepted slice", () => {
        expect(Object.keys(CURSOR_ASSET_READER_REGISTRY).sort()).toEqual([
            "Guidance",
            "Memory",
            "Rule",
            "Skill",
            "Subagent",
            "Workflow",
        ]);
        expect(CURSOR_ASSET_READER_REGISTRY.Guidance.disposition).toBe("reader");
        expect(CURSOR_ASSET_READER_REGISTRY.Rule.disposition).toBe("reader");
        expect(CURSOR_ASSET_READER_REGISTRY.Skill.disposition).toBe("reader");
    });

    it("imports root Guidance and Cursor `.mdc` activation semantics with exact native bytes", async () => {
        const always = fixtureFrontmatter(
            "description: Always enforce safety\nalwaysApply: true",
            "# Safety\nNever expose credentials.",
        );
        const pathRule = fixtureFrontmatter(
            "description: TypeScript files\nglobs: **/*.ts\nalwaysApply: false",
            "# TypeScript\nUse strict mode.",
        );
        const modelRule = fixtureFrontmatter(
            "description: Use when reviewing database changes\nalwaysApply: false",
            "# Database review\nCheck migrations.",
        );
        const result = await cursorProvider.read(
            readInput(ROOT, capabilities(["Guidance", "Rule"]), {
                "AGENTS.md": "# Project guidance\n",
                "CLAUDE.md": "# Claude-compatible guidance\n",
                "CLAUDE.local.md": "# Private compatibility guidance\n",
                ".cursorrules": "# Legacy Cursor guidance\n",
                ".cursor/rules/always.mdc": always,
                ".cursor/rules/typescript.mdc": pathRule,
                ".cursor/rules/nested/database.mdc": modelRule,
                ".cursor/rules/ignore.txt": "ignored",
                ".cursor/other/ignore.mdc": "ignored",
            }),
        );
        expect(result.sourceParseReports.map((report) => report.status)).toEqual(["parsed"]);
        expect(result.candidates.map((candidate) => [candidate.kind, candidate.displayName])).toEqual([
            ["Guidance", ".cursorrules"],
            ["Guidance", "AGENTS.md"],
            ["Guidance", "CLAUDE.local.md"],
            ["Guidance", "CLAUDE.md"],
            ["Rule", "always"],
            ["Rule", "database"],
            ["Rule", "typescript"],
        ]);
        expect(result.candidates.find((candidate) => candidate.displayName === "always")?.typeData).toMatchObject({
            activation: { mode: "always" },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "typescript")?.typeData).toMatchObject({
            activation: { mode: "path", globs: ["**/*.ts"] },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "database")?.typeData).toMatchObject({
            activation: { mode: "model_decision" },
        });
        expect(result.candidates.find((candidate) => candidate.displayName === "CLAUDE.local.md")?.promotionSafety).toBe(
            "requires_user_confirmation",
        );
        for (const candidate of result.candidates) expect(validateCursorNativeDialect(nativeInput(candidate))).toBe(true);
        expect(
            result.sourceParseReports
                .flatMap((report) => report.readEntryDispositions)
                .filter((row) => row.disposition === "ignored").length,
        ).toBeGreaterThan(0);
    });

    it("retains malformed Rules as incomplete instead of guessing private semantics", async () => {
        const files = {
            ".cursor/rules/missing.mdc": fixtureFrontmatter("description: Missing", "body"),
            ".cursor/rules/conflict.mdc": fixtureFrontmatter("description: Conflict\nglobs: **/*.ts\nalwaysApply: true", "body"),
            ".cursor/rules/unknown.mdc": fixtureFrontmatter(
                "description: Unknown\nalwaysApply: false\nfutureBehavior: enabled",
                "body",
            ),
            ".cursor/rules/empty-model.mdc": fixtureFrontmatter("description: \nalwaysApply: false", "body"),
            ".cursor/rules/unclosed.mdc": "---\ndescription: nope\nalwaysApply: true\nbody",
            ".cursor/rules/binary.mdc": Uint8Array.of(0xff, 0xfe),
            "AGENTS.md": Uint8Array.of(0xff),
            "CLAUDE.md": "",
        };
        const result = await cursorProvider.read(readInput(ROOT, capabilities(["Guidance", "Rule"]), files));
        expect(result.candidates.filter((candidate) => candidate.kind === "Rule")).toHaveLength(5);
        expect(
            result.candidates
                .filter((candidate) => candidate.kind === "Rule")
                .every((candidate) => candidate.status === "incomplete"),
        ).toBe(true);
        expect(result.diagnostics.map((item) => item.code)).toContain("cursor.rule_not_utf8");
        expect(result.diagnostics.map((item) => item.code)).toContain("cursor.guidance_not_utf8");
        expect(result.sourceParseReports.map((report) => report.status)).toEqual(["parsed"]);
    });

    it("parses exact Rule branches and rejects unsafe native graphs", () => {
        expect(parseCursorFrontmatter("plain body")).toMatchObject({
            hasFrontmatter: false,
            closed: false,
            values: {},
            presentKeys: [],
            body: "plain body",
            diagnostics: [],
        });
        expect(
            parseCursorRule(fixtureFrontmatter("description: x\nalwaysApply: true", "body"), ".cursor/rules/x.mdc"),
        ).toMatchObject({
            typeData: { activation: { mode: "always" } },
            diagnostics: [],
        });
        expect(
            parseCursorRule(
                fixtureFrontmatter("description: x\nglobs: ../escape\nalwaysApply: false", "body"),
                ".cursor/rules/x.mdc",
            ).diagnostics,
        ).toEqual([expect.objectContaining({ code: "cursor.rule_glob_invalid" })]);

        const validResult = awaitReadSingleRule();
        return validResult.then((candidate) => {
            const input = nativeInput(candidate);
            expect(validateCursorNativeDialect(input)).toBe(true);
            input.nativeFiles[0] = { relativePath: "../escape.mdc", bytes: input.nativeFiles[0]?.bytes ?? new Uint8Array() };
            expect(validateCursorNativeDialect(input)).toBe(false);
            const malformed = nativeInput(candidate);
            malformed.nativeFiles[0] = {
                relativePath: malformed.nativeFiles[0]?.relativePath ?? ".cursor/rules/x.mdc",
                bytes: Uint8Array.of(0xff),
            };
            expect(validateCursorNativeDialect(malformed)).toBe(false);
        });
    });

    it("keeps source selection, diagnostics, registry, and traversal decisions explicit", () => {
        const guidance = capabilities(["Guidance"])[0];
        if (guidance === undefined) throw new Error("Cursor Guidance capability missing");
        const selected = userSelectedReadInput(ROOT, guidance, "project", "/fixture/project", { "AGENTS.md": "body" });
        expect(resolveCursorSourceContext(selected, ROOT, guidance)).toMatchObject({
            scope: "project",
            projectRootPath: "/fixture/project",
            layout: "external",
        });
        expect(
            resolveCursorSourceContext(readInput(ROOT, [guidance], {}), ROOT, { ...guidance, assetKind: "Memory" }),
        ).toBeNull();
        expect(
            resolveCursorSourceContext(readInput(ROOT, [guidance], {}), { ...ROOT, rootRole: "unknown" }, guidance),
        ).toBeNull();
        expect(getCursorAssetReader("Guidance").disposition).toBe("reader");
        expect(getCursorAssetReader("Memory")).toMatchObject({ disposition: "reader" });

        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Rule", {} as never, ".cursor/rules/nested")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Guidance", {} as never, ".cursor")).toBe(false);
        const owningContext = { ownsSharedPhysicalSource: true } as never;
        const siblingContext = { ownsSharedPhysicalSource: false } as never;
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Guidance", owningContext, "AGENTS.md")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Rule", owningContext, ".cursor/rules/.mdc")).toBe(false);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Rule", owningContext, ".cursor/rules/active.mdc")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Guidance", siblingContext, "AGENTS.md")).toBe(false);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Rule", siblingContext, ".cursor/rules/active.mdc")).toBe(false);
        expect(CURSOR_SOURCE_TRAVERSAL.dispositionId({ readEntryHandleId: "entry" })).toBe("cursor-disposition:entry");
        expect(CURSOR_SOURCE_TRAVERSAL.rootEntryKindDiagnostic({ root: ROOT } as never, "directory").code).toBe(
            "cursor.source_root_not_directory",
        );
        expect(CURSOR_SOURCE_TRAVERSAL.rootEntryKindDiagnostic({ root: ROOT } as never, "file").code).toBe(
            "cursor.source_root_not_file",
        );
        expect(CURSOR_SOURCE_TRAVERSAL.mechanismNotCallableDiagnostic({ root: ROOT } as never).code).toBe(
            "cursor.source_path_mechanism_not_callable",
        );
        expect(CURSOR_SOURCE_READ.diagnostics.unknownAuthority().code).toBe("cursor.read_authority_unknown");
        expect(CURSOR_SOURCE_READ.diagnostics.capabilityNotCallable(ROOT).code).toBe("cursor.source_capability_not_callable");
        expect(
            CURSOR_SOURCE_READ.diagnostics.readerUnavailable(ROOT, {
                diagnosticCode: "cursor.unavailable",
                message: "unavailable",
            }).code,
        ).toBe("cursor.unavailable");
        expect(CURSOR_SOURCE_READ.diagnostics.contextUnresolved(ROOT).code).toBe("cursor.source_scope_unresolved");
        expect(CURSOR_SOURCE_READ.diagnostics.rootWithoutObligation(ROOT).code).toBe("cursor.root_without_obligation");
    });

    it("fails native validation on exact malformed bytes and canonical shape changes", async () => {
        const candidate = await awaitReadSingleRule();
        const invalidUtf8 = nativeInput(candidate);
        const bytes = Uint8Array.of(0xff, 0xfe);
        invalidUtf8.nativeFiles[0] = { relativePath: ".cursor/rules/exact.mdc", bytes };
        const descriptor = invalidUtf8.representation.files[0];
        if (descriptor === undefined) throw new Error("Cursor native descriptor missing");
        invalidUtf8.representation.files[0] = {
            ...descriptor,
            contentHash: sha256SourceBytes(bytes),
            byteSize: bytes.byteLength,
        };
        expect(validateCursorNativeDialect(invalidUtf8)).toBe(false);

        for (const mutate of [
            (input: NativeDialectValidationInputV1) => input.canonicalFiles.push(input.canonicalFiles[0] as never),
            (input: NativeDialectValidationInputV1) => {
                const entry = input.canonicalFiles[0];
                if (entry === undefined) throw new Error("Cursor canonical file missing");
                entry.file.role = "resource";
            },
            (input: NativeDialectValidationInputV1) => {
                const entry = input.canonicalFiles[0];
                if (entry === undefined) throw new Error("Cursor canonical file missing");
                entry.file.executable = true;
            },
            (input: NativeDialectValidationInputV1) => {
                const entry = input.canonicalFiles[0];
                if (entry === undefined) throw new Error("Cursor canonical file missing");
                entry.file.references.push("dependency");
            },
            (input: NativeDialectValidationInputV1) => (input.canonical.kind = "Guidance"),
        ]) {
            const changed = nativeInput(candidate);
            mutate(changed);
            expect(validateCursorNativeDialect(changed)).toBe(false);
        }
    });
});

async function awaitReadSingleRule(): Promise<AdapterExtractedAssetCandidate> {
    const result = await cursorProvider.read(
        readInput(ROOT, capabilities(["Rule"]), {
            ".cursor/rules/exact.mdc": fixtureFrontmatter("description: Exact\nalwaysApply: true", "body"),
        }),
    );
    const candidate = result.candidates[0];
    if (candidate === undefined) throw new Error("Cursor Rule fixture missing");
    return candidate;
}

function capabilities(kinds: AssetKind[]): AdapterAssetSourceCapability[] {
    return kinds.map((assetKind) =>
        requiredCapability(
            (row) =>
                row.agentRuntimeId === "CURSOR_AGENT_CLI" &&
                row.assetKind === assetKind &&
                row.entrySupportStatus === "supported" &&
                row.rootRole === "project_actual" &&
                row.sourceDomain === "project_root",
        ),
    );
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("Cursor native fixture requires separate files");
    }
    return {
        canonical: { kind: candidate.kind, typeData: candidate.typeData } as NativeDialectValidationInputV1["canonical"],
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
