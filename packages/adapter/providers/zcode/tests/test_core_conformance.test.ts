import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterReadTarget, SourceRoot, UuidV4 } from "@oaam/core";
import { readVersionAuthority } from "../../../core/src/catalog/version-authority";
import {
    clearRegistry,
    disableAdapter,
    enableAdapter,
    freezeRegistry,
    getRegisteredVersionDialectRegistry,
    registerAdapterProvider,
} from "../../../core/src/orchestration/adapter-registry";
import { executeAdapterReadWithAuthority } from "../../../core/src/source-import/source-read-execution";
import {
    bindAcceptFixtureCandidate,
    bindFixtureImportService,
    bindFixtureProbeRootTarget,
    fixtureSourceRoot,
} from "../../../test-support";
import { zcodeProvider } from "../src/zcode-provider";

let sandbox = "";
let config = "";
let skills = "";
let agents = "";
let memory = "";
let project = "";
let transactions = "";
let assets = "";
let oaam = "";
let locks = "";

const PROJECT_ID = "00000000-0000-4000-8000-000000000109" as UuidV4;
const target = bindFixtureProbeRootTarget({
    adapterId: "ZCODE",
    agentRuntimeId: "ZCODE_APP",
    versionText: "fixture",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const acceptCandidate = bindAcceptFixtureCandidate("zcode-core-conformance");
const importService = bindFixtureImportService({
    provider: zcodeProvider,
    assetsRoot: () => assets,
    oaamRoot: () => oaam,
    authorityLocksRoot: () => locks,
    projectRootPath: () => project,
    projectId: PROJECT_ID,
});

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-core-conformance-"));
    config = path.join(sandbox, ".zcode");
    skills = path.join(config, "skills");
    agents = path.join(sandbox, "storage", "agents");
    memory = path.join(sandbox, "storage", "cli", "memories", "projects", "project-key");
    project = path.join(sandbox, "project");
    transactions = path.join(sandbox, "transactions");
    assets = path.join(sandbox, "assets");
    oaam = path.join(sandbox, "oaam");
    locks = path.join(sandbox, "locks");
    for (const directory of [
        path.join(config, "commands"),
        path.join(config, "workflows"),
        path.join(skills, "sample"),
        agents,
        path.join(memory, "topics"),
        project,
        transactions,
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    clearRegistry();
});

afterEach(() => {
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode Core-owned source conformance", () => {
    it("imports every complete non-Catalog native dialect and reopens it after the Provider is disabled", async () => {
        writeSourceFixtures();
        const roots = [configRoot(), skillRoot(), agentRoot(), memoryRoot()];
        const readTarget = target(roots, ["Guidance", "Workflow", "Skill", "Subagent", "Memory"]);
        bindMemoryProject(readTarget, projectRoot());
        const readAgain = async () => {
            const result = await executeAdapterReadWithAuthority(zcodeProvider, readTarget, {
                managedTargetGuards: [],
                reservationIdentityFingerprints: [],
                transactionsRoot: transactions,
            });
            if (result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics, null, 2));
            return result.value;
        };
        const read = await readAgain();
        const complete = read.candidates.filter(
            (candidate) =>
                candidate.status === "complete" && !(candidate.kind === "Memory" && candidate.typeData.entityRole === "catalog"),
        );
        expect(read.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "ZCode Memory catalog",
                    status: "complete",
                    memoryCatalogMemberBindingInputs: [
                        {
                            rawTarget: "topics/build.md",
                            routingTitle: "Build conventions",
                            routingHint: "Build rules",
                        },
                    ],
                }),
                expect.objectContaining({ displayName: "Build conventions", status: "complete" }),
            ]),
        );
        expect(complete.map((candidate) => candidate.nativeRepresentation.dialectId).sort()).toEqual(
            [
                "zcode-command-markdown-v1",
                "zcode-guidance-markdown-v1",
                "zcode-memory-topic-v1",
                "zcode-script-workflow-javascript-v1",
                "zcode-skill-directory-v1",
                "zcode-subagent-markdown-v1",
            ].sort(),
        );

        const service = importService(readAgain);
        const accepted: Array<{
            candidate: (typeof complete)[number];
            assetId: UuidV4;
            versionId: UuidV4;
        }> = [];
        for (const candidate of complete) {
            const result = await acceptCandidate(service, read, candidate.candidateId);
            expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe("complete");
            accepted.push({ candidate, assetId: result.value.assetId, versionId: result.value.versionId });
        }

        const registration = registerAdapterProvider(zcodeProvider);
        expect(registration.status, JSON.stringify(registration.diagnostics, null, 2)).toBe("complete");
        expect(enableAdapter("ZCODE").status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(disableAdapter("ZCODE").status).toBe("complete");
        const dialectRegistry = getRegisteredVersionDialectRegistry();

        for (const item of accepted) {
            const closure = readVersionAuthority(assets, item.assetId, item.versionId, dialectRegistry);
            expect(closure).not.toBeNull();
            expect(closure?.manifest.nativeRepresentations).toHaveLength(1);
            expect(closure?.manifest.nativeRepresentations[0]?.dialectId).toBe(item.candidate.nativeRepresentation.dialectId);
            expect(closure?.nativePayloads[0]?.files.map((file) => file.relativePath)).toEqual(
                item.candidate.nativeRepresentation.files.map((file) => file.relativePath),
            );
            expect(closure?.nativePayloads[0]?.files.map((file) => [...file.bytes])).toEqual(
                item.candidate.nativeRepresentation.files.map((file) => [...file.bytes]),
            );
            if (item.candidate.kind === "Skill") {
                expect(closure?.manifest.nativeRepresentations[0]).toEqual(
                    expect.objectContaining({
                        schemaVersion: 2,
                        directories: expect.arrayContaining(["sample", "sample/empty"]),
                    }),
                );
            }
        }
    });

    it("imports the ordered ZCode Memory Catalog dependency-first and reopens its exact native file", async () => {
        writeSourceFixtures();
        const root = memoryRoot();
        const readTarget = target([root], ["Memory"]);
        bindMemoryProject(readTarget, projectRoot());
        const readAgain = async () => {
            const result = await executeAdapterReadWithAuthority(zcodeProvider, readTarget, {
                managedTargetGuards: [],
                reservationIdentityFingerprints: [],
                transactionsRoot: transactions,
            });
            if (result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics, null, 2));
            return result.value;
        };
        const read = await readAgain();
        const catalog = read.candidates.find((candidate) => candidate.typeData.entityRole === "catalog");
        const topic = read.candidates.find((candidate) => candidate.displayName === "Build conventions");
        if (catalog === undefined || topic === undefined) throw new Error("ZCode Memory graph fixture is incomplete");
        const service = importService(readAgain);
        const preview = service.previewImport([read]);
        expect(preview.status, JSON.stringify(preview.diagnostics, null, 2)).toBe("complete");
        if (preview.status !== "complete") throw new Error("ZCode Memory preview failed");
        const accepted = await service.acceptImportBatch({
            previewSnapshot: preview.value,
            decisions: [
                {
                    candidateId: catalog.candidateId,
                    action: "create_asset",
                    freshness: { freshnessAction: "require_current_source" },
                    promotion: { promotionAction: "import_only", userActionId: "zcode-memory-catalog-conformance" },
                    callableBindings: [
                        {
                            subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                            targetCandidateId: topic.candidateId,
                        },
                    ],
                },
                {
                    candidateId: topic.candidateId,
                    action: "create_asset",
                    freshness: { freshnessAction: "require_current_source" },
                    promotion: { promotionAction: "import_only", userActionId: "zcode-memory-catalog-conformance" },
                    callableBindings: [],
                },
            ],
        });
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");
        if (accepted.status !== "complete") throw new Error("ZCode Memory Catalog import failed");
        const byCandidate = new Map(
            accepted.value.items.flatMap((item) =>
                item.status === "complete" ? [[item.candidateId, item.version] as const] : [],
            ),
        );
        const catalogVersion = byCandidate.get(catalog.candidateId);
        const topicVersion = byCandidate.get(topic.candidateId);
        if (catalogVersion === undefined || topicVersion === undefined) throw new Error("ZCode Memory Versions are missing");

        expect(registerAdapterProvider(zcodeProvider).status).toBe("complete");
        expect(enableAdapter("ZCODE").status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(disableAdapter("ZCODE").status).toBe("complete");
        const closure = readVersionAuthority(
            assets,
            catalogVersion.assetId,
            catalogVersion.versionId,
            getRegisteredVersionDialectRegistry(),
        );
        expect(closure?.manifest.typeData).toEqual({
            schemaVersion: 2,
            entityRole: "catalog",
            members: [
                {
                    targetAssetVersionId: topicVersion.versionId,
                    routingTitle: "Build conventions",
                    routingHint: "Build rules",
                },
            ],
        });
        expect(closure?.nativePayloads[0]?.files.map((file) => file.relativePath)).toEqual(["MEMORY.md"]);
    });
});

