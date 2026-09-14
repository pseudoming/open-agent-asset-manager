import { describe, expect, it } from "vitest";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import type { AdapterExtractedAssetCandidate, NativeDialectValidationInputV1 } from "@oaam/core";
import { validateZcodeNativeDialect } from "../src/zcode-source-read-native";
import { resolveZcodeSourceContext } from "../src/zcode-source-read";
import { zcodeProvider } from "../src/zcode-provider";
import { DIGEST, memoryCapability, memoryRoot, projectRoot, rawReadInput, readMemory } from "./zcode-source-test-fixtures";

const TOPIC = `---
name: "Build conventions"
description: "Prefer exact source evidence."
type: project
updatedAt: "2026-07-21T00:00:00.000Z"
source: "explicit_user_request"
sessionId: "session-1"
---

Keep provider evidence scoped to the selected project.
`;

describe("ZCode Memory source read", () => {
    it("reads one bindable Catalog and direct project-keyed topic Units", async () => {
        const result = await readMemory(memoryRoot(), {
            "MEMORY.md":
                "# ZCode Project Memory\n\n## Topic Index\n\n" +
                "- [Build conventions](topics/build.md) — Prefer exact source evidence. (type: project)\n",
            "memory_summary.md": "Derived projection must not become a Unit.\n",
            "topics/build.md": TOPIC,
            "topics/unlinked.md": TOPIC.replace("Build conventions", "Unlinked topic").replace("session-1", "session-2"),
            "topics/nested/ignored.md": TOPIC.replace("Build conventions", "Nested topic"),
            "rollout_summaries/session.md": "Session-derived content must not be read.\n",
            "extensions/ad_hoc/notes/note.md": "Runtime extension content must not be read.\n",
        });

        expect(result.candidates).toHaveLength(3);
        const catalog = result.candidates.find((candidate) => candidate.typeData.entityRole === "catalog");
        expect(catalog).toEqual(
            expect.objectContaining({
                kind: "Memory",
                scope: "project",
                projectRootPath: "/fixture/project",
                displayName: "ZCode Memory catalog",
                status: "complete",
                assetCandidateStatus: "importable",
                files: [],
                typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
                memoryCatalogMemberBindingInputs: [
                    {
                        rawTarget: "topics/build.md",
                        routingTitle: "Build conventions",
                        routingHint: "Prefer exact source evidence.",
                    },
                ],
                nativeRepresentation: expect.objectContaining({
                    dialectId: "zcode-memory-catalog-v1",
                    files: [expect.objectContaining({ relativePath: "MEMORY.md" })],
                }),
            }),
        );
        if (catalog === undefined) throw new Error("missing Memory catalog fixture");
        expect(validateZcodeNativeDialect(nativeInput(catalog))).toBe(false);
        const reboundCatalog = nativeInput(catalog);
        if (reboundCatalog.canonical.kind !== "Memory" || reboundCatalog.canonical.typeData.entityRole !== "catalog") {
            throw new Error("Catalog native fixture has the wrong canonical role");
        }
        reboundCatalog.canonical.typeData.members = [
            {
                targetAssetVersionId: "00000000-0000-4000-8000-000000000901",
                routingTitle: "Build conventions",
                routingHint: "Prefer exact source evidence.",
            },
        ];
        expect(validateZcodeNativeDialect(reboundCatalog)).toBe(true);
        const topic = result.candidates.find((candidate) => candidate.displayName === "Build conventions");
        expect(topic).toEqual(
            expect.objectContaining({
                kind: "Memory",
                scope: "project",
                scopePath: "",
                projectRootPath: "/fixture/project",
                displayDescription: "Prefer exact source evidence.",
                status: "complete",
                assetCandidateStatus: "importable",
                promotionSafety: "requires_user_confirmation",
                files: [
                    expect.objectContaining({
                        logicalPath: "memory.md",
                        text: "Keep provider evidence scoped to the selected project.",
                    }),
                ],
                typeData: {
                    schemaVersion: 2,
                    entityRole: "unit",
                    card: { name: "Build conventions", description: "Prefer exact source evidence." },
                    loading: { card: "high", body: "low" },
                    applicabilityRule: "",
                },
                nativeRepresentation: expect.objectContaining({
                    dialectId: "zcode-memory-topic-v1",
                    files: [expect.objectContaining({ relativePath: "topics/build.md" })],
                }),
                sourceEvidence: expect.arrayContaining([
                    expect.objectContaining({ kind: "summary", value: expect.stringContaining("MEMORY.md:Build conventions") }),
                ]),
            }),
        );
        expect(result.candidates.find((candidate) => candidate.displayName === "Unlinked topic")?.diagnostics).toContainEqual(
            expect.objectContaining({ code: "zcode.memory_topic_unlinked", severity: "warning" }),
        );
        expect(JSON.stringify(result)).not.toContain("Derived projection must not become a Unit");
        expect(JSON.stringify(result)).not.toContain("Session-derived content must not be read");
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" })]),
        );
    });

    it("preserves exact ZCode topic annotations as validated restoration state", async () => {
        const result = await readMemory(memoryRoot(), { "topics/build.md": TOPIC });
        const candidate = result.candidates[0];
        if (candidate === undefined) throw new Error("missing Memory topic fixture");
        expect(candidate.dialectRestorationTransition.action).toBe("replace");
        const bytes =
            candidate.dialectRestorationTransition.action === "replace"
                ? candidate.dialectRestorationTransition.bytes
                : new Uint8Array();
        const restoration = zcodeProvider.dialectContracts.restoration.find(
            (row) => row.definition.dialectId === "zcode-memory-topic-v1",
        );
        expect(restoration?.validatePayload(bytes)).toBe(true);
        expect(restoration?.validatePayload(Buffer.from("{}"))).toBe(false);
        expect(restoration?.validatePayload(Buffer.from("{"))).toBe(false);
        for (const nonRecord of ["null", "[]", '"text"']) {
            expect(restoration?.validatePayload(Buffer.from(nonRecord)), nonRecord).toBe(false);
        }
        expect(
            restoration?.validatePayload(
                Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        dialectId: "zcode-memory-topic-v1",
                        classification: "unknown",
                        sessionId: "",
                        source: "",
                        updatedAt: "",
                    }),
                ),
            ),
        ).toBe(false);

        const input = nativeInput(candidate);
        expect(validateZcodeNativeDialect(input)).toBe(true);
        const changed = structuredClone(input);
        const canonical = changed.canonicalFiles[0];
        if (canonical?.contentKind === "text") canonical.text = "changed";
        expect(validateZcodeNativeDialect(changed)).toBe(false);
    });

    it("matches the installed topic parser's type/name/body requirements and description fallback", async () => {
        const fallback = await readMemory(memoryRoot(), {
            "topics/fallback.md": "---\r\nname: Fallback\r\ntype: feedback\r\n---\r\n\r\nUse exact fixtures when possible.\r\n",
        });
        expect(fallback.candidates).toEqual([
            expect.objectContaining({
                displayName: "Fallback",
                displayDescription: "Use exact fixtures when possible.",
                files: [expect.objectContaining({ text: "Use exact fixtures when possible." })],
            }),
        ]);

        for (const source of [
            "\ufeff---\nname: BOM\ntype: project\n---\nBody\n",
            "No frontmatter\n",
            "---\nname: Missing close\ntype: project\nBody\n",
            "---\nname: Missing type\n---\nBody\n",
            "---\ntype: project\n---\nBody\n",
            "---\nname: Unknown\ntype: other\n---\nBody\n",
        ]) {
            const result = await readMemory(memoryRoot(), { "topics/invalid.md": source });
            expect(result.candidates, source).toEqual([]);
            expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "zcode.memory_topic_invalid" }));
        }
        const empty = await readMemory(memoryRoot(), { "topics/empty.md": "---\nname: Empty\ntype: project\n---\n \n" });
        expect(empty.candidates).toEqual([
            expect.objectContaining({
                displayName: "Empty",
                status: "incomplete",
                assetCandidateStatus: "incomplete",
                diagnostics: [expect.objectContaining({ code: "zcode.memory_topic_body_empty" })],
            }),
        ]);
        const binary = await readMemory(memoryRoot(), { "topics/binary.md": new Uint8Array([0xff]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.memory_topic_not_utf8" }));

        const binaryCatalog = await readMemory(memoryRoot(), { "MEMORY.md": new Uint8Array([0xff]) });
        expect(binaryCatalog.candidates).toEqual([]);
        expect(binaryCatalog.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.memory_catalog_not_utf8" }));

        const quoted = await readMemory(memoryRoot(), {
            "topics/quoted.md": '---\n# comment\nname: "Quoted"\ntype: reference\ndescription: "\\q"\nignored\n---\nBody\n',
        });
        expect(quoted.candidates).toEqual([expect.objectContaining({ displayName: "Quoted", displayDescription: "\\q" })]);

        const longName = "N".repeat(90);
        const bounded = await readMemory(memoryRoot(), {
            "topics/bounded.md": `---\nname: ${longName}\ntype: project\n---\nBody\n`,
        });
        expect(bounded.candidates[0]?.displayName).toBe(`${"N".repeat(69)}...`);
    });

    it("does not invent an empty Catalog and diagnoses both malformed link boundaries", async () => {
        const empty = await readMemory(memoryRoot(), { "MEMORY.md": "\n" });
        expect(empty.candidates).toEqual([]);
        expect(empty.diagnostics).toEqual([]);

        const malformed = await readMemory(memoryRoot(), {
            "MEMORY.md": "- [missing target\n- [missing delimiter](topics/build.md) hint\n",
        });
        expect(malformed.candidates).toEqual([
            expect.objectContaining({
                status: "incomplete",
                assetCandidateStatus: "incomplete",
                diagnostics: [
                    expect.objectContaining({ code: "zcode.memory_catalog_member_invalid" }),
                    expect.objectContaining({ code: "zcode.memory_catalog_member_invalid" }),
                ],
            }),
        ]);
    });

    it("keeps duplicate index paths visible without choosing one as authority", async () => {
        const result = await readMemory(memoryRoot(), {
            "MEMORY.md":
                "- [First](topics/build.md) — first (type: project)\n" +
                "- [Second](topics/build.md) — second (type: project)\n" +
                "- [Third](topics/build.md) — third (type: project)\n" +
                "- [](topics/empty-title.md) — ignored (type: project)\n",
            "topics/build.md": TOPIC,
            "topics/empty-title.md": TOPIC.replace("Build conventions", "Empty title topic"),
        });
        const catalog = result.candidates.find((candidate) => candidate.typeData.entityRole === "catalog");
        const topic = result.candidates.find((candidate) => candidate.displayName === "Build conventions");
        expect(catalog?.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.memory_catalog_duplicate_link" }));
        expect(topic?.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode.memory_topic_unlinked" }));
        expect(topic?.sourceEvidence.some((evidence) => evidence.kind === "summary")).toBe(false);
        expect(
            result.candidates
                .find((candidate) => candidate.displayName === "Empty title topic")
                ?.sourceEvidence.some((evidence) => evidence.kind === "summary"),
        ).toBe(false);
    });

    it("binds project-keyed Memory to one observed workspace identity and rejects ambiguity", () => {
        const root = memoryRoot();
        root.locatorEvidence[1] = {
            locatorKind: "project_registry_entry",
            locatorKey: "registry-entry",
            evidenceLevel: "local_artifact",
        };
        const capability = memoryCapability(root);
        const input = rawReadInput(root, [capability], {});
        const selector = input.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("fixture requires probe roots");
        const workspace = projectRoot();
        selector.observation.sourceRoots.push(workspace);
        selector.observation.observedProjects.push(observedProject("project-1", workspace.sourceRootId));

        expect(resolveZcodeSourceContext(input, root, capability)).toMatchObject({
            scope: "project",
            projectRootPath: "/fixture/project",
            layout: "memory",
        });

        selector.observation.observedProjects.push(observedProject("project-2", workspace.sourceRootId));
        expect(resolveZcodeSourceContext(input, root, capability)).toBeNull();
    });
});

function observedProject(observedProjectId: string, sourceRootId: string) {
    return {
        observedProjectId,
        runtimeProjectKey: observedProjectId,
        displayName: observedProjectId,
        workspaces: [{ sourceRootId, role: "primary" as const }],
        evidence: [
            {
                evidenceKind: "agent_runtime_resource" as const,
                agentRuntimeResourceId: "registry-resource",
                locatorKey: "registry-entry",
                evidenceLevel: "local_artifact" as const,
            },
        ],
        diagnostics: [],
    };
}

function nativeInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.nativeRepresentation.representationSource !== "separate_files") {
        throw new Error("fixture requires separate native files");
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
            schemaVersion: 1,
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
