import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdapterReadTarget, SourceRoot, UuidV4 } from "@oaam/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createAdapterReadOperation,
    DEFAULT_ADAPTER_READ_OPERATION_LIMITS,
} from "../../../core/src/adapters/adapter-read-access";
import { readVersionAuthority } from "../../../core/src/catalog/version-authority";
import {
    executeAdapterReadWithAuthority,
    executeAdapterReadWithAuthorityForTest,
} from "../../../core/src/source-import/source-read-execution";
import {
    bindAcceptFixtureCandidate,
    bindAuthoritativeFixtureRead,
    bindDialectRegistry,
    bindFixtureImportService,
    bindFixtureProbeRootTarget,
    bindFixtureReadAuthority,
    bindPortableSelectorValidator,
    bindWorkflowEntryAgentValidator,
    fixtureSourceRoot,
} from "../../../test-support";
import { opencodeProvider } from "../src/opencode-provider";
import { projectObservationsFromRuntimeList } from "../src/opencode-probe-project-projection";

let sandbox = "";
let project = "";
let config = "";
let sharedSkills = "";
let transactions = "";
let assets = "";
let oaam = "";
let locks = "";
const PROJECT_ID = "00000000-0000-4000-8000-000000000301" as UuidV4;
const target = bindFixtureProbeRootTarget({
    adapterId: "OPENCODE",
    agentRuntimeId: "OPENCODE_CLI",
    versionText: "1.17.11-fixture",
    installationEvidence: [
        {
            kind: "executable",
            path: "/fixture/opencode",
            evidenceLevel: "source_code",
            diagnostics: [],
        },
    ],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const authority = bindFixtureReadAuthority(() => transactions);
const authoritativeRead = bindAuthoritativeFixtureRead({
    provider: opencodeProvider,
    target,
    transactionsRoot: () => transactions,
});
const importService = bindFixtureImportService({
    provider: opencodeProvider,
    assetsRoot: () => assets,
    oaamRoot: () => oaam,
    authorityLocksRoot: () => locks,
    projectRootPath: () => project,
    projectId: PROJECT_ID,
});
const acceptCandidate = bindAcceptFixtureCandidate("opencode-conformance");

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-conformance-"));
    project = path.join(sandbox, "project");
    config = path.join(sandbox, "config");
    sharedSkills = path.join(sandbox, "shared-skills");
    transactions = path.join(sandbox, "transactions");
    assets = path.join(sandbox, "assets");
    oaam = path.join(sandbox, "oaam");
    locks = path.join(sandbox, "locks");
    for (const directory of [
        path.join(project, ".opencode", "commands"),
        path.join(project, ".opencode", "agents"),
        path.join(project, ".opencode", "skills", "sample", "docs"),
        config,
        sharedSkills,
        transactions,
    ])
        fs.mkdirSync(directory, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode Core-owned read conformance", () => {
    it("reads Guidance from the exact project root produced by OpenCode registry discovery", async () => {
        fs.writeFileSync(path.join(project, "AGENTS.md"), "# Registry-discovered project guidance\n");
        const roots = new Map<string, SourceRoot>();
        projectObservationsFromRuntimeList(
            [
                {
                    runtimeProjectKey: "registry-project",
                    displayName: "Registry project",
                    primaryRuntimePath: project,
                    additionalRuntimePaths: [],
                    locatorKey: "debug_scrap:registry-project",
                },
            ],
            null,
            "agent_runtime_verified",
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            roots,
        );
        const discoveredRoot = [...roots.values()][0];
        if (discoveredRoot === undefined) throw new Error("OpenCode registry projection did not produce a project root");
        expect(discoveredRoot.locatorEvidence).toEqual([
            expect.objectContaining({
                locatorKind: "project_registry_entry",
                evidenceLevel: "agent_runtime_verified",
            }),
        ]);

        const readTarget = target([discoveredRoot], ["Guidance"]);
        if (readTarget.sourceSelector.selectorKind !== "probe_roots") {
            throw new Error("OpenCode registry fixture requires a probe-root selector");
        }
        const cli = readTarget.sourceSelector.observation.observedAgentRuntimes[0];
        if (cli === undefined) throw new Error("OpenCode CLI registry observation is missing");
        readTarget.sourceSelector.observation.observedAgentRuntimes.push({
            ...structuredClone(cli),
            agentRuntimeId: "OPENCODE_APP",
            versionText: "",
            installationEvidence: [],
            installationStatus: "not_found",
        });

        const result = await executeAdapterReadWithAuthority(opencodeProvider, readTarget, authority());

        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.sourceReadObligations).toHaveLength(2);
        expect(result.value?.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                scope: "project",
                displayName: "AGENTS.md",
            }),
        ]);
    });

    it("fails at the Core handle budget without leaving an issued handle unclassified", async () => {
        const result = await executeAdapterReadWithAuthorityForTest(
            opencodeProvider,
            target([projectRoot()], ["Guidance"]),
            authority(),
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

    it("reads four native project assets while keeping config instructions and policy outside asset authority", async () => {
        writeProjectFixtures();
        fs.writeFileSync(
            path.join(project, "opencode.jsonc"),
            [
                "{",
                '  "$schema": "https://opencode.ai/config.json",',
                '  "instructions": ["docs/rules.md"],',
                '  "agent": { "secret-agent": { "prompt": "do not persist" } },',
                '  "provider": { "token": "TOP-SECRET" },',
                "}",
            ].join("\n"),
        );

        const result = await executeAdapterReadWithAuthority(
            opencodeProvider,
            target([projectRoot()], ["Guidance", "Workflow", "Skill", "Subagent"]),
            authority(),
        );
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates.map((candidate) => candidate.kind).sort()).toEqual(
            ["Guidance", "Workflow", "Skill", "Subagent"].sort(),
        );
        expect(result.value?.candidates.every((candidate) => candidate.status === "complete")).toBe(true);
        expect(result.value?.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["opencode.manifest_fragment_deferred"]),
        );
        expect(JSON.stringify(result.value?.candidates)).not.toContain("TOP-SECRET");
        expect(JSON.stringify(result.value?.candidates)).not.toContain("do not persist");
        const dispositions = result.value?.sourceParseReports[0]?.readEntryDispositions ?? [];
        expect(dispositions.length).toBeGreaterThan(0);
        expect(
            dispositions.every(
                (item) => item.disposition === "ignored" || item.disposition === "traversed" || item.candidateIds.length > 0,
            ),
        ).toBe(true);
    });

    it("imports every complete dialect and reopens the exact native graph", async () => {
        writeProjectFixtures();
        const root = projectRoot();
        const kinds: AdapterReadTarget["allowedKinds"] = ["Guidance", "Workflow", "Skill", "Subagent"];
        const readAgain = () => authoritativeRead(root, kinds);
        const read = await readAgain();
        const service = importService(readAgain);
        const expectedPaths = new Map<string, string[]>([
            ["opencode-guidance-markdown-v1", ["AGENTS.md"]],
            ["opencode-command-markdown-v1", [".opencode/commands/review.md"]],
            [
                "opencode-skill-directory-v2",
                [
                    ".opencode/skills/sample/SKILL.md",
                    ".opencode/skills/sample/docs/details.md",
                    ".opencode/skills/sample/image.bin",
                ],
            ],
            ["opencode-subagent-markdown-v1", [".opencode/agents/reviewer.md"]],
        ]);
        expect(read.candidates).toHaveLength(4);

        for (const candidate of read.candidates) {
            const accepted = await acceptCandidate(service, read, candidate.candidateId);
            expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
            const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
            const representation = closure?.manifest.nativeRepresentations[0];
            const payload = closure?.nativePayloads[0];
            const contract = opencodeProvider.dialectContracts.native.find(
                (item) => item.definition.dialectId === representation?.dialectId,
            );
            if (closure === null || representation === undefined || payload === undefined || contract === undefined) {
                throw new Error("OpenCode imported native closure is incomplete");
            }
            if (candidate.nativeRepresentation.representationSource === "canonical_files") {
                throw new Error("OpenCode native candidate did not preserve its source graph");
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
                representation.files.map((file) => file.relativePath),
            );
            expect(candidate.nativeRepresentation.files.map((file) => [...file.bytes])).toEqual(
                payload.files.map((file) => [...file.bytes]),
            );
            expect(payload.files.map((file) => file.relativePath)).toEqual(expectedPaths.get(representation.dialectId));
            const validationInput = {
                canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData },
                canonicalFiles: closure.files,
                representation,
                nativeFiles: payload.files,
            };
            expect(contract.validateSameContent(validationInput)).toBe(true);
            const wrongGraph = structuredClone(validationInput);
            const sourcePath = wrongGraph.representation.files.find((file) =>
                representation.dialectId === "opencode-skill-directory-v2"
                    ? file.relativePath.endsWith("/SKILL.md") || file.relativePath === "SKILL.md"
                    : true,
            )?.relativePath;
            const graphDescriptor = wrongGraph.representation.files.find((file) => file.relativePath === sourcePath);
            const graphPayload = wrongGraph.nativeFiles.find((file) => file.relativePath === sourcePath);
            if (graphDescriptor === undefined || graphPayload === undefined) {
                throw new Error("OpenCode native graph path fixture is incomplete");
            }
            const wrongPath = wrongNativePath(representation.dialectId);
            graphDescriptor.relativePath = wrongPath;
            graphPayload.relativePath = wrongPath;
            expect(contract.validateSameContent(wrongGraph)).toBe(false);
            if (representation.dialectId === "opencode-skill-directory-v2") {
                const reorderedReferences = structuredClone(validationInput);
                const entry = reorderedReferences.canonicalFiles.find((file) => file.file.logicalPath === "SKILL.md");
                if (entry === undefined || entry.file.references.length < 2) {
                    throw new Error("OpenCode Skill reference-order fixture is incomplete");
                }
                entry.file.references.reverse();
                expect(contract.validateSameContent(reorderedReferences)).toBe(false);
            }
            const tampered = structuredClone(validationInput);
            if (tampered.nativeFiles[0] !== undefined) {
                tampered.nativeFiles[0].bytes = Buffer.from("tampered");
            }
            expect(contract.validateSameContent(tampered)).toBe(false);
        }
    });

    it("binds OpenCode command execution-agent and body @agent references before native reopen", async () => {
        fs.writeFileSync(
            path.join(project, ".opencode", "commands", "delegate.md"),
            [
                "---",
                "description: Delegate review",
                "agent: reviewer",
                "subtask: true",
                "---",
                "Read @docs/runbook.md, then ask @reviewer.",
                "",
            ].join("\n"),
        );
        fs.mkdirSync(path.join(project, "docs"), { recursive: true });
        fs.writeFileSync(path.join(project, "docs", "runbook.md"), "# Runbook\n");
        fs.writeFileSync(
            path.join(project, ".opencode", "agents", "reviewer.md"),
            "---\ndescription: Reviewer\nmode: subagent\n---\nReview carefully.\n",
        );
        const readAgain = () => authoritativeRead(projectRoot(), ["Workflow", "Subagent"]);
        const read = await readAgain();
        const service = importService(readAgain);
        const preview = service.previewImport([read]);
        const reviewerCandidate = read.candidates.find(
            (candidate) => candidate.kind === "Subagent" && candidate.displayName === "reviewer",
        );
        const delegateCandidate = read.candidates.find(
            (candidate) => candidate.kind === "Workflow" && candidate.displayName === "delegate",
        );
        const reviewer = preview.value.items.find((item) => item.candidateId === reviewerCandidate?.candidateId);
        const delegate = preview.value.items.find((item) => item.candidateId === delegateCandidate?.candidateId);
        if (
            reviewer === undefined ||
            reviewer.action !== "create_asset" ||
            delegate === undefined ||
            delegate.action !== "create_asset"
        ) {
            throw new Error("OpenCode callable fixture did not produce importable candidates");
        }
        expect(delegate.callableBindingRequests).toEqual(
            expect.arrayContaining([
                {
                    subject: { subjectKind: "workflow_execution_agent" },
                    rawTarget: "reviewer",
                    required: true,
                },
                {
                    subject: {
                        subjectKind: "file_reference",
                        logicalPath: "WORKFLOW.md",
                        referenceIndex: 1,
                    },
                    rawTarget: "reviewer",
                    required: true,
                },
            ]),
        );
        const reviewerAccepted = await service.acceptImport({
            previewSnapshot: preview.value,
            decision: {
                candidateId: reviewer.candidateId,
                action: "create_asset",
                freshness: { freshnessAction: "require_current_source" },
                promotion: { promotionAction: "import_only", userActionId: "accept-reviewer" },
                callableBindings: [],
            },
        });
        expect(reviewerAccepted.status, JSON.stringify(reviewerAccepted.diagnostics, null, 2)).toBe("complete");
        const targetAssetVersionId = reviewerAccepted.value.versionId;
        const refreshedPreview = service.previewImport([await readAgain()]);
        const refreshedDelegate = refreshedPreview.value.items.find(
            (item) => item.candidateId === delegateCandidate?.candidateId,
        );
        if (refreshedDelegate === undefined || refreshedDelegate.action !== "create_asset") {
            throw new Error("OpenCode Workflow was not importable after refreshing its preview");
        }
        const delegateAccepted = await service.acceptImport({
            previewSnapshot: refreshedPreview.value,
            decision: {
                candidateId: refreshedDelegate.candidateId,
                action: "create_asset",
                freshness: { freshnessAction: "require_current_source" },
                promotion: { promotionAction: "import_only", userActionId: "accept-delegate" },
                callableBindings: [
                    {
                        subject: { subjectKind: "workflow_execution_agent" },
                        targetAssetVersionId,
                    },
                    {
                        subject: {
                            subjectKind: "file_reference",
                            logicalPath: "WORKFLOW.md",
                            referenceIndex: 1,
                        },
                        targetAssetVersionId,
                    },
                ],
            },
        });
        expect(delegateAccepted.status, JSON.stringify(delegateAccepted.diagnostics, null, 2)).toBe("complete");
        const closure = readVersionAuthority(
            assets,
            delegateAccepted.value.assetId,
            delegateAccepted.value.versionId,
            dialectRegistry(),
        );
        if (closure === null) throw new Error("bound OpenCode Workflow closure is missing");
        expect(closure.manifest.typeData).toMatchObject({
            implementation: {
                execution: { agent: { mode: "bound", targetAssetVersionId } },
            },
        });
        expect(closure.files[0]?.file.references).toEqual([
            {
                kind: "include",
                rawTarget: "docs/runbook.md",
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            },
            expect.objectContaining({
                kind: "execute",
                rawTarget: "reviewer",
                resolution: "resolved_asset_version",
                targetAssetVersionId,
            }),
        ]);
    });

    it("reads global config declarations and shared Skill folders with global scope", async () => {
        fs.mkdirSync(path.join(config, "commands"), { recursive: true });
        fs.mkdirSync(path.join(config, "agents"), { recursive: true });
        fs.mkdirSync(path.join(config, "skills", "global-skill"), { recursive: true });
        fs.mkdirSync(path.join(sharedSkills, "shared-skill"), { recursive: true });
        fs.writeFileSync(path.join(config, "AGENTS.md"), "# Global guidance\n");
        fs.writeFileSync(path.join(config, "commands", "global.md"), "Global command.\n");
        fs.writeFileSync(path.join(config, "agents", "global.md"), "---\ndescription: Global subagent\n---\nGlobal subagent.\n");
        fs.writeFileSync(path.join(config, "skills", "global-skill", "SKILL.md"), skill("global-skill"));
        fs.writeFileSync(path.join(sharedSkills, "shared-skill", "SKILL.md"), skill("shared-skill"));

        const configRead = await authoritativeRead(configRoot(), ["Guidance", "Workflow", "Skill", "Subagent"]);
        expect(configRead.candidates.map((candidate) => [candidate.kind, candidate.scope])).toEqual([
            ["Guidance", "global"],
            ["Skill", "global"],
            ["Subagent", "global"],
            ["Workflow", "global"],
        ]);
        const sharedRead = await authoritativeRead(sharedSkillRoot(), ["Skill"]);
        expect(sharedRead.candidates).toEqual([
            expect.objectContaining({
                kind: "Skill",
                scope: "global",
                displayName: "shared-skill",
            }),
        ]);
    });

    it("keeps both exact Skill interpretations when CLI and App read the same physical root", async () => {
        fs.mkdirSync(path.join(sharedSkills, "shared-skill"), { recursive: true });
        fs.writeFileSync(path.join(sharedSkills, "shared-skill", "SKILL.md"), skill("shared-skill"));
        const readTarget = target([sharedSkillRoot()], ["Skill"]);
        if (readTarget.sourceSelector.selectorKind !== "probe_roots") {
            throw new Error("OpenCode shared-root fixture requires a probe-root selector");
        }
        const cli = readTarget.sourceSelector.observation.observedAgentRuntimes[0];
        if (cli === undefined) throw new Error("OpenCode CLI observation fixture is missing");
        readTarget.sourceSelector.observation.observedAgentRuntimes.push({
            ...structuredClone(cli),
            agentRuntimeId: "OPENCODE_APP",
            versionText: "1.18.15-app-fixture",
        });

        const result = await executeAdapterReadWithAuthority(opencodeProvider, readTarget, authority());

        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.sourceReadObligations).toHaveLength(2);
        const candidates = result.value?.candidates ?? [];
        expect(candidates).toHaveLength(2);
        expect(new Set(candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
        expect(candidates.map((candidate) => candidate.nativeRepresentation.dialectId).sort()).toEqual([
            "opencode-skill-directory-v1",
            "opencode-skill-directory-v2",
        ]);
        const ownedObligations = new Set<string>();
        for (const candidate of candidates) {
            expect(candidate).toMatchObject({ kind: "Skill", scope: "global", displayName: "shared-skill" });
            const ids = new Set(
                result.value?.sourceParseReports.flatMap((report) =>
                    report.readEntryDispositions.flatMap((disposition) =>
                        disposition.disposition !== "ignored" && disposition.candidateIds.includes(candidate.candidateId)
                            ? [disposition.sourceReadObligationId]
                            : [],
                    ),
                ),
            );
            expect(ids.size).toBe(1);
            for (const id of ids) {
                ownedObligations.add(id);
                const obligation = result.value?.sourceReadObligations.find((item) => item.sourceReadObligationId === id);
                const capability = opencodeProvider.assetSourceCapabilities.find(
                    (item) => item.sourceCapabilityFingerprint === obligation?.sourceCapabilityFingerprint,
                );
                expect(capability?.agentRuntimeId).toBe(
                    candidate.nativeRepresentation.dialectId === "opencode-skill-directory-v2" ? "OPENCODE_CLI" : "OPENCODE_APP",
                );
            }
            expect(candidate.sourceFileOrigins.every((origin) => origin.observedReadEntryIds.length === 1)).toBe(true);
        }
        expect(ownedObligations.size).toBe(2);
    });

    it("obeys probe-recorded project source feature gates", async () => {
        writeProjectFixtures();
        fs.mkdirSync(path.join(project, ".agents", "skills", "agent-skill"), { recursive: true });
        fs.mkdirSync(path.join(project, ".claude", "skills", "claude-skill"), { recursive: true });
        fs.writeFileSync(path.join(project, ".agents", "skills", "agent-skill", "SKILL.md"), skill("agent-skill"));
        fs.writeFileSync(path.join(project, ".claude", "skills", "claude-skill", "SKILL.md"), skill("claude-skill"));

        const restricted = sourceRoot(
            "restricted-project",
            project,
            "project_actual",
            "project_root",
            "user_provided_path",
            "probe_project_root:project_config_off:external_skills_on:claude_prompt_on:claude_skills_off",
        );
        const read = await authoritativeRead(restricted, ["Guidance", "Workflow", "Skill", "Subagent"]);
        expect(read.candidates).toEqual([expect.objectContaining({ kind: "Skill", displayName: "agent-skill" })]);
    });

    it("imports and reopens the Claude-compatible project Guidance fallback", async () => {
        fs.writeFileSync(path.join(project, "CLAUDE.md"), "# OpenCode fallback guidance\n");
        fs.writeFileSync(path.join(project, "CONTEXT.md"), "# Shadowed deprecated guidance\n");
        const readAgain = () => authoritativeRead(projectRoot(), ["Guidance"]);
        const read = await readAgain();
        expect(read.candidates).toEqual([
            expect.objectContaining({
                displayName: "CLAUDE.md",
                nativeRepresentation: expect.objectContaining({
                    dialectId: "opencode-guidance-markdown-v1",
                    files: [expect.objectContaining({ relativePath: "CLAUDE.md" })],
                }),
            }),
        ]);
        const accepted = await acceptCandidate(importService(readAgain), read, read.candidates[0]?.candidateId ?? "missing");
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
        const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
        expect(closure?.nativePayloads[0]?.files).toEqual([expect.objectContaining({ relativePath: "CLAUDE.md" })]);
    });

    it("fails closed for missing, duplicate, and future dialect payloads", async () => {
        fs.writeFileSync(path.join(project, "AGENTS.md"), "# Guidance\n");
        const read = await authoritativeRead(projectRoot(), ["Guidance"]);
        const candidate = read.candidates[0];
        if (candidate === undefined) throw new Error("Guidance candidate missing");
        const accepted = await acceptCandidate(
            importService(() => authoritativeRead(projectRoot(), ["Guidance"])),
            read,
            candidate.candidateId,
        );
        const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
        const representation = closure?.manifest.nativeRepresentations[0];
        const payload = closure?.nativePayloads[0];
        const contract = opencodeProvider.dialectContracts.native[0];
        if (closure === null || representation === undefined || payload === undefined || contract === undefined) {
            throw new Error("Guidance native closure missing");
        }
        const input = {
            canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData },
            canonicalFiles: closure.files,
            representation,
            nativeFiles: payload.files,
        };
        for (const unsafePath of [
            "",
            "/AGENTS.md",
            "nested\\AGENTS.md",
            "AGENTS.md\0",
            "nested//AGENTS.md",
            "nested/./AGENTS.md",
            "nested/../AGENTS.md",
        ]) {
            const unsafeGraph = structuredClone(input);
            const unsafeDescriptor = unsafeGraph.representation.files[0];
            const unsafePayload = unsafeGraph.nativeFiles[0];
            if (unsafeDescriptor === undefined || unsafePayload === undefined) {
                throw new Error("Guidance native path fixture missing");
            }
            unsafeDescriptor.relativePath = unsafePath;
            unsafePayload.relativePath = unsafePath;
            expect(contract.validateSameContent(unsafeGraph)).toBe(false);
        }
        const missing = structuredClone(input);
        missing.nativeFiles = [];
        expect(contract.validateSameContent(missing)).toBe(false);
        const duplicate = structuredClone(input);
        duplicate.representation.files.push(structuredClone(duplicate.representation.files[0] as never));
        expect(contract.validateSameContent(duplicate)).toBe(false);
        const future = structuredClone(input);
        future.representation.dialectId = "opencode-guidance-markdown-v2";
        expect(contract.validateSameContent(future)).toBe(false);

        const wrongKind = structuredClone(input);
        Object.assign(wrongKind.canonical, { kind: "Skill" });
        expect(contract.validateSameContent(wrongKind)).toBe(false);
        const wrongSchema = structuredClone(input);
        Object.assign(wrongSchema.representation, { schemaVersion: 2 });
        expect(contract.validateSameContent(wrongSchema)).toBe(false);
        const duplicatePayload = structuredClone(input);
        duplicatePayload.nativeFiles.push(structuredClone(duplicatePayload.nativeFiles[0] as never));
        expect(contract.validateSameContent(duplicatePayload)).toBe(false);
        const wrongSize = structuredClone(input);
        const wrongSizeDescriptor = wrongSize.representation.files[0];
        if (wrongSizeDescriptor === undefined) throw new Error("Guidance descriptor missing");
        wrongSizeDescriptor.byteSize += 1;
        expect(contract.validateSameContent(wrongSize)).toBe(false);
        const wrongHash = structuredClone(input);
        const wrongHashDescriptor = wrongHash.representation.files[0];
        if (wrongHashDescriptor === undefined) throw new Error("Guidance descriptor missing");
        wrongHashDescriptor.contentHash = `sha256:${"0".repeat(64)}`;
        expect(contract.validateSameContent(wrongHash)).toBe(false);
        const missingPath = structuredClone(input);
        const missingPathDescriptor = missingPath.representation.files[0];
        if (missingPathDescriptor === undefined) throw new Error("Guidance descriptor missing");
        missingPathDescriptor.relativePath = "missing.md";
        expect(contract.validateSameContent(missingPath)).toBe(false);
        const canonicalMismatch = structuredClone(input);
        canonicalMismatch.canonicalFiles = [];
        expect(contract.validateSameContent(canonicalMismatch)).toBe(false);
        const executableMismatch = structuredClone(input);
        const executableDescriptor = executableMismatch.representation.files[0];
        if (executableDescriptor === undefined) throw new Error("Guidance descriptor missing");
        executableDescriptor.executable = !executableDescriptor.executable;
        // Executable mode belongs to the fingerprint-protected native descriptor. The
        // same-content validator must preserve it, not invent a Markdown-wide policy.
        expect(contract.validateSameContent(executableMismatch)).toBe(true);

        const normalized = structuredClone(input);
        const normalizedDescriptor = normalized.representation.files[0];
        const normalizedCanonical = normalized.canonicalFiles[0];
        if (normalizedDescriptor === undefined || normalizedCanonical?.contentKind !== "text") {
            throw new Error("Guidance text authority missing");
        }
        normalizedDescriptor.mediaType = "TEXT/MARKDOWN; charset=utf-8";
        normalizedCanonical.file.mediaType = "TEXT/MARKDOWN; charset=utf-8";
        normalizedCanonical.text = normalizedCanonical.text.replaceAll("\n", "\r\n");
        expect(contract.validateSameContent(normalized)).toBe(true);
    });

    it("validates every OpenCode portable selector without accepting unknown semantics", () => {
        expect(validatePortableSelector("subagent_tool", { valueKind: "selector", selector: "read" })).toBe(true);
        expect(validatePortableSelector("subagent_tool", { valueKind: "selector", selector: " " })).toBe(false);
        expect(validatePortableSelector("subagent_tool", { valueKind: "positive_limit", limit: 1 })).toBe(false);

        expect(
            validatePortableSelector("workflow_model", {
                valueKind: "relative_tier",
                selector: "openai/gpt",
                relativeTier: -1,
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
                relativeTier: 1,
            }),
        ).toBe(false);
        expect(validatePortableSelector("subagent_model", { valueKind: "selector", selector: "model" })).toBe(false);

        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "positive_limit", limit: 3 })).toBe(true);
        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "positive_limit", limit: 0 })).toBe(false);
        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "positive_limit", limit: 1.5 })).toBe(false);
        expect(validatePortableSelector("subagent_turn_limit", { valueKind: "selector", selector: "3" })).toBe(false);

        expect(validatePortableSelector("subagent_color", { valueKind: "selector", selector: "info" })).toBe(true);
        expect(validatePortableSelector("subagent_color", { valueKind: "selector", selector: "#a0B1c2" })).toBe(true);
        expect(validatePortableSelector("subagent_color", { valueKind: "selector", selector: "unknown" })).toBe(false);
        expect(validatePortableSelector("subagent_color", { valueKind: "positive_limit", limit: 1 })).toBe(false);

        const color = opencodeProvider.dialectContracts.portableSelectors.find(
            (candidate) => candidate.definition.field === "subagent_color",
        );
        if (color === undefined) throw new Error("missing OpenCode color selector");
        expect(
            color.validateSelector({
                kind: "Skill",
                field: "subagent_color",
                dialectId: color.definition.dialectId,
                value: { valueKind: "selector", selector: "info" },
            } as never),
        ).toBe(false);
    });

    it("accepts only built-in OpenCode Workflow agent selectors", () => {
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_default" })).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "build" })).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "custom-user" })).toBe(false);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_default" }, "incomplete")).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "custom-user" }, "incomplete")).toBe(false);
    });
});

