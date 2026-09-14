import { sha256SourceBytes } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AgentRuntimeId,
    NativeDialectValidationInputV1,
    Sha256Digest,
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

const DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const PROJECT_ROOT = fixtureSourceRoot({
    sourceRootId: "project",
    path: "/fixture/project",
    rootRole: "project_actual",
    sourceDomain: "project_root",
    locatorKind: "user_provided_path",
    locatorKey: "cursor_project",
    evidenceLevel: "user_provided",
});
const SUBAGENT = `---
name: reviewer
description: Review changes conservatively.
tools: Read, Grep
model: fast
readonly: true
background: false
---
Review the requested changes and report evidence.
`;

describe("Cursor project Subagent source", () => {
    it("registers callable Subagent and selected-snapshot Memory readers", () => {
        expect(CURSOR_ASSET_READER_REGISTRY.Subagent.disposition).toBe("reader");
        expect(CURSOR_ASSET_READER_REGISTRY.Memory).toMatchObject({ disposition: "reader" });
    });

    it("reads recursive project declarations with exact field and native mapping", async () => {
        const result = await read("CURSOR_AGENT_CLI", {
            ".cursor/agents/reviewer.md": SUBAGENT,
            ".cursor/agents/team/security.markdown": SUBAGENT.replace("name: reviewer", "name: security"),
            ".cursor/commands/not-agent.md": SUBAGENT,
            ".cursor/agents/not-agent.json": SUBAGENT,
        });
        expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(["reviewer", "security"]);
        expect(result.candidates[0]).toMatchObject({
            kind: "Subagent",
            displayName: "reviewer",
            displayDescription: "Review changes conservatively.",
            scope: "project",
            status: "complete",
            assetCandidateStatus: "importable",
            files: [{ logicalPath: "instructions.json", role: "entry" }],
            nativeRepresentation: {
                representationSource: "separate_files",
                dialectId: CURSOR_NATIVE_DIALECTS.subagent,
                files: [{ relativePath: ".cursor/agents/reviewer.md" }],
            },
            typeData: {
                tools: { availability: { base: { mode: "allowlist" } } },
                execution: {
                    permission: { mode: "selected", effect: "read_only" },
                    scheduling: { mode: "always_foreground" },
                    model: { mode: "selected", selector: "fast", relativeTier: -1 },
                },
            },
        });
        expect(validateCursorNativeDialect(nativeInput(required(result.candidates[0])))).toBe(true);
    });

    it("offers independently verified App source evidence without duplicate interpretation", async () => {
        const cliObservation = observation("CURSOR_AGENT_CLI", "available")(PROJECT_ROOT);
        const appObservation = observation("CURSOR_APP", "available")(PROJECT_ROOT);
        const combined = {
            ...cliObservation,
            observedAgentRuntimes: [...cliObservation.observedAgentRuntimes, ...appObservation.observedAgentRuntimes],
        };
        const result = await cursorProvider.read(
            fixtureProviderReadInput({
                root: PROJECT_ROOT,
                capabilities: [capability("CURSOR_AGENT_CLI"), capability("CURSOR_APP")],
                fixture: { ".cursor/agents/shared.md": SUBAGENT },
                digest: DIGEST,
                observation: combined,
                resolveEntries: true,
                obligationId: (row) => `cursor-subagent-${row.agentRuntimeId}`,
            }),
        );
        expect(result.candidates).toEqual([
            expect.objectContaining({
                displayName: "reviewer",
                sourceEvidence: [expect.objectContaining({ evidenceLevel: "agent_runtime_verified" })],
            }),
        ]);
        expect(
            cursorProvider.assetSourceCapabilities.find(
                (row) => row.agentRuntimeId === "CURSOR_APP" && row.assetKind === "Subagent",
            ),
        ).toMatchObject({ entrySupportStatus: "supported", evidenceLevel: "agent_runtime_verified" });

        const appOnly = await read("CURSOR_APP", { ".cursor/agents/app.md": SUBAGENT.replace("reviewer", "app") });
        expect(appOnly.candidates).toEqual([
            expect.objectContaining({
                displayName: "app",
                sourceEvidence: [expect.objectContaining({ evidenceLevel: "agent_runtime_verified" })],
            }),
        ]);
    });

    it("keeps ambiguous or private behavior incomplete and rejects malformed declarations", async () => {
        const incomplete = await read("CURSOR_AGENT_CLI", {
            ".cursor/agents/unknown.md": SUBAGENT.replace("model: fast", "futureBehavior: true"),
            ".cursor/agents/forced.md": SUBAGENT.replace("model: fast", "force-default-model: true"),
            ".cursor/agents/aliases.md": SUBAGENT.replace("background: false", "background: false\nis_background: true"),
        });
        expect(incomplete.candidates).toHaveLength(3);
        expect(incomplete.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);

        for (const source of [
            "No frontmatter\n",
            "---\nname: missing-close\ndescription: Missing\n",
            "---\nname: missing-description\n---\nBody\n",
            "---\ndescription: missing-name\n---\nBody\n",
            "---\nname: empty\ndescription: Empty\n---\n \n",
        ]) {
            const result = await read("CURSOR_AGENT_CLI", { ".cursor/agents/invalid.md": source });
            expect(result.candidates).toEqual([]);
            expect(result.sourceParseReports[0]?.status).toBe("skipped_ignored_source");
        }
        const binary = await read("CURSOR_AGENT_CLI", { ".cursor/agents/binary.md": Uint8Array.of(0xff) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor.subagent_not_utf8" }));
    });

    it("marks duplicate logical identities and enforces traversal/path bounds", async () => {
        const duplicate = await read("CURSOR_AGENT_CLI", {
            ".cursor/agents/one.md": SUBAGENT,
            ".cursor/agents/nested/two.mdc": SUBAGENT,
        });
        expect(duplicate.candidates).toHaveLength(2);
        expect(duplicate.candidates.every((candidate) => candidate.status === "incomplete")).toBe(true);
        expect(duplicate.candidates[0]?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "cursor.subagent_duplicate_identity" }),
        );

        const context = { layout: "project", ownsSharedPhysicalSource: true } as never;
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Subagent", context, ".cursor")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldEnterDirectory("Subagent", context, ".cursor/agents/a/b")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Subagent", context, ".cursor/agents/a/b.markdown")).toBe(true);
        expect(CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Subagent", context, ".cursor/agents/a/b.json")).toBe(false);
        expect(
            CURSOR_SOURCE_TRAVERSAL.shouldReadFile("Subagent", context, ".cursor/agents/a/b/c/d/e/f/g/h/i/j/k/too-deep.md"),
        ).toBe(false);
        expect(
            CURSOR_SOURCE_TRAVERSAL.shouldReadFile(
                "Subagent",
                { layout: "config", ownsSharedPhysicalSource: true } as never,
                "agents/global.md",
            ),
        ).toBe(false);
    });

    it("fails persisted native reopening on changed semantics, graph or path", async () => {
        const candidate = required((await read("CURSOR_AGENT_CLI", { ".cursor/agents/reviewer.md": SUBAGENT })).candidates[0]);
        for (const mutate of [
            (input: NativeDialectValidationInputV1) => {
                input.representation.dialectId = CURSOR_NATIVE_DIALECTS.skill;
            },
            (input: NativeDialectValidationInputV1) => {
                input.nativeFiles[0] = { relativePath: "../escape.md", bytes: Buffer.from(SUBAGENT) };
            },
            (input: NativeDialectValidationInputV1) => {
                required(input.canonicalFiles[0]).file.logicalPath = "OTHER.json";
            },
            (input: NativeDialectValidationInputV1) => {
                const canonical = input.canonical;
                if (canonical.kind === "Subagent") canonical.typeData.name = "changed";
            },
        ]) {
            const changed = nativeInput(candidate);
            mutate(changed);
            expect(validateCursorNativeDialect(changed)).toBe(false);
        }
        const incomplete = required(
            (
                await read("CURSOR_AGENT_CLI", {
                    ".cursor/agents/incomplete.md": SUBAGENT.replace("model: fast", "force-default-model: true"),
                })
            ).candidates[0],
        );
        expect(validateCursorNativeDialect(nativeInput(incomplete))).toBe(false);
    });
});

