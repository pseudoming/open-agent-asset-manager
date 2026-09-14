/** Exact OpenCode Skill graph source/import/parent-rebase/deploy/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { computeTargetApplicabilityFingerprint } from "../../packages/core/src/foundation/fingerprint-render";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import type {
    AdapterReadTarget,
    CoreService,
    ImportAcceptRequest,
    PlatformContext,
    ProbeResult,
    RenderAnalysisView,
    RenderSelectionRequest,
    UuidV4,
} from "../../packages/core/src/types";

const SKILL_NAME = "oaam-phase57-skill-graph";
const SOURCE_BODY = "Use every bundled resource. OAAM_OPENCODE_SKILL_SOURCE_41A7D2\n";
const FOREIGN_BODY = SOURCE_BODY.replace("41A7D2", "99C4E1");
const REVERSED_BODY = SOURCE_BODY.replace("41A7D2", "D1E2F3");
const SOURCE_REFERENCE = "OAAM_OPENCODE_REFERENCE_SOURCE\n";
const FOREIGN_REFERENCE = "OAAM_OPENCODE_REFERENCE_FOREIGN\n";
const REVERSED_REFERENCE = "OAAM_OPENCODE_REFERENCE_REVERSED\n";
const SOURCE_SCRIPT = "#!/bin/sh\nprintf 'OAAM_OPENCODE_SCRIPT_SOURCE\\n'\n";
const FOREIGN_SCRIPT = SOURCE_SCRIPT.replace("SOURCE", "FOREIGN");
const REVERSED_SCRIPT = SOURCE_SCRIPT.replace("SOURCE", "REVERSED");
const SOURCE_BINARY = Buffer.from([0, 255, 1, 2]);
const FOREIGN_BINARY = Buffer.from([0, 255, 3, 4]);
const REVERSED_BINARY = Buffer.from([0, 255, 5, 6]);
const HEADER = `${[
    "---",
    `name: ${SKILL_NAME}`,
    "description: OAAM OpenCode integrated graph Skill",
    "slash: true",
    "license: MIT",
    "compatibility: OpenCode 1.18",
    "metadata:",
    "  owner: oaam",
    "---",
].join("\n")}\n`;

describe("OpenCode CLI exact Skill integrated lifecycle", () => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let skillRoot = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-skill-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        skillRoot = path.join(projectRoot, ".opencode", "skills", SKILL_NAME);
        platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
        writeSkillGraph(SOURCE_BODY, SOURCE_REFERENCE, SOURCE_SCRIPT, SOURCE_BINARY, false);
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("preserves the complete graph across current-exact deploy, parent-native rebase, and reverse accept", async () => {
        const harness = await importedSkillHarness();
        const original = readSkillVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Skill",
            typeData: {
                schemaVersion: 2,
                name: SKILL_NAME,
                description: "OAAM OpenCode integrated graph Skill",
                entryDialectId: "opencode-skill-markdown-v2",
                portableMetadata: {
                    license: "MIT",
                    compatibility: "OpenCode 1.18",
                    metadata: { owner: "oaam" },
                },
            },
        });
        expect(canonicalGraph(original)).toEqual({
            "SKILL.md": { kind: "text", value: SOURCE_BODY, executable: false },
            "assets/marker.bin": { kind: "binary", value: SOURCE_BINARY.toString("hex"), executable: false },
            "references/details.md": { kind: "text", value: SOURCE_REFERENCE, executable: false },
            "scripts/run.sh": { kind: "text", value: SOURCE_SCRIPT, executable: false },
        });
        expect(nativeGraph(original)).toEqual({
            [`.opencode/skills/${SKILL_NAME}/SKILL.md`]: { kind: "text", value: `${HEADER}${SOURCE_BODY}`, executable: false },
            [`.opencode/skills/${SKILL_NAME}/assets/marker.bin`]: {
                kind: "binary",
                value: SOURCE_BINARY.toString("hex"),
                executable: false,
            },
            [`.opencode/skills/${SKILL_NAME}/references/details.md`]: {
                kind: "text",
                value: SOURCE_REFERENCE,
                executable: false,
            },
            [`.opencode/skills/${SKILL_NAME}/scripts/run.sh`]: {
                kind: "text",
                value: SOURCE_SCRIPT,
                executable: false,
            },
        });

        fs.rmSync(skillRoot, { recursive: true, force: true });
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["OPENCODE_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        requireComplete(deployment, "create Skill Deployment");
        requireComplete(await deploy(harness.core, deployment.value.deploymentId), "deploy current-exact Skill");
        expect(diskGraph()).toEqual({
            "SKILL.md": { kind: "text", value: `${HEADER}${SOURCE_BODY}`, executable: false },
            "assets/marker.bin": { kind: "binary", value: SOURCE_BINARY.toString("hex"), executable: false },
            "references/details.md": { kind: "text", value: SOURCE_REFERENCE, executable: false },
            "scripts/run.sh": { kind: "text", value: SOURCE_SCRIPT, executable: false },
        });

        const foreign = harness.core.createVersion(harness.assetId, {
            typeData: structuredClone(original.manifest.typeData),
            files: editedCanonicalFiles(original, FOREIGN_BODY, FOREIGN_REFERENCE, FOREIGN_SCRIPT, FOREIGN_BINARY, true),
            userActionEvidenceId: "opencode-skill-foreign-canonical-edit",
            changeKind: "edit",
            sourceVersionId: harness.versionId,
            changeNote: "Portable graph edit before returning to OpenCode",
        });
        requireComplete(foreign, "create foreign-canonical Skill");
        const foreignClosure = readSkillVersion(harness.assetId, foreign.value.versionId);
        expect(foreignClosure.manifest.sourceVersionId).toBe(harness.versionId);
        expect(foreignClosure.manifest.nativeRepresentations).toEqual([]);
        expect(foreignClosure.nativePayloads).toEqual([]);

        requireComplete(
            harness.core.updateDeploymentInputs(deployment.value.deploymentId, {
                assets: [{ assetId: harness.assetId, versionId: foreign.value.versionId, allowIncomplete: false }],
            }),
            "select foreign-canonical Skill",
        );
        requireComplete(await deploy(harness.core, deployment.value.deploymentId), "deploy parent-rebased Skill");
        expect(diskGraph()).toEqual({
            "SKILL.md": { kind: "text", value: `${HEADER}${FOREIGN_BODY}`, executable: false },
            "assets/marker.bin": { kind: "binary", value: FOREIGN_BINARY.toString("hex"), executable: false },
            "references/details.md": { kind: "text", value: FOREIGN_REFERENCE, executable: false },
            "scripts/run.sh": { kind: "text", value: FOREIGN_SCRIPT, executable: true },
        });

        writeSkillGraph(REVERSED_BODY, REVERSED_REFERENCE, REVERSED_SCRIPT, REVERSED_BINARY, false);
        const inspected = await harness.core.inspectDeploymentRenderedTarget(deployment.value.deploymentId);
        requireComplete(inspected, "inspect parent-rebased Skill edits");
        expect(inspected.value.changes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: REVERSED_BODY },
                }),
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "binary", bytes: Uint8Array.from(REVERSED_BINARY) },
                }),
                expect.objectContaining({ changeKind: "file_executable_replacement", executable: false }),
            ]),
        );
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: deployment.value.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        requireComplete(prepared, "prepare Skill reverse");
        if (prepared.value.preparationState !== "prepared") throw new Error("Skill reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-opencode-skill-graph-edit",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        requireComplete(committed, "commit Skill reverse");
        if (committed.value.commitState !== "committed") throw new Error("Skill reverse commit did not commit");

        const accepted = readSkillVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.manifest.sourceVersionId).toBe(foreign.value.versionId);
        expect(canonicalGraph(accepted)).toEqual({
            "SKILL.md": { kind: "text", value: REVERSED_BODY, executable: false },
            "assets/marker.bin": { kind: "binary", value: REVERSED_BINARY.toString("hex"), executable: false },
            "references/details.md": { kind: "text", value: REVERSED_REFERENCE, executable: false },
            "scripts/run.sh": { kind: "text", value: REVERSED_SCRIPT, executable: false },
        });
        expect(nativeGraph(accepted)).toEqual({
            [`.opencode/skills/${SKILL_NAME}/SKILL.md`]: { kind: "text", value: `${HEADER}${REVERSED_BODY}`, executable: false },
            [`.opencode/skills/${SKILL_NAME}/assets/marker.bin`]: {
                kind: "binary",
                value: REVERSED_BINARY.toString("hex"),
                executable: false,
            },
            [`.opencode/skills/${SKILL_NAME}/references/details.md`]: {
                kind: "text",
                value: REVERSED_REFERENCE,
                executable: false,
            },
            [`.opencode/skills/${SKILL_NAME}/scripts/run.sh`]: {
                kind: "text",
                value: REVERSED_SCRIPT,
                executable: false,
            },
        });
        expect(nativeGraph(readSkillVersion(harness.assetId, harness.versionId))).toEqual(nativeGraph(original));
    });

    async function importedSkillHarness(): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createSkillCore();
        enableOpenCode(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "OpenCode Skill fixture" });
        requireComplete(project, "register Skill fixture Project");
        const read = await core.readAssetsFromAdapter(skillReadTarget());
        requireComplete(read, "read OpenCode Skill");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        requireComplete(preview, "preview OpenCode Skill");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("Skill import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-opencode-skill",
            },
            callableBindings: [],
        };
        const accepted = await core.acceptImport({ previewSnapshot: preview.value, decision });
        requireComplete(accepted, "accept OpenCode Skill");
        return {
            core,
            projectId: project.value.projectId,
            assetId: accepted.value.assetId,
            versionId: accepted.value.versionId,
        };
    }

    function createSkillCore(): CoreService {
        return createCoreServiceForTest(
            {
                providers: [opencodeProvider],
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: increasingClock(),
                newUuid: uuidSequence(),
            },
            {
                async probeAdapters() {
                    return { status: "complete", value: [skillProbeResult()], diagnostics: [] };
                },
                resolveObservedTargetContext() {
                    return { status: "complete", targetContext: skillTargetContext(), diagnostics: [] };
                },
            },
        );
    }

    function skillProbeResult(): ProbeResult {
        const sourceRoot = projectSourceRoot();
        return {
            status: "complete",
            observation: {
                adapterId: opencodeProvider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: "OPENCODE_CLI",
                        versionText: "1.18.15",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: path.join(sandbox, "fixture-bin", "opencode"),
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [sourceRoot.sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: ["opencode-skill-project"],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot],
                agentRuntimeResources: [],
                observedProjects: [
                    {
                        observedProjectId: "opencode-skill-project",
                        runtimeProjectKey: projectRoot,
                        displayName: "OpenCode Skill fixture",
                        workspaces: [{ sourceRootId: sourceRoot.sourceRootId, role: "primary" }],
                        evidence: [
                            {
                                evidenceKind: "invocation",
                                locatorKey: "probe_project_root:project_config_on:external_skills_on:claude_skills_on",
                                evidenceLevel: "user_provided",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                targetCandidates: [
                    {
                        targetCandidateId: "opencode-skill-project-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: "OpenCode Skill fixture",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "OPENCODE_CLI",
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "user_provided_path",
                                        locatorKey: "probe_project_root:project_config_on:external_skills_on:claude_skills_on",
                                        evidenceLevel: "user_provided",
                                    },
                                ],
                                diagnostics: [],
                            },
                        ],
                        diagnostics: [],
                    },
                ],
            },
            diagnostics: [],
        };
    }

    function skillReadTarget(): AdapterReadTarget {
        const sourceRoot = projectSourceRoot();
        return {
            adapterId: opencodeProvider.adapterId,
            allowedKinds: ["Skill"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: skillProbeResult().observation,
                sourceRootIds: [sourceRoot.sourceRootId],
            },
        };
    }

    function projectSourceRoot() {
        return {
            sourceRootId: "selected-project-root",
            rootRole: "project_actual" as const,
            sourceDomain: "project_root" as const,
            path: projectRoot,
            accessStatus: "available" as const,
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path" as const,
                    locatorKey: "probe_project_root:project_config_on:external_skills_on:claude_prompt_on:claude_skills_on",
                    evidenceLevel: "user_provided" as const,
                },
            ],
            diagnostics: [],
        };
    }

    function skillTargetContext() {
        const declaration = opencodeProvider.renderContractDeclarations.find(
            (candidate) =>
                candidate.declarationKind === "native_project_exact_graph_v1" &&
                candidate.agentRuntimeId === "OPENCODE_CLI" &&
                candidate.assetKind === "Skill",
        );
        const build = declaration?.verifiedBuilds[0];
        const schema = opencodeProvider.targetContextSchemas.find(
            (candidate) => candidate.targetContextSchemaId === declaration?.target.targetContextSchemaId,
        );
        const descriptor = opencodeProvider.agentRuntimes.find((candidate) => candidate.agentRuntimeId === "OPENCODE_CLI");
        if (declaration === undefined || build === undefined || schema === undefined || descriptor === undefined) {
            throw new Error("OpenCode verified Skill target context is missing");
        }
        const renderFacts = [
            { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" as const },
            ...Object.entries(declaration.target.requiredFacts).map(([key, value]) => ({
                key,
                value,
                evidenceLevel: "agent_runtime_verified" as const,
            })),
        ].sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
        const preimage = {
            schemaVersion: 1 as const,
            agentRuntimeId: build.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            targetContextSchemaId: schema.targetContextSchemaId,
            targetContextSchemaFingerprint: schema.schemaFingerprint,
            renderFacts,
        };
        return {
            ...preimage,
            targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
                context: preimage,
                entryClass: descriptor.entryClass,
            }),
        };
    }

    function readSkillVersion(assetId: UuidV4, versionId: UuidV4) {
        const closure = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            assetId,
            versionId,
            createVersionDialectRegistry(
                opencodeProvider.dialectContracts.native,
                opencodeProvider.dialectContracts.restoration,
                opencodeProvider.dialectContracts.portableEntries,
                opencodeProvider.dialectContracts.portableSelectors,
            ),
        );
        if (closure === null) throw new Error("OpenCode Skill Version authority is missing");
        return closure;
    }

    function writeSkillGraph(body: string, reference: string, script: string, binary: Buffer, executable: boolean): void {
        fs.mkdirSync(path.join(skillRoot, "assets"), { recursive: true });
        fs.mkdirSync(path.join(skillRoot, "references"), { recursive: true });
        fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `${HEADER}${body}`);
        fs.writeFileSync(path.join(skillRoot, "assets", "marker.bin"), binary);
        fs.writeFileSync(path.join(skillRoot, "references", "details.md"), reference);
        fs.writeFileSync(path.join(skillRoot, "scripts", "run.sh"), script);
        fs.chmodSync(path.join(skillRoot, "scripts", "run.sh"), executable ? 0o755 : 0o644);
    }

    function diskGraph() {
        return {
            "SKILL.md": textDisk("SKILL.md"),
            "assets/marker.bin": binaryDisk("assets/marker.bin"),
            "references/details.md": textDisk("references/details.md"),
            "scripts/run.sh": textDisk("scripts/run.sh"),
        };
    }

    function textDisk(relativePath: string) {
        const fullPath = path.join(skillRoot, ...relativePath.split("/"));
        return { kind: "text", value: fs.readFileSync(fullPath, "utf8"), executable: isExecutable(fullPath) };
    }

    function binaryDisk(relativePath: string) {
        const fullPath = path.join(skillRoot, ...relativePath.split("/"));
        return { kind: "binary", value: fs.readFileSync(fullPath).toString("hex"), executable: isExecutable(fullPath) };
    }

    function isExecutable(filePath: string): boolean {
        return (fs.statSync(filePath).mode & 0o111) !== 0;
    }
});

async function deploy(core: CoreService, deploymentId: UuidV4) {
    const analysis = await core.analyzeDeploymentRender(deploymentId);
    requireComplete(analysis, "analyze Skill Deployment");
    const selectionRequest = exactSelection(analysis.value);
    const preview = await core.previewDeploymentRender({ deploymentId, selectionRequest });
    requireComplete(preview, "preview Skill Deployment");
    return core.deployDeployment({
        deploymentId,
        deploymentAction: "apply",
        selectionRequest,
        expectedPreviewFingerprint: preview.value.previewFingerprint,
    });
}

function exactSelection(analysis: RenderAnalysisView): RenderSelectionRequest {
    const options = analysis.analyses.flatMap((item) => item.semanticOptions);
    return {
        schemaVersion: 1,
        renderInputFingerprint: analysis.renderInputFingerprint,
        semanticOptions: analysis.requiredSemantics.map((semantic) => {
            const matches = options.filter((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint);
            const selected = matches[0];
            if (matches.length !== 1 || selected === undefined) throw new Error("exact Skill selection is not unique");
            return { optionFingerprint: selected.optionFingerprint, approvalRequest: { approvalAction: "none" } };
        }),
    };
}

function editedCanonicalFiles(
    closure: NonNullable<ReturnType<typeof readVersionAuthority>>,
    body: string,
    reference: string,
    script: string,
    binary: Buffer,
    executable: boolean,
) {
    return closure.files.map((file) => {
        const base = {
            logicalPath: file.file.logicalPath,
            role: file.file.role,
            mediaType: file.file.mediaType,
            executable: file.file.logicalPath === "scripts/run.sh" ? executable : file.file.executable,
            references: structuredClone(file.file.references),
        };
        if (file.file.logicalPath === "SKILL.md") return { ...base, contentKind: "text" as const, text: body };
        if (file.file.logicalPath === "references/details.md") {
            return { ...base, contentKind: "text" as const, text: reference };
        }
        if (file.file.logicalPath === "scripts/run.sh") return { ...base, contentKind: "text" as const, text: script };
        if (file.file.logicalPath === "assets/marker.bin") {
            return { ...base, contentKind: "binary" as const, bytes: Uint8Array.from(binary) };
        }
        throw new Error(`unexpected OpenCode Skill file ${file.file.logicalPath}`);
    });
}

function canonicalGraph(closure: NonNullable<ReturnType<typeof readVersionAuthority>>) {
    return Object.fromEntries(
        closure.files.map((file) => [
            file.file.logicalPath,
            file.contentKind === "text"
                ? { kind: "text", value: file.text, executable: file.file.executable }
                : { kind: "binary", value: Buffer.from(file.bytes).toString("hex"), executable: file.file.executable },
        ]),
    );
}

function nativeGraph(closure: NonNullable<ReturnType<typeof readVersionAuthority>>) {
    const payload = closure.nativePayloads.find((item) => item.dialectId === "opencode-skill-directory-v2");
    const representation = closure.manifest.nativeRepresentations.find(
        (item) => item.dialectId === "opencode-skill-directory-v2",
    );
    if (payload === undefined || representation === undefined) throw new Error("OpenCode Skill native payload is missing");
    return Object.fromEntries(
        payload.files.map((file) => {
            const descriptor = representation.files.find((candidate) => candidate.relativePath === file.relativePath);
            if (descriptor === undefined) throw new Error(`OpenCode native descriptor missing for ${file.relativePath}`);
            return [
                file.relativePath,
                descriptor.contentKind === "text"
                    ? {
                          kind: "text",
                          value: Buffer.from(file.bytes).toString("utf8"),
                          executable: descriptor.executable,
                      }
                    : {
                          kind: "binary",
                          value: Buffer.from(file.bytes).toString("hex"),
                          executable: descriptor.executable,
                      },
            ];
        }),
    );
}

function enableOpenCode(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [opencodeProvider.adapterId],
        userActionId: "enable-opencode-skill-fixture",
    });
    requireComplete(enabled, "enable OpenCode");
}

function requireComplete<T extends { status: string; diagnostics: unknown[] }>(
    result: T,
    label: string,
): asserts result is T & { status: "complete"; value: Exclude<T extends { value: infer V } ? V : never, undefined> } {
    expect(result.status, `${label}: ${JSON.stringify(result.diagnostics)}`).toBe("complete");
}

function increasingClock(): () => number {
    let value = 1_000;
    return () => (value += 1);
}

function uuidSequence(): () => UuidV4 {
    let value = 0;
    return () => {
        value += 1;
        return `20000000-0000-4000-8000-${String(value).padStart(12, "0")}` as UuidV4;
    };
}
