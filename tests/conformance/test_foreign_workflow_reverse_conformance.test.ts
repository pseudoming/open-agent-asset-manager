import { approvedSkillSelection, requireComplete } from "./skill-public-conformance-support";
/** Real source imports, reviewed conversion and source-native reverse through public Core and Host. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProtocolRequest } from "../../packages/app-server/protocol/src/index";
import { dispatchH1Long } from "../../packages/app-server/host/src/dispatch-registry";
import { createHostRenderApprovalAuthority } from "../../packages/app-server/host/src/render-approval-authority";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import type { AdapterProvider, PlatformContext, ProbeResult, UuidV4 } from "../../packages/core/src/types";

import { computeTargetApplicabilityFingerprint } from "../../packages/core/src/foundation/fingerprint-render";
const NAME = "git-review";
const BODY = "Review the requested changes.\n\n```bash\nBASE_BRANCH=${BASE_BRANCH:-main}\nprintf '%s\\n' \"$BASE_BRANCH\"\n```\n";
const HEADER = "---\nname: git-review\ndescription: Review Git changes and preserve explicit invocation.\n---\n";
const SUFFIX = "\nCheck the added release note.\n";
const source = {
    provider: antigravityProvider,
    agentRuntimeId: "ANTIGRAVITY_APP",
    version: "1.12.2",
    folder: ".agents",
} as const;
const target = { provider: claudecodeProvider, agentRuntimeId: "CLAUDE_CODE_CLI", folder: ".claude" } as const;
const providers = [source.provider, target.provider];
const body = BODY;
const expectedLosses = [] as const;
let sandbox: string, projectRoot: string, oaamRoot: string, platformContext: PlatformContext;
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-foreign-workflow-public-"));
    projectRoot = path.join(sandbox, "project");
    oaamRoot = path.join(sandbox, "oaam");
    platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
    fs.mkdirSync(path.join(projectRoot, ".agents/workflows"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".agents/workflows", NAME + ".md"), HEADER + BODY);
    clearRegistry();
    closeDb();
});
afterEach(() => {
    closeDb();
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Antigravity instruction Workflow to Claude public path", () => {
    it("saves one changed body as a source-native Version and advances the same applied Deployment", async () => {
        let clock = 1000;
        let sequence = 0;
        const authority = createHostRenderApprovalAuthority(() => ++clock);
        const core = createCoreServiceForTest(
            {
                providers,
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: () => ++clock,
                confirmOneTimeRenderApproval: (input) => authority.confirmOneTimeApproval(input),
                newUuid: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` as UuidV4,
            },
            {
                async probeAdapters() {
                    return { status: "complete", value: providers.map(probe), diagnostics: [] };
                },
                resolveObservedTargetContext() {
                    return {
                        status: "complete",
                        targetContext: targetContext(),
                        diagnostics: [],
                    };
                },
            },
        );
        const enablement = core.getAdapterEnablement();
        requireComplete(
            core.replaceAdapterEnablement({
                expectedRevision: enablement.value.revision,
                expectedSettingFingerprint: enablement.value.settingFingerprint,
                enabledAdapterIds: providers.map((p) => p.adapterId),
                userActionId: "enable-foreign-source-workflow-tools",
            }),
            "enable Providers",
        );
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Foreign Workflow public path" });
        requireComplete(project, "register Project");
        const read = await core.readAssetsFromAdapter({
            adapterId: source.provider.adapterId,
            allowedKinds: ["Workflow"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: probe(source.provider).observation,
                sourceRootIds: [sourceRoot().sourceRootId],
            },
        });
        requireComplete(read, "read actual source Workflow");
        expect(read.value.candidates).toHaveLength(1);
        expect(read.value.candidates[0]!.status, JSON.stringify(read.value.candidates[0]!.diagnostics)).toBe("complete");
        const preview = core.previewImport([read.value]);
        requireComplete(preview, "preview actual source");
        const candidateId = preview.value.items[0]!.candidateId;
        const imported = await core.acceptImport({
            previewSnapshot: preview.value,
            decision: {
                candidateId,
                action: "create_asset",
                freshness: { freshnessAction: "require_current_source" },
                promotion: {
                    promotionAction: "grant_current_version_current_target",
                    target: { targetKind: "project", projectId: project.value.projectId },
                    userActionId: "authorize-original-source-version",
                },
                callableBindings: [],
            },
        });
        requireComplete(imported, "import source");
        const { assetId, versionId } = imported.value;
        const registry = createVersionDialectRegistry(
            providers.flatMap((p) => p.dialectContracts.native),
            providers.flatMap((p) => p.dialectContracts.restoration),
            providers.flatMap((p) => p.dialectContracts.portableEntries),
            providers.flatMap((p) => p.dialectContracts.portableSelectors),
        );
        const original = readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)!;
        expect(original.manifest.typeData).toMatchObject({
            invocation: { userInvocable: true, agentInvocable: true, argumentNames: [] },
        });
        expect(original.manifest.nativeRepresentations[0]?.dialectId).toBe("antigravity-workflow-markdown-v1");
        const deployment = core.createDeployment({
            projectId: project.value.projectId,
            consumerAgentRuntimeIds: [target.agentRuntimeId],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId, versionId, allowIncomplete: false }],
        });
        requireComplete(deployment, "create foreign Deployment");
        const deploymentId = deployment.value.deploymentId;
        const analysis = await core.analyzeDeploymentRender(deploymentId);
        requireComplete(analysis, "analyze foreign conversion");
        const options = analysis.value.analyses.flatMap((row) => row.semanticOptions);
        expect(options.length).toBeGreaterThan(0);
        expect(
            options.every(
                (option) => option.outcome === "preserved" && option.approvalRequirement.approvalState === "not_required",
            ),
        ).toBe(true);
        const selectionRequest = approvedSkillSelection(analysis.value, expectedLosses);
        const forwardResolutions = authority.createResolutions(selectionRequest);
        const applyPreview = await authority.runWithResolutions(selectionRequest, forwardResolutions, () =>
            core.previewDeploymentRender({ deploymentId, selectionRequest }),
        );
        requireComplete(applyPreview, "preview converted graph");
        requireComplete(
            await authority.runWithResolutions(selectionRequest, forwardResolutions, () =>
                core.deployDeployment({
                    deploymentId,
                    selectionRequest,
                    expectedPreviewFingerprint: applyPreview.value.previewFingerprint,
                    deploymentAction: "apply",
                }),
            ),
            "apply converted graph",
        );
        const targetEntry = path.join(projectRoot, ".claude/commands", NAME + ".md");
        expect(fs.readFileSync(targetEntry, "utf8")).toContain(BODY);
        expect(fs.readFileSync(targetEntry, "utf8")).toContain("disable-model-invocation: false");
        expect(fs.readFileSync(targetEntry, "utf8")).toContain("user-invocable: true");
        fs.appendFileSync(targetEntry, SUFFIX);
        const changed = fs.readFileSync(targetEntry);
        const inspected = await core.inspectDeploymentRenderedTarget(deploymentId);
        requireComplete(inspected, "inspect foreign body edit");
        expect(inspected.value.changes).toHaveLength(1);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        requireComplete(prepared, "prepare foreign reverse");
        if (prepared.value.preparationState !== "prepared") throw new Error("Foreign reverse was not prepared");
        const preparedValue = prepared.value;
        const reverseSelection = approvedSkillSelection(preparedValue.renderAnalysis, expectedLosses);
        const committed = (await dispatchH1Long(
            core,
            createProtocolRequest("foreign-reverse", "reverse_accept.commit", {
                preparationId: preparedValue.preparationId,
                expectedPreparationRevision: preparedValue.preparationRevision,
                userActionId: "save-foreign-body-change",
                newVersionPromotion: "grant_staged_version_current_target",
                renderSelection: {
                    schemaVersion: 1,
                    renderInputFingerprint: reverseSelection.renderInputFingerprint.slice(7),
                    semanticOptions: reverseSelection.semanticOptions.map((option) => ({
                        optionFingerprint: option.optionFingerprint.slice(7),
                        approval:
                            option.approvalRequest.approvalAction === "none"
                                ? { action: "none" }
                                : { action: "approve_once", userActionId: "approve-disclosed-foreign-conversion" },
                    })),
                },
            }),
            undefined,
            undefined,
            authority,
        )) as Awaited<ReturnType<typeof core.commitRenderedTargetAccept>>;
        requireComplete(committed, "commit foreign reverse");
        if (committed.value.commitState !== "committed") throw new Error("Foreign reverse was not committed");
        const accepted = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            assetId,
            committed.value.version.versionId,
            registry,
        )!;
        expect(accepted.manifest.typeData).toEqual(original.manifest.typeData);
        expect(accepted.manifest.sourceVersionId).toBe(versionId);
        expect(accepted.files.find((f) => f.file.role === "entry")).toMatchObject({ text: body + SUFFIX });
        expect(accepted.manifest.nativeRepresentations[0]?.dialectId).toBe("antigravity-workflow-markdown-v1");
        expect(Buffer.from(accepted.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(HEADER + BODY + SUFFIX);
        expect(readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)).toEqual(original);
        expect(fs.readFileSync(path.join(projectRoot, ".agents/workflows", NAME + ".md"), "utf8")).toBe(HEADER + BODY);
        expect(fs.readFileSync(targetEntry)).toEqual(changed);
        expect(core.getDeployment(deploymentId)).toMatchObject({
            status: "complete",
            value: {
                found: true,
                value: {
                    deploymentId,
                    assets: [{ assetId, versionId: committed.value.version.versionId }],
                    derivedStatus: { stage: "in_sync" },
                },
            },
        });
    });
    function sourceRoot() {
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
    function probe(provider: AdapterProvider): ProbeResult {
        const agentRuntimeId = provider === source.provider ? source.agentRuntimeId : target.agentRuntimeId;
        const versionText = provider === source.provider ? source.version : targetContext().versionText;
        return {
            status: "complete",
            observation: {
                adapterId: provider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId,
                        versionText,
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: path.join(sandbox, "fixture-bin", agentRuntimeId),
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [sourceRoot().sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot()],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [
                    {
                        targetCandidateId: "foreign-workflow-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: NAME,
                        entryApplicabilities: [
                            {
                                agentRuntimeId,
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "user_provided_path",
                                        locatorKey: "probe_project_root",
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
});
function targetContext() {
    const provider = claudecodeProvider;
    const declaration = provider.renderContractDeclarations.find(
        (d) =>
            d.declarationKind === "native_project_exact_graph_v1" &&
            d.agentRuntimeId === "CLAUDE_CODE_CLI" &&
            d.assetKind === "Workflow" &&
            d.outputContractId.endsWith("_CANONICAL_V1"),
    );
    if (!declaration || declaration.declarationKind !== "native_project_exact_graph_v1")
        throw new Error("Workflow declaration missing");
    const build = declaration.verifiedBuilds.find((b) => b.platform === "wsl")!;
    const schema = provider.targetContextSchemas.find(
        (s) => s.targetContextSchemaId === declaration.target.targetContextSchemaId,
    )!;
    const renderFacts = [{ key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const }];
    const value = {
        schemaVersion: 1 as const,
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts,
    };
    return {
        ...value,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({ context: value, entryClass: "cli" }),
    };
}
