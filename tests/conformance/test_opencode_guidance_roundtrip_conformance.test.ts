/** Exact OpenCode Guidance source/import/deploy/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { sha256Bytes } from "../../packages/core/src/foundation/crypto-bytes";
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
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import {
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectTargetContextForTest,
} from "../../packages/core/src/render/native-project-guidance";

const SOURCE_TEXT = "# OpenCode project guidance\n\nKeep this source boundary exact.\n";
const ACCEPTED_TEXT = "# OpenCode project guidance\n\nKeep this accepted runtime edit.\n";
const RUNTIME_CASES = [
    {
        agentRuntimeId: "OPENCODE_CLI",
        displayName: "OpenCode CLI",
        evidenceKind: "executable",
        artifactName: "opencode",
    },
    {
        agentRuntimeId: "OPENCODE_APP",
        displayName: "OpenCode App",
        evidenceKind: "app_bundle",
        artifactName: "app.asar",
    },
] as const;

describe.each(RUNTIME_CASES)("$displayName Guidance integrated round trip", (runtimeCase) => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let guidancePath = "";
    let executablePath = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-guidance-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        guidancePath = path.join(projectRoot, "AGENTS.md");
        executablePath = path.join(sandbox, "bin", runtimeCase.artifactName);
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

    it("preserves native bytes, deploys AGENTS.md, and reverse-accepts one exact runtime edit", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness();
        const original = readGuidanceVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
            nativeRepresentations: [expect.objectContaining({ dialectId: "opencode-guidance-markdown-v1" })],
        });
        expect(original.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "opencode-guidance-markdown-v1",
                files: [{ relativePath: "AGENTS.md", bytes: new Uint8Array(Buffer.from(SOURCE_TEXT)) }],
            }),
        ]);

        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: [runtimeCase.agentRuntimeId],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");
        const deployed = await deploy(harness.core, deployment.value.deploymentId);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(guidancePath, "utf8")).toBe(SOURCE_TEXT);

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
        if (prepared.value.preparationState !== "prepared") throw new Error("OpenCode reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-opencode-guidance-edit",
            newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
        if (committed.value.commitState !== "committed") throw new Error("OpenCode reverse commit did not commit");
        expect(committed.value.version.versionId).not.toBe(harness.versionId);

        const accepted = readGuidanceVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "opencode-guidance-markdown-v1",
                files: [{ relativePath: "AGENTS.md", bytes: new Uint8Array(Buffer.from(ACCEPTED_TEXT)) }],
            }),
        ]);
        expect(readGuidanceVersion(harness.assetId, harness.versionId).files[0]).toMatchObject({
            contentKind: "text",
            text: SOURCE_TEXT,
        });
    });

    it("accepts a comparable non-exact build with an explicit unverified warning", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness("compatible_build");
        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: [runtimeCase.agentRuntimeId],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });

        const analyzed = await harness.core.analyzeDeploymentRender(deployment.value.deploymentId);

        expect(analyzed.status).toBe("complete");
        expect(analyzed.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_target_build_compatibility_inferred", severity: "warning" }),
        );
        expect(fs.existsSync(guidancePath)).toBe(false);
        expect(harness.core.getDeployment(deployment.value.deploymentId).value.value?.files).toEqual([]);
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
    });

    it("rejects a build older than the earliest verified cell anchor", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness("older_build");
        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: [runtimeCase.agentRuntimeId],
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

    it("binds the actual Provider's Guidance schema instead of a sibling AssetKind declaration", () => {
        const buildBytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x01]);
        const build = {
            ...verifiedTargetBuild(),
            buildIdentity: sha256Bytes(buildBytes),
        };
        const schemaIds = opencodeProvider.assetTargetCapabilities.flatMap((capability) =>
            capability.agentRuntimeId === runtimeCase.agentRuntimeId &&
            capability.assetKind === "Guidance" &&
            capability.entrySupportStatus === "supported" &&
            "targetContextSchemaId" in capability
                ? [capability.targetContextSchemaId]
                : [],
        );
        expect(schemaIds).toHaveLength(1);
        const input = {
            provider: { ...opencodeProvider, enabled: true },
            probeResult: guidanceProbeResult(build.versionText),
            agentRuntimeId: runtimeCase.agentRuntimeId,
            targetRootPath: projectRoot,
            projectRootPath: projectRoot,
            targetContextSchemaIds: schemaIds,
        };
        const dependencies = {
            verifiedBuilds: [build],
            readBuildArtifact: () => ({
                bytes: buildBytes,
                executable: true,
                identity: { deviceId: "actual-provider", fileId: runtimeCase.agentRuntimeId, entryKind: "file" as const },
            }),
        };

        expect(resolveObservedNativeProjectTargetContextForTest(input, dependencies)).toMatchObject({
            status: "complete",
            targetContext: { targetContextSchemaId: schemaIds[0] },
        });
        expect(
            resolveObservedNativeProjectTargetContextForTest({ ...input, targetContextSchemaIds: undefined }, dependencies),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
        });
    });

    async function importedGuidanceHarness(targetMode: "verified" | "compatible_build" | "older_build" = "verified"): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createGuidanceCore(targetMode);
        enableOpenCode(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "OpenCode Guidance fixture" });
        expect(project.status, JSON.stringify(project.diagnostics)).toBe("complete");
        const read = await core.readAssetsFromAdapter(guidanceReadTarget());
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("OpenCode Guidance import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-opencode-guidance",
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

    function createGuidanceCore(targetMode: "verified" | "compatible_build" | "older_build"): CoreService {
        const build = verifiedTargetBuild();
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
                    return {
                        status: "complete",
                        value: [guidanceProbeResult(targetMode === "older_build" ? "0.9.0" : build.versionText)],
                        diagnostics: [],
                    };
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
                            bytes: new TextEncoder().encode("unverified OpenCode build"),
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
                adapterId: opencodeProvider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: runtimeCase.agentRuntimeId,
                        versionText,
                        installationEvidence: [
                            {
                                kind: runtimeCase.evidenceKind,
                                path: executablePath,
                                evidenceLevel: "local_artifact",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [sourceRoot.sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: ["opencode-project"],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot],
                agentRuntimeResources: [],
                observedProjects: [
                    {
                        observedProjectId: "opencode-project",
                        runtimeProjectKey: projectRoot,
                        displayName: "OpenCode Guidance fixture",
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
                        targetCandidateId: "opencode-project-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: "OpenCode Guidance fixture",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: runtimeCase.agentRuntimeId,
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

    function guidanceReadTarget(): AdapterReadTarget {
        const sourceRoot = projectSourceRoot();
        return {
            adapterId: opencodeProvider.adapterId,
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
            sourceRootId: "opencode-project-root",
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

    function readGuidanceVersion(assetId: UuidV4, versionId: UuidV4) {
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
        if (closure === null) throw new Error("OpenCode Guidance Version authority is missing");
        return closure;
    }

    function verifiedTargetBuild() {
        const declaration = opencodeProvider.renderContractDeclarations.find(
            (candidate) =>
                candidate.declarationKind === "native_project_guidance_v1" &&
                candidate.agentRuntimeId === runtimeCase.agentRuntimeId,
        );
        const build = declaration?.verifiedBuilds.filter((candidate) => candidate.platform === platformContext.platform).at(-1);
        if (build === undefined) throw new Error("OpenCode verified Guidance target build is missing");
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
            if (matches.length !== 1 || selected === undefined)
                throw new Error("exact OpenCode Guidance selection is not unique");
            return { optionFingerprint: selected.optionFingerprint, approvalRequest: { approvalAction: "none" } };
        }),
    };
}

function enableOpenCode(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [opencodeProvider.adapterId],
        userActionId: "enable-opencode-guidance-fixture",
    });
    if (enabled.status !== "complete") throw new Error(`failed to enable OpenCode: ${JSON.stringify(enabled.diagnostics)}`);
}

function increasingClock(): () => number {
    let value = 1_000;
    return () => (value += 1);
}

function uuidSequence(): () => UuidV4 {
    let value = 0;
    return () => {
        value += 1;
        return `21000000-0000-4000-8000-${String(value).padStart(12, "0")}` as UuidV4;
    };
}
