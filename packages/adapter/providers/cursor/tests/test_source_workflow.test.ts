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
    fixtureProviderReadInput,
    fixtureSourceRoot,
} from "../../../test-support";
import { cursorProvider } from "../src/cursor-provider";
import { CURSOR_NATIVE_DIALECTS } from "../src/cursor-source-read-model";
import { validateCursorNativeDialect } from "../src/cursor-source-read-native";
import { CURSOR_ASSET_READER_REGISTRY } from "../src/cursor-source-read-registry";
import { CURSOR_SOURCE_TRAVERSAL } from "../src/cursor-source-read-scan";
import {
    commandPathWithinRoot,
    cursorCommandArgumentNames,
    isCursorCommandPath,
    parseCursorCommand,
} from "../src/cursor-source-read-workflow";

const DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const PROJECT_ROOT = sourceRoot("project", "project_actual", "project_root", "/fixture/project");
const CONFIG_ROOT = sourceRoot("config", "config", "agent_runtime_private", "/fixture/home/.cursor");

describe("Cursor Agent/App command Workflow sources", () => {
    it("registers Workflow as a callable reader without lending sibling capability", () => {
        expect(CURSOR_ASSET_READER_REGISTRY.Workflow.disposition).toBe("reader");
        expect(CURSOR_ASSET_READER_REGISTRY.Skill.disposition).toBe("reader");
        expect(CURSOR_ASSET_READER_REGISTRY.Subagent.disposition).toBe("reader");
    });

    it("reads only direct Markdown commands for the exact Cursor Agent project and personal roots", async () => {
        const project = await read("CURSOR_AGENT_CLI", PROJECT_ROOT, {
            ".cursor/commands/release.md": "# Release\nShip $1 and then summarize $ARGUMENTS.\n",
            ".cursor/commands/nested/ignored.md": "nested",
            ".cursor/commands/ignored.txt": "text",
            ".claude/commands/compatible.md": "not Cursor native",
        });
        expect(project.candidates).toHaveLength(1);
        expect(project.candidates[0]).toMatchObject({
            kind: "Workflow",
            displayName: "release",
            displayDescription: "Release",
            scope: "project",
            status: "complete",
            assetCandidateStatus: "importable",
            typeData: {
                name: "release",
                invocation: { argumentNames: ["1", "ARGUMENTS"] },
                implementation: { instructionDialectId: CURSOR_NATIVE_DIALECTS.agentCommandWorkflow },
            },
            nativeRepresentation: {
                representationSource: "separate_files",
                dialectId: CURSOR_NATIVE_DIALECTS.agentCommandWorkflow,
                files: [{ relativePath: ".cursor/commands/release.md" }],
            },
        });
        expect(validateCursorNativeDialect(nativeInput(required(project.candidates[0])))).toBe(true);

        const personal = await read("CURSOR_AGENT_CLI", CONFIG_ROOT, {
            "commands/personal.md": "Personal command $2.\n",
            "commands/nested/ignored.md": "nested",
        });
        expect(personal.candidates).toEqual([
            expect.objectContaining({
                displayName: "personal",
                scope: "global",
                nativeRepresentation: expect.objectContaining({
                    dialectId: CURSOR_NATIVE_DIALECTS.agentCommandWorkflow,
                    files: [expect.objectContaining({ relativePath: "commands/personal.md" })],
                }),
            }),
        ]);
    });

    it("reads recursive Markdown and text commands for the exact Cursor App project and personal roots", async () => {
        const project = await read("CURSOR_APP", PROJECT_ROOT, {
            ".cursor/commands/release.md": "# Release\nShip $ARGUMENTS.\n",
            ".cursor/commands/team/review.txt": "Review $1 before $2.\n",
            ".cursor/commands/a/b/c/d/e/f/g/h/i/j/depth-ten.md": "depth ten",
            ".cursor/commands/a/b/c/d/e/f/g/h/i/j/k/too-deep.md": "too deep",
            ".cursor/commands/not-supported.json": "{}",
        });
        expect(project.candidates.map((candidate) => candidate.displayName)).toEqual([
            "a/b/c/d/e/f/g/h/i/j/depth-ten",
            "release",
            "team/review",
        ]);
        const nested = required(project.candidates.find((candidate) => candidate.displayName === "team/review"));
        expect(nested).toMatchObject({
            typeData: { invocation: { argumentNames: ["1", "2"] } },
            nativeRepresentation: {
                dialectId: CURSOR_NATIVE_DIALECTS.appCommandWorkflow,
                files: [{ relativePath: ".cursor/commands/team/review.txt", mediaType: "text/plain" }],
            },
        });
        expect(validateCursorNativeDialect(nativeInput(nested))).toBe(true);

        const portable = cursorProvider.dialectContracts.portableEntries.find(
            (row) => row.definition.dialectId === CURSOR_NATIVE_DIALECTS.appCommandWorkflow,
        );
        if (portable === undefined) throw new Error("Cursor App Workflow portable-entry contract missing");
        const portableInput: PortableEntryDialectValidationInputV1 = {
            use: {
                kind: "Workflow",
                field: "workflow_instruction",
                dialectId: CURSOR_NATIVE_DIALECTS.appCommandWorkflow,
                logicalPath: nested.files[0]?.logicalPath ?? "",
            },
            versionStatus: "complete",
            canonical: { kind: "Workflow", typeData: nested.typeData },
            canonicalFiles: nativeInput(nested).canonicalFiles,
        };
        expect(portable.validateCanonicalEntry(portableInput)).toBe(true);
        expect(portable.validateSourceApplicability({ agentRuntimeId: "CURSOR_APP", versionText: "fixture" })).toBe(true);
        expect(portable.validateSourceApplicability({ agentRuntimeId: "CURSOR_AGENT_CLI", versionText: "fixture" })).toBe(false);
        expect(portable.validateCanonicalEntry({ ...portableInput, canonicalFiles: [] })).toBe(false);
        expect(portable.validateCanonicalEntry({ ...portableInput, versionStatus: "incomplete", canonicalFiles: [] })).toBe(true);
        expect(
            portable.validateCanonicalEntry({
                ...portableInput,
                canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
            } as PortableEntryDialectValidationInputV1),
        ).toBe(false);

        const personal = await read("CURSOR_APP", CONFIG_ROOT, {
            "commands/team/triage.txt": "Triage $ARGUMENTS.\n",
        });
        expect(personal.candidates[0]).toMatchObject({
            displayName: "team/triage",
            scope: "global",
            nativeRepresentation: expect.objectContaining({ dialectId: CURSOR_NATIVE_DIALECTS.appCommandWorkflow }),
        });
    });

    it("assigns a shared direct Markdown command to one available entry without duplicate interpretation", async () => {
        const cliObservation = bindFixtureProbeObservation({
            adapterId: "CURSOR",
            agentRuntimeId: "CURSOR_AGENT_CLI",
            versionText: "2026.07.23-e383d2b",
            installationEvidence: [],
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
        })(PROJECT_ROOT);
        const appObservation = bindFixtureProbeObservation({
            adapterId: "CURSOR",
            agentRuntimeId: "CURSOR_APP",
            versionText: "3.12.30",
            installationEvidence: [],
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
        })(PROJECT_ROOT);
        const observation = {
            ...cliObservation,
            observedAgentRuntimes: [...cliObservation.observedAgentRuntimes, ...appObservation.observedAgentRuntimes],
        };
        const capabilities = [
            workflowCapability("CURSOR_AGENT_CLI", PROJECT_ROOT),
            workflowCapability("CURSOR_APP", PROJECT_ROOT),
        ];
        const result = await cursorProvider.read(
            fixtureProviderReadInput({
                root: PROJECT_ROOT,
                capabilities,
                fixture: { ".cursor/commands/shared.md": "Shared direct command.\n" },
                digest: DIGEST,
                observation,
                resolveEntries: true,
                obligationId: (capability) => `cursor-workflow-shared-${capability.agentRuntimeId}`,
            }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayName: "shared",
                nativeRepresentation: expect.objectContaining({
                    dialectId: CURSOR_NATIVE_DIALECTS.agentCommandWorkflow,
                }),
            }),
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it("matches exact placeholder and path semantics while rejecting ambiguous names", () => {
        expect(cursorCommandArgumentNames("$1 $ARGUMENTS x$2 $3word $99 $100 $1 $ARGUMENTSfoo")).toEqual([
            "1",
            "ARGUMENTS",
            "99",
        ]);
        expect(commandPathWithinRoot("project", ".cursor/commands/team/review.md")).toBe("team/review.md");
        expect(commandPathWithinRoot("config", "commands/review.md")).toBe("review.md");
        expect(commandPathWithinRoot("external", ".cursor/commands/../escape.md")).toBeNull();
        expect(isCursorCommandPath(".cursor/commands/release.md", false, "project")).toBe(true);
        expect(isCursorCommandPath(".cursor/commands/team/release.md", false, "project")).toBe(false);
        expect(isCursorCommandPath(".cursor/commands/team/release.txt", true, "project")).toBe(true);
        expect(isCursorCommandPath("commands/team/release.txt", true, "global")).toBe(true);
        expect(isCursorCommandPath("commands/../escape.md", true, "global")).toBe(false);

        const invalid = parseCursorCommand(
            { agentRuntimeId: "CURSOR_AGENT_CLI", layout: "project" },
            { relativePath: ".cursor/commands/bad name.md", text: "" },
        );
        expect(invalid.diagnostics.map((item) => item.code)).toEqual([
            "cursor.workflow_name_invalid",
            "cursor.workflow_body_empty",
        ]);
    });

    it("retains empty or non-UTF-8 command evidence without presenting it as importable", async () => {
        const result = await read("CURSOR_APP", PROJECT_ROOT, {
            ".cursor/commands/empty.md": "",
            ".cursor/commands/binary.md": Uint8Array.of(0xff, 0xfe),
            ".cursor/commands/good.md": "Good command.\n",
        });
        expect(result.candidates.map((candidate) => [candidate.displayName, candidate.status])).toEqual([
            ["empty", "incomplete"],
            ["good", "complete"],
        ]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor.workflow_not_utf8" }));
        expect(result.sourceParseReports[0]).toMatchObject({ status: "parsed" });
    });

    it("keeps traversal depth, extensions, and native validation fail closed", async () => {
        const appContext = { agentRuntimeId: "CURSOR_APP", layout: "project", ownsSharedPhysicalSource: true } as const;
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Workflow", appContext as never, ".cursor")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Workflow", appContext as never, ".cursor/commands/a/b")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Workflow", appContext as never, ".cursor/commands/a/b.txt")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Workflow", appContext as never, ".cursor/commands/a/b.json")).toBe(false);

        const candidate = required(
            (await read("CURSOR_APP", PROJECT_ROOT, { ".cursor/commands/team/review.txt": "Review $1.\n" })).candidates[0],
        );
        for (const mutate of [
            (input: NativeDialectValidationInputV1) =>
                (input.representation.dialectId = CURSOR_NATIVE_DIALECTS.agentCommandWorkflow),
            (input: NativeDialectValidationInputV1) =>
                (input.nativeFiles[0] = { relativePath: "../escape.txt", bytes: Buffer.from("Review $1.\n") }),
            (input: NativeDialectValidationInputV1) => {
                required(input.canonicalFiles[0]).file.logicalPath = "OTHER.md";
            },
            (input: NativeDialectValidationInputV1) =>
                ((input.canonical as Extract<typeof input.canonical, { kind: "Workflow" }>).typeData.name = "changed"),
        ]) {
            const changed = nativeInput(candidate);
            mutate(changed);
            expect(validateCursorNativeDialect(changed)).toBe(false);
        }

        const emptyNative = nativeInput(candidate);
        const emptyBytes = new Uint8Array();
        emptyNative.nativeFiles[0] = { relativePath: ".cursor/commands/team/review.txt", bytes: emptyBytes };
        emptyNative.representation.files[0] = {
            ...required(emptyNative.representation.files[0]),
            contentHash: sha256SourceBytes(emptyBytes),
            byteSize: 0,
        };
        expect(validateCursorNativeDialect(emptyNative)).toBe(false);
    });
});

