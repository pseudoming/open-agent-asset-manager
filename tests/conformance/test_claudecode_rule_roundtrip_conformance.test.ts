/** Exact Claude Code Rule source/import/deploy/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
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
import { computeTargetApplicabilityFingerprint } from "../../packages/core/src/foundation/fingerprint";

const SOURCE_TEXT = "# Keep reviews focused\n";
const ACCEPTED_TEXT = "# Keep reviews focused and verify tests\n";

describe("Claude Code CLI Rule integrated round trip", () => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let rulePath = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claudecode-rule-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        rulePath = path.join(projectRoot, ".claude", "rules", "review.md");
        platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
        fs.mkdirSync(path.dirname(rulePath), { recursive: true });
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("reads, imports, deploys, and reverse-accepts one exact project Rule", async () => {
        fs.writeFileSync(rulePath, SOURCE_TEXT);
        const harness = await importedRuleHarness();
        const original = readRuleVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Rule",
            typeData: {
                schemaVersion: 2,
                name: "review",
                description: "",
                activation: { mode: "always" },
            },
        });
        expect(original.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "claudecode-rule-markdown-v1",
                files: [{ relativePath: ".claude/rules/review.md", bytes: new Uint8Array(Buffer.from(SOURCE_TEXT)) }],
            }),
        ]);

        fs.rmSync(rulePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");
        const deployed = await deploy(harness.core, deployment.value.deploymentId);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(rulePath, "utf8")).toBe(SOURCE_TEXT);
        expect(deployed.value.files).toEqual([
            expect.objectContaining({ relativePath: ".claude/rules/review.md", observedState: "present" }),
        ]);

        fs.writeFileSync(rulePath, ACCEPTED_TEXT);
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
        if (prepared.value.preparationState !== "prepared") throw new Error("Rule reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-rule-edit",
            newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
        if (committed.value.commitState !== "committed") throw new Error("Rule reverse commit did not commit");
        expect(committed.value.version.assetId).toBe(harness.assetId);
        expect(committed.value.version.versionId).not.toBe(harness.versionId);
        expect(fs.readFileSync(rulePath, "utf8")).toBe(ACCEPTED_TEXT);

        const accepted = readRuleVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.manifest.typeData).toEqual(original.manifest.typeData);
        expect(accepted.files).toEqual([expect.objectContaining({ contentKind: "text", text: ACCEPTED_TEXT })]);
        expect(accepted.nativePayloads).toEqual([
            expect.objectContaining({
                dialectId: "claudecode-rule-markdown-v1",
                files: [{ relativePath: ".claude/rules/review.md", bytes: new Uint8Array(Buffer.from(ACCEPTED_TEXT)) }],
            }),
        ]);
        expect(readRuleVersion(harness.assetId, harness.versionId).files[0]).toMatchObject({
            contentKind: "text",
            text: SOURCE_TEXT,
        });
    });

    it("restores one imported path-triggered Rule through its exact Claude representation", async () => {
        const pathTriggered = "---\npaths:\n  - src/**/*.ts\n---\n# Only TypeScript\n";
        fs.writeFileSync(rulePath, pathTriggered);
        const harness = await importedRuleHarness();
        fs.rmSync(rulePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        const analysis = await harness.core.analyzeDeploymentRender(deployment.value.deploymentId);
        expect(analysis.status, JSON.stringify(analysis.diagnostics)).toBe("complete");
        const deployed = await deploy(harness.core, deployment.value.deploymentId);
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(rulePath, "utf8")).toBe(pathTriggered);
        expect(harness.core.getDeployment(deployment.value.deploymentId).value.value?.files).toEqual([
            expect.objectContaining({ relativePath: ".claude/rules/review.md", observedState: "present" }),
        ]);
    });

    it("rejects a target-side trigger mutation without publishing a Version", async () => {
        fs.writeFileSync(rulePath, SOURCE_TEXT);
        const harness = await deployedRuleHarness();
        const triggerMutation = "---\npaths:\n  - src/**/*.ts\n---\n# Only TypeScript\n";
        fs.writeFileSync(rulePath, triggerMutation);
        const inspected = await harness.core.inspectDeploymentRenderedTarget(harness.deploymentId);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value.changes).toEqual([]);
        expect(inspected.value.files).toEqual([expect.objectContaining({ attributionState: "conflict" })]);
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: harness.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status).toBe("failed");
        expect(prepared.diagnostics[0]?.code).toBe("reverse_accept.t5_change_unsupported");
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
        expect(fs.readFileSync(rulePath, "utf8")).toBe(triggerMutation);
    });

    it.each([
        {
            label: "renamed target",
            mutate() {
                fs.renameSync(rulePath, path.join(path.dirname(rulePath), "renamed.md"));
            },
        },
        {
            label: "executable-bit drift",
            mutate() {
                fs.chmodSync(rulePath, 0o755);
            },
        },
    ])("rejects $label as a reverse conflict without publishing a Version", async ({ mutate }) => {
        fs.writeFileSync(rulePath, SOURCE_TEXT);
        const harness = await deployedRuleHarness();
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

    it("rejects a stale Rule edit after preview without publishing a Version", async () => {
        fs.writeFileSync(rulePath, SOURCE_TEXT);
        const harness = await deployedRuleHarness();
        fs.writeFileSync(rulePath, "# First runtime edit\n");
        const inspected = await harness.core.inspectDeploymentRenderedTarget(harness.deploymentId);
        const prepared = await harness.core.prepareRenderedTargetAccept({
            deploymentId: harness.deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        if (prepared.value.preparationState !== "prepared") throw new Error("Rule reverse preparation did not prepare");
        fs.writeFileSync(rulePath, "# Second runtime edit\n");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-stale-rule-edit",
            newVersionPromotion: { promotionAction: "grant_staged_version_current_target" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        expect(committed.status).toBe("failed");
        expect(committed.diagnostics[0]?.code).toBe("reverse_accept.inspection_stale");
        expect(harness.core.listVersions(harness.assetId).value).toHaveLength(1);
        expect(fs.readFileSync(rulePath, "utf8")).toBe("# Second runtime edit\n");
    });

    async function importedRuleHarness(): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createRuleCore();
        enableClaudeCode(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Rule fixture" });
        expect(project.status, JSON.stringify(project.diagnostics)).toBe("complete");
        const read = await core.readAssetsFromAdapter(ruleReadTarget());
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("Rule import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-rule",
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

    async function deployedRuleHarness(): Promise<Awaited<ReturnType<typeof importedRuleHarness>> & { deploymentId: UuidV4 }> {
        const imported = await importedRuleHarness();
        fs.rmSync(rulePath);
        const deployment = imported.core.createDeployment({
            projectId: imported.projectId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
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

    function createRuleCore(): CoreService {
        const ruleBuild = verifiedRuleTargetBuild();
        return createCoreServiceForTest(
            {
                providers: [claudecodeProvider],
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: increasingClock(),
                newUuid: uuidSequence(),
            },
            {
                async probeAdapters() {
                    // P37-3 owns the real CLI load fixture. This deterministic Core seam supplies
                    // that separately verified build fact without claiming to execute Claude here.
                    return {
                        status: "complete",
                        value: [ruleProbeResult(ruleBuild.versionText)],
                        diagnostics: [],
                    };
                },
                resolveObservedTargetContext(_input) {
                    return {
                        status: "complete",
                        targetContext: ruleTargetContext(ruleBuild),
                        diagnostics: [],
                    };
                },
            },
        );
    }

    function ruleProbeResult(versionText: string): ProbeResult {
        const sourceRoot = projectSourceRoot();
        return {
            status: "complete",
            observation: {
                adapterId: claudecodeProvider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        versionText,
                        installationEvidence: [
                            {
                                kind: "version_command",
                                path: "claude --version",
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                            {
                                kind: "executable",
                                path: path.join(sandbox, "fixture-bin", "claude"),
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
                targetCandidates: [],
            },
            diagnostics: [],
        };
    }

    function ruleReadTarget(): AdapterReadTarget {
        const sourceRoot = projectSourceRoot();
        const observation = ruleProbeResult(verifiedRuleTargetBuild().versionText).observation;
        return {
            adapterId: claudecodeProvider.adapterId,
            allowedKinds: ["Rule"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation,
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
                    locatorKey: "selected-project-root",
                    evidenceLevel: "user_provided" as const,
                },
            ],
            diagnostics: [],
        };
    }

    function readRuleVersion(assetId: UuidV4, versionId: UuidV4) {
        const closure = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            assetId,
            versionId,
            createVersionDialectRegistry(
                claudecodeProvider.dialectContracts.native,
                claudecodeProvider.dialectContracts.restoration,
                claudecodeProvider.dialectContracts.portableEntries,
                claudecodeProvider.dialectContracts.portableSelectors,
            ),
        );
        if (closure === null) throw new Error("Rule Version authority is missing");
        return closure;
    }

    function verifiedRuleTargetBuild() {
        const ruleDeclarations = claudecodeProvider.renderContractDeclarations.filter(
            (candidate) =>
                candidate.declarationKind === "native_project_rule_v1" &&
                candidate.outputContractId === "CLAUDECODE_NATIVE_PROJECT_RULE_V1" &&
                candidate.agentRuntimeId === "CLAUDE_CODE_CLI",
        );
        if (ruleDeclarations.length !== 1) {
            throw new Error("Claude Code canonical CLI Rule target declaration is not unique");
        }
        const ruleDeclaration = ruleDeclarations[0];
        const ruleBuild = ruleDeclaration?.verifiedBuilds[0];
        if (ruleBuild === undefined) throw new Error("Claude Code verified Rule target build is missing");
        return ruleBuild;
    }

    function ruleTargetContext(ruleBuild: ReturnType<typeof verifiedRuleTargetBuild>) {
        const descriptor = claudecodeProvider.agentRuntimes.find(
            (candidate) => candidate.agentRuntimeId === ruleBuild.agentRuntimeId,
        );
        const schema = claudecodeProvider.targetContextSchemas.find(
            (candidate) => candidate.agentRuntimeId === ruleBuild.agentRuntimeId,
        );
        if (descriptor === undefined || schema === undefined) {
            throw new Error("Claude Code Rule build has no target-context owner");
        }
        const preimage = {
            schemaVersion: 1 as const,
            agentRuntimeId: ruleBuild.agentRuntimeId,
            versionText: ruleBuild.versionText,
            buildIdentity: ruleBuild.buildIdentity,
            targetContextSchemaId: schema.targetContextSchemaId,
            targetContextSchemaFingerprint: schema.schemaFingerprint,
            renderFacts: [{ key: "oaam.platform", value: ruleBuild.platform, evidenceLevel: "agent_runtime_verified" as const }],
        };
        return {
            ...preimage,
            targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
                context: preimage,
                entryClass: descriptor.entryClass,
            }),
        };
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
            if (matches.length !== 1 || selected === undefined) throw new Error("exact Rule selection is not unique");
            return { optionFingerprint: selected.optionFingerprint, approvalRequest: { approvalAction: "none" } };
        }),
    };
}

function enableClaudeCode(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [claudecodeProvider.adapterId],
        userActionId: "enable-claudecode-rule-fixture",
    });
    if (enabled.status !== "complete") throw new Error(`failed to enable Claude Code: ${JSON.stringify(enabled.diagnostics)}`);
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