async function read(agentRuntimeId: AgentRuntimeId, files: Record<string, string | Uint8Array>) {
    const bindRead = bindFixtureProviderReadInput({
        digest: DIGEST,
        observation: observation(agentRuntimeId, "available"),
        resolveEntries: true,
        obligationId: (_row, index) => `cursor-subagent-${agentRuntimeId}-${index}`,
    });
    return cursorProvider.read(bindRead(PROJECT_ROOT, [capability(agentRuntimeId)], files));
}

function observation(agentRuntimeId: AgentRuntimeId, installationStatus: "available") {
    return bindFixtureProbeObservation({
        adapterId: "CURSOR",
        agentRuntimeId,
        versionText: agentRuntimeId === "CURSOR_APP" ? "3.12.30" : "2026.07.23-e383d2b",
        installationEvidence: [],
        installationStatus,
        projectDiscoveryStatus: "complete",
    });
}

function capability(agentRuntimeId: AgentRuntimeId): AdapterAssetSourceCapability {
    return bindRequiredAdapterCapability(
        cursorProvider,
        "Cursor Subagent capability missing",
    )(
        (row) =>
            row.agentRuntimeId === agentRuntimeId &&
            row.assetKind === "Subagent" &&
            row.entrySupportStatus === "supported" &&
            row.rootRole === "project_actual",
    );
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") throw new Error("native files missing");
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

function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("required Cursor Subagent fixture missing");
    return value;
}
