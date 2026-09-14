import { sha256SourceBytes } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AgentRuntimeId,
    NativeDialectValidationInputV1,
    PortableEntryDialectValidationInputV1,
    Sha256Digest,
    SourceRoot,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    bindFixtureProbeObservation,
    bindFixtureProviderReadInput,
    bindRequiredAdapterCapability,
    bindUserSelectedReadInput,
    fixtureSourceRoot,
    readAccessFailed,
} from "../../../test-support";
import { cursorProvider } from "../src/cursor-provider";
import { cursorSkillBases } from "../src/cursor-source-read-foundation";
import { CURSOR_NATIVE_DIALECTS } from "../src/cursor-source-read-model";
import { validateCursorNativeDialect } from "../src/cursor-source-read-native";
import { CURSOR_ASSET_READER_REGISTRY } from "../src/cursor-source-read-registry";
import { CURSOR_SOURCE_TRAVERSAL } from "../src/cursor-source-read-scan";
import { buildCursorSkillCandidates } from "../src/cursor-source-read-skill";

const DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const PROJECT_ROOT = sourceRoot("project", "project_actual", "project_root", "/fixture/project");
const CONFIG_ROOT = sourceRoot("config", "config", "agent_runtime_private", "/fixture/home/.cursor");
const SHARED_ROOT = sourceRoot("shared", "source", "family_shared", "/fixture/home/.agents/skills");
const ENTRY = `---
name: release-helper
description: Prepare a release with bundled evidence.
disable-model-invocation: true
---

Read [the checklist](references/checklist.md) before running the script.
`;