function writeSourceFixtures(): void {
    fs.mkdirSync(path.join(skills, "sample", "empty"), { recursive: true });
    fs.writeFileSync(path.join(config, "AGENTS.md"), "# ZCode guidance\n");
    fs.writeFileSync(
        path.join(config, "commands", "review.md"),
        "---\ndescription: Review the selected change.\nallowed-tools: Read\n---\nReview $ARGUMENTS.\n",
    );
    fs.writeFileSync(
        path.join(config, "workflows", "release.workflow.js"),
        'export const meta = { name: "release", description: "Release safely." };\n',
    );
    fs.writeFileSync(
        path.join(skills, "sample", "SKILL.md"),
        "---\nname: sample\ndescription: Sample skill.\n---\nRead the binary resource.\n",
    );
    fs.writeFileSync(path.join(skills, "sample", "resource.bin"), new Uint8Array([0, 255, 1]));
    fs.writeFileSync(
        path.join(agents, "reviewer.md"),
        "---\nname: reviewer\ndescription: Review conservatively.\ntools: Read\n---\nReview the requested change.\n",
    );
    fs.writeFileSync(
        path.join(memory, "MEMORY.md"),
        "# ZCode Project Memory\n\n## Topic Index\n\n- [Build conventions](topics/build.md) — Build rules (type: project)\n",
    );
    fs.writeFileSync(
        path.join(memory, "topics", "build.md"),
        "---\nname: Build conventions\ndescription: Preserve the build boundary.\ntype: project\n" +
            "sessionId: source-session\nsource: user\nupdatedAt: 2026-07-22T00:00:00.000Z\n---\n" +
            "Run the canonical verification before publishing.\n",
    );
}

