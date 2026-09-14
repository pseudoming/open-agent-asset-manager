/** Exact OpenCode Workflow source/import/foreign-return/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import { makeVerifiedNativeProjectGuidanceTargetContextForTest } from "../../packages/core/src/render/native-project-guidance";
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

const SOURCE_BODY = "Reply with exactly `OAAM_OPENCODE_WORKFLOW_11815_8C4E91` and no other text.\n";
const FOREIGN_BODY = SOURCE_BODY.replace("8C4E91", "A7B8C9");
const REVERSED_BODY = SOURCE_BODY.replace("8C4E91", "D1E2F3");
const HEADER = ["---", "description: Release the selected target", "model: openai/gpt-5", "---", ""].join("\n");
const SOURCE_NATIVE = `${HEADER}${SOURCE_BODY}`;
const FOREIGN_NATIVE = `${HEADER}${FOREIGN_BODY}`;
const REVERSED_NATIVE = `${HEADER}${REVERSED_BODY}`;

describe("OpenCode CLI exact Workflow integrated lifecycle", () => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let workflowPath = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-workflow-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        workflowPath = path.join(projectRoot, ".opencode", "commands", "oaam-phase57-workflow.md");
        platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
        fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("preserves the native wrapper across exact deploy, foreign canonical return, and body-only reverse", async () => {
        fs.writeFileSync(workflowPath, SOURCE_NATIVE);
        const harness = await importedWorkflowHarness();
        const original = readWorkflowVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Workflow",
            typeData: {
                schemaVersion: 2,
                name: "oaam-phase57-workflow",
                description: "Release the selected target",
                implementation: {
                    kind: "instructions",
                    instructionDialectId: "opencode-command-markdown-v1",
                    execution: {
                        mode: "caller",
                        agent: { mode: "agent_runtime_default" },
                        model: {
                            mode: "selected",
                            dialectId: "opencode-model-selector-v1",
                            selector: "openai/gpt-5",
                        },
                        effort: { mode: "inherit" },
                        shell: { mode: "none" },
                    },
                },
                invocation: {
                    commandNames: ["oaam-phase57-workflow"],
                    userInvocable: true,
                    agentInvocable: false,
                },
            },
        });
        expect(nativeText(original)).toBe(SOURCE_NATIVE);

        fs.rmSync(workflowPath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["OPENCODE_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");
        requireComplete(await deploy(harness.core, deployment.value.deploymentId), "deploy current-exact Workflow");
        expect(fs.readFileSync(workflowPath, "utf8")).toBe(SOURCE_NATIVE);

        const foreign = harness.core.createVersion(harness.assetId, {
            typeData: structuredClone(original.manifest.typeData),
            files: editedCanonicalFiles(original, FOREIGN_BODY),
            userActionEvidenceId: "opencode-workflow-foreign-canonical-edit",
            changeKind: "edit",
            sourceVersionId: harness.versionId,
            changeNote: "Portable canonical edit before returning to OpenCode",
        });
        requireComplete(foreign, "create foreign-canonical Workflow");
        const foreignClosure = readWorkflowVersion(harness.assetId, foreign.value.versionId);
        expect(foreignClosure.manifest.sourceVersionId).toBe(harness.versionId);
        expect(foreignClosure.manifest.nativeRepresentations).toEqual([]);
        expect(foreignClosure.nativePayloads).toEqual([]);
        expect(foreignClosure.manifest.dialectRestorationPayloads).toEqual(original.manifest.dialectRestorationPayloads);

        requireComplete(
            harness.core.updateDeploymentInputs(deployment.value.deploymentId, {
                assets: [{ assetId: harness.assetId, versionId: foreign.value.versionId, allowIncomplete: false }],
            }),
            "select foreign-canonical Workflow",
        );
        requireComplete(await deploy(harness.core, deployment.value.deploymentId), "deploy parent-rebased Workflow");
        expect(fs.readFileSync(workflowPath, "utf8")).toBe(FOREIGN_NATIVE);

        fs.writeFileSync(workflowPath, REVERSED_NATIVE);
        const inspected = await harness.core.inspectDeploymentRenderedTarget(deployment.value.deploymentId);
        requireComplete(inspected, "inspect parent-rebased Workflow edit");
        expect(inspected.value.changes).toEqual([
            expect.objectContaining({
                changeKind: "file_content_replacement",
                replacementContent: { contentKind: "text", text: REVERSED_BODY },
            }),
        ]);
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: deployment.value.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        requireComplete(prepared, "prepare parent-rebased Workflow reverse");
        if (prepared.value.preparationState !== "prepared") throw new Error("Workflow reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-opencode-workflow-body-edit",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        requireComplete(committed, "commit parent-rebased Workflow reverse");
        if (committed.value.commitState !== "committed") throw new Error("Workflow reverse commit did not commit");
        expect(committed.value.version.assetId).toBe(harness.assetId);

        const accepted = readWorkflowVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.manifest.sourceVersionId).toBe(foreign.value.versionId);
        expect(accepted.files).toEqual([expect.objectContaining({ contentKind: "text", text: REVERSED_BODY })]);
        expect(nativeText(accepted)).toBe(REVERSED_NATIVE);
        expect(nativeText(readWorkflowVersion(harness.assetId, harness.versionId))).toBe(SOURCE_NATIVE);
        expect(readWorkflowVersion(harness.assetId, foreign.value.versionId).manifest.nativeRepresentations).toEqual([]);
        expect(fs.readFileSync(workflowPath, "utf8")).toBe(REVERSED_NATIVE);
    });

    it("blocks foreign canonical private-metadata changes before any target mutation", async () => {
        fs.writeFileSync(workflowPath, SOURCE_NATIVE);
        const harness = await importedWorkflowHarness();
        const original = readWorkflowVersion(harness.assetId, harness.versionId);
        if (original.manifest.kind !== "Workflow") throw new Error("OpenCode fixture imported a non-Workflow Version");
        const originalTypeData = original.manifest.typeData;
        fs.rmSync(workflowPath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["OPENCODE_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        requireComplete(deployment, "create blocked Workflow Deployment");

        const changedDescription = { ...originalTypeData, description: "Changed outside OpenCode" };
        const changedModel = structuredClone(originalTypeData);
        if (changedModel.implementation.kind !== "instructions") throw new Error("Workflow implementation is not instructions");
        changedModel.implementation.execution.model = { mode: "inherit" };
        for (const [label, typeData] of [
            ["description", changedDescription],
            ["model", changedModel],
        ] as const) {
            const changed = harness.core.createVersion(harness.assetId, {
                typeData,
                files: editedCanonicalFiles(original, FOREIGN_BODY),
                userActionEvidenceId: `opencode-workflow-block-${label}`,
                changeKind: "edit",
                sourceVersionId: harness.versionId,
            });
            requireComplete(changed, `create ${label} counterexample`);
            requireComplete(
                harness.core.updateDeploymentInputs(deployment.value.deploymentId, {
                    assets: [{ assetId: harness.assetId, versionId: changed.value.versionId, allowIncomplete: false }],
                }),
                `select ${label} counterexample`,
            );
            const analysis = await harness.core.analyzeDeploymentRender(deployment.value.deploymentId);
            expect(analysis.status).toBe("partial");
            if (analysis.status !== "partial") throw new Error("An explicit unsupported negative must remain inspectable");
            expect(
                analysis.value.analyses.every(
                    (row) =>
                        row.outputUnits.length === 0 && row.semanticOptions.length === 0 && row.blockedSemanticRefs.length > 0,
                ),
            ).toBe(true);
            expect(analysis.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
                "opencode_project_workflow_exact_graph_blocked",
            ]);
            expect(fs.existsSync(workflowPath)).toBe(false);
            expect(harness.core.getDeployment(deployment.value.deploymentId).value.value?.files).toEqual([]);
        }
    });

    async function importedWorkflowHarness(): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createWorkflowCore();
        enableOpenCode(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "OpenCode Workflow fixture" });
        requireComplete(project, "register Workflow fixture Project");
        const read = await core.readAssetsFromAdapter(workflowReadTarget());
        requireComplete(read, "read OpenCode Workflow");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        requireComplete(preview, "preview OpenCode Workflow");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("Workflow import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-opencode-workflow",
            },
            callableBindings: [],
        };
        const accepted = await core.acceptImport({ previewSnapshot: preview.value, decision });
        requireComplete(accepted, "accept OpenCode Workflow");
        return {
            core,
            projectId: project.value.projectId,
            assetId: accepted.value.assetId,
            versionId: accepted.value.versionId,
        };
    }

    function createWorkflowCore(): CoreService {
        const { guidanceBuild } = verifiedTargetBuilds();
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
                    return { status: "complete", value: [workflowProbeResult()], diagnostics: [] };
                },
                resolveObservedTargetContext(input) {
                    return {
                        status: "complete",
                        targetContext: makeVerifiedNativeProjectGuidanceTargetContextForTest({
                            provider: input.provider,
                            build: guidanceBuild,
                        }),
                        diagnostics: [],
                    };
                },
            },
        );
    }

    function workflowProbeResult(): ProbeResult {
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
                        observedProjectIds: ["opencode-workflow-project"],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot],
                agentRuntimeResources: [],
                observedProjects: [
                    {
                        observedProjectId: "opencode-workflow-project",
                        runtimeProjectKey: projectRoot,
                        displayName: "OpenCode Workflow fixture",
                        workspaces: [{ sourceRootId: sourceRoot.sourceRootId, role: "primary" }],
                        evidence: [
                            {
                                evidenceKind: "invocation",
                                locatorKey: "probe_project_root:project_config_on",
                                evidenceLevel: "user_provided",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                targetCandidates: [
                    {
                        targetCandidateId: "opencode-workflow-project-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: "OpenCode Workflow fixture",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "OPENCODE_CLI",
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "user_provided_path",
                                        locatorKey: "probe_project_root:project_config_on",
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

    function workflowReadTarget(): AdapterReadTarget {
        const sourceRoot = projectSourceRoot();
        return {
            adapterId: opencodeProvider.adapterId,
            allowedKinds: ["Workflow"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: workflowProbeResult().observation,
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

    function readWorkflowVersion(assetId: UuidV4, versionId: UuidV4) {
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
        if (closure === null) throw new Error("OpenCode Workflow Version authority is missing");
        return closure;
    }

    function verifiedTargetBuilds() {
        const guidance = opencodeProvider.renderContractDeclarations.find(
            (candidate) =>
                candidate.declarationKind === "native_project_guidance_v1" && candidate.agentRuntimeId === "OPENCODE_CLI",
        );
        const workflow = opencodeProvider.renderContractDeclarations.find(
            (candidate) =>
                candidate.declarationKind === "native_project_exact_graph_v1" &&
                candidate.agentRuntimeId === "OPENCODE_CLI" &&
                candidate.assetKind === "Workflow",
        );
        const workflowBuild = workflow?.verifiedBuilds[0];
        const guidanceBuild = guidance?.verifiedBuilds.find(
            (candidate) =>
                candidate.versionText === workflowBuild?.versionText &&
                candidate.buildIdentity === workflowBuild.buildIdentity &&
                candidate.platform === workflowBuild.platform,
        );
        if (guidanceBuild === undefined || workflowBuild === undefined)
            throw new Error("OpenCode verified target builds are missing");
        expect(workflowBuild).toMatchObject({
            agentRuntimeId: guidanceBuild.agentRuntimeId,
            versionText: guidanceBuild.versionText,
            buildIdentity: guidanceBuild.buildIdentity,
            platform: guidanceBuild.platform,
        });
        return { guidanceBuild, workflowBuild };
    }
});

async function deploy(core: CoreService, deploymentId: UuidV4) {
    const analysis = await core.analyzeDeploymentRender(deploymentId);
    requireComplete(analysis, "analyze Workflow Deployment");
    const selectionRequest = exactSelection(analysis.value);
    const preview = await core.previewDeploymentRender({ deploymentId, selectionRequest });
    requireComplete(preview, "preview Workflow Deployment");
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
            if (matches.length !== 1 || selected === undefined) throw new Error("exact Workflow selection is not unique");
            return { optionFingerprint: selected.optionFingerprint, approvalRequest: { approvalAction: "none" } };
        }),
    };
}

function editedCanonicalFiles(closure: ReturnType<typeof readVersionAuthority> & {}, text: string) {
    if (closure === null) throw new Error("Workflow closure is missing");
    return closure.files.map((file) => {
        if (file.contentKind !== "text") throw new Error("OpenCode Workflow entry is not text");
        return {
            logicalPath: file.file.logicalPath,
            role: file.file.role,
            contentKind: "text" as const,
            mediaType: file.file.mediaType,
            text,
            executable: file.file.executable,
            references: structuredClone(file.file.references),
        };
    });
}

function nativeText(closure: NonNullable<ReturnType<typeof readVersionAuthority>>): string {
    const payload = closure.nativePayloads.find((item) => item.dialectId === "opencode-command-markdown-v1");
    const file = payload?.files[0];
    if (payload?.files.length !== 1 || file === undefined) throw new Error("OpenCode Workflow native payload is missing");
    return Buffer.from(file.bytes).toString("utf8");
}

function enableOpenCode(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [opencodeProvider.adapterId],
        userActionId: "enable-opencode-workflow-fixture",
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
        return `10000000-0000-4000-8000-${String(value).padStart(12, "0")}` as UuidV4;
    };
}