describe("Cursor complete Skill graph sources", () => {
    it("fails closed when an unrecognized source layout reaches Skill routing", () => {
        expect(cursorSkillBases("unrecognized" as never)).toEqual([]);
    });

    it("imports project and personal complete graphs with binary/executable resources", async () => {
        const project = await read("CURSOR_AGENT_CLI", PROJECT_ROOT, {
            ".cursor/skills/release-helper/SKILL.md": ENTRY,
            ".cursor/skills/release-helper/references/checklist.md": "Checklist\n",
            ".cursor/skills/release-helper/assets/marker.bin": Uint8Array.of(0, 255, 1),
            ".cursor/skills/release-helper/scripts/run.py": { text: "print('ok')\n", executable: true },
            ".cursor/skills/.system/managed/SKILL.md": ENTRY,
        });
        expect(project.candidates).toHaveLength(1);
        const candidate = required(project.candidates[0]);
        expect(candidate).toMatchObject({
            kind: "Skill",
            displayName: "release-helper",
            displayDescription: "Prepare a release with bundled evidence.",
            scope: "project",
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety: "default_promotable",
            typeData: {
                entryDialectId: CURSOR_NATIVE_DIALECTS.skill,
                invocation: { model: { mode: "disabled" } },
            },
            nativeRepresentation: {
                representationSource: "separate_file_graph",
                dialectId: CURSOR_NATIVE_DIALECTS.skill,
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: ".cursor/skills/release-helper/SKILL.md" }),
                    expect.objectContaining({ relativePath: ".cursor/skills/release-helper/scripts/run.py", executable: true }),
                ]),
            },
        });
        expect(candidate.files.map((file) => [file.logicalPath, file.role, file.contentKind, file.executable])).toEqual([
            ["SKILL.md", "entry", "text", false],
            ["assets/marker.bin", "resource", "binary", false],
            ["references/checklist.md", "resource", "text", false],
            ["scripts/run.py", "resource", "text", true],
        ]);
        expect(candidate.files[0]?.references).toEqual([
            expect.objectContaining({ resolution: "resolved_version_file", targetLogicalPath: "references/checklist.md" }),
        ]);
        expect(validateCursorNativeDialect(nativeInput(candidate))).toBe(true);
        const portable = cursorProvider.dialectContracts.portableEntries.find(
            (row) => row.definition.dialectId === CURSOR_NATIVE_DIALECTS.skill,
        );
        if (portable === undefined) throw new Error("Cursor Skill portable-entry contract missing");
        const portableInput: PortableEntryDialectValidationInputV1 = {
            use: {
                kind: "Skill",
                field: "skill_entry",
                dialectId: CURSOR_NATIVE_DIALECTS.skill,
                logicalPath: "SKILL.md",
            },
            versionStatus: "complete",
            canonical: { kind: "Skill", typeData: candidate.typeData },
            canonicalFiles: nativeInput(candidate).canonicalFiles,
        };
        expect(portable.validateCanonicalEntry(portableInput)).toBe(true);
        expect(portable.validateSourceApplicability({ agentRuntimeId: "CURSOR_AGENT_CLI", versionText: "fixture" })).toBe(true);
        expect(portable.validateSourceApplicability({ agentRuntimeId: "OTHER", versionText: "fixture" })).toBe(false);
        expect(portable.validateCanonicalEntry({ ...portableInput, canonicalFiles: [] })).toBe(false);
        expect(portable.validateCanonicalEntry({ ...portableInput, versionStatus: "incomplete", canonicalFiles: [] })).toBe(true);

        const personal = await read("CURSOR_AGENT_CLI", CONFIG_ROOT, { "skills/release-helper/SKILL.md": ENTRY });
        expect(personal.candidates[0]).toMatchObject({
            scope: "global",
            nativeRepresentation: { files: [expect.objectContaining({ relativePath: "skills/release-helper/SKILL.md" })] },
        });
        const shared = await read("CURSOR_AGENT_CLI", SHARED_ROOT, { "release-helper/SKILL.md": ENTRY });
        expect(shared.candidates[0]).toMatchObject({
            scope: "global",
            nativeRepresentation: { files: [expect.objectContaining({ relativePath: "release-helper/SKILL.md" })] },
        });
    });

    it("projects one physical Skill when CLI and App share the same selected root", async () => {
        const cliObservation = bindFixtureProbeObservation({
            adapterId: "CURSOR",
            agentRuntimeId: "CURSOR_AGENT_CLI",
            versionText: "2026.07.23-e383d2b",
            installationEvidence: [],
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
        });
        const readInput = bindFixtureProviderReadInput({
            digest: DIGEST,
            observation: (root) => {
                const observation = cliObservation(root);
                const cli = observation.observedAgentRuntimes[0];
                if (cli === undefined) throw new Error("Cursor CLI fixture runtime missing");
                return {
                    ...observation,
                    observedAgentRuntimes: [cli, { ...cli, agentRuntimeId: "CURSOR_APP", versionText: "3.13.25" }],
                };
            },
            resolveEntries: true,
            obligationId: (capability) => `cursor-shared-skill-${capability.agentRuntimeId}`,
        });
        const result = await cursorProvider.read(
            readInput(
                PROJECT_ROOT,
                [skillCapability("CURSOR_AGENT_CLI", PROJECT_ROOT), skillCapability("CURSOR_APP", PROJECT_ROOT)],
                { ".cursor/skills/release-helper/SKILL.md": ENTRY },
            ),
        );
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({ displayName: "release-helper", status: "complete" });
        expect(result.diagnostics.some((item) => item.code === "cursor.skill_duplicate_identity")).toBe(false);
    });

    it("preserves App/package and Cursor-private fields under the independently verified App target", async () => {
        const privateEntry = ENTRY.replace(
            "disable-model-invocation: true",
            "disable-model-invocation: false\nprivate-cursor-field: keep-this",
        );
        const app = await read("CURSOR_APP", PROJECT_ROOT, {
            ".agents/skills/release-helper/SKILL.md": privateEntry,
            ".agents/skills/release-helper/reference.txt": "private resource\n",
        });
        expect(app.candidates[0]).toMatchObject({
            status: "complete",
            promotionSafety: "requires_user_confirmation",
            diagnostics: [expect.objectContaining({ code: "cursor.skill_private_frontmatter_preserved", severity: "warning" })],
            typeData: { invocation: { model: { mode: "model_decision" } } },
            nativeRepresentation: {
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: ".agents/skills/release-helper/SKILL.md" }),
                ]),
            },
        });
        expect(
            cursorProvider.assetTargetCapabilities.find(
                (row) => row.agentRuntimeId === "CURSOR_APP" && row.assetKind === "Skill",
            ),
        ).toMatchObject({ entrySupportStatus: "supported" });
    });

    it("preserves the authorized project-relative path when a direct Skill root is selected", async () => {
        const root = sourceRoot("selected-project-shared", "source", "family_shared", "/fixture/project/.agents/skills");
        const capability = skillCapability("CURSOR_AGENT_CLI", root);
        const observation = bindFixtureProbeObservation({
            adapterId: "CURSOR",
            agentRuntimeId: "CURSOR_AGENT_CLI",
            versionText: "2026.07.23-e383d2b",
            installationEvidence: [],
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
        });
        const base = bindFixtureProviderReadInput({
            digest: DIGEST,
            observation,
            resolveEntries: true,
            obligationId: () => "cursor-selected-project-skill",
        });
        const selected = bindUserSelectedReadInput(base)(root, capability, "project", "/fixture/project", {
            "release-helper/SKILL.md": ENTRY,
        });
        const result = await cursorProvider.read(selected);
        expect(result.candidates[0]).toMatchObject({
            scope: "project",
            projectRootPath: "/fixture/project",
            nativeRepresentation: {
                files: [expect.objectContaining({ relativePath: ".agents/skills/release-helper/SKILL.md" })],
            },
        });
    });

    it("marks duplicate identities incomplete and rejects executable or malformed declarations", async () => {
        const duplicate = await read("CURSOR_AGENT_CLI", PROJECT_ROOT, {
            ".cursor/skills/release-helper/SKILL.md": ENTRY,
            ".agents/skills/release-helper/SKILL.md": ENTRY,
        });
        expect(duplicate.candidates).toHaveLength(2);
        expect(duplicate.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(
            duplicate.candidates.every((candidate) =>
                candidate.diagnostics.some((item) => item.code === "cursor.skill_duplicate_identity"),
            ),
        ).toBe(true);

        const rejected = await read("CURSOR_AGENT_CLI", CONFIG_ROOT, {
            "skills/executable/SKILL.md": ENTRY.replace("name: release-helper", "name: executable").replace(
                "description: Prepare a release with bundled evidence.",
                "description: rejected\nhooks: run-me",
            ),
            "skills/missing/resource.txt": "missing entry",
            "skills/binary/SKILL.md": Uint8Array.of(0xff, 0xfe),
            "skills/empty/SKILL.md": "---\nname: empty\ndescription: empty\n---\n",
            "skills/bad-bool/SKILL.md": ENTRY.replace("name: release-helper", "name: bad-bool").replace(
                "disable-model-invocation: true",
                "disable-model-invocation: maybe",
            ),
            "skills/unclosed/SKILL.md": "---\nname: unclosed\ndescription: unclosed\nbody",
            "skills/good/SKILL.md": ENTRY.replaceAll("release-helper", "good"),
        });
        expect(rejected.candidates).toEqual([
            expect.objectContaining({ displayName: "bad-bool", status: "incomplete" }),
            expect.objectContaining({ displayName: "good", status: "complete" }),
        ]);
        expect(rejected.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "cursor.skill_executable_declaration_rejected" }),
                expect.objectContaining({ code: "cursor.skill_entry_missing" }),
                expect.objectContaining({ code: "cursor.skill_entry_not_utf8" }),
                expect.objectContaining({ code: "cursor.skill_required_content_missing" }),
            ]),
        );
        expect(rejected.candidates[0]?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "cursor.skill_disable_model_invocation_invalid" }),
        );
        expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor.skill_frontmatter_unclosed" }));
    });

    it("keeps traversal bounded to ordinary Skill roots and excludes managed system roots", () => {
        const context = { layout: "project" } as never;
        expect(CURSOR_ASSET_READER_REGISTRY.Skill.disposition).toBe("reader");
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Skill", context, ".cursor")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Skill", context, ".cursor/skills/demo/assets")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Skill", context, ".cursor/skills/.system")).toBe(false);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Skill", context, ".agents/skills/demo/SKILL.md")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Skill", context, ".cursor/skills-cursor/demo/SKILL.md")).toBe(false);
    });

    it("marks a graph incomplete when a file or directory cannot be read", () => {
        const capability = skillCapability("CURSOR_AGENT_CLI", SHARED_ROOT);
        const entryBytes = Buffer.from(ENTRY);
        const entryHandle = {
            readEntryHandleId: "cursor-skill-entry",
            sourceReadObligationId: "cursor-skill-obligation",
            sourceRootId: SHARED_ROOT.sourceRootId,
            relativePath: "release-helper/SKILL.md",
            entryKind: "file" as const,
        };
        const built = buildCursorSkillCandidates(
            {
                root: SHARED_ROOT,
                scope: "global",
                projectRootPath: "",
                layout: "skill_root",
                agentRuntimeId: "CURSOR_AGENT_CLI",
                ownsSharedPhysicalSource: true,
            },
            {
                obligation: {
                    sourceReadObligationId: "cursor-skill-obligation",
                    sourceRootId: SHARED_ROOT.sourceRootId,
                    sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
                },
                capability,
                files: [
                    {
                        handle: entryHandle,
                        observedReadEntryId: "cursor-skill-entry-observed",
                        relativePath: entryHandle.relativePath,
                        bytes: entryBytes,
                        executable: false,
                        text: ENTRY,
                    },
                ],
                directories: [
                    {
                        handle: {
                            ...entryHandle,
                            readEntryHandleId: "cursor-skill-folder",
                            relativePath: "release-helper",
                            entryKind: "directory",
                        },
                        observedReadEntryId: "cursor-skill-folder-observed",
                        relativePath: "release-helper",
                    },
                ],
                dispositions: [],
                observedReadEntryIds: ["cursor-skill-entry-observed", "cursor-skill-folder-observed"],
                diagnostics: [],
                hadIgnoredSource: true,
                unreadableRelativePaths: ["release-helper/missing.bin"],
                unreadableDirectoryPaths: ["release-helper/missing-dir"],
                attachCandidate() {},
                ignoreRecord() {},
                ignoreHandle() {},
                async readReferencedFile() {
                    return { state: "failed", failureStatus: "not_found" };
                },
            },
        );
        expect(built.candidates[0]).toMatchObject({
            status: "incomplete",
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "cursor.skill_resource_unreadable" }),
                expect.objectContaining({ code: "cursor.skill_resource_directory_unreadable" }),
            ]),
        });
    });

    it("records bounded traversal file and directory failures without inventing candidates", async () => {
        const fileFailure = createReadInput("CURSOR_AGENT_CLI", CONFIG_ROOT, {
            "skills/release-helper/SKILL.md": ENTRY,
        });
        fileFailure.readAccess = {
            ...fileFailure.readAccess,
            async readFile() {
                return readAccessFailed("cursor-skill-read-failed", "not_found");
            },
        };
        const unreadable = await cursorProvider.read(fileFailure);
        expect(unreadable.candidates).toEqual([]);
        expect(unreadable.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "file_unreadable" }),
        );

        const directoryFailure = createReadInput("CURSOR_AGENT_CLI", CONFIG_ROOT, {
            "skills/release-helper/SKILL.md": ENTRY,
        });
        directoryFailure.readAccess = {
            ...directoryFailure.readAccess,
            async listDirectory() {
                return readAccessFailed("cursor-skill-list-failed", "not_found");
            },
        };
        expect((await cursorProvider.read(directoryFailure)).sourceParseReports[0]).toMatchObject({
            status: "skipped_ignored_source",
        });
    });

    it("fails native validation for graph, bytes, canonical, and dialect drift", async () => {
        const candidate = required(
            (
                await read("CURSOR_AGENT_CLI", PROJECT_ROOT, {
                    ".cursor/skills/release-helper/SKILL.md": ENTRY,
                    ".cursor/skills/release-helper/reference.txt": "resource\n",
                })
            ).candidates[0],
        );
        for (const mutate of [
            (input: NativeDialectValidationInputV1) => (input.representation.dialectId = CURSOR_NATIVE_DIALECTS.rule),
            (input: NativeDialectValidationInputV1) =>
                (input.nativeFiles[0] = { relativePath: "../escape/SKILL.md", bytes: required(input.nativeFiles[0]).bytes }),
            (input: NativeDialectValidationInputV1) =>
                ((input.canonical as Extract<typeof input.canonical, { kind: "Skill" }>).typeData.description = "changed"),
            (input: NativeDialectValidationInputV1) => {
                required(input.canonicalFiles[0]).file.logicalPath = "OTHER.md";
            },
            (input: NativeDialectValidationInputV1) => {
                required(input.representation.files[0]).contentHash = `sha256:${"0".repeat(64)}`;
            },
        ]) {
            const changed = nativeInput(candidate);
            mutate(changed);
            expect(validateCursorNativeDialect(changed)).toBe(false);
        }
    });
});