const validateWorkflowEntryAgent = bindWorkflowEntryAgentValidator(opencodeProvider);
const validatePortableSelector = bindPortableSelectorValidator(opencodeProvider);

function wrongNativePath(dialectId: string): string {
    switch (dialectId) {
        case "opencode-guidance-markdown-v1":
            return "wrong.md";
        case "opencode-command-markdown-v1":
            return ".opencode/agents/wrong.md";
        case "opencode-instructions-config-graph-v1":
            return "wrong.md";
        case "opencode-skill-directory-v2":
            return ".opencode/skills/sample/README.md";
        case "opencode-subagent-markdown-v1":
            return ".opencode/commands/wrong.md";
        default:
            throw new Error(`unexpected OpenCode dialect ${dialectId}`);
    }
}

function writeProjectFixtures(): void {
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# Project guidance\n");
    fs.mkdirSync(path.join(project, "docs"), { recursive: true });
    fs.writeFileSync(path.join(project, "docs", "rules.md"), "# Project instructions Rule\n");
    fs.writeFileSync(
        path.join(project, "opencode.jsonc"),
        '{\n  "$schema": "https://opencode.ai/config.json",\n  "instructions": ["docs/rules.md"],\n  "theme": "warm"\n}\n',
    );
    fs.writeFileSync(
        path.join(project, ".opencode", "commands", "review.md"),
        "---\ndescription: Review changes\nagent: general\nsubtask: true\n---\nReview $ARGUMENTS.\n",
    );
    fs.writeFileSync(
        path.join(project, ".opencode", "agents", "reviewer.md"),
        "---\ndescription: Reviewer\nmode: subagent\ntools:\n  read: true\n  shell: false\n---\nReview carefully.\n",
    );
    fs.writeFileSync(
        path.join(project, ".opencode", "skills", "sample", "SKILL.md"),
        "---\nname: sample\ndescription: Sample skill\n---\nUse [details](docs/details.md) and [image](image.bin).\n",
    );
    fs.writeFileSync(path.join(project, ".opencode", "skills", "sample", "docs", "details.md"), "# Details\n");
    fs.writeFileSync(path.join(project, ".opencode", "skills", "sample", "image.bin"), new Uint8Array([0, 255, 1]));
}

function skill(name: string): string {
    return `---\nname: ${name}\ndescription: ${name} description\n---\nUse ${name}.\n`;
}

function projectRoot(): SourceRoot {
    return sourceRoot(
        "project-root",
        project,
        "project_actual",
        "project_root",
        "user_provided_path",
        "probe_project_root:project_config_on:external_skills_on:claude_prompt_on:claude_skills_on",
    );
}

function configRoot(): SourceRoot {
    return sourceRoot(
        "config-root",
        config,
        "config",
        "agent_runtime_private",
        "runtime_known_rule",
        "opencode_global_config:opencode_config_default",
    );
}

function sharedSkillRoot(): SourceRoot {
    return sourceRoot(
        "shared-skill-root",
        sharedSkills,
        "source",
        "family_shared",
        "runtime_known_rule",
        "opencode_agents_shared_skills",
    );
}

function sourceRoot(
    sourceRootId: string,
    rootPath: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"],
    locatorKey: string,
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path: rootPath,
        rootRole,
        sourceDomain,
        locatorKind,
        locatorKey,
        evidenceLevel: "source_code",
    });
}

const dialectRegistry = bindDialectRegistry(opencodeProvider);
