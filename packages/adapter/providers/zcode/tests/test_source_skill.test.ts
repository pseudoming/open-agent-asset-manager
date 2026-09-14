import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExtractedAssetCandidate, NativeDialectValidationInputV1 } from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { executeAdapterReadWithAuthority } from "../../../core/src/source-import/source-read-execution";
import { bindFixtureProbeRootTarget, fixtureSourceRoot, readAccessFailed } from "../../../test-support";
import { validateZcodeNativeDialect } from "../src/zcode-source-read-native";
import { zcodeProvider } from "../src/zcode-provider";
import {
    DIGEST,
    externalRoot,
    privateSkillRoot,
    projectSkillRoot,
    rawReadInput,
    readSkill,
    skillCapability,
    skillRoot,
    userSelectedReadInput,
} from "./zcode-source-test-fixtures";

const VALID_ENTRY = `---
name: demo
description: Demonstrate the ZCode Skill reader.
license: MIT
compatibility: ZCode
metadata:
  owner: user
---

Read [the guide](references/guide.md).
`;

let sandbox = "";
const probeTarget = bindFixtureProbeRootTarget({
    adapterId: "ZCODE",
    agentRuntimeId: "ZCODE_APP",
    versionText: "fixture",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-skill-roots-"));
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode Skill source read", () => {
    it("imports one complete Skill folder graph with binary resources and resolved references", async () => {
        const result = await readSkill(privateSkillRoot(), {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/references/guide.md": "Guide\n",
            "demo/assets/logo.bin": new Uint8Array([0xff, 0x00, 0x80]),
            "demo/scripts/run.py": { text: "print('ok')\n", executable: true },
            "other.txt": "Not a Skill folder\n",
        });
        expect(result.candidates).toHaveLength(1);
        const candidate = result.candidates[0];
        expect(candidate).toEqual(
            expect.objectContaining({
                kind: "Skill",
                displayName: "demo",
                displayDescription: "Demonstrate the ZCode Skill reader.",
                scope: "global",
                scopePath: "",
                status: "complete",
                assetCandidateStatus: "importable",
                typeData: expect.objectContaining({
                    schemaVersion: 2,
                    name: "demo",
                    description: "Demonstrate the ZCode Skill reader.",
                    whenToUse: "Demonstrate the ZCode Skill reader.",
                    entryDialectId: "zcode-skill-markdown-v1",
                    portableMetadata: { license: "MIT", compatibility: "ZCode", metadata: { owner: "user" } },
                }),
                nativeRepresentation: expect.objectContaining({
                    representationSource: "separate_file_graph",
                    dialectId: "zcode-skill-directory-v1",
                }),
            }),
        );
        expect(candidate?.files.map((file) => [file.logicalPath, file.role, file.contentKind, file.executable])).toEqual([
            ["SKILL.md", "entry", "text", false],
            ["assets/logo.bin", "resource", "binary", false],
            ["references/guide.md", "resource", "text", false],
            ["scripts/run.py", "resource", "text", true],
        ]);
        expect(candidate?.files[0]?.references).toEqual([
            expect.objectContaining({ resolution: "resolved_version_file", targetLogicalPath: "references/guide.md" }),
        ]);
        expect(candidate?.nativeRepresentation).toEqual(
            expect.objectContaining({
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: "demo/SKILL.md" }),
                    expect.objectContaining({ relativePath: "demo/assets/logo.bin" }),
                ]),
            }),
        );
    });

    it("reads each project Skill root independently instead of suppressing the compatibility root", async () => {
        const preferred = await readSkill(projectSkillRoot(), {
            "preferred/SKILL.md": VALID_ENTRY.replace("name: demo", "name: preferred"),
        });
        const compatibility = await readSkill(projectSkillRoot("/fixture/project/.agents/skills"), {
            "fallback/SKILL.md": VALID_ENTRY.replace("name: demo", "name: fallback"),
        });
        expect(preferred.candidates).toEqual([
            expect.objectContaining({ kind: "Skill", displayName: "preferred", scope: "project", scopePath: "" }),
        ]);
        expect(compatibility.candidates).toEqual([
            expect.objectContaining({ kind: "Skill", displayName: "fallback", scope: "project", scopePath: "" }),
        ]);
        expect(preferred.candidates[0]?.nativeRepresentation).toEqual(
            expect.objectContaining({
                files: [expect.objectContaining({ relativePath: ".zcode/skills/preferred/SKILL.md" })],
            }),
        );
        expect(compatibility.candidates[0]?.nativeRepresentation).toEqual(
            expect.objectContaining({
                files: [expect.objectContaining({ relativePath: ".agents/skills/fallback/SKILL.md" })],
            }),
        );
        expect(validateZcodeNativeDialect(nativeInput(preferred.candidates[0] as AdapterExtractedAssetCandidate))).toBe(true);
        expect(validateZcodeNativeDialect(nativeInput(compatibility.candidates[0] as AdapterExtractedAssetCandidate))).toBe(true);
    });

    it("retains distinct Skills across both global roots", async () => {
        const roots = physicalGlobalSkillRoots();
        writeSkill(roots[0]?.path ?? "", "alpha", "alpha");
        writeSkill(roots[1]?.path ?? "", "beta", "beta");
        const result = await executeAdapterReadWithAuthority(zcodeProvider, probeTarget(roots, ["Skill"]), {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: path.join(sandbox, "transactions-distinct"),
        });
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(
            result.value?.candidates
                .map((candidate) => [candidate.displayName, candidate.status])
                .sort(([left], [right]) => String(left).localeCompare(String(right))),
        ).toEqual([
            ["alpha", "complete"],
            ["beta", "complete"],
        ]);
    });

    it("marks every same-name Skill across selected roots incomplete", async () => {
        const roots = physicalGlobalSkillRoots();
        for (const root of roots) writeSkill(root.path, "demo", "demo");
        const result = await executeAdapterReadWithAuthority(zcodeProvider, probeTarget(roots, ["Skill"]), {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: path.join(sandbox, "transactions-conflict"),
        });
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates).toHaveLength(2);
        expect(result.value?.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "demo",
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "zcode.skill_duplicate_identity" })]),
                }),
            ]),
        );
        expect(result.value?.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
    });

    it("keeps direct Skills separate and excludes system units while retaining nested SKILL.md resources", async () => {
        const result = await readSkill(skillRoot(), {
            "alpha/SKILL.md": VALID_ENTRY.replace("name: demo", "name: alpha"),
            "alpha/references/SKILL.md": "Nested resource\n",
            "beta/SKILL.md": VALID_ENTRY.replace("name: demo", "name: beta"),
            ".system/builtin/SKILL.md": VALID_ENTRY.replace("name: demo", "name: builtin"),
        });
        expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(["alpha", "beta"]);
        expect(result.candidates[0]?.files.map((file) => file.logicalPath)).toContain("references/SKILL.md");
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" })]),
        );
    });

    it("rejects missing required content, binary entries, missing entries, and executable authority", async () => {
        const invalidEntries = [
            "No frontmatter\n",
            "---\nname: demo\ndescription: missing close\n",
            "---\ndescription: Missing name\n---\nBody\n",
            "---\nname: demo\n---\nBody\n",
            "---\nname: demo\ndescription: Empty body\n---\n \n",
            "---\nname: demo\ndescription: Hooked\nhooks: active\n---\nBody\n",
            "---\nname: demo\ndescription: Shelled\nshell: bash\n---\nBody\n",
            "---\nname: demo\ndescription: MCP unit\nmcp: docs\n---\nBody\n",
            "---\nname: demo\ndescription: Plugin unit\nplugins: active\n---\nBody\n",
        ];
        for (const entry of invalidEntries) {
            const result = await readSkill(skillRoot(), { "demo/SKILL.md": entry, "demo/resource.txt": "resource" });
            expect(result.candidates, entry).toEqual([]);
            expect(result.sourceParseReports[0]?.status, entry).toBe("skipped_ignored_source");
        }
        const binary = await readSkill(skillRoot(), { "demo/SKILL.md": new Uint8Array([0xff, 0xfe]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.skill_entry_not_utf8" }));

        const missing = await readSkill(skillRoot(), { "demo/resource.txt": "No entry\n" });
        expect(missing.candidates).toEqual([]);
        expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.skill_entry_missing" }));
    });

    it("returns incomplete candidates for unknown metadata or unreadable file resources", async () => {
        for (const [entry, code] of [
            [VALID_ENTRY.replace("license: MIT", "future-field: active"), "zcode.skill_frontmatter_semantics_unsupported"],
            [VALID_ENTRY.replace("  owner: user", "  owner: 7"), "zcode.skill_frontmatter_invalid"],
            [VALID_ENTRY.replace("metadata:\n  owner: user", "metadata: [owner]"), "zcode.skill_metadata_invalid"],
        ] as const) {
            const result = await readSkill(skillRoot(), { "demo/SKILL.md": entry });
            expect(result.candidates).toEqual([
                expect.objectContaining({
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    diagnostics: expect.arrayContaining([expect.objectContaining({ code, severity: "error" })]),
                }),
            ]);
        }

        const root = skillRoot();
        const input = rawReadInput(root, [skillCapability(root)], {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/references/unreadable.md": "Unreadable\n",
        });
        const base = input.readAccess;
        const paths = new Map<string, string>();
        input.readAccess = {
            ...base,
            async resolveRootEntry(obligationId, sourceRootId) {
                const outcome = await base.resolveRootEntry(obligationId, sourceRootId);
                if (outcome.state === "succeeded") paths.set(outcome.value.readEntryHandleId, outcome.value.relativePath);
                return outcome;
            },
            async listDirectory(handleId) {
                const outcome = await base.listDirectory(handleId);
                if (outcome.state === "succeeded") {
                    for (const child of outcome.value.children) paths.set(child.readEntryHandleId, child.relativePath);
                }
                return outcome;
            },
            async readFile(handleId) {
                return paths.get(handleId) === "demo/references/unreadable.md"
                    ? readAccessFailed("fixture-unreadable", "permission_denied")
                    : base.readFile(handleId);
            },
        };
        const unreadable = await zcodeProvider.read(input);
        expect(unreadable.candidates).toEqual([
            expect.objectContaining({
                status: "incomplete",
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: "zcode.skill_resource_unreadable" })]),
            }),
        ]);
    });

    it("returns an incomplete candidate when a nested resource directory cannot be listed", async () => {
        const root = skillRoot();
        const input = rawReadInput(root, [skillCapability(root)], {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/references/guide.md": "Guide\n",
        });
        const base = input.readAccess;
        const paths = new Map<string, string>();
        input.readAccess = {
            ...base,
            async resolveRootEntry(obligationId, sourceRootId) {
                const outcome = await base.resolveRootEntry(obligationId, sourceRootId);
                if (outcome.state === "succeeded") paths.set(outcome.value.readEntryHandleId, outcome.value.relativePath);
                return outcome;
            },
            async listDirectory(handleId) {
                if (paths.get(handleId) === "demo/references") {
                    return readAccessFailed("fixture-directory-unreadable", "permission_denied");
                }
                const outcome = await base.listDirectory(handleId);
                if (outcome.state === "succeeded") {
                    for (const child of outcome.value.children) paths.set(child.readEntryHandleId, child.relativePath);
                }
                return outcome;
            },
        };

        const result = await zcodeProvider.read(input);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                status: "incomplete",
                assetCandidateStatus: "incomplete",
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({ code: "zcode.skill_resource_directory_unreadable", severity: "error" }),
                ]),
            }),
        ]);
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([expect.objectContaining({ disposition: "ignored", reasonCode: "directory_unreadable" })]),
        );
    });

    it("honors an explicit global or project binding without widening the selected root", async () => {
        const root = externalRoot();
        const capability = skillCapability(root);
        const global = await zcodeProvider.read(
            userSelectedReadInput(root, capability, "global", "", { "demo/SKILL.md": VALID_ENTRY }),
        );
        expect(global.candidates).toEqual([expect.objectContaining({ kind: "Skill", scope: "global", scopePath: "" })]);

        const project = await zcodeProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/project", { "demo/SKILL.md": VALID_ENTRY }),
        );
        expect(project.candidates).toEqual([
            expect.objectContaining({ kind: "Skill", scope: "project", projectRootPath: "/fixture/project", scopePath: "" }),
        ]);
    });

    it("revalidates the whole native graph and rejects native, canonical, or graph drift", async () => {
        const result = await readSkill(skillRoot(), {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/references/guide.md": "Guide\n",
            "demo/logo.bin": new Uint8Array([0xff, 0x00]),
        });
        const candidate = result.candidates[0];
        if (candidate?.kind !== "Skill" || candidate.nativeRepresentation.representationSource !== "separate_file_graph") {
            throw new Error("missing ZCode Skill candidate");
        }
        const input = nativeInput(candidate);
        expect(validateZcodeNativeDialect(input)).toBe(true);
        expect(
            zcodeProvider.dialectContracts.native
                .find((row) => row.definition.dialectId === "zcode-skill-directory-v1")
                ?.validateSameContent(input),
        ).toBe(true);

        for (const [root, files] of [
            [privateSkillRoot(), { "config/SKILL.md": VALID_ENTRY.replace("name: demo", "name: config") }],
            [projectSkillRoot(), { "project/SKILL.md": VALID_ENTRY.replace("name: demo", "name: project") }],
            [skillRoot(), { "fallback/SKILL.md": VALID_ENTRY.replace("name: demo", "name: fallback") }],
        ] as const) {
            const resultForLayout = await readSkill(root, files);
            const layoutCandidate = resultForLayout.candidates[0];
            if (layoutCandidate === undefined) throw new Error("missing native layout fixture");
            expect(validateZcodeNativeDialect(nativeInput(layoutCandidate))).toBe(true);
        }

        for (const prefix of ["skills/", ".zcode/skills/", ".agents/skills/"]) {
            const historical = structuredClone(input);
            if (historical.representation.schemaVersion !== 2) throw new Error("missing native directory graph");
            historical.representation.directories = historical.representation.directories.map(
                (relativePath) => `${prefix}${relativePath}` as typeof relativePath,
            );
            for (const file of historical.representation.files) file.relativePath = `${prefix}${file.relativePath}`;
            for (const file of historical.nativeFiles) file.relativePath = `${prefix}${file.relativePath}`;
            expect(validateZcodeNativeDialect(historical)).toBe(true);
        }

        const wrongDialect = structuredClone(input);
        wrongDialect.representation.dialectId = "zcode-skill-directory-v2";
        expect(validateZcodeNativeDialect(wrongDialect)).toBe(false);

        const changedCanonical = structuredClone(input);
        const canonical = changedCanonical.canonicalFiles.find((file) => file.file.logicalPath === "SKILL.md");
        if (canonical?.contentKind === "text") canonical.text = "Changed\n";
        expect(validateZcodeNativeDialect(changedCanonical)).toBe(false);

        const changedNative = structuredClone(input);
        const native = changedNative.nativeFiles.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (native !== undefined) native.bytes = Buffer.from("Changed\n");
        expect(validateZcodeNativeDialect(changedNative)).toBe(false);

        const outsideGraph = structuredClone(input);
        const source = input.representation.files[0];
        if (source === undefined) throw new Error("missing native fixture");
        outsideGraph.representation.files.push({ ...source, relativePath: "other/resource.md" });
        outsideGraph.nativeFiles.push({
            relativePath: "other/resource.md",
            bytes: input.nativeFiles[0]?.bytes ?? new Uint8Array(),
        });
        expect(validateZcodeNativeDialect(outsideGraph)).toBe(false);

        const mixedGraph = structuredClone(input);
        const mixedSource = input.representation.files[0];
        if (mixedSource === undefined) throw new Error("missing mixed graph fixture");
        mixedGraph.representation.files.push({ ...mixedSource, relativePath: "skills/other/SKILL.md" });
        mixedGraph.nativeFiles.push({
            relativePath: "skills/other/SKILL.md",
            bytes: input.nativeFiles[0]?.bytes ?? new Uint8Array(),
        });
        expect(validateZcodeNativeDialect(mixedGraph)).toBe(false);

        const missingEntry = structuredClone(input);
        const entryIndex = missingEntry.representation.files.findIndex((file) => file.relativePath.endsWith("/SKILL.md"));
        const entryDescriptor = missingEntry.representation.files[entryIndex];
        const entryPayload = missingEntry.nativeFiles[entryIndex];
        if (entryDescriptor === undefined || entryPayload === undefined) throw new Error("missing entry fixture");
        entryDescriptor.relativePath = "demo/ENTRY.md";
        entryPayload.relativePath = "demo/ENTRY.md";
        expect(validateZcodeNativeDialect(missingEntry)).toBe(false);
    });

    it("declares a portable Skill entry only for ZCode sources and the exact canonical entry", async () => {
        const result = await readSkill(skillRoot(), { "demo/SKILL.md": VALID_ENTRY });
        const candidate = result.candidates[0];
        if (candidate?.kind !== "Skill") throw new Error("missing portable Skill fixture");
        const contract = zcodeProvider.dialectContracts.portableEntries.find(
            (row) => row.definition.dialectId === "zcode-skill-markdown-v1",
        );
        if (contract === undefined) throw new Error("missing portable Skill contract");
        const native = nativeInput(candidate);
        const input = {
            use: {
                kind: "Skill",
                field: "skill_entry",
                dialectId: "zcode-skill-markdown-v1",
                logicalPath: "SKILL.md",
            },
            versionStatus: "complete",
            canonical: native.canonical,
            canonicalFiles: native.canonicalFiles,
        };
        expect(contract.validateCanonicalEntry(input as never)).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "ZCODE_APP", versionText: "fixture" })).toBe(true);
        expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_CLI", versionText: "fixture" })).toBe(false);

        for (const changed of [
            { ...input, use: { ...input.use, kind: "Workflow" } },
            { ...input, use: { ...input.use, field: "workflow_instruction" } },
            { ...input, use: { ...input.use, dialectId: "foreign" } },
            { ...input, canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } } },
            { ...input, canonicalFiles: [] },
        ]) {
            expect(contract.validateCanonicalEntry(changed as never)).toBe(false);
        }
        expect(contract.validateCanonicalEntry({ ...input, versionStatus: "incomplete", canonicalFiles: [] } as never)).toBe(
            true,
        );
    });
});

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_file_graph") {
        throw new Error("fixture requires a separate native file graph");
    }
    return {
        canonical: { kind: candidate.kind, typeData: candidate.typeData },
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
            schemaVersion: 2,
            dialectId: candidate.nativeRepresentation.dialectId,
            dialectContractFingerprint: DIGEST,
            canonicalContentFingerprint: DIGEST,
            directories: candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
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

function physicalGlobalSkillRoots() {
    return [
        fixtureSourceRoot({
            sourceRootId: "zcode-private-root",
            path: path.join(sandbox, "private-skills"),
            rootRole: "source",
            sourceDomain: "agent_runtime_private",
            locatorKind: "runtime_known_rule",
            locatorKey: "zcode_user_skill_root",
            evidenceLevel: "source_code",
        }),
        fixtureSourceRoot({
            sourceRootId: "zcode-shared-root",
            path: path.join(sandbox, "shared-skills"),
            rootRole: "source",
            sourceDomain: "family_shared",
            locatorKind: "runtime_known_rule",
            locatorKey: "zcode_shared_skill_root",
            evidenceLevel: "source_code",
        }),
    ];
}

function writeSkill(root: string, folder: string, name: string): void {
    const target = path.join(root, folder, "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, VALID_ENTRY.replace("name: demo", `name: ${name}`));
}
