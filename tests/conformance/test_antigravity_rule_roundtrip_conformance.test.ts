/** Exact Antigravity Rule source/import/foreign-return/reverse conformance through Core authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
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

const SOURCE_BODY = "Reply with exactly `OAAM_AGY_RULE_112_8C4E91` and no other text.\n";
const FOREIGN_BODY = SOURCE_BODY.replace("8C4E91", "A7B8C9");
const REVERSED_BODY = SOURCE_BODY.replace("8C4E91", "D1E2F3");
const HEADER = ["---", "trigger: always_on", "---", ""].join("\n");
const SOURCE_NATIVE = `${HEADER}${SOURCE_BODY}`;
const FOREIGN_NATIVE = `${HEADER}${FOREIGN_BODY}`;
const REVERSED_NATIVE = `${HEADER}${REVERSED_BODY}`;

describe("Antigravity CLI exact Rule integrated lifecycle", () => {
    let sandbox = "";
    let oaamRoot = "";
    let projectRoot = "";
    let rulePath = "";
    let platformContext: PlatformContext;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-rule-roundtrip-"));
        oaamRoot = path.join(sandbox, "oaam");
        projectRoot = path.join(sandbox, "project");
        rulePath = path.join(projectRoot, ".agents", "rules", "oaam-phase55-rule.md");
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

    it("preserves the native wrapper across exact deploy, foreign canonical return, and body-only reverse", async () => {
        fs.writeFileSync(rulePath, SOURCE_NATIVE);
        const harness = await importedRuleHarness();
        const original = readRuleVersion(harness.assetId, harness.versionId);
        expect(original.manifest).toMatchObject({
            kind: "Rule",
            typeData: {
                schemaVersion: 2,
                name: "oaam-phase55-rule",
                description: "",
                activation: { mode: "always" },
            },
        });
        expect(nativeText(original)).toBe(SOURCE_NATIVE);

        fs.rmSync(rulePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        expect(deployment.status, JSON.stringify(deployment.diagnostics)).toBe("complete");
        requireComplete(await deploy(harness.core, deployment.value.deploymentId), "deploy current-exact Rule");
        expect(fs.readFileSync(rulePath, "utf8")).toBe(SOURCE_NATIVE);

        const foreign = harness.core.createVersion(harness.assetId, {
            typeData: structuredClone(original.manifest.typeData),
            files: editedCanonicalFiles(original, FOREIGN_BODY),
            userActionEvidenceId: "antigravity-rule-foreign-canonical-edit",
            changeKind: "edit",
            sourceVersionId: harness.versionId,
            changeNote: "Portable canonical edit before returning to Antigravity",
        });
        requireComplete(foreign, "create foreign-canonical Rule");
        const foreignClosure = readRuleVersion(harness.assetId, foreign.value.versionId);
        expect(foreignClosure.manifest.sourceVersionId).toBe(harness.versionId);
        expect(foreignClosure.manifest.nativeRepresentations).toEqual([]);
        expect(foreignClosure.nativePayloads).toEqual([]);
        expect(foreignClosure.manifest.dialectRestorationPayloads).toEqual(original.manifest.dialectRestorationPayloads);

        requireComplete(
            harness.core.updateDeploymentInputs(deployment.value.deploymentId, {
                assets: [{ assetId: harness.assetId, versionId: foreign.value.versionId, allowIncomplete: false }],
            }),
            "select foreign-canonical Rule",
        );
        requireComplete(await deploy(harness.core, deployment.value.deploymentId), "deploy parent-rebased Rule");
        expect(fs.readFileSync(rulePath, "utf8")).toBe(FOREIGN_NATIVE);

        fs.writeFileSync(rulePath, REVERSED_NATIVE);
        const inspected = await harness.core.inspectDeploymentRenderedTarget(deployment.value.deploymentId);
        requireComplete(inspected, "inspect parent-rebased Rule edit");
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
        requireComplete(prepared, "prepare parent-rebased Rule reverse");
        if (prepared.value.preparationState !== "prepared") throw new Error("Rule reverse preparation did not prepare");
        const committed = await harness.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-antigravity-rule-body-edit",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: exactSelection(prepared.value.renderAnalysis),
        });
        requireComplete(committed, "commit parent-rebased Rule reverse");
        if (committed.value.commitState !== "committed") throw new Error("Rule reverse commit did not commit");
        expect(committed.value.version.assetId).toBe(harness.assetId);

        const accepted = readRuleVersion(harness.assetId, committed.value.version.versionId);
        expect(accepted.manifest.sourceVersionId).toBe(foreign.value.versionId);
        expect(accepted.files).toEqual([expect.objectContaining({ contentKind: "text", text: REVERSED_BODY })]);
        expect(nativeText(accepted)).toBe(REVERSED_NATIVE);
        expect(nativeText(readRuleVersion(harness.assetId, harness.versionId))).toBe(SOURCE_NATIVE);
        expect(readRuleVersion(harness.assetId, foreign.value.versionId).manifest.nativeRepresentations).toEqual([]);
        expect(fs.readFileSync(rulePath, "utf8")).toBe(REVERSED_NATIVE);
    });

    it("blocks a foreign canonical trigger or description change before any target mutation", async () => {
        fs.writeFileSync(rulePath, SOURCE_NATIVE);
        const harness = await importedRuleHarness();
        const original = readRuleVersion(harness.assetId, harness.versionId);
        if (original.manifest.kind !== "Rule") throw new Error("Antigravity fixture imported a non-Rule Version");
        const originalTypeData = original.manifest.typeData;
        fs.rmSync(rulePath);
        const deployment = harness.core.createDeployment({
            projectId: harness.projectId,
            consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId: harness.assetId, versionId: harness.versionId, allowIncomplete: false }],
        });
        requireComplete(deployment, "create blocked Rule Deployment");

        for (const [label, typeData] of [
            ["description", { ...originalTypeData, description: "Changed outside Antigravity" }],
            ["trigger", { ...originalTypeData, activation: { mode: "manual" as const } }],
        ] as const) {
            const changed = harness.core.createVersion(harness.assetId, {
                typeData,
                files: editedCanonicalFiles(original, FOREIGN_BODY),
                userActionEvidenceId: `antigravity-rule-block-${label}`,
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
                "antigravity_project_rule_exact_file_blocked",
            ]);
            expect(fs.existsSync(rulePath)).toBe(false);
            expect(harness.core.getDeployment(deployment.value.deploymentId).value.value?.files).toEqual([]);
        }
    });

    async function importedRuleHarness(): Promise<{
        core: CoreService;
        projectId: UuidV4;
        assetId: UuidV4;
        versionId: UuidV4;
    }> {
        const core = createRuleCore();
        enableAntigravity(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Antigravity Rule fixture" });
        requireComplete(project, "register Rule fixture Project");
        const read = await core.readAssetsFromAdapter(ruleReadTarget());
        requireComplete(read, "read Antigravity Rule");
        expect(read.value.candidates).toHaveLength(1);
        const preview = core.previewImport([read.value]);
        requireComplete(preview, "preview Antigravity Rule");
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("Rule import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-and-authorize-antigravity-rule",
            },
            callableBindings: [],
        };
        const accepted = await core.acceptImport({ previewSnapshot: preview.value, decision });
        requireComplete(accepted, "accept Antigravity Rule");
        return {
            core,
            projectId: project.value.projectId,
            assetId: accepted.value.assetId,
            versionId: accepted.value.versionId,
        };
    }

    function createRuleCore(): CoreService {
        const { guidanceBuild } = verifiedTargetBuilds();
        return createCoreServiceForTest(
            {
                providers: [antigravityProvider],
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: increasingClock(),
                newUuid: uuidSequence(),
            },
            {
                async probeAdapters() {
                    return { status: "complete", value: [ruleProbeResult()], diagnostics: [] };
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

    function ruleProbeResult(): ProbeResult {
        const sourceRoot = projectSourceRoot();
        return {
            status: "complete",
            observation: {
                adapterId: antigravityProvider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: "ANTIGRAVITY_CLI",
                        versionText: "1.1.2",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: path.join(sandbox, "fixture-bin", "agy"),
                                evidenceLevel: "agent_runtime_verified",
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
        return {
            adapterId: antigravityProvider.adapterId,
            allowedKinds: ["Rule"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: ruleProbeResult().observation,
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
                    locatorKind: "project_registry_entry" as const,
                    locatorKey: "phase55-rule-project",
                    evidenceLevel: "agent_runtime_verified" as const,
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
                antigravityProvider.dialectContracts.native,
                antigravityProvider.dialectContracts.restoration,
                antigravityProvider.dialectContracts.portableEntries,
                antigravityProvider.dialectContracts.portableSelectors,
            ),
        );
        if (closure === null) throw new Error("Antigravity Rule Version authority is missing");
        return closure;
    }

    function verifiedTargetBuilds() {
        const guidance = antigravityProvider.renderContractDeclarations.find(
            (candidate) => candidate.declarationKind === "native_project_guidance_v1",
        );
        const rule = antigravityProvider.renderContractDeclarations.find(
            (candidate) => candidate.declarationKind === "native_project_exact_file_v1" && candidate.assetKind === "Rule",
        );
        const guidanceBuild = guidance?.verifiedBuilds[0];
        const ruleBuild = rule?.verifiedBuilds[0];
        if (guidanceBuild === undefined || ruleBuild === undefined)
            throw new Error("Antigravity verified target builds are missing");
        expect(ruleBuild).toMatchObject({
            agentRuntimeId: guidanceBuild.agentRuntimeId,
            versionText: guidanceBuild.versionText,
            buildIdentity: guidanceBuild.buildIdentity,
            platform: guidanceBuild.platform,
        });
        return { guidanceBuild, ruleBuild };
    }
});

async function deploy(core: CoreService, deploymentId: UuidV4) {
    const analysis = await core.analyzeDeploymentRender(deploymentId);
    requireComplete(analysis, "analyze Rule Deployment");
    const selectionRequest = exactSelection(analysis.value);
    const preview = await core.previewDeploymentRender({ deploymentId, selectionRequest });
    requireComplete(preview, "preview Rule Deployment");
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

function editedCanonicalFiles(closure: ReturnType<typeof readVersionAuthority> & {}, text: string) {
    if (closure === null) throw new Error("Rule closure is missing");
    return closure.files.map((file) => {
        if (file.contentKind !== "text") throw new Error("Antigravity Rule entry is not text");
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
    const payload = closure.nativePayloads.find((item) => item.dialectId === "antigravity-rule-markdown-v1");
    const file = payload?.files[0];
    if (payload?.files.length !== 1 || file === undefined) throw new Error("Antigravity Rule native payload is missing");
    return Buffer.from(file.bytes).toString("utf8");
}

function enableAntigravity(core: CoreService): void {
    const current = core.getAdapterEnablement();
    const enabled = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [antigravityProvider.adapterId],
        userActionId: "enable-antigravity-rule-fixture",
    });
    requireComplete(enabled, "enable Antigravity");
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
