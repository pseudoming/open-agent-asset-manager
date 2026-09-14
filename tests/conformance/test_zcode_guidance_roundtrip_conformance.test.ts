/** Exact ZCode Guidance source/import/deploy/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zcodeProvider } from "../../packages/adapter/providers/zcode/src/zcode-provider";
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

const SOURCE_TEXT = "# ZCode project guidance\n\nKeep the source boundary exact.\n";
const ACCEPTED_TEXT = "# ZCode project guidance\n\nKeep the deployed edit and its history.\n";

describe("ZCode App Guidance integrated WSL round trip", () => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let guidancePath = "";
    let consumerPath = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-guidance-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        guidancePath = path.join(projectRoot, "AGENTS.md");
        consumerPath = path.join(sandbox, "ZCode", "resources", "glm", "zcode.cjs");
        platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
        fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(consumerPath, "synthetic ZCode consumer evidence\n");
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
        const harness = await importedGuidanceHarness("verified");
        const original = readGuidanceVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
            nativeRepresentations: [expect.objectContaining({ dialectId: "zcode-guidance-markdown-v1" })],
        });
        expect(original.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "zcode-guidance-markdown-v1",
                files: [{ relativePath: "AGENTS.md", bytes: new Uint8Array(Buffer.from(SOURCE_TEXT)) }],
            }),
        ]);

        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["ZCODE_APP"],
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
        if (prepared.value.preparationState !== "prepared") throw new Error("ZCode reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-zcode-guidance-edit",
            newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
        if (committed.value.commitState !== "committed") throw new Error("ZCode reverse commit did not commit");
        expect(committed.value.version.assetId).toBe(harness.assetId);
        expect(committed.value.version.versionId).not.toBe(harness.versionId);
        expect(fs.readFileSync(guidancePath, "utf8")).toBe(ACCEPTED_TEXT);

        const accepted = readGuidanceVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.manifest.typeData).toEqual(original.manifest.typeData);
        expect(accepted.files).toEqual([expect.objectContaining({ contentKind: "text", text: ACCEPTED_TEXT })]);
        expect(accepted.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "zcode-guidance-markdown-v1",
                files: [{ relativePath: "AGENTS.md", bytes: new Uint8Array(Buffer.from(ACCEPTED_TEXT)) }],
            }),
        ]);
        expect(readGuidanceVersion(harness.assetId, harness.versionId).files[0]).toMatchObject({
            contentKind: "text",
            text: SOURCE_TEXT,
        });
    });

    it("rejects a consumer build older than the earliest App anchor before writing or publishing", async () => {
        fs.writeFileSync(guidancePath, SOURCE_TEXT);
        const harness = await importedGuidanceHarness("older_build");
        fs.rmSync(guidancePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["ZCODE_APP"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");

        const analyzed = await harness.core.analyzeDeploymentRender(deployment.value.deploymentId);

        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("native_guidance_build_unverified");
        expect(fs.existsSync(guidancePath)).toBe(false);
        expect(harness.core.getDeployment(deployment.value.deploymentId).value.value?.files).toEqual([]);
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
    });

    async function importedGuidanceHarness(targetMode: "verified" | "older_build"): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createGuidanceCore(targetMode);
        enableZcode(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "ZCode Guidance fixture" });
        expect(project.status, JSON.stringify(project.diagnostics)).toBe("complete");
        const read = await core.readAssetsFromAdapter(guidanceReadTarget());
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("ZCode Guidance import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-zcode-guidance",
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

    function createGuidanceCore(targetMode: "verified" | "older_build"): CoreService {
        const build = verifiedWslBuild();
        return createCoreServiceForTest(
            {
                providers: [zcodeProvider],
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
                        value: [guidanceProbeResult(targetMode === "verified" ? build.versionText : "3.3.4")],
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
                            bytes: new TextEncoder().encode("unverified ZCode consumer"),
                            executable: false,
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
                adapterId: zcodeProvider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: "ZCODE_APP",
                        versionText,
                        installationEvidence: [
                            {
                                kind: "app_bundle",
                                path: consumerPath,
                                evidenceLevel: "local_artifact",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [sourceRoot.sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [
                    {
                        targetCandidateId: "zcode-project-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: "ZCode Guidance fixture",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "ZCODE_APP",
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "user_provided_path",
                                        locatorKey: "zcode-project-root",
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
            adapterId: zcodeProvider.adapterId,
            allowedKinds: ["Guidance"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: guidanceProbeResult(verifiedWslBuild().versionText).observation,
                sourceRootIds: [sourceRoot.sourceRootId],
            },
        };
    }

    function projectSourceRoot() {
        return {
            sourceRootId: "zcode-project-root",
            rootRole: "project_actual" as const,
            sourceDomain: "project_root" as const,
            path: projectRoot,
            accessStatus: "available" as const,
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path" as const,
                    locatorKey: "selected_project_root",
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
                zcodeProvider.dialectContracts.native,
                zcodeProvider.dialectContracts.restoration,
                zcodeProvider.dialectContracts.portableEntries,
                zcodeProvider.dialectContracts.portableSelectors,
            ),
        );
        if (closure === null) throw new Error("ZCode Guidance Version authority is missing");
        return closure;
    }

    function verifiedWslBuild() {
        const declaration = zcodeProvider.renderContractDeclarations.find(
            (candidate) => candidate.declarationKind === "native_project_guidance_v1",
        );
        const build = declaration?.verifiedBuilds.find(
            (candidate) => candidate.platform === "wsl" && candidate.versionText === "3.5.3",
        );
        if (build === undefined) throw new Error("ZCode WSL verified Guidance target build is missing");
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

function enableZcode(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [zcodeProvider.adapterId],
        userActionId: "enable-zcode-guidance-fixture",
    });
    if (enabled.status !== "complete") throw new Error(`failed to enable ZCode: ${JSON.stringify(enabled.diagnostics)}`);
}

function increasingClock(): () => number {
    let value = 1_000;
    return () => (value += 1);
}

function uuidSequence(): () => UuidV4 {
    let value = 0;
    return () => {
        value += 1;
        return `50000000-0000-4000-8000-${String(value).padStart(12, "0")}` as UuidV4;
    };
}
