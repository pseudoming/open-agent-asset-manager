/** Exact Codex Guidance source/import/deploy/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import {
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectGuidanceTargetContextForTest,
} from "../../packages/core/src/render/native-project-guidance";
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

const SOURCE_TEXT = "# Codex project guidance\n\nKeep the source boundary exact.\n";
const ACCEPTED_TEXT = "# Codex project guidance\n\nKeep the deployed edit and its history.\n";

describe("Codex CLI Guidance integrated round trip", () => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let guidancePath = "";
    let executablePath = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-guidance-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        guidancePath = path.join(projectRoot, "AGENTS.md");
        executablePath = path.join(sandbox, "bin", "codex");
        platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
        fs.mkdirSync(path.dirname(executablePath), { recursive: true });
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(executablePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("reads, imports, deploys, and reverse-accepts one exact project Guidance file", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness();
        const original = readGuidanceVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
            nativeRepresentations: [expect.objectContaining({ dialectId: "codex-guidance-markdown-v1" })],
        });
        expect(original.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "codex-guidance-markdown-v1",
                files: [{ relativePath: "AGENTS.md", bytes: new Uint8Array(Buffer.from(SOURCE_TEXT)) }],
            }),
        ]);

        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["CODEX_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");
        const deployed = await deploy(harness.core, deployment.value.deploymentId);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(guidancePath, "utf8")).toBe(SOURCE_TEXT);
        expect(deployed.value.files).toEqual([expect.objectContaining({ relativePath: "AGENTS.md", observedState: "present" })]);

        fs.writeFileSync(guidancePath, ACCEPTED_TEXT);
        const inspected = await harness.core.inspectDeploymentRenderedTarget(deployment.value.deploymentId);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value.changes).toEqual([
            expect.objectContaining({
                changeKind: "file_content_replacement",
                replacementContent: { contentKind: "text", text: ACCEPTED_TEXT },
            }),
        ]);
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: deployment.value.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        if (prepared.value.preparationState !== "prepared") throw new Error("Guidance reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-codex-guidance-edit",
            newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
        if (committed.value.commitState !== "committed") throw new Error("Guidance reverse commit did not commit");
        expect(committed.value.version.assetId).toBe(harness.assetId);
        expect(committed.value.version.versionId).not.toBe(harness.versionId);
        expect(fs.readFileSync(guidancePath, "utf8")).toBe(ACCEPTED_TEXT);

        const accepted = readGuidanceVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.manifest.typeData).toEqual(original.manifest.typeData);
        expect(accepted.files).toEqual([expect.objectContaining({ contentKind: "text", text: ACCEPTED_TEXT })]);
        expect(accepted.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "codex-guidance-markdown-v1",
                files: [{ relativePath: "AGENTS.md", bytes: new Uint8Array(Buffer.from(ACCEPTED_TEXT)) }],
            }),
        ]);
        expect(readGuidanceVersion(harness.assetId, harness.versionId).files[0]).toMatchObject({
            contentKind: "text",
            text: SOURCE_TEXT,
        });
    });

    it.each([
        {
            label: "renamed target",
            mutate() {
                fs.renameSync(guidancePath, path.join(projectRoot, "RENAMED.md"));
            },
        },
        {
            label: "executable-bit drift",
            mutate() {
                fs.chmodSync(guidancePath, 0o755);
            },
        },
    ])("rejects $label as a reverse conflict without publishing a Version", async ({ mutate }) => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await deployedGuidanceHarness();
        mutate();
        const inspected = await harness.core.inspectDeploymentRenderedTarget(harness.deploymentId);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value.changes).toEqual([]);
        expect(inspected.value.files).toEqual([expect.objectContaining({ attributionState: "conflict" })]);
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: harness.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status).toBe("failed");
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
    });

    it("rejects a stale Guidance edit after preparation without publishing a Version", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await deployedGuidanceHarness();
        fs.writeFileSync(guidancePath, "# First runtime edit\n");
        const inspected = await harness.core.inspectDeploymentRenderedTarget(harness.deploymentId);
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: harness.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        if (prepared.value.preparationState !== "prepared") throw new Error("Guidance reverse preparation did not prepare");
        fs.writeFileSync(guidancePath, "# Second runtime edit\n");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-stale-codex-guidance-edit",
            newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        expect(committed.status).toBe("failed");
        expect(committed.diagnostics[0]?.code).toBe("reverse_accept.inspection_stale");
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
        expect(fs.readFileSync(guidancePath, "utf8")).toBe("# Second runtime edit\n");
    });

    it("deploys a same-version unverified consumer build with the Provider compatibility warning", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness("unverified_build");
        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["CODEX_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        const analyzed = await harness.core.analyzeDeploymentRender(deployment.value.deploymentId);
        expect(analyzed.status, JSON.stringify(analyzed.diagnostics)).toBe("complete");
        expect(analyzed.diagnostics).toEqual([
            expect.objectContaining({ code: "codex_target_build_compatibility_inferred", severity: "warning" }),
        ]);
        const deployed = await deploy(harness.core, deployment.value.deploymentId);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(guidancePath, "utf8")).toBe(SOURCE_TEXT);
    });

    it("rejects a consumer build older than the earliest Guidance anchor before writing AGENTS.md", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness("older_build");
        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["CODEX_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        const analyzed = await harness.core.analyzeDeploymentRender(deployment.value.deploymentId);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("native_guidance_build_unverified");
        expect(fs.existsSync(guidancePath)).toBe(false);
        expect(harness.core.getDeployment(deployment.value.deploymentId).value.value?.files).toEqual([]);
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
    });

    async function importedGuidanceHarness(targetMode: "verified" | "unverified_build" | "older_build" = "verified"): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createGuidanceCore(targetMode);
        enableCodex(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Codex Guidance fixture" });
        expect(project.status, JSON.stringify(project.diagnostics)).toBe("complete");
        const read = await core.readAssetsFromAdapter(guidanceReadTarget());
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("Guidance import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-codex-guidance",
            },
            callableBindings: [],
        };
        const accepted = await core.acceptImport({ previewSnapshot: preview.value, decision });
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        return {
            core,
            projectId: project.value.projectId,
            assetId: accepted.value.assetId,
            versionId: accepted.value.versionId,
        };
    }

    async function deployedGuidanceHarness() {
        const imported = await importedGuidanceHarness();
        fs.rmSync(guidancePath);
        const deployment = imported.core.createDeployment({
            projectId: imported.projectId,
            consumerAgentRuntimeIds: ["CODEX_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: imported.assetId, versionId: imported.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");
        const deployed = await deploy(imported.core, deployment.value.deploymentId);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        return { ...imported, deploymentId: deployment.value.deploymentId };
    }

    function createGuidanceCore(targetMode: "verified" | "unverified_build" | "older_build"): CoreService {
        const build = verifiedTargetBuild();
        const observedVersionText = targetMode === "older_build" ? "0.140.0" : build.versionText;
        return createCoreServiceForTest(
            {
                providers: [codexProvider],
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: increasingClock(),
                newUuid: uuidSequence(),
            },
            {
                async probeAdapters() {
                    return { status: "complete", value: [guidanceProbeResult(observedVersionText)], diagnostics: [] };
                },
                resolveObservedTargetContext(input) {
                    if (targetMode === "verified") {
                        return {
                            status: "complete",
                            targetContext: makeVerifiedNativeProjectGuidanceTargetContextForTest({
                                provider: input.provider,
                                build,
                            }),
                            diagnostics: [],
                        };
                    }
                    return resolveObservedNativeProjectGuidanceTargetContextForTest(input, {
                        verifiedBuilds: [build],
                        readBuildArtifact: () => ({
                            bytes: new TextEncoder().encode(`${targetMode} Codex build`),
                            executable: true,
                            identity: { deviceId: "fixture", fileId: "unverified", entryKind: "file" },
                        }),
                    });
                },
            },
        );
    }

    function guidanceProbeResult(versionText: string): ProbeResult {
        const sourceRoot = projectSourceRoot();
        return {
            status: "complete",
            observation: {
                adapterId: codexProvider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: "CODEX_CLI",
                        versionText,
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: executablePath,
                                evidenceLevel: "local_artifact",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [sourceRoot.sourceRootId],
                        agentRuntimeResourceIds: ["codex-project-registry", "codex-config-resource"],
                        observedProjectIds: ["codex-project"],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot],
                agentRuntimeResources: [
                    {
                        agentRuntimeResourceId: "codex-project-registry",
                        roles: ["project_registry"],
                        path: path.join(sandbox, "codex-projects.json"),
                        accessStatus: "available",
                        locatorEvidence: [
                            {
                                locatorKind: "runtime_known_rule",
                                locatorKey: "codex_project_registry",
                                evidenceLevel: "local_artifact",
                            },
                        ],
                        diagnostics: [],
                    },
                    {
                        agentRuntimeResourceId: "codex-config-resource",
                        roles: ["agent_runtime_data"],
                        path: path.join(sandbox, "config.toml"),
                        accessStatus: "not_found",
                        locatorEvidence: [
                            {
                                locatorKind: "runtime_known_rule",
                                locatorKey: "codex:config.toml",
                                evidenceLevel: "local_artifact",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                observedProjects: [
                    {
                        observedProjectId: "codex-project",
                        runtimeProjectKey: projectRoot,
                        displayName: "Codex Guidance fixture",
                        workspaces: [{ sourceRootId: sourceRoot.sourceRootId, role: "primary" }],
                        evidence: [
                            {
                                evidenceKind: "agent_runtime_resource",
                                agentRuntimeResourceId: "codex-project-registry",
                                locatorKey: "codex_project_registry",
                                evidenceLevel: "local_artifact",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                targetCandidates: [
                    {
                        targetCandidateId: "codex-project-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: "Codex Guidance fixture",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "CODEX_CLI",
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "project_registry_entry",
                                        locatorKey: "codex_project_registry",
                                        evidenceLevel: "local_artifact",
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

    function guidanceReadTarget(): AdapterReadTarget {
        const sourceRoot = projectSourceRoot();
        return {
            adapterId: codexProvider.adapterId,
            allowedKinds: ["Guidance"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: guidanceProbeResult(verifiedTargetBuild().versionText).observation,
                sourceRootIds: [sourceRoot.sourceRootId],
            },
        };
    }

    function projectSourceRoot() {
        return {
            sourceRootId: "codex-project-root",
            rootRole: "project_actual" as const,
            sourceDomain: "project_root" as const,
            path: projectRoot,
            accessStatus: "available" as const,
            locatorEvidence: [
                {
                    locatorKind: "project_registry_entry" as const,
                    locatorKey: "codex_project_registry",
                    evidenceLevel: "local_artifact" as const,
                },
            ],
            diagnostics: [],
        };
    }

    function readGuidanceVersion(assetId: UuidV4, versionId: UuidV4) {
        const closure = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            assetId,
            versionId,
            createVersionDialectRegistry(
                codexProvider.dialectContracts.native,
                codexProvider.dialectContracts.restoration,
                codexProvider.dialectContracts.portableEntries,
                codexProvider.dialectContracts.portableSelectors,
            ),
        );
        if (closure === null) throw new Error("Guidance Version authority is missing");
        return closure;
    }

    function verifiedTargetBuild() {
        const declaration = codexProvider.renderContractDeclarations.find(
            (candidate) => candidate.declarationKind === "native_project_guidance_v1",
        );
        const build = declaration?.verifiedBuilds[0];
        if (build === undefined) throw new Error("Codex verified Guidance target build is missing");
        return build;
    }
});

async function deploy(core: CoreService, deploymentId: UuidV4) {
    const analysis = await core.analyzeDeploymentRender(deploymentId);
    expect(analysis.status, JSON.stringify(analysis.diagnostics)).toBe("complete");
    const selectionRequest = exactSelection(analysis.value);
    const preview = await core.previewDeploymentRender({ deploymentId, selectionRequest });
    expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
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
            if (matches.length !== 1 || selected === undefined) throw new Error("exact Guidance selection is not unique");
            return { optionFingerprint: selected.optionFingerprint, approvalRequest: { approvalAction: "none" } };
        }),
    };
}

function enableCodex(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [codexProvider.adapterId],
        userActionId: "enable-codex-guidance-fixture",
    });
    if (enabled.status !== "complete") throw new Error(`failed to enable Codex: ${JSON.stringify(enabled.diagnostics)}`);
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
