import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdapterProbeContext, AdapterProbeResult, AdapterReadResult, SourceRoot, UuidV4 } from "@oaam/core";
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
import { antigravityProvider } from "../src/antigravity-provider";
import { getPathRule } from "../src/antigravity-paths";
import { discoverAntigravityProjects, materializeAntigravityProjects } from "../src/antigravity-probe-projects";

let sandbox = "";
let project = "";
let family = "";
let privateSkills = "";
let transactions = "";
let assets = "";
let oaam = "";
let locks = "";
const PROJECT_ID = "00000000-0000-4000-8000-000000000201" as UuidV4;
const target = bindFixtureProbeRootTarget({
    adapterId: "ANTIGRAVITY",
    agentRuntimeId: "ANTIGRAVITY_CLI",
    versionText: "fixture",
    installationEvidence: [
        {
            kind: "executable",
            path: "/fixture/agy",
            evidenceLevel: "local_artifact",
            diagnostics: [],
        },
    ],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const authority = bindFixtureReadAuthority(() => transactions);
const authoritativeRead = bindAuthoritativeFixtureRead({
    provider: antigravityProvider,
    target,
    transactionsRoot: () => transactions,
});
const importService = bindFixtureImportService({
    provider: antigravityProvider,
    assetsRoot: () => assets,
    oaamRoot: () => oaam,
    authorityLocksRoot: () => locks,
    projectRootPath: () => project,
    projectId: PROJECT_ID,
});
const acceptCandidate = bindAcceptFixtureCandidate("antigravity-conformance");

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-conformance-"));
    project = path.join(sandbox, "project");
    family = path.join(sandbox, ".gemini");
    privateSkills = path.join(family, "antigravity-cli", "skills");
    transactions = path.join(sandbox, "transactions");
    assets = path.join(sandbox, "assets");
    oaam = path.join(sandbox, "oaam");
    locks = path.join(sandbox, "locks");
    for (const directory of [
        path.join(project, ".agents", "rules"),
        path.join(project, ".agents", "workflows"),
        path.join(project, ".agents", "skills", "sample", "docs"),
        path.join(project, ".agents", "agents", "reviewer"),
        path.join(family, "config", "global_workflows"),
        path.join(family, "config", "skills", "global-skill"),
        path.join(family, "config", "agents", "global-agent"),
        path.join(family, "skills", "shared-skill"),
        privateSkills,
        transactions,
    ])
        fs.mkdirSync(directory, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Antigravity Core-owned read conformance", () => {
    it.each([
        "ANTIGRAVITY_APP",
        "ANTIGRAVITY_CLI",
        "ANTIGRAVITY_IDE",
    ] as const)("reads a complete Skill and Workflow from the production explicit-Project projection for %s", async (agentRuntimeId) => {
        writeProjectFixtures();
        fs.writeFileSync(path.join(project, ".agents/skills/sample/docs/checklist.md"), "Keep every resource.\n");
        const root = await explicitProjectRoot();
        const exactTarget = bindFixtureProbeRootTarget({
            adapterId: "ANTIGRAVITY",
            agentRuntimeId,
            versionText: "fixture",
            installationEvidence: [
                { kind: "executable", path: "/fixture/agy", evidenceLevel: "local_artifact", diagnostics: [] },
            ],
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
        });
        const result = await executeAdapterReadWithAuthority(
            antigravityProvider,
            exactTarget([root], ["Skill", "Workflow"]),
            authority(),
        );
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(result.value?.candidates.map((candidate) => candidate.kind).sort()).toEqual(["Skill", "Workflow"]);
        const skill = result.value?.candidates.find((candidate) => candidate.kind === "Skill");
        expect(skill?.status).toBe("complete");
        expect(result.value?.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([expect.objectContaining({ disposition: "parsed", candidateIds: [skill?.candidateId] })]),
        );
    });

    it("keeps unsupported Memory and non-Project private roots outside explicit-Project read authority", async () => {
        const root = await explicitProjectRoot();
        for (const readTarget of [
            target([root], ["Memory"]),
            target([{ ...root, sourceDomain: "agent_runtime_private" }], ["Skill"]),
        ]) {
            const result = await executeAdapterReadWithAuthority(antigravityProvider, readTarget, authority());
            expect(result.status).toBe("failed");
            expect(result.diagnostics).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "read.source_capability_unavailable" })]),
            );
        }
    });

    it("fails at the Core handle budget without leaving an issued handle unclassified", async () => {
        const result = await executeAdapterReadWithAuthorityForTest(
            antigravityProvider,
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

    it("publishes all five declaration kinds without scanning private brain", async () => {
        writeProjectFixtures();
        fs.mkdirSync(path.join(family, "antigravity", "brain", "session", ".agents", "agents", "leak"), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(family, "antigravity", "brain", "session", ".agents", "agents", "leak", "agent.json"),
            agentJson("leak", "must not be collected"),
        );
        const result = await executeAdapterReadWithAuthority(
            antigravityProvider,
            target([projectRoot()], ["Guidance", "Rule", "Workflow", "Skill", "Subagent"]),
            authority(),
        );
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates.map((candidate) => candidate.kind).sort()).toEqual(
            ["Guidance", "Rule", "Workflow", "Skill", "Subagent"].sort(),
        );
        expect(result.value?.candidates.some((candidate) => candidate.displayName === "leak")).toBe(false);
        expect(result.diagnostics).toEqual([]);
        const dispositions = result.value?.sourceParseReports[0]?.readEntryDispositions ?? [];
        expect(dispositions.length).toBeGreaterThan(0);
        expect(
            dispositions.every(
                (item) => item.disposition === "ignored" || item.disposition === "traversed" || item.candidateIds.length > 0,
            ),
        ).toBe(true);
    });

    it("reads family Guidance, Workflow, Skill, and Subagent from one canonical family root", async () => {
        fs.writeFileSync(path.join(family, "GEMINI.md"), "# Global guidance\n");
        fs.writeFileSync(
            path.join(family, "config", "global_workflows", "review.md"),
            "---\ndescription: Review globally\n---\nReview.\n",
        );
        fs.writeFileSync(
            path.join(family, "config", "skills", "global-skill", "SKILL.md"),
            skillMarkdown("global-skill", "Global skill"),
        );
        fs.writeFileSync(path.join(family, "skills", "shared-skill", "SKILL.md"), skillMarkdown("shared-skill", "Shared skill"));
        fs.writeFileSync(
            path.join(family, "config", "agents", "global-agent", "agent.json"),
            agentJson("global-agent", "Global agent"),
        );
        const result = await executeAdapterReadWithAuthority(
            antigravityProvider,
            target([familyRoot()], ["Guidance", "Workflow", "Skill", "Subagent"]),
            authority(),
        );
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates.map((candidate) => `${candidate.kind}:${candidate.displayName}`).sort()).toEqual([
            "Guidance:GEMINI.md",
            "Skill:global-skill",
            "Skill:shared-skill",
            "Subagent:global-agent",
            "Workflow:review",
        ]);
        expect(result.value?.candidates.every((candidate) => candidate.scope === "global")).toBe(true);
    });

    it("keeps sibling CLI and IDE source observations distinct until Core reconciles one physical asset", async () => {
        fs.writeFileSync(path.join(project, "AGENTS.md"), "# Shared project guidance\n");
        const readTarget = target([projectRoot()], ["Guidance"]);
        if (readTarget.sourceSelector.selectorKind !== "probe_roots") {
            throw new Error("Antigravity reconciliation fixture requires probe roots");
        }
        const cli = readTarget.sourceSelector.observation.observedAgentRuntimes[0];
        if (cli === undefined) throw new Error("Antigravity CLI observation is missing");
        readTarget.sourceSelector.observation.observedAgentRuntimes.push({
            ...structuredClone(cli),
            agentRuntimeId: "ANTIGRAVITY_IDE",
            installationEvidence: [
                {
                    kind: "executable",
                    path: "/fixture/antigravity-ide",
                    evidenceLevel: "local_artifact",
                    diagnostics: [],
                },
            ],
        });

        const result = await executeAdapterReadWithAuthority(antigravityProvider, readTarget, authority());
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        const read = result.value;
        if (read === undefined) throw new Error("Antigravity reconciliation read is missing");
        expect(read.candidates).toHaveLength(2);
        expect(new Set(read.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);

        const runtimeByCapability = new Map(
            antigravityProvider.assetSourceCapabilities.map((capability) => [
                capability.sourceCapabilityFingerprint,
                capability.agentRuntimeId,
            ]),
        );
        const sourceRuntimeIds = read.candidates
            .flatMap((candidate) => {
                const obligationIds = new Set(
                    read.sourceParseReports.flatMap((report) =>
                        report.readEntryDispositions.flatMap((disposition) =>
                            disposition.disposition !== "ignored" && disposition.candidateIds.includes(candidate.candidateId)
                                ? [disposition.sourceReadObligationId]
                                : [],
                        ),
                    ),
                );
                return read.sourceReadObligations
                    .filter((obligation) => obligationIds.has(obligation.sourceReadObligationId))
                    .map((obligation) => runtimeByCapability.get(obligation.sourceCapabilityFingerprint))
                    .filter((agentRuntimeId) => agentRuntimeId !== undefined);
            })
            .sort();
        expect(sourceRuntimeIds).toEqual(["ANTIGRAVITY_CLI", "ANTIGRAVITY_IDE"]);

        const preview = importService(async () => structuredClone(read)).previewImport([read]);
        expect(preview.status, JSON.stringify(preview.diagnostics, null, 2)).toBe("complete");
        expect(preview.value.items).toHaveLength(1);
        expect(preview.value.items[0]).toEqual(expect.objectContaining({ action: "create_asset" }));
    });

    it("reads runtime-private CLI skills without treating the whole data root as an asset source", async () => {
        fs.mkdirSync(path.join(privateSkills, "private-skill"), { recursive: true });
        fs.writeFileSync(path.join(privateSkills, "private-skill", "SKILL.md"), skillMarkdown("private-skill", "Private skill"));
        const result = await executeAdapterReadWithAuthority(
            antigravityProvider,
            target([privateSkillRoot()], ["Skill"]),
            authority(),
        );
        expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
        expect(result.value?.candidates).toEqual([
            expect.objectContaining({ kind: "Skill", displayName: "private-skill", scope: "global" }),
        ]);
    });

    it("preserves folder resources and keeps flat skills as separate identities", async () => {
        fs.writeFileSync(
            path.join(project, ".agents", "skills", "sample", "SKILL.md"),
            "---\nname: sample\ndescription: Sample\nlicense: MIT\ncompatibility: linux\nmetadata:\n  owner: oaam\n---\nRead [details](docs/details.md).\n",
        );
        fs.writeFileSync(path.join(project, ".agents", "skills", "sample", "docs", "details.md"), "# Details\n");
        fs.writeFileSync(path.join(project, ".agents", "skills", "sample", "image.bin"), new Uint8Array([0, 255, 1]));
        fs.writeFileSync(path.join(project, ".agents", "skills", "sample.md"), skillMarkdown("sample", "Flat variant"));
        const read = await authoritativeRead(projectRoot(), ["Skill"]);
        expect(read.candidates).toHaveLength(2);
        const folder = read.candidates.find(
            (candidate) => candidate.nativeRepresentation.dialectId === "antigravity-skill-folder-v1",
        );
        expect(folder?.files.map((file) => [file.logicalPath, file.contentKind])).toEqual([
            ["SKILL.md", "text"],
            ["docs/details.md", "text"],
            ["image.bin", "binary"],
        ]);
        expect(folder?.files[0]?.references).toEqual([
            expect.objectContaining({ resolution: "resolved_version_file", targetLogicalPath: "docs/details.md" }),
        ]);
        expect(folder?.typeData).toMatchObject({
            portableMetadata: { license: "MIT", compatibility: "linux", metadata: { owner: "oaam" } },
        });
    });

    it("skips invalid skills visibly and keeps uncertain Rule/Workflow/Subagent candidates incomplete", async () => {
        fs.writeFileSync(path.join(project, ".agents", "rules", "plain.md"), "Plain rule\n");
        fs.writeFileSync(path.join(project, ".agents", "workflows", "plain.md"), "# No description\n");
        fs.mkdirSync(path.join(project, ".agents", "skills", "invalid"), { recursive: true });
        fs.writeFileSync(
            path.join(project, ".agents", "skills", "invalid", "SKILL.md"),
            "---\ndescription: Missing name\n---\nBody\n",
        );
        fs.writeFileSync(
            path.join(project, ".agents", "agents", "reviewer", "agent.json"),
            JSON.stringify({
                ...JSON.parse(agentJson("reviewer", "Reviewer")),
                futurePermissionMode: "unsafe",
            }),
        );
        const read = await authoritativeRead(projectRoot(), ["Rule", "Workflow", "Skill", "Subagent"]);
        expect(read.candidates.some((candidate) => candidate.kind === "Skill")).toBe(false);
        const uncertain = read.candidates.filter((candidate) => candidate.kind !== "Skill");
        expect(uncertain.map((candidate) => candidate.kind).sort()).toEqual(["Rule", "Subagent", "Workflow"].sort());
        expect(
            uncertain.every((candidate) => candidate.status === "incomplete" && candidate.assetCandidateStatus === "incomplete"),
        ).toBe(true);
        expect(read.sourceParseReports[0]?.status).toBe("parsed");
        expect(read.diagnostics.map((item) => item.code)).toContain("antigravity.skill_required_content_missing");
    });

    it("keeps same-name Subagent permission variants separate", async () => {
        fs.mkdirSync(path.join(project, ".agents", "agents", "one"), { recursive: true });
        fs.mkdirSync(path.join(project, ".agents", "agents", "two"), { recursive: true });
        fs.writeFileSync(
            path.join(project, ".agents", "agents", "one", "agent.json"),
            agentJson("reviewer", "One", ["view_file"]),
        );
        fs.writeFileSync(
            path.join(project, ".agents", "agents", "two", "agent.json"),
            agentJson("reviewer", "Two", ["view_file", "run_command"]),
        );
        const read = await authoritativeRead(projectRoot(), ["Subagent"]);
        expect(read.candidates).toHaveLength(2);
        expect(new Set(read.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
        expect(read.candidates.map((candidate) => candidate.typeData).filter((data) => "tools" in data)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    tools: {
                        availability: { base: { mode: "allowlist", allowed: [expect.anything()] }, unavailable: [] },
                        permission: expect.anything(),
                    },
                }),
                expect.objectContaining({
                    tools: {
                        availability: {
                            base: { mode: "allowlist", allowed: [expect.anything(), expect.anything()] },
                            unavailable: [],
                        },
                        permission: expect.anything(),
                    },
                }),
            ]),
        );
    });

    it("imports every complete native dialect and reopens the exact bytes", async () => {
        writeProjectFixtures();
        fs.writeFileSync(path.join(project, ".agents", "skills", "flat.md"), skillMarkdown("flat", "Flat"));
        const kinds: AdapterReadTarget["allowedKinds"] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent"];
        const readAgain = () => authoritativeRead(projectRoot(), kinds);
        const read = await readAgain();
        const complete = read.candidates.filter((candidate) => candidate.status === "complete");
        expect(complete).toHaveLength(6);
        const service = importService(readAgain);
        for (const candidate of complete) {
            const accepted = await acceptCandidate(service, read, candidate.candidateId);
            expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
            const closure = readVersionAuthority(assets, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
            expect(closure).not.toBeNull();
            const representation = closure?.manifest.nativeRepresentations[0];
            const payload = closure?.nativePayloads[0];
            const contract = antigravityProvider.dialectContracts.native.find(
                (item) => item.definition.dialectId === representation?.dialectId,
            );
            if (closure === null || representation === undefined || payload === undefined || contract === undefined) {
                throw new Error("Antigravity native closure is incomplete");
            }
            if (candidate.nativeRepresentation.representationSource === "canonical_files") {
                throw new Error("Antigravity native candidate did not preserve its source graph");
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
            const validationInput = {
                canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData } as const,
                canonicalFiles: closure.files,
                representation,
                nativeFiles: payload.files,
            };
            expect(contract.validateSameContent(validationInput)).toBe(true);
            expect(
                contract.validateSameContent({
                    ...validationInput,
                    canonical: { kind: "Memory", typeData: validationInput.canonical.typeData },
                } as never),
            ).toBe(false);
            expect(
                contract.validateSameContent({
                    ...validationInput,
                    canonical: { ...validationInput.canonical, typeData: { schemaVersion: 99 } },
                } as never),
            ).toBe(false);
            expect(
                contract.validateSameContent({
                    ...validationInput,
                    representation: { ...validationInput.representation, schemaVersion: 99 },
                } as never),
            ).toBe(false);
            expect(
                contract.validateSameContent({
                    ...validationInput,
                    nativeFiles: [...validationInput.nativeFiles, structuredClone(validationInput.nativeFiles[0] as never)],
                } as never),
            ).toBe(false);
            const wrongSize = structuredClone(validationInput);
            if (wrongSize.representation.files[0] !== undefined) wrongSize.representation.files[0].byteSize += 1;
            expect(contract.validateSameContent(wrongSize)).toBe(false);
            const wrongHash = structuredClone(validationInput);
            if (wrongHash.representation.files[0] !== undefined) {
                wrongHash.representation.files[0].contentHash = `sha256:${"0".repeat(64)}`;
            }
            expect(contract.validateSameContent(wrongHash)).toBe(false);
            const wrongContentKind = structuredClone(validationInput);
            if (wrongContentKind.representation.files[0] !== undefined) {
                wrongContentKind.representation.files[0].contentKind =
                    wrongContentKind.representation.files[0].contentKind === "text" ? "binary" : "text";
            }
            expect(contract.validateSameContent(wrongContentKind)).toBe(false);
            const tampered = structuredClone(validationInput);
            if (tampered.canonicalFiles[0]?.contentKind === "text") tampered.canonicalFiles[0].text += "tampered";
            expect(contract.validateSameContent(tampered)).toBe(false);
        }
    });

    it("reopens family config and runtime-private Skill dialects from their exact native layouts", async () => {
        fs.writeFileSync(path.join(family, "GEMINI.md"), "# Global guidance\n");
        fs.writeFileSync(
            path.join(family, "config", "global_workflows", "review.md"),
            "---\ndescription: Review globally\n---\nReview.\n",
        );
        fs.writeFileSync(
            path.join(family, "config", "skills", "global-skill", "SKILL.md"),
            skillMarkdown("global-skill", "Global skill"),
        );
        fs.writeFileSync(path.join(family, "skills", "shared-skill", "SKILL.md"), skillMarkdown("shared-skill", "Shared skill"));
        fs.writeFileSync(
            path.join(family, "config", "agents", "global-agent", "agent.json"),
            agentJson("global-agent", "Global agent"),
        );
        await importAndValidate(
            () => authoritativeRead(familyRoot(), ["Guidance", "Workflow", "Skill", "Subagent"]),
            path.join(sandbox, "family-assets"),
            5,
        );

        fs.mkdirSync(path.join(privateSkills, "private-skill"), { recursive: true });
        fs.writeFileSync(path.join(privateSkills, "private-skill", "SKILL.md"), skillMarkdown("private-skill", "Private skill"));
        await importAndValidate(() => authoritativeRead(privateSkillRoot(), ["Skill"]), path.join(sandbox, "private-assets"), 1);
    });

    it("fails closed for a missing, duplicated, or future native dialect payload", async () => {
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
        const contract = antigravityProvider.dialectContracts.native[0];
        if (closure === null || representation === undefined || payload === undefined || contract === undefined) {
            throw new Error("Guidance native closure missing");
        }
        const input = {
            canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData } as const,
            canonicalFiles: closure.files,
            representation,
            nativeFiles: payload.files,
        };
        const missing = structuredClone(input);
        missing.nativeFiles = [];
        expect(contract.validateSameContent(missing)).toBe(false);
        const duplicate = structuredClone(input);
        duplicate.representation.files.push(structuredClone(duplicate.representation.files[0] as never));
        expect(contract.validateSameContent(duplicate)).toBe(false);
        const future = structuredClone(input);
        future.representation.dialectId = "antigravity-guidance-markdown-v2";
        expect(contract.validateSameContent(future)).toBe(false);
    });

    it("validates Antigravity context and tool selectors without default success", () => {
        expect(
            validatePortableSelector("subagent_context", {
                valueKind: "selector_set",
                selectors: ["user_rules", "skills"],
            }),
        ).toBe(true);
        expect(
            validatePortableSelector("subagent_context", {
                valueKind: "selector_set",
                selectors: [],
            }),
        ).toBe(false);
        expect(
            validatePortableSelector("subagent_context", {
                valueKind: "selector_set",
                selectors: ["skills", "skills"],
            }),
        ).toBe(false);
        expect(
            validatePortableSelector("subagent_context", {
                valueKind: "selector_set",
                selectors: ["skills", " "],
            }),
        ).toBe(false);
        expect(
            validatePortableSelector("subagent_context", {
                valueKind: "selector",
                selector: "skills",
            }),
        ).toBe(false);
        expect(
            validatePortableSelector("subagent_tool", {
                valueKind: "selector",
                selector: "view_file",
            }),
        ).toBe(true);
        expect(
            validatePortableSelector("subagent_tool", {
                valueKind: "selector",
                selector: " ",
            }),
        ).toBe(false);
        expect(
            validatePortableSelector("subagent_tool", {
                valueKind: "positive_limit",
                limit: 1,
            }),
        ).toBe(false);

        const tool = antigravityProvider.dialectContracts.portableSelectors.find(
            (candidate) => candidate.definition.field === "subagent_tool",
        );
        if (tool === undefined) throw new Error("missing Antigravity tool selector");
        expect(
            tool.validateSelector({
                kind: "Workflow",
                field: "subagent_tool",
                dialectId: tool.definition.dialectId,
                value: { valueKind: "selector", selector: "view_file" },
            } as never),
        ).toBe(false);
    });

    it("rejects a runtime-named Workflow agent that Antigravity cannot encode", () => {
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_default" })).toBe(true);
        expect(
            validateWorkflowEntryAgent({
                mode: "bound",
                targetAssetVersionId: "00000000-0000-4000-8000-000000000001",
            }),
        ).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "reviewer" })).toBe(false);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_default" }, "incomplete")).toBe(true);
        expect(validateWorkflowEntryAgent({ mode: "agent_runtime_named", selector: "reviewer" }, "incomplete")).toBe(false);
    });
});

