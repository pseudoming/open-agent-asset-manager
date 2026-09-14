import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterReadTarget, SourceRoot, UuidV4 } from "@oaam/core";
import { readVersionAuthority } from "../../../core/src/catalog/version-authority";
import {
    executeAdapterReadWithAuthority,
    executeAdapterReadWithAuthorityForTest,
} from "../../../core/src/source-import/source-read-execution";
import {
    createAdapterReadOperation,
    DEFAULT_ADAPTER_READ_OPERATION_LIMITS,
} from "../../../core/src/adapters/adapter-read-access";
import {
    bindAcceptFixtureCandidate,
    bindAuthoritativeFixtureRead,
    bindDialectRegistry,
    bindFixtureImportService,
    bindFixtureProbeRootTarget,
    bindPortableSelectorValidator,
    bindWorkflowEntryAgentValidator,
} from "../../../test-support";
import { claudecodeProvider } from "../src/claudecode-provider";

let sandbox = "";
let project = "";
let memory = "";
let transactions = "";
let assets = "";
let oaam = "";
let locks = "";
const PROJECT_ID = "00000000-0000-4000-8000-000000000101" as UuidV4;
const target = bindFixtureProbeRootTarget({
    adapterId: "CLAUDECODE",
    agentRuntimeId: "CLAUDE_CODE_CLI",
    versionText: "fixture",
    installationEvidence: [
        {
            kind: "executable",
            path: "/fixture/claude",
            evidenceLevel: "local_artifact",
            diagnostics: [],
        },
    ],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const appTarget = bindFixtureProbeRootTarget({
    adapterId: "CLAUDECODE",
    agentRuntimeId: "CLAUDE_CODE_APP",
    versionText: "fixture-app",
    installationEvidence: [
        {
            kind: "executable",
            path: "/fixture/claude-app",
            evidenceLevel: "local_artifact",
            diagnostics: [],
        },
    ],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const targetWithProjectAssociation = (
    sourceRoots: SourceRoot[],
    allowedKinds: Parameters<typeof target>[1],
): ReturnType<typeof target> => {
    const readTarget = target(sourceRoots, allowedKinds);
    const selector = readTarget.sourceSelector;
    const memorySourceRoot = sourceRoots.find((root) => root.sourceDomain === "project_keyed");
    if (selector.selectorKind !== "probe_roots" || memorySourceRoot === undefined) return readTarget;
    const workspace = projectRoot();
    selector.observation.sourceRoots.push(workspace);
    const runtime = selector.observation.observedAgentRuntimes[0];
    runtime?.sourceRootIds.push(workspace.sourceRootId);
    runtime?.observedProjectIds.push("claudecode-project");
    selector.observation.observedProjects.push({
        observedProjectId: "claudecode-project",
        runtimeProjectKey: project,
        displayName: "project",
        workspaces: [{ sourceRootId: workspace.sourceRootId, role: "primary" }],
        evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
        diagnostics: [],
    });
    return readTarget;
};
const authoritativeRead = bindAuthoritativeFixtureRead({
    provider: claudecodeProvider,
    target: targetWithProjectAssociation,
    transactionsRoot: () => transactions,
});
const appAuthoritativeRead = bindAuthoritativeFixtureRead({
    provider: claudecodeProvider,
    target: appTarget,
    transactionsRoot: () => transactions,
});
const importService = bindFixtureImportService({
    provider: claudecodeProvider,
    assetsRoot: () => assets,
    oaamRoot: () => oaam,
    authorityLocksRoot: () => locks,
    projectRootPath: () => project,
    projectId: PROJECT_ID,
});
const acceptCandidate = bindAcceptFixtureCandidate("adapter-conformance");

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claudecode-conformance-"));
    project = path.join(sandbox, "project");
    memory = path.join(sandbox, "memory");
    transactions = path.join(sandbox, "transactions");
    assets = path.join(sandbox, "assets");
    oaam = path.join(sandbox, "oaam");
    locks = path.join(sandbox, "locks");
    fs.mkdirSync(path.join(project, ".claude", "rules"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "skills", "sample"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
    fs.mkdirSync(memory, { recursive: true });
    fs.mkdirSync(transactions, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Claude Code Core-owned read conformance", () => {
    it("fails at the Core handle budget without leaving an issued handle unclassified", async () => {
        const result = await executeAdapterReadWithAuthorityForTest(
            claudecodeProvider,
            target([projectRoot()], ["Guidance"]),
            {
                managedTargetGuards: [],
                reservationIdentityFingerprints: [],
                transactionsRoot: transactions,
            },
            (input, revalidate) =>
                createAdapterReadOperation(
                    {
                        ...input,
                        limits: { ...DEFAULT_ADAPTER_READ_OPERATION_LIMITS, maxIssuedHandles: 1 },
                    },
                    revalidate,
                ),
        );
        expect(result.status).toBe("failed");
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "read.resource_limit_exceeded" })]),
        );
        expect(result.diagnostics.some((item) => item.code === "read.handle_disposition_missing")).toBe(false);
    });

    it("publishes five project declaration kinds through real no-follow handles", async () => {
        fs.writeFileSync(path.join(project, "CLAUDE.md"), "# Guidance\n");
        fs.writeFileSync(path.join(project, ".claude", "rules", "rule.md"), "Rule body\n");
        fs.writeFileSync(
            path.join(project, ".claude", "commands", "review.md"),
            "---\nname: review\ndescription: Review\n---\nReview changes.\n",
        );
        fs.writeFileSync(
            path.join(project, ".claude", "skills", "sample", "SKILL.md"),
            "---\nname: sample\ndescription: Sample\n---\nUse the sample.\n",
        );
        fs.writeFileSync(path.join(project, ".claude", "skills", "sample", "image.bin"), new Uint8Array([0, 255, 1]));
        fs.writeFileSync(
            path.join(project, ".claude", "agents", "reviewer.md"),
            "---\nname: reviewer\ndescription: Reviewer\n---\nReview carefully.\n",
        );
        const root = projectRoot();
        const result = await executeAdapterReadWithAuthority(
            claudecodeProvider,
            target([root], ["Guidance", "Rule", "Workflow", "Skill", "Subagent"]),
            { managedTargetGuards: [], reservationIdentityFingerprints: [], transactionsRoot: transactions },
        );
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates.map((candidate) => candidate.kind).sort()).toEqual(
            ["Guidance", "Rule", "Workflow", "Skill", "Subagent"].sort(),
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.value?.observedReadEntries.length).toBeGreaterThan(5);
        const dispositions = result.value?.sourceParseReports[0]?.readEntryDispositions ?? [];
        expect(dispositions.length).toBeGreaterThan(0);
        expect(
            dispositions.every(
                (item) => item.disposition === "ignored" || item.disposition === "traversed" || item.candidateIds.length > 0,
            ),
        ).toBe(true);
    });

    it("projects a filesystem Memory Catalog and its exact Unit binding as complete", async () => {
        fs.writeFileSync(path.join(memory, "MEMORY.md"), "# Memory\n- [Topic](topic.md) — summary\n");
        fs.writeFileSync(
            path.join(memory, "topic.md"),
            "---\nname: Topic\ndescription: topic\ntype: project\n---\nRemember this.\n",
        );
        const root = memoryRoot();
        const result = await executeAdapterReadWithAuthority(
            claudecodeProvider,
            targetWithProjectAssociation([root], ["Memory"]),
            {
                managedTargetGuards: [],
                reservationIdentityFingerprints: [],
                transactionsRoot: transactions,
            },
        );
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "Claude Code Memory catalog",
                    status: "complete",
                    memoryCatalogMemberBindingInputs: [{ rawTarget: "topic.md", routingTitle: "Topic", routingHint: "summary" }],
                }),
                expect.objectContaining({ displayName: "Topic", status: "complete" }),
            ]),
        );
        expect(result.diagnostics).toEqual([]);
    });

    it("imports a Memory Catalog and its Units dependency-first with exact native reopen", async () => {
        fs.mkdirSync(path.join(memory, "topics"), { recursive: true });
        fs.writeFileSync(
            path.join(memory, "MEMORY.md"),
            "# Memory\n- [Second](topics/second.md) — second hint\n- [First](topics/first.md) — first hint\n",
        );
        fs.writeFileSync(
            path.join(memory, "topics", "first.md"),
            "---\nname: First\ndescription: first\ntype: project\n---\nFirst body.\n",
        );
        fs.writeFileSync(
            path.join(memory, "topics", "second.md"),
            "---\nname: Second\ndescription: second\ntype: reference\n---\nSecond body.\n",
        );
        const root = memoryRoot();
        const readAgain = () => authoritativeRead(root, ["Memory"]);
        const read = await readAgain();
        const catalog = read.candidates.find((candidate) => candidate.typeData.entityRole === "catalog");
        const first = read.candidates.find((candidate) => candidate.displayName === "First");
        const second = read.candidates.find((candidate) => candidate.displayName === "Second");
        if (catalog === undefined || first === undefined || second === undefined)
            throw new Error("Memory graph fixture is incomplete");
        const service = importService(readAgain);
        const preview = service.previewImport([read]);
        expect(preview.status, JSON.stringify(preview.diagnostics, null, 2)).toBe("complete");
        const accepted = await service.acceptImportBatch({
            previewSnapshot: preview.value,
            decisions: [
                {
                    candidateId: catalog.candidateId,
                    action: "create_asset",
                    freshness: { freshnessAction: "require_current_source" },
                    promotion: { promotionAction: "import_only", userActionId: "memory-catalog-conformance" },
                    callableBindings: [
                        {
                            subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                            targetCandidateId: second.candidateId,
                        },
                        {
                            subject: { subjectKind: "memory_catalog_member", memberIndex: 1 },
                            targetCandidateId: first.candidateId,
                        },
                    ],
                },
                ...[first, second].map((candidate) => ({
                    candidateId: candidate.candidateId,
                    action: "create_asset" as const,
                    freshness: { freshnessAction: "require_current_source" as const },
                    promotion: {
                        promotionAction: "import_only" as const,
                        userActionId: "memory-catalog-conformance",
                    },
                    callableBindings: [],
                })),
            ],
        });
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
        if (accepted.status !== "complete") throw new Error("Memory Catalog batch import failed");
        const byCandidate = new Map(
            accepted.value.items.flatMap((item) =>
                item.status === "complete" ? [[item.candidateId, item.version] as const] : [],
            ),
        );
        const catalogVersion = byCandidate.get(catalog.candidateId);
        const firstVersion = byCandidate.get(first.candidateId);
        const secondVersion = byCandidate.get(second.candidateId);
        if (catalogVersion === undefined || firstVersion === undefined || secondVersion === undefined) {
            throw new Error("Memory Catalog batch did not publish every Version");
        }
        const closure = readVersionAuthority(assets, catalogVersion.assetId, catalogVersion.versionId, dialectRegistry());
        expect(closure?.manifest.typeData).toEqual({
            schemaVersion: 2,
            entityRole: "catalog",
            members: [
                {
                    targetAssetVersionId: secondVersion.versionId,
                    routingTitle: "Second",
                    routingHint: "second hint",
                },
                {
                    targetAssetVersionId: firstVersion.versionId,
                    routingTitle: "First",
                    routingHint: "first hint",
                },
            ],
        });
        expect(closure?.nativePayloads[0]?.files.map((file) => file.relativePath)).toEqual(["MEMORY.md"]);
    });

    it("imports every complete project dialect through Core and reopens the exact native graph", async () => {
        fs.mkdirSync(path.join(project, ".claude", "rules", "nested"), { recursive: true });
        fs.mkdirSync(path.join(project, ".claude", "commands", "team"), { recursive: true });
        fs.mkdirSync(path.join(project, ".claude", "workflows", "tools"), { recursive: true });
        fs.mkdirSync(path.join(project, ".claude", "agents", "team"), { recursive: true });
        fs.mkdirSync(path.join(project, ".claude", "skills", "sample", "docs"), { recursive: true });
        fs.writeFileSync(path.join(project, "CLAUDE.md"), "\ufeff# Guidance\r\n");
        fs.writeFileSync(path.join(project, ".claude", "rules", "nested", "rule.md"), "Rule body\n");
        fs.writeFileSync(
            path.join(project, ".claude", "commands", "team", "review.md"),
            "---\nname: review\ndescription: Review\n---\nReview changes.\n",
        );
        const workflowEntry = path.join(project, ".claude", "workflows", "tools", "timezone.js");
        fs.writeFileSync(workflowEntry, "export const meta = { name: 'timezone', description: 'Timezone' };\n");
        fs.chmodSync(workflowEntry, 0o755);
        fs.mkdirSync(path.join(project, ".claude", "workflows", "tools", "resources"), { recursive: true });
        fs.mkdirSync(path.join(project, ".claude", "workflows", "tools", "scripts"), { recursive: true });
        fs.writeFileSync(path.join(project, ".claude", "workflows", "tools", "resources", "marker.txt"), "Workflow resource\n");
        fs.writeFileSync(
            path.join(project, ".claude", "workflows", "tools", "resources", "marker.bin"),
            new Uint8Array([0, 255, 2]),
        );
        const workflowHelper = path.join(project, ".claude", "workflows", "tools", "scripts", "helper.js");
        fs.writeFileSync(workflowHelper, "export const marker = 'workflow helper';\n");
        fs.chmodSync(workflowHelper, 0o755);
        fs.writeFileSync(
            path.join(project, ".claude", "skills", "sample", "SKILL.md"),
            "---\nname: sample\ndescription: Sample\n---\nUse [details](docs/details.md).\n",
        );
        fs.writeFileSync(path.join(project, ".claude", "skills", "sample", "docs", "details.md"), "# Details\n");
        fs.writeFileSync(path.join(project, ".claude", "skills", "sample", "image.bin"), new Uint8Array([0, 255, 1]));
        fs.writeFileSync(
            path.join(project, ".claude", "agents", "team", "reviewer.md"),
            "---\nname: reviewer\ndescription: Reviewer\n---\nReview carefully.\n",
        );
        const root = projectRoot();
        const kinds: AdapterReadTarget["allowedKinds"] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent"];
        const readAgain = () => authoritativeRead(root, kinds);
        const read = await readAgain();
        const service = importService(readAgain);
        const expectedPaths = new Map<string, string[]>([
            ["claudecode-guidance-markdown-v1", ["CLAUDE.md"]],
            ["claudecode-rule-markdown-v1", [".claude/rules/nested/rule.md"]],
            ["claudecode-command-markdown-v1", [".claude/commands/team/review.md"]],
            [
                "claudecode-js-workflow-v1",
                [
                    ".claude/workflows/tools/resources/marker.bin",
                    ".claude/workflows/tools/resources/marker.txt",
                    ".claude/workflows/tools/scripts/helper.js",
                    ".claude/workflows/tools/timezone.js",
                ],
            ],
            [
                "claudecode-skill-directory-v1",
                [".claude/skills/sample/SKILL.md", ".claude/skills/sample/docs/details.md", ".claude/skills/sample/image.bin"],
            ],
            ["claudecode-subagent-markdown-v1", [".claude/agents/team/reviewer.md"]],
        ]);
        const completeCandidates = read.candidates.filter((candidate) => candidate.status === "complete");
        expect(completeCandidates).toHaveLength(6);
        expect(completeCandidates.find((candidate) => candidate.kind === "Skill")?.nativeRepresentation).toMatchObject({
            files: [
                { relativePath: ".claude/skills/sample/SKILL.md" },
                { relativePath: ".claude/skills/sample/docs/details.md" },
                { relativePath: ".claude/skills/sample/image.bin" },
            ],
        });
        expect(
            completeCandidates.find(
                (candidate) =>
                    candidate.kind === "Workflow" && candidate.nativeRepresentation.dialectId === "claudecode-js-workflow-v1",
            )?.nativeRepresentation,
        ).toMatchObject({
            files: [
                { relativePath: ".claude/workflows/tools/resources/marker.bin", executable: false },
                { relativePath: ".claude/workflows/tools/resources/marker.txt", executable: false },
                { relativePath: ".claude/workflows/tools/scripts/helper.js", executable: true },
                { relativePath: ".claude/workflows/tools/timezone.js", executable: true },
            ],
        });

        for (const candidate of completeCandidates) {
            const accepted = await acceptCandidate(service, read, candidate.candidateId);
            expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
            const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
            expect(closure).not.toBeNull();
            const key = candidate.nativeRepresentation.dialectId;
            expect(closure?.nativePayloads[0]?.files.map((file) => file.relativePath)).toEqual(expectedPaths.get(key));
            const representation = closure?.manifest.nativeRepresentations[0];
            if (representation === undefined || candidate.nativeRepresentation.representationSource === "canonical_files") {
                throw new Error("Claude native candidate did not preserve its source graph");
            }
            if (candidate.nativeRepresentation.representationSource === "separate_file_graph") {
                expect(representation.schemaVersion).toBe(2);
                if (representation.schemaVersion !== 2) throw new Error("directory native representation missing");
                expect(representation.directories).toEqual(
                    candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                );
            } else {
                expect(representation.schemaVersion).toBe(1);
            }
            expect(candidate.nativeRepresentation.files.map((file) => file.relativePath)).toEqual(
                closure?.manifest.nativeRepresentations[0]?.files.map((file) => file.relativePath),
            );
            expect(candidate.nativeRepresentation.files.map((file) => [...file.bytes])).toEqual(
                closure?.nativePayloads[0]?.files.map((file) => [...file.bytes]),
            );
        }
    });

    it.each([
        ["---\ndescription: Explicit description\n---\n# Body title\n", "Explicit description"],
        ["---\nname: sample\n---\n\n# Body title\nUse the resource.\n", "Body title"],
        ["\n# Body title\nUse the resource.\n", "Body title"],
        [`# ${"Long title ".repeat(12)}\nBody.\n`, `${"Long title ".repeat(12).trim().substring(0, 97)}...`],
    ])("imports verified missing-field Skill defaults without rewriting the entry: %s", async (entryText, expectedDescription) => {
        const boundary = ".claude/skills/sample";
        fs.mkdirSync(path.join(project, boundary, "reports", "pending"), { recursive: true });
        fs.writeFileSync(path.join(project, boundary, "SKILL.md"), entryText);
        fs.writeFileSync(path.join(project, boundary, "resource.bin"), Uint8Array.of(0, 255, 13, 10));
        fs.writeFileSync(path.join(project, boundary, "report.sh"), "#!/bin/sh\nprintf '%s\\n' \"$TARGET_DIR\"\n", {
            mode: 0o755,
        });
        const readAgain = () => authoritativeRead(projectRoot(), ["Skill"]);
        const read = await readAgain();
        expect(read.candidates).toHaveLength(1);
        const candidate = read.candidates[0]!;
        expect(candidate).toMatchObject({
            kind: "Skill",
            status: "complete",
            assetCandidateStatus: "importable",
            displayName: "sample",
            displayDescription: expectedDescription,
            typeData: {
                name: "sample",
                description: expectedDescription,
                invocation: { user: { mode: "direct", commandName: "sample" } },
            },
            diagnostics: [],
        });
        const accepted = await acceptCandidate(importService(readAgain), read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
        expect(closure?.manifest.nativeRepresentations[0]).toMatchObject({
            schemaVersion: 2,
            directories: [boundary, `${boundary}/reports`, `${boundary}/reports/pending`],
        });
        const payloads = closure!.nativePayloads[0]!.files;
        expect(Buffer.from(payloads.find((file) => file.relativePath === `${boundary}/SKILL.md`)!.bytes).toString("utf8")).toBe(
            entryText,
        );
        expect([...payloads.find((file) => file.relativePath === `${boundary}/resource.bin`)!.bytes]).toEqual([0, 255, 13, 10]);
        expect(
            closure?.manifest.nativeRepresentations[0]?.files.find((file) => file.relativePath.endsWith("report.sh"))?.executable,
        ).toBe(true);
        expect(fs.readFileSync(path.join(project, boundary, "SKILL.md"), "utf8")).toBe(entryText);
    });

    it("imports an App-only project Skill through Core without borrowing CLI dialect applicability", async () => {
        const boundary = path.join(".claude", "skills", "app-only");
        fs.mkdirSync(path.join(project, boundary, "references"), { recursive: true });
        fs.writeFileSync(
            path.join(project, boundary, "SKILL.md"),
            "---\nname: app-only\ndescription: App-only import\n---\nUse [details](references/details.md).\n",
        );
        fs.writeFileSync(path.join(project, boundary, "references", "details.md"), "# App-only details\n");
        const root = projectRoot();
        const readAgain = () => appAuthoritativeRead(root, ["Skill"]);
        const read = await readAgain();
        const runtimeByFingerprint = new Map(
            claudecodeProvider.assetSourceCapabilities.map((capability) => [
                capability.sourceCapabilityFingerprint,
                capability.agentRuntimeId,
            ]),
        );
        expect([
            ...new Set(
                read.sourceReadObligations.map((obligation) => runtimeByFingerprint.get(obligation.sourceCapabilityFingerprint)),
            ),
        ]).toEqual(["CLAUDE_CODE_APP"]);
        expect(read.candidates).toEqual([
            expect.objectContaining({
                kind: "Skill",
                status: "complete",
                nativeRepresentation: expect.objectContaining({
                    dialectId: "claudecode-skill-directory-v1",
                    files: [
                        expect.objectContaining({ relativePath: ".claude/skills/app-only/SKILL.md" }),
                        expect.objectContaining({ relativePath: ".claude/skills/app-only/references/details.md" }),
                    ],
                }),
            }),
        ]);

        const service = importService(readAgain);
        const preview = service.previewImport([read]);
        expect(preview.status, JSON.stringify(preview.diagnostics, null, 2)).toBe("complete");
        expect(preview.value.items).toEqual([
            expect.objectContaining({
                candidateId: read.candidates[0]?.candidateId,
                action: "create_asset",
            }),
        ]);
        const accepted = await acceptCandidate(service, read, read.candidates[0]?.candidateId ?? "");
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
        const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
        expect(closure?.manifest.portableDialectContracts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ field: "skill_entry", dialectId: "claudecode-skill-markdown-v1" }),
            ]),
        );
        expect(closure?.nativePayloads[0]?.files.map((file) => file.relativePath)).toEqual([
            ".claude/skills/app-only/SKILL.md",
            ".claude/skills/app-only/references/details.md",
        ]);
    });

    it("imports a Memory topic with validated restoration metadata and rejects tampering", async () => {
        fs.mkdirSync(path.join(memory, "topics"), { recursive: true });
        fs.writeFileSync(path.join(memory, "MEMORY.md"), "# Memory\n- [Topic](topics/topic.md) — summary\n");
        fs.writeFileSync(
            path.join(memory, "topics", "topic.md"),
            "---\nname: Topic\ndescription: topic\ntype: project\nmetadata:\n  originSessionId: session-1\n---\nRemember this.\n",
        );
        const root = memoryRoot();
        const readAgain = () => authoritativeRead(root, ["Memory"]);
        const read = await readAgain();
        const topic = read.candidates.find((candidate) => candidate.displayName === "Topic");
        expect(topic?.status).toBe("complete");
        const accepted = await acceptCandidate(importService(readAgain), read, topic?.candidateId ?? "");
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
        const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
        expect(closure?.nativePayloads[0]?.files.map((file) => file.relativePath)).toEqual(["topics/topic.md"]);
        const restoration = closure?.restorationPayloads[0];
        const contract = claudecodeProvider.dialectContracts.restoration[0];
        expect(restoration === undefined ? false : contract?.validatePayload(restoration.bytes)).toBe(true);
        expect(
            contract?.validatePayload(
                Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        dialectId: "claudecode-memory-topic-v1",
                        topLevelType: "project",
                        metadataType: "",
                        metadataOriginSessionId: "session-1",
                        metadataNodeType: "",
                        unexpected: true,
                    }),
                ),
            ),
        ).toBe(false);

        const representation = closure?.manifest.nativeRepresentations[0];
        const native = closure?.nativePayloads[0];
        const nativeContract = claudecodeProvider.dialectContracts.native.find(
            (item) => item.definition.dialectId === "claudecode-memory-topic-v1",
        );
        if (closure === null || representation === undefined || native === undefined) {
            throw new Error("Memory Version closure is incomplete");
        }
        const validationInput = {
            canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData } as const,
            canonicalFiles: closure.files,
            representation,
            nativeFiles: native.files,
        };
        expect(nativeContract?.validateSameContent(validationInput)).toBe(true);
        const parameterizedMediaType = structuredClone(validationInput);
        const parameterizedCanonical = parameterizedMediaType.canonicalFiles[0];
        const parameterizedNative = parameterizedMediaType.representation.files[0];
        if (parameterizedCanonical !== undefined) {
            parameterizedCanonical.file.mediaType = "text/markdown; charset=utf-8";
        }
        if (parameterizedNative !== undefined) {
            parameterizedNative.mediaType = "text/markdown; charset=utf-8";
        }
        expect(nativeContract?.validateSameContent(parameterizedMediaType)).toBe(true);
        const tampered = structuredClone(validationInput);
        const canonical = tampered.canonicalFiles[0];
        if (canonical?.contentKind === "text") canonical.text = "tampered";
        expect(nativeContract?.validateSameContent(tampered)).toBe(false);

        const wrongDialect = structuredClone(validationInput);
        wrongDialect.representation.dialectId = "claudecode-memory-future-v2";
        expect(nativeContract?.validateSameContent(wrongDialect)).toBe(false);
        const wrongKind = structuredClone(validationInput);
        (wrongKind.canonical as { kind: string }).kind = "Guidance";
        expect(nativeContract?.validateSameContent(wrongKind)).toBe(false);
        const wrongSchema = structuredClone(validationInput);
        (wrongSchema.representation as { schemaVersion: number }).schemaVersion = 2;
        expect(nativeContract?.validateSameContent(wrongSchema)).toBe(false);
        const duplicateDescriptor = structuredClone(validationInput);
        duplicateDescriptor.representation.files.push(
            structuredClone(
                duplicateDescriptor.representation.files[0] as NonNullable<(typeof duplicateDescriptor.representation.files)[0]>,
            ),
        );
        expect(nativeContract?.validateSameContent(duplicateDescriptor)).toBe(false);
        const duplicatePayload = structuredClone(validationInput);
        duplicatePayload.nativeFiles.push(
            structuredClone(duplicatePayload.nativeFiles[0] as NonNullable<(typeof duplicatePayload.nativeFiles)[0]>),
        );
        expect(nativeContract?.validateSameContent(duplicatePayload)).toBe(false);
        const missingPayload = structuredClone(validationInput);
        missingPayload.nativeFiles.splice(0, 1);
        expect(nativeContract?.validateSameContent(missingPayload)).toBe(false);
        const wrongHash = structuredClone(validationInput);
        const descriptor = wrongHash.representation.files[0];
        if (descriptor !== undefined) descriptor.contentHash = `sha256:${"f".repeat(64)}`;
        expect(nativeContract?.validateSameContent(wrongHash)).toBe(false);
        const wrongMediaType = structuredClone(validationInput);
        const mediaDescriptor = wrongMediaType.representation.files[0];
        if (mediaDescriptor !== undefined) mediaDescriptor.mediaType = "application/json";
        expect(nativeContract?.validateSameContent(wrongMediaType)).toBe(false);

        const restorationCases = [
            new Uint8Array([0xff]),
            Buffer.from("[]"),
            Buffer.from("{}"),
            Buffer.from(
                JSON.stringify({
                    schemaVersion: 2,
                    dialectId: "wrong-v1",
                    topLevelType: 1,
                    metadataType: "",
                    metadataOriginSessionId: "",
                    metadataNodeType: "",
                }),
            ),
            Buffer.from(
                JSON.stringify({
                    schemaVersion: 1,
                    dialectId: "claudecode-memory-topic-v1",
                    topLevelType: "unknown",
                    metadataType: "",
                    metadataOriginSessionId: "",
                    metadataNodeType: "",
                }),
            ),
            Buffer.from(
                JSON.stringify({
                    schemaVersion: 1,
                    dialectId: "claudecode-memory-topic-v1",
                    topLevelType: "project",
                    metadataType: "reference",
                    metadataOriginSessionId: "",
                    metadataNodeType: "",
                }),
            ),
        ];
        expect(restorationCases.every((bytes) => contract?.validatePayload(bytes) === false)).toBe(true);
        expect(
            contract?.validatePayload(
                Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        dialectId: "claudecode-memory-topic-v1",
                        topLevelType: "",
                        metadataType: "project",
                        metadataOriginSessionId: "session-2",
                        metadataNodeType: "memory",
                    }),
                ),
            ),
        ).toBe(true);
        expect(
            contract?.validatePayload(
                Buffer.from(
                    JSON.stringify({
                        schemaVersion: 1,
                        dialectId: "claudecode-memory-topic-v1",
                        topLevelType: "project",
                        metadataType: "project",
                        metadataOriginSessionId: "session-3",
                        metadataNodeType: "memory",
                    }),
                ),
            ),
        ).toBe(true);
    });

    it("rejects matching-build selector tier and permission-effect drift", () => {
        const registry = dialectRegistry();
        const model = registry.getPortableSelector("Workflow", "workflow_model", "claudecode-model-selector-v1");
        const permission = registry.getPortableSelector("Subagent", "subagent_permission", "claudecode-permission-mode-v1");
        expect(
            model?.validateSelector({
                kind: "Workflow",
                field: "workflow_model",
                dialectId: "claudecode-model-selector-v1",
                value: { valueKind: "relative_tier", selector: "haiku", relativeTier: 1 },
            }),
        ).toBe(true);
        expect(
            model?.validateSelector({
                kind: "Workflow",
                field: "workflow_model",
                dialectId: "claudecode-model-selector-v1",
                value: { valueKind: "relative_tier", selector: "haiku", relativeTier: 5 },
            }),
        ).toBe(false);
        expect(
            model?.validateSelector({
                kind: "Workflow",
                field: "workflow_model",
                dialectId: "claudecode-model-selector-v1",
                value: { valueKind: "selector", selector: "haiku" },
            }),
        ).toBe(false);
        expect(
            permission?.validateSelector({
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: "claudecode-permission-mode-v1",
                value: {
                    valueKind: "permission_effect",
                    selector: "plan",
                    effect: "read_only",
                },
            }),
        ).toBe(true);
        expect(
            permission?.validateSelector({
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: "claudecode-permission-mode-v1",
                value: {
                    valueKind: "permission_effect",
                    selector: "plan",
                    effect: "bypass_permission_checks",
                },
            }),
        ).toBe(false);
    });

    it("validates every provider-owned portable selector semantic without permissive fallbacks", () => {
        expect(validatePortableSelector("workflow_tool", { valueKind: "selector", selector: "Read" })).toBe(true);
        expect(validatePortableSelector("workflow_tool", { valueKind: "selector", selector: "  " })).toBe(false);
        expect(validatePortableSelector("workflow_tool", { valueKind: "positive_limit", limit: 1 })).toBe(false);

        expect(validatePortableSelector("workflow_shell", { valueKind: "selector", selector: "bash" })).toBe(true);
        expect(validatePortableSelector("workflow_shell", { valueKind: "selector", selector: "powershell" })).toBe(true);
        expect(validatePortableSelector("workflow_shell", { valueKind: "selector", selector: "zsh" })).toBe(false);
        expect(validatePortableSelector("workflow_shell", { valueKind: "positive_limit", limit: 1 })).toBe(false);

        expect(validatePortableSelector("skill_agent", { valueKind: "selector", selector: "Explore" })).toBe(true);
        expect(validatePortableSelector("skill_agent", { valueKind: "selector", selector: "custom" })).toBe(false);
        expect(validatePortableSelector("skill_agent", { valueKind: "positive_limit", limit: 1 })).toBe(false);

        expect(
            validatePortableSelector("workflow_model", {
                valueKind: "relative_tier",
                selector: "sonnet",
                relativeTier: 5,
            }),
        ).toBe(true);
        expect(
            validatePortableSelector("workflow_model", {
                valueKind: "relative_tier",
                selector: " ",
                relativeTier: -1,
            }),
        ).toBe(false);
        expect(
            validatePortableSelector("workflow_effort", {
                valueKind: "relative_tier",
                selector: "high",
                relativeTier: 7,
            }),
        ).toBe(true);
        expect(
            validatePortableSelector("workflow_effort", {
                valueKind: "relative_tier",
                selector: "high",
                relativeTier: 1,
            }),
        ).toBe(false);

        expect(
            validatePortableSelector("subagent_permission", {
                valueKind: "permission_effect",
                selector: "plan",
                effect: "read_only",
            }),
        ).toBe(true);
        expect(
            validatePortableSelector("subagent_permission", {
                valueKind: "permission_effect",
                selector: "future",
                effect: "read_only",
            }),
        ).toBe(false);
        expect(validatePortableSelector("subagent_permission", { valueKind: "selector", selector: "plan" })).toBe(false);

        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "positive_limit", limit: 2 })).toBe(true);
        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "positive_limit", limit: 0 })).toBe(false);
        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "positive_limit", limit: 1.5 })).toBe(false);
        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "selector", selector: "2" })).toBe(false);

        expect(validatePortableSelector("subagent_color", { valueKind: "selector", selector: "blue" })).toBe(true);
        expect(validatePortableSelector("subagent_color", { valueKind: "selector", selector: " " })).toBe(false);
        expect(validatePortableSelector("subagent_color", { valueKind: "positive_limit", limit: 1 })).toBe(false);
    });

    it("requires the exact non-executable text resource for a Subagent initial prompt", () => {
        const contract = claudecodeProvider.dialectContracts.portableEntries.find(
            (candidate) => candidate.definition.field === "subagent_initial_prompt",
        );
        if (contract === undefined) throw new Error("missing Claude initial-prompt contract");
        const input = {
            use: {
                kind: "Subagent",
                field: "subagent_initial_prompt",
                dialectId: contract.definition.dialectId,
                logicalPath: "initial.md",
            },
            versionStatus: "complete",
            canonical: {
                kind: "Subagent",
                typeData: {
                    directInvocation: {
                        mode: "user_selectable",
                        initialPrompt: {
                            mode: "resource",
                            dialectId: contract.definition.dialectId,
                            logicalPath: "initial.md",
                        },
                    },
                },
            },
            canonicalFiles: [
                {
                    contentKind: "text",
                    text: "Start here.\n",
                    file: { logicalPath: "initial.md", role: "resource", executable: false },
                },
            ],
        };
        expect(contract.validateCanonicalEntry(input as never)).toBe(true);

        const empty = structuredClone(input);
        const emptyFile = empty.canonicalFiles[0];
        if (emptyFile === undefined) throw new Error("missing empty prompt fixture");
        emptyFile.text = "  ";
        expect(contract.validateCanonicalEntry(empty as never)).toBe(false);
        const executable = structuredClone(input);
        const executableFile = executable.canonicalFiles[0];
        if (executableFile === undefined) throw new Error("missing executable prompt fixture");
        executableFile.file.executable = true;
        expect(contract.validateCanonicalEntry(executable as never)).toBe(false);
        const wrongKind = structuredClone(input);
        wrongKind.canonical.kind = "Workflow";
        expect(contract.validateCanonicalEntry(wrongKind as never)).toBe(false);
        const incomplete = structuredClone(input);
        incomplete.versionStatus = "incomplete";
        incomplete.canonicalFiles = [];
        expect(contract.validateCanonicalEntry(incomplete as never)).toBe(true);
    });

    it("accepts only verified Claude runtime-native Workflow agent selectors", () => {
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_default" })).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "Explore" })).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "custom-user" })).toBe(false);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_default" }, "incomplete")).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "custom-user" }, "incomplete")).toBe(false);
    });
});

const validateWorkflowEntryAgent = bindWorkflowEntryAgentValidator(claudecodeProvider);
const validatePortableSelector = bindPortableSelectorValidator(claudecodeProvider);
const dialectRegistry = bindDialectRegistry(claudecodeProvider);

function projectRoot(): SourceRoot {
    return {
        sourceRootId: "project-root",
        rootRole: "project_actual",
        sourceDomain: "project_root",
        path: project,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "user_provided_path",
                locatorKey: "probe_project_root",
                evidenceLevel: "user_provided",
            },
        ],
        diagnostics: [],
    };
}

function memoryRoot(): SourceRoot {
    return {
        sourceRootId: "memory-root",
        rootRole: "source",
        sourceDomain: "project_keyed",
        path: memory,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "claude_project_memory_default",
                evidenceLevel: "source_code",
            },
        ],
        diagnostics: [],
    };
}