function configRoot(): SourceRoot {
    return root("zcode-config", config, "config", "agent_runtime_private", "zcode_user_data_root");
}

function skillRoot(): SourceRoot {
    return root("zcode-skills", skills, "source", "agent_runtime_private", "zcode_user_skill_root");
}

function agentRoot(): SourceRoot {
    return root("zcode-agents", agents, "source", "agent_runtime_private", "storage.dir");
}

function memoryRoot(): SourceRoot {
    const value = root("zcode-memory", memory, "source", "project_keyed", "zcode_project_memory_root");
    value.locatorEvidence.push({
        locatorKind: "user_provided_path",
        locatorKey: "user_selection",
        evidenceLevel: "user_provided",
    });
    return value;
}

function projectRoot(): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId: "zcode-project",
        path: project,
        rootRole: "project_actual",
        sourceDomain: "project_root",
        locatorKind: "user_provided_path",
        locatorKey: "probe_project_root",
        evidenceLevel: "user_provided",
    });
}

function root(
    sourceRootId: string,
    rootPath: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKey: string,
): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId,
        path: rootPath,
        rootRole,
        sourceDomain,
        locatorKind: locatorKey === "storage.dir" ? "runtime_declared_path" : "runtime_known_rule",
        locatorKey,
        evidenceLevel: "source_code",
    });
}

function bindMemoryProject(readTarget: AdapterReadTarget, workspace: SourceRoot): void {
    const selector = readTarget.sourceSelector;
    if (selector.selectorKind !== "probe_roots") throw new Error("ZCode conformance requires probe roots");
    selector.observation.sourceRoots.push(workspace);
    selector.observation.observedAgentRuntimes[0]?.sourceRootIds.push(workspace.sourceRootId);
    selector.observation.observedAgentRuntimes[0]?.observedProjectIds.push("zcode-project");
    selector.observation.observedProjects.push({
        observedProjectId: "zcode-project",
        runtimeProjectKey: project,
        displayName: "project",
        workspaces: [{ sourceRootId: workspace.sourceRootId, role: "primary" }],
        evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
        diagnostics: [],
    });
}