const validateWorkflowEntryAgent = bindWorkflowEntryAgentValidator(antigravityProvider);
const validatePortableSelector = bindPortableSelectorValidator(antigravityProvider);

function writeProjectFixtures(): void {
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# Project guidance\n");
    fs.writeFileSync(
        path.join(project, ".agents", "rules", "rule.md"),
        "---\ntrigger: always_on\nname: project-rule\ndescription: Always\n---\nRule body.\n",
    );
    fs.writeFileSync(
        path.join(project, ".agents", "workflows", "review.md"),
        "---\ndescription: Review changes\n---\nReview changes.\n",
    );
    fs.writeFileSync(path.join(project, ".agents", "skills", "sample", "SKILL.md"), skillMarkdown("sample", "Sample skill"));
    fs.writeFileSync(path.join(project, ".agents", "agents", "reviewer", "agent.json"), agentJson("reviewer", "Reviewer"));
}

function skillMarkdown(name: string, description: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`;
}

function agentJson(name: string, description: string, tools: string[] = ["view_file"]): string {
    return JSON.stringify({
        name,
        description,
        hidden: true,
        config: {
            customAgent: {
                systemPromptSections: [{ title: "Agent System Instructions", content: `Act as ${name}.` }],
                toolNames: tools,
                systemPromptConfig: { includeSections: ["user_rules", "skills"] },
            },
        },
    });
}

function projectRoot(): SourceRoot {
    return sourceRoot("project-root", project, "project_actual", "project_root", "project_registry_entry");
}

async function explicitProjectRoot(): Promise<SourceRoot> {
    const context: AdapterProbeContext = {
        authorizationScope: "project",
        projectRootPath: project,
        platformContext: { platform: "linux", platformInstanceId: "fixture:linux", accessRootPath: sandbox },
    };
    const rule = getPathRule("linux", sandbox);
    if (rule === null) throw new Error("missing Linux path rule");
    const resource: AdapterProbeResult["observation"]["agentRuntimeResources"][number] = {
        agentRuntimeResourceId: "unread-registry",
        roles: ["project_registry"],
        path: path.join(sandbox, "registry"),
        accessStatus: "not_found",
        locatorEvidence: [],
        diagnostics: [],
    };
    const refuseRegistryRead = (): never => {
        throw new Error("explicit Project must not read a global registry");
    };
    const discovered = await discoverAntigravityProjects(context, {}, rule, resource, resource, resource, resource, {
        readDirectoryEntries: refuseRegistryRead,
        readRegularFile: refuseRegistryRead,
    });
    expect(discovered.diagnostics).toEqual([]);
    const roots = new Map<string, SourceRoot>();
    const materialized = materializeAntigravityProjects(discovered.records, roots, context.platformContext, rule);
    expect(materialized.diagnostics).toEqual([]);
    expect(roots.size).toBe(1);
    const root = [...roots.values()][0];
    if (root === undefined) throw new Error("explicit Project was not materialized");
    expect(root.locatorEvidence).toEqual([
        { locatorKind: "user_provided_path", locatorKey: "probe_project_root", evidenceLevel: "user_provided" },
    ]);
    return root;
}

function familyRoot(): SourceRoot {
    return sourceRoot("family-root", family, "config", "family_shared", "runtime_known_rule");
}

function privateSkillRoot(): SourceRoot {
    return sourceRoot("private-skill-root", privateSkills, "source", "agent_runtime_private", "runtime_known_rule");
}

function sourceRoot(
    sourceRootId: string,
    rootPath: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"],
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path: rootPath,
        rootRole,
        sourceDomain,
        locatorKind,
        locatorKey: sourceRootId,
        evidenceLevel: "agent_runtime_verified",
    });
}

const dialectRegistry = bindDialectRegistry(antigravityProvider);

async function importAndValidate(
    readAgain: () => Promise<AdapterReadResult>,
    assetsRoot: string,
    expectedCandidates: number,
): Promise<void> {
    const read = await readAgain();
    const candidates = read.candidates.filter((candidate) => candidate.status === "complete");
    expect(candidates).toHaveLength(expectedCandidates);
    const service = importService(readAgain, assetsRoot);
    for (const candidate of candidates) {
        const accepted = await acceptCandidate(service, read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
        const closure = readVersionAuthority(assetsRoot, accepted.value.assetId, accepted.value.versionId, dialectRegistry());
        const representation = closure?.manifest.nativeRepresentations[0];
        const payload = closure?.nativePayloads[0];
        const contract = antigravityProvider.dialectContracts.native.find(
            (item) => item.definition.dialectId === representation?.dialectId,
        );
        if (closure === null || representation === undefined || payload === undefined || contract === undefined) {
            throw new Error("Antigravity imported native closure is incomplete");
        }
        expect(
            contract.validateSameContent({
                canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData },
                canonicalFiles: closure.files,
                representation,
                nativeFiles: payload.files,
            }),
        ).toBe(true);
    }
}