async function read(agentRuntimeId: AgentRuntimeId, root: SourceRoot, files: Record<string, string | Uint8Array>) {
    const observation = bindFixtureProbeObservation({
        adapterId: "CURSOR",
        agentRuntimeId,
        versionText: agentRuntimeId === "CURSOR_APP" ? "3.12.30" : "2026.07.23-e383d2b",
        installationEvidence: [],
        installationStatus: "available",
        projectDiscoveryStatus: "complete",
    });
    const readInput = bindFixtureProviderReadInput({
        digest: DIGEST,
        observation,
        resolveEntries: true,
        obligationId: (_capability, index) => `cursor-workflow-${agentRuntimeId}-${index}`,
    });
    return cursorProvider.read(readInput(root, [workflowCapability(agentRuntimeId, root)], files));
}

function workflowCapability(agentRuntimeId: AgentRuntimeId, root: SourceRoot): AdapterAssetSourceCapability {
    return bindRequiredAdapterCapability(
        cursorProvider,
        "Cursor Workflow source capability missing",
    )(
        (row) =>
            row.agentRuntimeId === agentRuntimeId &&
            row.assetKind === "Workflow" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === root.rootRole &&
            row.sourceDomain === root.sourceDomain,
    );
}

function sourceRoot(
    sourceRootId: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    path: string,
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path,
        rootRole,
        sourceDomain,
        locatorKind: rootRole === "config" ? "runtime_known_rule" : "user_provided_path",
        locatorKey: `cursor_${sourceRootId}`,
        evidenceLevel: rootRole === "config" ? "local_artifact" : "user_provided",
    });
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("Cursor Workflow native fixture requires separate files");
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
    if (value === undefined) throw new Error("Cursor Workflow fixture value missing");
    return value;
}