async function read(
    agentRuntimeId: AgentRuntimeId,
    root: SourceRoot,
    files: Record<string, string | Uint8Array | { text: string; executable: boolean }>,
) {
    return cursorProvider.read(createReadInput(agentRuntimeId, root, files));
}

function createReadInput(
    agentRuntimeId: AgentRuntimeId,
    root: SourceRoot,
    files: Record<string, string | Uint8Array | { text: string; executable: boolean }>,
) {
    const observation = bindFixtureProbeObservation({
        adapterId: "CURSOR",
        agentRuntimeId,
        versionText: agentRuntimeId === "CURSOR_APP" ? "3.13.25" : "2026.07.23-e383d2b",
        installationEvidence: [],
        installationStatus: "available",
        projectDiscoveryStatus: "complete",
    });
    const readInput = bindFixtureProviderReadInput({
        digest: DIGEST,
        observation,
        resolveEntries: true,
        obligationId: (_capability, index) => `cursor-skill-${agentRuntimeId}-${index}`,
    });
    return readInput(root, [skillCapability(agentRuntimeId, root)], files);
}

function skillCapability(agentRuntimeId: AgentRuntimeId, root: SourceRoot): AdapterAssetSourceCapability {
    return bindRequiredAdapterCapability(
        cursorProvider,
        "Cursor Skill source capability missing",
    )(
        (row) =>
            row.agentRuntimeId === agentRuntimeId &&
            row.assetKind === "Skill" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain,
    );
}

function sourceRoot(
    sourceRootId: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    rootPath: string,
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path: rootPath,
        rootRole,
        sourceDomain,
        locatorKind: rootRole === "project_actual" ? "user_provided_path" : "runtime_known_rule",
        locatorKey: `cursor_${sourceRootId}`,
        evidenceLevel: rootRole === "project_actual" ? "user_provided" : "source_code",
    });
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource === "canonical_files") {
        throw new Error("Cursor Skill native fixture requires separate files");
    }
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
    if (value === undefined) throw new Error("Cursor Skill fixture value missing");
    return value;
}
